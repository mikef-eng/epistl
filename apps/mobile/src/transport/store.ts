/**
 * Owns the chat relay's connection lifecycle as a single TanStack Store
 * (`docs/decisions/0009-tanstack-store-and-query-for-network-layer.md`).
 * This absorbs what `createReconnectingChatSocket`
 * (`apps/mobile/src/api/ws.ts`, now removed) used to do as a standalone
 * factory: exponential backoff with jitter, the `CLOSE_UNAUTHORIZED` (4001)
 * terminal-close rule, and fetching a fresh token on every (re)connect
 * attempt. `ws.ts` narrows to just the transport driver (`buildWsUrl`,
 * `createChatSocket`, and the wire frame types) that `connect`/`send` below
 * call into.
 *
 * This lands WS-only, per issue #74: `activeTransport` only ever becomes
 * `'ws'` or `null` here. A future `quic.ts` driver plugs into this same
 * store, and `connect` becomes the place that races QUIC vs WS (later
 * issues in this batch, e.g. #75/#76/#77) — not implemented here.
 *
 * Screens never hold a socket handle/ref or register `onMessage`/
 * `onStatusChange` callbacks: they call `transportStore.actions.send(frame)`
 * / `.connect(getToken)` / `.close()` and subscribe to
 * `status`/`activeTransport`/`lastFrame` via `useStore(transportStore, ...)`.
 */
import { Store } from '@tanstack/react-store';

import { createChatSocket, type IncomingFrame, type SendFrame } from '../api/ws';

export type { IncomingFrame, SendFrame };

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface TransportState {
  status: ConnectionStatus;
  activeTransport: 'ws' | 'quic' | null;
  lastFrame: IncomingFrame | null;
}

export interface TransportActions extends Record<string, (...args: never[]) => unknown> {
  /** Opens a connection via `createChatSocket(await getToken())`, reporting
   * `'connecting'` first. Any close/error other than the server's
   * `CLOSE_UNAUTHORIZED` (4001) close code schedules a reconnect with
   * exponential backoff: 1s, 2s, 4s, ... capped at 30s, +/-20% jitter,
   * reporting `'reconnecting'` while a retry is scheduled/in flight. A
   * successful (re)connect reports `'connected'`, sets `activeTransport:
   * 'ws'`, and resets the backoff back to 1s. A 4001 close (or `getToken()`
   * resolving to `null`, meaning there's no session to reconnect with) is
   * terminal: reports `'disconnected'` and stops retrying. Any disconnect
   * sets `activeTransport: null`. `getToken()` is called fresh on every
   * (re)connect attempt so a token refreshed while disconnected is picked
   * up rather than reusing a stale one. Calling `connect` again (e.g. a
   * screen remounting) supersedes any previous in-flight/scheduled attempt. */
  connect: (getToken: () => Promise<string | null>) => void;
  /** Forwards `frame` to the currently-open underlying socket, if any. A
   * no-op while `status` isn't `'connected'` (callers should gate sends on
   * that themselves, as `ChatScreen` does today). */
  send: (frame: SendFrame) => void;
  /** Cancels any pending/future reconnect attempt and closes the current
   * socket if one is open. Safe to call more than once. */
  close: () => void;
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

// Module-scoped connection bookkeeping. This doesn't live in the store's
// reactive `state` (only `status`/`activeTransport`/`lastFrame` do) because
// none of it needs to trigger a re-render by itself -- it's read/written
// only from inside the actions below, mirroring what a closure inside
// `createReconnectingChatSocket` used to hold per-instance. `store.ts`
// exports a single app-wide store, so these are effectively that store's
// private instance fields.
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = INITIAL_BACKOFF_MS;
let closed = true;
/** Bumped on every `connect()`/`close()` call so a superseded connect
 * attempt's in-flight `getToken()` call, scheduled reconnect, or socket
 * event handlers can recognize they're stale and no-op instead of
 * resurrecting a dead connection or clobbering a newer one's state. */
let generation = 0;

export const transportStore = new Store<TransportState, TransportActions>(
  {
    status: 'disconnected',
    activeTransport: null,
    lastFrame: null,
  },
  ({ setState }) => {
    function scheduleReconnect(getToken: () => Promise<string | null>, myGeneration: number) {
      if (closed || myGeneration !== generation) {
        return;
      }
      setState((s) => ({ ...s, status: 'reconnecting' }));
      const delay = withJitter(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void doConnect(getToken, myGeneration);
      }, delay);
    }

    async function doConnect(getToken: () => Promise<string | null>, myGeneration: number) {
      if (closed || myGeneration !== generation) {
        return;
      }
      const token = await getToken();
      if (closed || myGeneration !== generation) {
        return;
      }
      if (!token) {
        setState((s) => ({ ...s, status: 'disconnected', activeTransport: null }));
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
        setState((s) => ({ ...s, lastFrame: frame }));
      };

      ws.onopen = () => {
        if (closed || myGeneration !== generation) {
          return;
        }
        backoffMs = INITIAL_BACKOFF_MS;
        setState((s) => ({ ...s, status: 'connected', activeTransport: 'ws' }));
      };

      ws.onclose = (event: { code: number }) => {
        if (socket === ws) {
          socket = null;
        }
        if (closed || myGeneration !== generation) {
          return;
        }
        if (event?.code === CLOSE_UNAUTHORIZED) {
          setState((s) => ({ ...s, status: 'disconnected', activeTransport: null }));
          return;
        }
        setState((s) => ({ ...s, activeTransport: null }));
        scheduleReconnect(getToken, myGeneration);
      };

      // Real WebSocket implementations (browser and React Native) always
      // follow a failed connection's `error` event with a `close` event, so
      // reconnect scheduling lives entirely in `onclose` above; this just
      // avoids relying on unhandled-error-event warnings.
      ws.onerror = () => {};
    }

    return {
      connect(getToken: () => Promise<string | null>) {
        closed = false;
        generation += 1;
        const myGeneration = generation;
        backoffMs = INITIAL_BACKOFF_MS;
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        setState((s) => ({ ...s, status: 'connecting', activeTransport: null }));
        void doConnect(getToken, myGeneration);
      },
      send(frame: SendFrame) {
        socket?.send(JSON.stringify(frame));
      },
      close() {
        closed = true;
        generation += 1;
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        socket?.close();
        socket = null;
        setState((s) => ({ ...s, status: 'disconnected', activeTransport: null }));
      },
    };
  }
);
