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
 * up `onmessage`/`onclose`/`onerror` and for calling `close()` when done.
 *
 * This is the low-level transport driver: reconnect/backoff logic, the
 * `CLOSE_UNAUTHORIZED` terminal-close rule, and connection-status tracking
 * live in `../transport/store.ts`'s `connect`/`send`/`close` actions
 * (`docs/decisions/0009-tanstack-store-and-query-for-network-layer.md`), not
 * here. */
export function createChatSocket(token: string): WebSocket {
  return new WebSocket(buildWsUrl(token));
}
