import type { QuicDriverConnection, QuicListeners } from '../quic';

/** `../store.ts` imports `../quic.ts`, which in turn imports the generated
 * `quic-relay-client` TurboModule bindings -- unavailable outside a real
 * native runtime. Per issue #77's acceptance criteria (and ADR 0010, no
 * real device/network race), the store's own tests mock `../quic` directly
 * at the module boundary the store actually calls through (`connectQuic`),
 * the same way `../__tests__/quic.test.ts` mocks one level deeper at
 * `quic-relay-client` for `quic.ts`'s own tests. */
const mockConnectQuic = jest.fn<Promise<QuicDriverConnection>, [string, QuicListeners]>();
jest.mock('../quic', () => ({
  connectQuic: (token: string, listeners: QuicListeners) => mockConnectQuic(token, listeners),
}));

// eslint-disable-next-line import/first -- must follow the jest.mock('../quic', ...) call above.
import { transportStore, QUIC_CONNECT_TIMEOUT_MS, type ConnectionStatus } from '../store';

/** Minimal fake matching the subset of the platform `WebSocket` surface the
 * store's `connect` action relies on (see `../store.ts`): the
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

/** Subscribes to `transportStore` and records every distinct `status`
 * value it passes through, mirroring the `onStatusChange` call log the
 * old `createReconnectingChatSocket` handlers received. */
function trackStatuses(): ConnectionStatus[] {
  const statuses: ConnectionStatus[] = [];
  let last: ConnectionStatus | undefined;
  transportStore.subscribe(() => {
    const current = transportStore.state.status;
    if (current !== last) {
      statuses.push(current);
      last = current;
    }
  });
  return statuses;
}

