/**
 * Thin wrapper around the platform `WebSocket` for the chat relay
 * (`apps/api/src/ws.rs`). There is no separate `API_WS_URL` env var: the WS
 * URL is derived from the same `API_BASE_URL` used by the REST client
 * (`./client.ts`) by swapping the `http`/`https` scheme for `ws`/`wss` and
 * appending `/ws?token=...`, so "where the backend is" has exactly one
 * source of truth rather than two env vars that could drift apart.
 *
 * Wire contract (see apps/api/src/ws.rs):
 *  - connect: `GET /ws?token=<bearer token>`
 *  - outgoing: `{"type": "send", "to": "<uuid>", "body_b64": "<base64>"}`
 *  - incoming: `{"type": "message", "from": "<uuid>", "body_b64": "<base64>"}`
 *              `{"type": "ack"}`
 *              `{"type": "error", "code": "queue_unavailable" | "not_a_contact" | "invalid_payload", ...}`
 */
import { API_BASE_URL } from './client';

export interface SendFrame {
  type: 'send';
  to: string;
  body_b64: string;
}

export interface IncomingMessageFrame {
  type: 'message';
  from: string;
  body_b64: string;
}

export interface AckFrame {
  type: 'ack';
}

export interface ErrorFrame {
  type: 'error';
  code: string;
  [key: string]: unknown;
}

export type IncomingFrame = IncomingMessageFrame | AckFrame | ErrorFrame;

/** Builds the `/ws` URL for `token`, derived from `API_BASE_URL`. */
export function buildWsUrl(token: string): string {
  const wsBase = API_BASE_URL.replace(/^http/, 'ws');
  return `${wsBase}/ws?token=${encodeURIComponent(token)}`;
}

/** Opens a new WebSocket connection to the chat relay, authenticated with
 * `token` as required by the backend. Callers are responsible for wiring
 * up `onmessage`/`onclose`/`onerror` and for calling `close()` when done. */
export function createChatSocket(token: string): WebSocket {
  return new WebSocket(buildWsUrl(token));
}

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface ReconnectingChatSocketHandlers {
  onMessage: (frame: IncomingFrame) => void;
  onStatusChange: (status: ConnectionStatus) => void;
}

export interface ReconnectingChatSocket {
  /** Cancels any pending/future reconnect attempt and closes the current
   * socket if one is open. Safe to call more than once. */
  close: () => void;
  /** Forwards `data` to the currently-open underlying socket, if any. A
   * no-op while `'connecting'`/`'reconnecting'`/`'disconnected'` (callers
   * should gate sends on `onStatusChange` reporting `'connected'`). */
  send: (data: string) => void;
}

/** The chat relay's close code for an unauthorized/invalid token (see
 * `CLOSE_UNAUTHORIZED` in `apps/api/src/ws.rs`). A stale/invalid token is a
 * terminal state requiring re-authentication, not a transient network
 * blip, so it must not trigger a reconnect. */
const CLOSE_UNAUTHORIZED = 4001;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
/** +/-20% jitter so multiple clients reconnecting after the same outage
 * don't all retry in lockstep. */
const JITTER_RATIO = 0.2;

function withJitter(delayMs: number): number {
  const jitter = delayMs * JITTER_RATIO;
  return delayMs + (Math.random() * 2 - 1) * jitter;
}

/**
 * Wraps `createChatSocket` with automatic reconnection so a dropped `/ws`
 * connection resumes on its own instead of requiring the caller to
 * leave/re-enter the screen (issue #55, superseding issue #10's "no
 * reconnect logic" scope note).
 *
 * Behavior:
 *  - Opens an initial connection via `createChatSocket(await getToken())`,
 *    reporting `'connecting'` first.
 *  - Any close/error other than the server's `CLOSE_UNAUTHORIZED` (4001)
 *    close code schedules a reconnect with exponential backoff: 1s, 2s,
 *    4s, ... capped at 30s, +/-20% jitter. `'reconnecting'` is reported
 *    while a retry is scheduled/in flight; a successful reconnect reports
 *    `'connected'` and resets the backoff back to 1s.
 *  - A 4001 close (or `getToken()` resolving to `null`, meaning there's no
 *    session to reconnect with) is terminal: reports `'disconnected'` and
 *    stops retrying.
 *  - `getToken()` is called fresh on every (re)connect attempt so a token
 *    refreshed while disconnected is picked up rather than reusing a
 *    stale one.
 */
export function createReconnectingChatSocket(
  getToken: () => Promise<string | null>,
  handlers: ReconnectingChatSocketHandlers
): ReconnectingChatSocket {
  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;

  function scheduleReconnect() {
    if (closed) {
      return;
    }
    handlers.onStatusChange('reconnecting');
    const delay = withJitter(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  async function connect() {
    if (closed) {
      return;
    }
    const token = await getToken();
    if (closed) {
      return;
    }
    if (!token) {
      handlers.onStatusChange('disconnected');
      return;
    }

    const ws = createChatSocket(token);
    socket = ws;

    ws.onmessage = (event: { data: unknown }) => {
      let frame: IncomingFrame;
      try {
        frame = JSON.parse(String(event.data)) as IncomingFrame;
      } catch {
        return;
      }
      handlers.onMessage(frame);
    };

    ws.onopen = () => {
      if (closed) {
        return;
      }
      backoffMs = INITIAL_BACKOFF_MS;
      handlers.onStatusChange('connected');
    };

    ws.onclose = (event: { code: number }) => {
      if (socket === ws) {
        socket = null;
      }
      if (closed) {
        return;
      }
      if (event?.code === CLOSE_UNAUTHORIZED) {
        handlers.onStatusChange('disconnected');
        return;
      }
      scheduleReconnect();
    };

    // Real WebSocket implementations (browser and React Native) always
    // follow a failed connection's `error` event with a `close` event, so
    // reconnect scheduling lives entirely in `onclose` above; this just
    // avoids relying on unhandled-error-event warnings.
    ws.onerror = () => {};
  }

  handlers.onStatusChange('connecting');
  void connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
    },
    send(data: string) {
      socket?.send(data);
    },
  };
}
