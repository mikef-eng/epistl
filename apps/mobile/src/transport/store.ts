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
 * Per issue #114, QUIC is the default, always-attempted-first transport:
 * `connect` attempts a QUIC connection (`../transport/quic.ts`'s
 * `connectQuic`, issue #76's driver) alone first on every (re)connect
 * attempt, and only starts dialing WS once that QUIC attempt has failed
 * outright or exceeded a bounded timeout (`QUIC_CONNECT_TIMEOUT_MS` below)
 * -- never concurrently with a QUIC attempt that hasn't yet failed or timed
 * out. See that constant's doc comment for the exact fallback/tie-break
 * rules. This corrects issue #77's original design, which raced QUIC and WS
 * concurrently with only a bounded head start for QUIC. `ws.ts`'s own
 * reconnect/backoff/terminal-close semantics (this file's original WS-only
 * behavior, issue #74) are preserved unchanged for the WS fallback.
 *
 * Screens never hold a socket handle/ref or register `onMessage`/
 * `onStatusChange` callbacks: they call `transportStore.actions.send(frame)`
 * / `.connect(getToken)` / `.close()` and subscribe to
 * `status`/`activeTransport`/`lastFrame` via `useStore(transportStore, ...)`.
 */
import { Store } from '@tanstack/react-store';

import { createChatSocket, type IncomingFrame, type SendFrame } from '../api/ws';
import { connectQuic, type QuicDriverConnection, type QuicListeners } from './quic';

export type { IncomingFrame, SendFrame };

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface TransportState {
  status: ConnectionStatus;
  activeTransport: 'ws' | 'quic' | null;
  lastFrame: IncomingFrame | null;
}

export interface TransportActions extends Record<string, (...args: never[]) => unknown> {
  /** Opens a connection by attempting QUIC (`./quic.ts`'s `connectQuic`)
   * alone first, only starting a WS attempt (`createChatSocket(await
   * getToken())`) once QUIC has failed outright or exceeded
   * `QUIC_CONNECT_TIMEOUT_MS` -- see that constant's doc comment for the
   * exact fallback/tie-break rules -- reporting `'connecting'` first. Any
   * WS close/error other than the server's `CLOSE_UNAUTHORIZED` (4001)
   * close code (mirrored on the QUIC side by `QuicCloseInfo.authFailed`)
   * schedules a reconnect attempt (which itself tries QUIC first again)
   * with exponential backoff: 1s, 2s, 4s, ... capped at 30s, +/-20% jitter,
   * reporting `'reconnecting'` while a retry is scheduled/in flight. A
   * successful (re)connect reports `'connected'` and sets `activeTransport`
   * to whichever transport actually connected, and resets the backoff back
   * to 1s. A 4001 close (or `getToken()` resolving to `null`, meaning
   * there's no session to reconnect with) is terminal: reports
   * `'disconnected'` and stops retrying. Any disconnect sets
   * `activeTransport: null`. `getToken()` is called fresh on every
   * (re)connect attempt so a token refreshed while disconnected is picked
   * up rather than reusing a stale one. Calling `connect` again (e.g. a
   * screen remounting) supersedes any previous in-flight/scheduled attempt. */
  connect: (getToken: () => Promise<string | null>) => void;
  /** Forwards `frame` to whichever driver (`./quic.ts` or `../api/ws.ts`) is
   * currently `activeTransport`. A no-op while `status` isn't `'connected'`
   * (callers should gate sends on that themselves, as `ChatScreen` does
   * today). */
  send: (frame: SendFrame) => void;
  /** Cancels any pending/future reconnect attempt and closes the current
   * connection (whichever transport is active, plus any still in-flight
   * QUIC/WS attempt) if one is open/in flight. Safe to call more than
   * once. */
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

/** How long QUIC (`./quic.ts`'s `connectQuic`) is tried alone before this
 * attempt falls back to WS (issue #114's strict-sequential model -- QUIC is
 * the default, always-attempted-first transport, not raced against WS with
 * a head start as issue #77 originally had it):
 *  - QUIC connects before this elapses -> `activeTransport: 'quic'`; WS is
 *    never dialed at all for this attempt.
 *  - QUIC hasn't connected by the time this elapses (or fails outright
 *    before then -- in which case the client does not wait out the rest of
 *    this timeout) -> WS is dialed for the first time: `activeTransport:
 *    'ws'` once it connects.
 *  - The original (never-aborted) QUIC attempt can still resolve after WS
 *    has been dialed. If WS has *already connected* (this attempt is
 *    settled) by the time that late QUIC success arrives, it is closed
 *    immediately and discarded -- it never displaces an already-connected
 *    WS session mid-attempt. If WS is still in the process of connecting
 *    (dialed, but not yet open) when QUIC succeeds, QUIC still wins (WS's
 *    in-flight attempt is discarded instead) -- nothing has been decided
 *    yet for this attempt.
 * 2000ms is a starting value (a real device's QUIC handshake, including TLS
 * 1.3, is expected to resolve well within this on a healthy network) --
 * tune based on real-world data once this ships, not a value with any
 * other significance. Exported (only) so tests can reference it directly
 * instead of hardcoding a duplicate magic number. */
export const QUIC_CONNECT_TIMEOUT_MS = 2000;

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
/** The QUIC driver connection currently backing `activeTransport: 'quic'`,
 * if any -- mirrors `socket` above for the WS side. Only ever set once a
 * given attempt has actually connected over QUIC (see `attemptConnect`
 * below); a QUIC connection that loses out to WS is closed and discarded
 * without ever being assigned here. */
let quicConnection: QuicDriverConnection | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = INITIAL_BACKOFF_MS;
let closed = true;
/** Bumped on every `connect()`/`close()` call so a superseded connect
 * attempt's in-flight `getToken()` call, scheduled reconnect, fallback
 * timer, or socket/QUIC event handlers can recognize they're stale and
 * no-op instead of resurrecting a dead connection or clobbering a newer
 * one's state. */
let generation = 0;
/** Bumped every time a new attempt actually starts -- i.e. once per
 * `attemptConnect` call, which happens on the initial `connect()` and on
 * every subsequent reconnect attempt within the same `generation`.
 * `generation` alone can't distinguish "this reconnect attempt" from "the
 * next one" since both share it; this closes that gap so a late event from
 * an earlier attempt within the same session (e.g. a QUIC success arriving
 * after that attempt already fell back to WS and a fresh reconnect attempt
 * has since started) is recognized as stale too. */
let attemptId = 0;

export const transportStore = new Store<TransportState, TransportActions>(
  {
    status: 'disconnected',
    activeTransport: null,
    lastFrame: null,
  },
  ({ setState, get }) => {
    function scheduleReconnect(getToken: () => Promise<string | null>, myGeneration: number) {
      if (closed || myGeneration !== generation) {
        return;
      }
      setState((s) => ({ ...s, status: 'reconnecting' }));
      const delay = withJitter(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void attemptConnect(getToken, myGeneration);
      }, delay);
    }

    /** Runs one QUIC-first, WS-fallback sequence for a single (re)connect
     * attempt. See `QUIC_CONNECT_TIMEOUT_MS`'s doc comment for the exact
     * fallback/tie-break rules this implements. */
    async function attemptConnect(
      getToken: () => Promise<string | null>,
      myGeneration: number
    ) {
      if (closed || myGeneration !== generation) {
        return;
      }
      const fetchedToken = await getToken();
      if (closed || myGeneration !== generation) {
        return;
      }
      if (!fetchedToken) {
        setState((s) => ({ ...s, status: 'disconnected', activeTransport: null }));
        return;
      }
      // Re-bound to a variable TypeScript's control-flow narrowing tracks
      // as `string` (not `string | null`) inside the nested closures below
      // (`startWs`, the `connectQuic(...).then(...)` handlers) -- narrowing
      // on `fetchedToken` itself doesn't carry into those, since they could
      // in principle run after further reassignment.
      const token: string = fetchedToken;

      attemptId += 1;
      const myAttempt = attemptId;
      const stale = () => closed || myGeneration !== generation || myAttempt !== attemptId;

      // This attempt's state. All of it is local to this attempt (as
      // opposed to the module-scoped `socket`/`quicConnection` above, which
      // track whichever connection -- if any -- actually ended up active).
      let settled = false;
      let ws: WebSocket | null = null;
      let wsDiscarded = false;
      let quicTimer: ReturnType<typeof setTimeout> | null = null;
      // Set once `connectQuic`'s promise resolves, so the QUIC listeners
      // below (created before that promise resolves) can recognize
      // mid-session events for *this* connection specifically.
      let thisQuicConn: QuicDriverConnection | null = null;

      function clearQuicTimer() {
        if (quicTimer !== null) {
          clearTimeout(quicTimer);
          quicTimer = null;
        }
      }

      function finishWithQuic(conn: QuicDriverConnection) {
        settled = true;
        clearQuicTimer();
        quicConnection = conn;
        if (ws !== null && !wsDiscarded) {
          wsDiscarded = true;
          ws.close();
        }
        if (ws !== null && socket === ws) {
          socket = null;
        }
        backoffMs = INITIAL_BACKOFF_MS;
        setState((s) => ({ ...s, status: 'connected', activeTransport: 'quic' }));
      }

      function finishWithWs() {
        settled = true;
        backoffMs = INITIAL_BACKOFF_MS;
        setState((s) => ({ ...s, status: 'connected', activeTransport: 'ws' }));
      }

      /** Neither transport connected for this attempt -- schedule a
       * reconnect, same as a lone failed WS attempt did before issue
       * #77. */
      function giveUp() {
        settled = true;
        setState((s) => ({ ...s, activeTransport: null }));
        scheduleReconnect(getToken, myGeneration);
      }

      /** Starts the WS fallback attempt. Called only once QUIC has failed
       * outright or exceeded `QUIC_CONNECT_TIMEOUT_MS` for this attempt --
       * never while a QUIC attempt that hasn't yet failed/timed out is
       * still outstanding (issue #114's strict-sequential model). */
      function startWs() {
        if (stale() || settled) {
          return;
        }
        const socketInstance = createChatSocket(token);
        ws = socketInstance;
        socket = socketInstance;

        socketInstance.onmessage = (event: { data: unknown }) => {
          if (stale() || wsDiscarded) {
            return;
          }
          let frame: IncomingFrame;
          try {
            frame = JSON.parse(String(event.data)) as IncomingFrame;
          } catch {
            return;
          }
          setState((s) => ({ ...s, lastFrame: frame }));
        };

        socketInstance.onopen = () => {
          if (stale()) {
            socketInstance.close();
            return;
          }
          if (settled) {
            // QUIC won late (it resolved successfully after this WS
            // attempt was dialed, but before WS itself connected) -- this
            // WS connection was never meant to be used.
            wsDiscarded = true;
            socketInstance.close();
            return;
          }
          finishWithWs();
        };

        socketInstance.onclose = (event: { code: number }) => {
          if (socket === socketInstance) {
            socket = null;
          }
          if (stale() || wsDiscarded) {
            return;
          }
          if (settled) {
            // WS was this attempt's winner and is now dropping mid-session
            // -- issue #74's existing reconnect/backoff/terminal-close
            // behavior, unchanged by the QUIC-first fallback.
            if (event?.code === CLOSE_UNAUTHORIZED) {
              setState((s) => ({ ...s, status: 'disconnected', activeTransport: null }));
              return;
            }
            setState((s) => ({ ...s, activeTransport: null }));
            scheduleReconnect(getToken, myGeneration);
            return;
          }
          // WS failed before ever connecting. QUIC has already
          // failed/timed out by the time WS was dialed, so there's nothing
          // left to fall back to for this attempt.
          if (event?.code === CLOSE_UNAUTHORIZED) {
            settled = true;
            setState((s) => ({ ...s, status: 'disconnected', activeTransport: null }));
            return;
          }
          giveUp();
        };

        // Real WebSocket implementations (browser and React Native) always
        // follow a failed connection's `error` event with a `close` event,
        // so reconnect scheduling lives entirely in `onclose` above; this
        // just avoids relying on unhandled-error-event warnings.
        socketInstance.onerror = () => {};
      }

      const quicListeners: QuicListeners = {
        onFrame(frame) {
          if (closed || myGeneration !== generation || quicConnection !== thisQuicConn) {
            return;
          }
          setState((s) => ({ ...s, lastFrame: frame }));
        },
        onClosed(info) {
          if (closed || myGeneration !== generation || quicConnection !== thisQuicConn) {
            return;
          }
          quicConnection = null;
          if (info.authFailed) {
            setState((s) => ({ ...s, status: 'disconnected', activeTransport: null }));
            return;
          }
          setState((s) => ({ ...s, activeTransport: null }));
          scheduleReconnect(getToken, myGeneration);
        },
      };

      quicTimer = setTimeout(() => {
        quicTimer = null;
        if (stale() || settled) {
          return;
        }
        // QUIC hasn't succeeded (or failed) within its bounded timeout --
        // fall back to WS now. The original QUIC attempt is not aborted; a
        // late success is handled in the `connectQuic(...).then(...)`
        // success handler below.
        startWs();
      }, QUIC_CONNECT_TIMEOUT_MS);

      connectQuic(token, quicListeners).then(
        (conn) => {
          thisQuicConn = conn;
          clearQuicTimer();
          if (stale() || settled) {
            // Either this attempt is dead, or WS has already connected by
            // the time QUIC finally succeeded -- a late QUIC success is
            // discarded, never displacing an already-connected WS session.
            conn.close();
            return;
          }
          finishWithQuic(conn);
        },
        () => {
          if (stale()) {
            return;
          }
          clearQuicTimer();
          if (settled) {
            return;
          }
          // QUIC failed outright -- fall back to WS immediately, without
          // waiting out the rest of QUIC_CONNECT_TIMEOUT_MS.
          startWs();
        }
      );
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
        void attemptConnect(getToken, myGeneration);
      },
      send(frame: SendFrame) {
        if (get().activeTransport === 'quic' && quicConnection) {
          void quicConnection.send(frame).catch(() => {});
          return;
        }
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
        quicConnection?.close();
        quicConnection = null;
        setState((s) => ({ ...s, status: 'disconnected', activeTransport: null }));
      },
    };
  }
);
