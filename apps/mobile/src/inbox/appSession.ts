/**
 * Wires the transport connection (`../transport/store.ts`'s
 * `transportStore`) and the shared inbox listener (`./listener.ts`) to the
 * authenticated app's lifetime, replacing `ChatScreen.tsx`'s former
 * per-mount `connect`/`close` (issue #165).
 *
 * `../navigation/MainTabs.tsx` -- the post-login landing route (`Main` on
 * the root stack) -- calls `startAppSession()` once on mount and
 * `stopAppSession()` on unmount. `Chat`/`AddContact`/`UserProfile`/`Settings`
 * stay on the same root stack as siblings pushed on top of `Main`, so
 * `MainTabs` (and this session) stays mounted underneath them; it is only
 * ever unmounted by `navigation.reset` back to `Login` (`SettingsScreen`'s
 * log-out and delete-account flows), which is exactly "torn down on
 * logout". This naturally satisfies "connect once a session exists, stay
 * open across navigation between screens, close on logout" without this
 * module (or `MainTabs`) needing to watch navigation state itself.
 */
import { getToken } from '../api/session';
import { transportStore } from '../transport/store';
import { startInboxListener, stopInboxListener } from './listener';

/** Opens the transport connection and starts the shared inbox listener.
 * `transportStore.actions.connect` itself is a no-op-to-`'disconnected'` if
 * `getToken()` resolves to `null` (no session), so this is safe to call
 * unconditionally from `MainTabs`. */
export function startAppSession(): void {
  transportStore.actions.connect(getToken);
  startInboxListener();
}

/** Closes the transport connection and stops the shared inbox listener. */
export function stopAppSession(): void {
  transportStore.actions.close();
  stopInboxListener();
}
