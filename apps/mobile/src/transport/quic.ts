/**
 * Thin wrapper around the generated `QuicConnection` TurboModule bindings
 * (`quic-relay-client`, produced from `packages/quic-relay-client` by
 * `uniffi-bindgen-react-native` -- issue #75) for the persistent QUIC
 * control-stream connection to the chat relay (`apps/api/src/quic.rs`).
 * Shaped to play the same role for QUIC that `../api/ws.ts`'s
 * `createChatSocket` plays for WS: a driver the transport store (issue #77,
 * not this one) can plug in, not itself a reconnect/backoff/racing layer.
 *
 * There is no separate `API_QUIC_URL`/`API_QUIC_HOST` env var: the host is
 * derived from the same `API_BASE_URL` used by the REST client and `ws.ts`
 * (`../api/client.ts`), by parsing its hostname, so "where the backend is"
 * stays a single source of truth. The port has no counterpart in `API_BASE_URL`
 * (QUIC needs a numeric host+port pair, not a URL), so it comes from
 * `EXPO_PUBLIC_QUIC_PORT`, defaulting to 4433 -- the same default the API
 * documents for `QUIC_LISTEN_ADDR` in its own `.env.example` -- so an
 * unconfigured dev setup on both sides still lines up.
 *
 * Wire contract (see apps/api/src/quic.rs and packages/quic-relay-client):
 *  - connect: opens the one control stream, writes
 *    `{"type":"auth","token":"<token>"}` as its first (newline-delimited)
 *    frame.
 *  - outgoing/incoming frames: same JSON shapes as `../api/ws.ts`'s
 *    `SendFrame`/`IncomingFrame` (`{"type":"send",...}`,
 *    `{"type":"message",...}`, `{"type":"ack"}`, `{"type":"error",...}`),
 *    one per newline-delimited line on the control stream.
 *  - the server closes with QUIC application error code `4001`
 *    (`CLOSE_CODE_UNAUTHORIZED`, mirroring WS's `CLOSE_UNAUTHORIZED`) for an
 *    invalid/rejected token -- see `QuicConnectError`/`QuicCloseInfo` below
 *    for how that's surfaced to callers.
 */
import {
  QuicClientError,
  QuicConnection,
  type QuicConnectionLike,
  type QuicConnectionListener,
} from 'quic-relay-client';

import { API_BASE_URL } from '../api/client';
import type { IncomingFrame, SendFrame } from '../api/ws';

export type { IncomingFrame, SendFrame } from '../api/ws';

/** Default QUIC port when `EXPO_PUBLIC_QUIC_PORT` is unset -- matches the
 * API's own default in `.env.example` (`QUIC_LISTEN_ADDR=0.0.0.0:4433`). */
const DEFAULT_QUIC_PORT = 4433;

/** The chat relay's QUIC application error code for an unauthorized/invalid
 * token (`CLOSE_CODE_UNAUTHORIZED` in `packages/quic-relay-client/src/lib.rs`
 * and `apps/api/src/quic.rs`), numerically the same value as WS's
 * `CLOSE_UNAUTHORIZED`. `QuicConnectionListener::on_closed`'s `reason` is a
 * human-readable string, not a machine code, but per that method's doc
 * comment it always includes the numeric code when the peer closed with
 * one -- so this is found via substring match, not structured parsing. */
const CLOSE_CODE_UNAUTHORIZED_PATTERN = /\b4001\b/;

/** Rejected by `connectQuic`/`connectQuicTo` when opening the connection
 * itself fails. `authFailed` distinguishes "the server rejected this
 * token" (issue #75's `QuicClientError::AuthFailed`, raised when the
 * server closes the connection with code 4001 within its own
 * `AUTH_RESULT_GRACE` window of the auth frame being sent) from any other
 * connection failure (DNS/socket/handshake/stream-IO problems, or an auth
 * rejection that arrives too late for `connect` itself to observe -- see
 * `QuicCloseInfo` below for that case). */
export class QuicConnectError extends Error {
  readonly authFailed: boolean;

  constructor(message: string, authFailed: boolean) {
    super(message);
    this.name = 'QuicConnectError';
    this.authFailed = authFailed;
  }
}