describe('transportStore', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    // Default: QUIC fails outright and immediately on every attempt, so
    // pre-existing WS-only tests below exercise the WS path exactly as
    // before, without needing to advance past `QUIC_CONNECT_TIMEOUT_MS`
    // themselves. The "QUIC vs WS race" describe block further down
    // overrides this per test.
    mockConnectQuic.mockReset();
    mockConnectQuic.mockRejectedValue(new Error('quic unavailable'));
  });

  afterEach(() => {
    // Closes any connection/pending reconnect left over from the test so
    // state doesn't leak into the next one (the store is a module-level
    // singleton, unlike the old factory which returned a fresh instance
    // per call).
    transportStore.actions.close();
    jest.useRealTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it('opens an initial connection, announcing "connecting" first', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    const statuses = trackStatuses();
    transportStore.actions.connect(getToken);

    await flush();

    expect(statuses[0]).toBe('connecting');
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('doubles the backoff delay across consecutive failed reconnect attempts (~1s, ~2s, ~4s)', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    const statuses = trackStatuses();
    transportStore.actions.connect(getToken);
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

    expect(statuses).toEqual(expect.arrayContaining(['connecting', 'reconnecting']));
  });

  it('resets the backoff back to ~1s after a successful reconnect', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    const statuses = trackStatuses();
    transportStore.actions.connect(getToken);
    await flush();

    // Fail twice in a row so the backoff would otherwise be at ~4s.
    FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(1300);
    FakeWebSocket.instances[1].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(2500);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // This attempt succeeds.
    FakeWebSocket.instances[2].onopen?.();
    expect(statuses.at(-1)).toBe('connected');
    expect(transportStore.state.activeTransport).toBe('ws');

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
    const statuses = trackStatuses();
    transportStore.actions.connect(getToken);
    await flush();

    FakeWebSocket.instances[0].onclose?.({ code: 4001 });

    expect(statuses.at(-1)).toBe('disconnected');
    expect(transportStore.state.activeTransport).toBeNull();

    await jest.advanceTimersByTimeAsync(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close() cancels a pending scheduled reconnect', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    transportStore.actions.connect(getToken);
    await flush();

    FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    transportStore.actions.close();

    await jest.advanceTimersByTimeAsync(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('closes the current open socket when close() is called', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    transportStore.actions.connect(getToken);
    await flush();

    transportStore.actions.close();

    expect(FakeWebSocket.instances[0].close).toHaveBeenCalled();
  });

  it('calls getToken() again on every reconnect attempt, not just the first', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    transportStore.actions.connect(getToken);
    await flush();
    expect(getToken).toHaveBeenCalledTimes(1);

    FakeWebSocket.instances[0].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(1300);
    expect(getToken).toHaveBeenCalledTimes(2);

    FakeWebSocket.instances[1].onclose?.({ code: 1006 });
    await jest.advanceTimersByTimeAsync(2500);
    expect(getToken).toHaveBeenCalledTimes(3);
  });

  it('dispatches incoming message frames onto lastFrame', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    transportStore.actions.connect(getToken);
    await flush();

    const frame = { type: 'ack' as const };
    FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify(frame) });

    expect(transportStore.state.lastFrame).toEqual(frame);
  });

  it('send() forwards a frame to the currently-open socket', async () => {
    const getToken = jest.fn().mockResolvedValue('token-1');
    transportStore.actions.connect(getToken);
    await flush();
    FakeWebSocket.instances[0].onopen?.();

    const sendSpy = jest.fn();
    (FakeWebSocket.instances[0] as unknown as { send: typeof sendSpy }).send = sendSpy;

    transportStore.actions.send({ type: 'send', to: 'contact-1', body_b64: 'Ym9keQ==' });

    expect(sendSpy).toHaveBeenCalledWith(
      JSON.stringify({ type: 'send', to: 'contact-1', body_b64: 'Ym9keQ==' })
    );
  });

  describe('QUIC vs WS race (issue #77)', () => {
    /** A `connectQuic` implementation whose resolution/rejection the test
     * controls explicitly, instead of settling immediately like
     * `mockResolvedValue`/`mockRejectedValue` would -- needed to exercise
     * "QUIC hasn't decided yet" states (e.g. before the timeout elapses). */
    function deferredQuicConnect(): {
      resolve: (conn: QuicDriverConnection) => void;
      reject: (error: unknown) => void;
    } {
      let capturedResolve: ((conn: QuicDriverConnection) => void) | undefined;
      let capturedReject: ((error: unknown) => void) | undefined;
      mockConnectQuic.mockImplementation(
        () =>
          new Promise((res, rej) => {
            capturedResolve = res;
            capturedReject = rej;
          })
      );
      // `connectQuic` (and thus the promise executor above) only actually
      // runs once the store's `attemptConnect` calls it -- i.e. after the
      // test awaits past that point -- so `resolve`/`reject` here are
      // late-bound indirections onto whatever the executor most recently
      // captured, not the (as-yet-unset) values at this call site.
      return {
        resolve: (conn: QuicDriverConnection) => capturedResolve?.(conn),
        reject: (error: unknown) => capturedReject?.(error),
      };
    }

    function fakeQuicConnection(): QuicDriverConnection & {
      send: jest.Mock;
      close: jest.Mock;
    } {
      return { send: jest.fn().mockResolvedValue(undefined), close: jest.fn() };
    }

    it('QUIC wins within the timeout: activeTransport becomes "quic" and the in-flight WS attempt is aborted, unused', async () => {
      const { resolve } = deferredQuicConnect();
      const getToken = jest.fn().mockResolvedValue('token-1');
      const statuses = trackStatuses();
      transportStore.actions.connect(getToken);
      await flush();
      expect(FakeWebSocket.instances).toHaveLength(1);

      const quicConn = fakeQuicConnection();
      resolve(quicConn);
      await flush();

      expect(transportStore.state.activeTransport).toBe('quic');
      expect(statuses.at(-1)).toBe('connected');
      expect(FakeWebSocket.instances[0].close).toHaveBeenCalled();
      expect(quicConn.close).not.toHaveBeenCalled();

      // send() now routes to the QUIC connection, not WS.
      transportStore.actions.send({ type: 'send', to: 'contact-1', body_b64: 'Ym9keQ==' });
      expect(quicConn.send).toHaveBeenCalledWith({
        type: 'send',
        to: 'contact-1',
        body_b64: 'Ym9keQ==',
      });
    });

    it('QUIC never resolves before the timeout, WS connects: activeTransport becomes "ws"', async () => {
      deferredQuicConnect();
      const getToken = jest.fn().mockResolvedValue('token-1');
      transportStore.actions.connect(getToken);
      await flush();

      // WS opens while QUIC's head start is still pending -- not yet used.
      FakeWebSocket.instances[0].onopen?.();
      expect(transportStore.state.activeTransport).toBeNull();
      expect(transportStore.state.status).not.toBe('connected');

      // QUIC's head start elapses without it ever resolving.
      await jest.advanceTimersByTimeAsync(QUIC_CONNECT_TIMEOUT_MS);
      expect(transportStore.state.activeTransport).toBe('ws');
      expect(transportStore.state.status).toBe('connected');
    });

    it('a late QUIC success after WS already won this attempt is discarded (no state change, connection closed)', async () => {
      const { resolve } = deferredQuicConnect();
      const getToken = jest.fn().mockResolvedValue('token-1');
      transportStore.actions.connect(getToken);
      await flush();

      FakeWebSocket.instances[0].onopen?.();
      await jest.advanceTimersByTimeAsync(QUIC_CONNECT_TIMEOUT_MS);
      expect(transportStore.state.activeTransport).toBe('ws');

      const lateQuicConn = fakeQuicConnection();
      resolve(lateQuicConn);
      await flush();

      expect(transportStore.state.activeTransport).toBe('ws');
      expect(transportStore.state.status).toBe('connected');
      expect(lateQuicConn.close).toHaveBeenCalledTimes(1);
    });

    it('QUIC fails outright and immediately: falls back to WS without waiting out the full timeout', async () => {
      mockConnectQuic.mockRejectedValue(new Error('quic connect failed'));
      const getToken = jest.fn().mockResolvedValue('token-1');
      const statuses = trackStatuses();
      transportStore.actions.connect(getToken);
      await flush();

      // WS opens well before `QUIC_CONNECT_TIMEOUT_MS` would elapse; no
      // timer advance beyond `flush()` (0ms) happens in this test at all.
      FakeWebSocket.instances[0].onopen?.();

      expect(transportStore.state.activeTransport).toBe('ws');
      expect(statuses.at(-1)).toBe('connected');
    });

    it('QUIC failing outright does not wait for WS: activeTransport stays unset until WS actually connects', async () => {
      mockConnectQuic.mockRejectedValue(new Error('quic connect failed'));
      const getToken = jest.fn().mockResolvedValue('token-1');
      transportStore.actions.connect(getToken);
      await flush();

      expect(transportStore.state.activeTransport).toBeNull();

      FakeWebSocket.instances[0].onopen?.();
      expect(transportStore.state.activeTransport).toBe('ws');
    });

    it('a live QUIC connection dropping after winning the race schedules a reconnect, same as a live WS drop today', async () => {
      const { resolve } = deferredQuicConnect();
      const getToken = jest.fn().mockResolvedValue('token-1');
      const statuses = trackStatuses();
      transportStore.actions.connect(getToken);
      await flush();

      const quicConn = fakeQuicConnection();
      resolve(quicConn);
      await flush();
      expect(transportStore.state.activeTransport).toBe('quic');
      const [, listeners] = mockConnectQuic.mock.calls[0];

      // The winning QUIC connection drops mid-session (not an auth failure).
      listeners.onClosed({ authFailed: false, reason: 'connection lost' });

      expect(transportStore.state.activeTransport).toBeNull();
      expect(statuses.at(-1)).toBe('reconnecting');

      // A fresh race starts for the reconnect attempt, same as a dropped WS
      // connection would trigger.
      await jest.advanceTimersByTimeAsync(1300);
      expect(mockConnectQuic.mock.calls.length).toBeGreaterThan(1);
    });

    it('a live QUIC connection dropping with an auth failure is terminal, mirroring WS\'s 4001 close', async () => {
      const { resolve } = deferredQuicConnect();
      const getToken = jest.fn().mockResolvedValue('token-1');
      const statuses = trackStatuses();
      transportStore.actions.connect(getToken);
      await flush();

      const quicConn = fakeQuicConnection();
      resolve(quicConn);
      await flush();
      const [, listeners] = mockConnectQuic.mock.calls[0];

      listeners.onClosed({ authFailed: true, reason: 'invalid token' });

      expect(transportStore.state.activeTransport).toBeNull();
      expect(statuses.at(-1)).toBe('disconnected');

      await jest.advanceTimersByTimeAsync(60000);
      expect(mockConnectQuic.mock.calls.length).toBe(1);
    });

    it('close() closes the live QUIC connection (not the discarded WS socket) when QUIC is activeTransport', async () => {
      const { resolve } = deferredQuicConnect();
      const getToken = jest.fn().mockResolvedValue('token-1');
      transportStore.actions.connect(getToken);
      await flush();

      const quicConn = fakeQuicConnection();
      resolve(quicConn);
      await flush();
      expect(transportStore.state.activeTransport).toBe('quic');
      // The losing WS attempt was already closed once, by the race itself.
      expect(FakeWebSocket.instances[0].close).toHaveBeenCalledTimes(1);

      transportStore.actions.close();

      expect(quicConn.close).toHaveBeenCalledTimes(1);
      // close() must not blindly re-close/touch the already-discarded WS
      // socket a second time.
      expect(FakeWebSocket.instances[0].close).toHaveBeenCalledTimes(1);
      expect(transportStore.state.status).toBe('disconnected');
      expect(transportStore.state.activeTransport).toBeNull();
    });
  });
});
