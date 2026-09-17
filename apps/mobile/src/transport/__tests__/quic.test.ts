import { connectQuic, connectQuicTo, quicTarget } from '../quic';

/** Fake matching the subset of the generated `quic-relay-client` TurboModule
 * bindings `../quic.ts` relies on (`QuicConnection.connect` and the
 * `QuicClientError` tag-checking predicates) -- not a real device
 * connection, per issue #76's acceptance criteria. Declared with a
 * `mock`-prefixed name so Jest's module-mock hoisting (which moves
 * `jest.mock` calls above all imports) allows referencing it here. */
const mockConnect = jest.fn();

/** `virtual: true` tells Jest not to resolve `quic-relay-client` on disk
 * before applying this mock. Without it, this is the only test file that
 * ever resolves the literal specifier `'quic-relay-client'` (a `file:`
 * dependency backed by a real symlink into `modules/quic-relay-client`),
 * and doing that resolution live from several parallel Jest workers at
 * once occasionally throws inside `jest-resolve`'s filesystem walk. Jest
 * silently swallows that exception and reports a generic
 * `Cannot find module 'quic-relay-client'` instead -- flaky only under
 * the full suite's default parallel workers, never in isolation or with
 * `--runInBand`. See issue #133 for the full investigation. */
jest.mock(
  'quic-relay-client',
  () => ({
    QuicConnection: {
      connect: (...args: unknown[]) => mockConnect(...args),
    },
    QuicClientError: {
      instanceOf: (obj: unknown): boolean =>
        typeof obj === 'object' && obj !== null && '__isQuicClientError' in obj,
      AuthFailed: {
        instanceOf: (obj: unknown): boolean =>
          typeof obj === 'object' &&
          obj !== null &&
          (obj as { tag?: string }).tag === 'AuthFailed',
      },
    },
  }),
  { virtual: true }
);

interface CapturedListener {
  onFrame: (frame: string) => void;
  onClosed: (reason: string) => void;
}

function fakeAuthFailedError(message: string) {
  return { __isQuicClientError: true, tag: 'AuthFailed', inner: { message } };
}

describe('quic.ts', () => {
  beforeEach(() => {
    mockConnect.mockReset();
  });

  it('connects, delivers a parsed frame, and forwards send()', async () => {
    const closeMock = jest.fn();
    const sendMock = jest.fn().mockResolvedValue(undefined);
    let captured: CapturedListener | undefined;
    mockConnect.mockImplementation(async (_host, _port, _token, listener: CapturedListener) => {
      captured = listener;
      return { close: closeMock, send: sendMock };
    });

    const onFrame = jest.fn();
    const onClosed = jest.fn();
    const connection = await connectQuicTo('relay.example.com', 4433, 'token-1', {
      onFrame,
      onClosed,
    });

    expect(mockConnect).toHaveBeenCalledWith(
      'relay.example.com',
      4433,
      'token-1',
      expect.any(Object)
    );

    captured?.onFrame('{"type":"ack"}');
    expect(onFrame).toHaveBeenCalledWith({ type: 'ack' });

    await connection.send({ type: 'send', to: 'contact-1', body_b64: 'Ym9keQ==' });
    expect(sendMock).toHaveBeenCalledWith(
      JSON.stringify({ type: 'send', to: 'contact-1', body_b64: 'Ym9keQ==' })
    );

    connection.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('drops a frame that is not valid JSON instead of forwarding it', async () => {
    let captured: CapturedListener | undefined;
    mockConnect.mockImplementation(async (_host, _port, _token, listener: CapturedListener) => {
      captured = listener;
      return { close: jest.fn(), send: jest.fn() };
    });

    const onFrame = jest.fn();
    await connectQuicTo('relay.example.com', 4433, 'token-1', { onFrame, onClosed: jest.fn() });

    captured?.onFrame('not json');
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('rejects with an auth failure that connect() itself observed, distinguishably', async () => {
    mockConnect.mockRejectedValue(fakeAuthFailedError('token rejected'));

    await expect(
      connectQuicTo('relay.example.com', 4433, 'bad-token', {
        onFrame: jest.fn(),
        onClosed: jest.fn(),
      })
    ).rejects.toMatchObject({
      name: 'QuicConnectError',
      authFailed: true,
      message: 'token rejected',
    });
  });

  it('rejects a transient connect failure with authFailed: false', async () => {
    mockConnect.mockRejectedValue(new Error('network unreachable'));

    await expect(
      connectQuicTo('relay.example.com', 4433, 'token-1', {
        onFrame: jest.fn(),
        onClosed: jest.fn(),
      })
    ).rejects.toMatchObject({
      name: 'QuicConnectError',
      authFailed: false,
      message: 'network unreachable',
    });
  });

  it('surfaces a mid-session close to the caller, classifying a late auth rejection', async () => {
    let captured: CapturedListener | undefined;
    mockConnect.mockImplementation(async (_host, _port, _token, listener: CapturedListener) => {
      captured = listener;
      return { close: jest.fn(), send: jest.fn() };
    });

    const onClosed = jest.fn();
    await connectQuicTo('relay.example.com', 4433, 'token-1', { onFrame: jest.fn(), onClosed });

    captured?.onClosed('closed by peer with application error code 4001 (invalid token)');

    expect(onClosed).toHaveBeenCalledWith({
      authFailed: true,
      reason: 'closed by peer with application error code 4001 (invalid token)',
    });
  });

  it('surfaces a mid-session close for a non-auth reason as authFailed: false', async () => {
    let captured: CapturedListener | undefined;
    mockConnect.mockImplementation(async (_host, _port, _token, listener: CapturedListener) => {
      captured = listener;
      return { close: jest.fn(), send: jest.fn() };
    });

    const onClosed = jest.fn();
    await connectQuicTo('relay.example.com', 4433, 'token-1', { onFrame: jest.fn(), onClosed });

    captured?.onClosed('timed out waiting for network activity');

    expect(onClosed).toHaveBeenCalledWith({
      authFailed: false,
      reason: 'timed out waiting for network activity',
    });
  });

  describe('quicTarget / connectQuic', () => {
    const originalPort = process.env.EXPO_PUBLIC_QUIC_PORT;

    afterEach(() => {
      process.env.EXPO_PUBLIC_QUIC_PORT = originalPort;
    });

    it('derives the host from API_BASE_URL and defaults the port to 4433', () => {
      delete process.env.EXPO_PUBLIC_QUIC_PORT;
      expect(quicTarget()).toEqual({ host: 'localhost', port: 4433 });
    });

    it('reads the port from EXPO_PUBLIC_QUIC_PORT when set', () => {
      process.env.EXPO_PUBLIC_QUIC_PORT = '9999';
      expect(quicTarget()).toEqual({ host: 'localhost', port: 9999 });
    });

    it('connectQuic() dials the target derived from quicTarget()', async () => {
      mockConnect.mockResolvedValue({ close: jest.fn(), send: jest.fn() });
      delete process.env.EXPO_PUBLIC_QUIC_PORT;

      await connectQuic('token-1', { onFrame: jest.fn(), onClosed: jest.fn() });

      expect(mockConnect).toHaveBeenCalledWith('localhost', 4433, 'token-1', expect.any(Object));
    });
  });
});