/** Passed to `QuicListeners.onClosed` when the control stream ends for any
 * reason, mid-session, after `connectQuic`/`connectQuicTo` already
 * resolved. `authFailed` is a best-effort classification (substring match
 * on `reason`, per `QuicConnectionListener::on_closed`'s doc comment) that
 * catches an auth rejection which arrived after `connectQuic`'s own grace
 * window already elapsed -- see `QuicConnectError` above for the
 * synchronous case. */
export interface QuicCloseInfo {
  authFailed: boolean;
  reason: string;
}

export interface QuicListeners {
  /** Called once per frame received on the control stream, already parsed
   * into the same `IncomingFrame` shape `../api/ws.ts` defines. A frame
   * whose text isn't valid JSON is dropped silently -- same behavior as
   * `../transport/store.ts`'s WS `onmessage` handler for a malformed WS
   * message. */
  onFrame: (frame: IncomingFrame) => void;
  /** Called exactly once, when the control stream ends for any reason --
   * see `QuicCloseInfo` above. No further `onFrame` calls follow. Not
   * called for a close the caller itself initiated via `close()`. */
  onClosed: (info: QuicCloseInfo) => void;
}

export interface QuicDriverConnection {
  /** Sends `frame` as a newline-delimited JSON frame on the control
   * stream. Rejects if the underlying write fails (e.g.
   * `QuicClientError::StreamIoFailed`). */
  send(frame: SendFrame): Promise<void>;
  /** Closes the connection. Harmless to call more than once. Does not
   * itself trigger `QuicListeners.onClosed` (see that field's doc
   * comment). */
  close(): void;
}

/** Derives the QUIC host from `API_BASE_URL`'s hostname and the port from
 * `EXPO_PUBLIC_QUIC_PORT` (see this module's doc comment) -- single source
 * of truth for "where the backend is," mirroring how `../api/ws.ts`'s
 * `buildWsUrl` derives from `API_BASE_URL` instead of a second env var. */
export function quicTarget(): { host: string; port: number } {
  const host = new URL(API_BASE_URL).hostname;
  const configuredPort = process.env.EXPO_PUBLIC_QUIC_PORT;
  const port = configuredPort ? Number(configuredPort) : DEFAULT_QUIC_PORT;
  return { host, port };
}

function isAuthFailedError(error: unknown): boolean {
  return (
    QuicClientError.instanceOf(error) && QuicClientError.AuthFailed.instanceOf(error)
  );
}

function messageFrom(error: unknown): string {
  if (QuicClientError.instanceOf(error)) {
    return (error as { inner: { message: string } }).inner.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function toListener(listeners: QuicListeners): QuicConnectionListener {
  return {
    onFrame(frameText: string) {
      let frame: IncomingFrame;
      try {
        frame = JSON.parse(frameText) as IncomingFrame;
      } catch {
        return;
      }
      listeners.onFrame(frame);
    },
    onClosed(reason: string) {
      listeners.onClosed({
        authFailed: CLOSE_CODE_UNAUTHORIZED_PATTERN.test(reason),
        reason,
      });
    },
  };
}

/** Opens a persistent QUIC connection to `host:port`, authenticated with
 * `token`, per issue #75's `QuicConnection::connect`. `listeners.onFrame`/
 * `onClosed` are called for the lifetime of the connection -- see
 * `QuicListeners`. Rejects with `QuicConnectError` if the connection
 * itself couldn't be opened (including a synchronously-observed auth
 * rejection). Exported mainly for tests and any caller that needs an
 * explicit host/port; `connectQuic` below is the single-source-of-truth
 * entry point most callers (e.g. the transport store, issue #77) should
 * use instead. */
export async function connectQuicTo(
  host: string,
  port: number,
  token: string,
  listeners: QuicListeners
): Promise<QuicDriverConnection> {
  let connection: QuicConnectionLike;
  try {
    connection = await QuicConnection.connect(host, port, token, toListener(listeners));
  } catch (error) {
    throw new QuicConnectError(messageFrom(error), isAuthFailedError(error));
  }

  return {
    async send(frame: SendFrame): Promise<void> {
      await connection.send(JSON.stringify(frame));
    },
    close(): void {
      connection.close();
    },
  };
}

/** Opens a persistent QUIC connection to the backend derived via
 * `quicTarget()`, authenticated with `token`. See `connectQuicTo` for the
 * full contract. */
export function connectQuic(
  token: string,
  listeners: QuicListeners
): Promise<QuicDriverConnection> {
  const { host, port } = quicTarget();
  return connectQuicTo(host, port, token, listeners);
}
