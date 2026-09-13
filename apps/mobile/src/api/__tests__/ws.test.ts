import { createReconnectingChatSocket, type IncomingFrame } from '../ws';

/** Minimal fake matching the subset of the platform `WebSocket` surface
 * `createReconnectingChatSocket` relies on (see `../ws.ts`): the
 * `onopen`/`onmessage`/`onclose`/`onerror` callback properties and a
 * `close()` method. Real close events (browser + React Native) carry a
 * `code`, which is what distinguishes a terminal 4001 (unauthorized) close
 * from any other transient drop. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = jest.fn();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
}

async function flush(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

describe('createReconnectingChatSocket', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    jest.useRealTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  function statuses(onStatusChange: jest.Mock): unknown[] {
    return onStatusChange.mock.calls.map((call) => call[0]);
  }

  it('opens an initial connection, announcing "connecting" first', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    const onStatusChange = jest.fn();
    createReconnectingChatSocket(getToken, { onMessage: jest.fn(), onStatusChange });

    await flush();

    expect(statuses(onStatusChange)[0]).toBe('connecting');
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('doubles the backoff delay across consecutive failed reconnect attempts (~1s, ~2s, ~4s)', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    const onStatusChange = jest.fn();
    createReconnectingChatSocket(getToken, { onMessage: jest.fn(), onStatusChange });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);

    // First failure: next attempt should land within [800ms, 1200ms] (1s +/-20%).
    FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(799);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(500); // total 1299ms, comfortably past the 1200ms ceiling
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Second failure: next attempt should land within [1600ms, 2400ms] (2s +/-20%).
    FakeWebSocket.instances[1].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(1599);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(900); // total 2499ms, past the 2400ms ceiling
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Third failure: next attempt should land within [3200ms, 4800ms] (4s +/-20%).
    FakeWebSocket.instances[2].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(3199);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(1700); // total 4899ms, past the 4800ms ceiling
    expect(FakeWebSocket.instances).toHaveLength(4);

    expect(statuses(onStatusChange)).toEqual(
      expect.arrayContaining(['connecting', 'reconnecting'])
    );
  });

  it('resets the backoff back to ~1s after a successful reconnect', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    const onStatusChange = jest.fn();
    createReconnectingChatSocket(getToken, { onMessage: jest.fn(), onStatusChange });
    await flush();

    // Fail twice in a row so the backoff would otherwise be at ~4s.
    FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(1300);
    FakeWebSocket.instances[1].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(2500);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // This attempt succeeds.
    FakeWebSocket.instances[2].onopen?.();
    expect(statuses(onStatusChange).at(-1)).toBe('connected');

    // A subsequent failure should schedule the *next* attempt at ~1s again,
    // not continue climbing from ~4s.
    FakeWebSocket.instances[2].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(799);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(500); // total 1299ms
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('does not schedule a reconnect after a 4001 (unauthorized) close, and reports "disconnected"', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    const onStatusChange = jest.fn();
    createReconnectingChatSocket(getToken, { onMessage: jest.fn(), onStatusChange });
    await flush();

    FakeWebSocket.instances[0].onclose?.({ code: 4001 });

    expect(statuses(onStatusChange).at(-1)).toBe('disconnected');

    await jest.advanceTimersByTimeAsync(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close() cancels a pending scheduled reconnect', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    const onStatusChange = jest.fn();
    const handle = createReconnectingChatSocket(getToken, { onMessage: jest.fn(), onStatusChange });
    await flush();

    FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    handle.close();

    await jest.advanceTimersByTimeAsync(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('closes the current open socket when close() is called', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    const handle = createReconnectingChatSocket(getToken, {
      onMessage: jest.fn(),
      onStatusChange: jest.fn(),
    });
    await flush();

    handle.close();

    expect(FakeWebSocket.instances[0].close).toHaveBeenCalled();
  });

  it('calls getToken() again on every reconnect attempt, not just the first', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    createReconnectingChatSocket(getToken, { onMessage: jest.fn(), onStatusChange: jest.fn() });
    await flush();
    expect(getToken).toHaveBeenCalledTimes(1);

    FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(1300);
    expect(getToken).toHaveBeenCalledTimes(2);

    FakeWebSocket.instances[1].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(2500);
    expect(getToken).toHaveBeenCalledTimes(3);
  });

  it('dispatches incoming message frames to onMessage on the current socket', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    const onMessage = jest.fn();
    createReconnectingChatSocket(getToken, { onMessage, onStatusChange: jest.fn() });
    await flush();

    const frame: IncomingFrame = { type: 'ack' };
    FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify(frame) });

    expect(onMessage).toHaveBeenCalledWith(frame);
  });
});
