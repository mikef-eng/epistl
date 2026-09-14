/**
 * Shared param list for the app's root native stack navigator. Screens
 * added by later issues (AddContact, Chat) should extend their entries here
 * as they gain real params instead of introducing a second source of truth.
 */
export type RootStackParamList = {
  Login: undefined;
  /**
   * The post-login landing route: a nested `Tab.Navigator` (see
   * `MainTabParamList` below), rendered by `src/navigation/MainTabs.tsx`.
   * `Chat`/`AddContact`/`Settings` stay on this root stack (not nested
   * inside the tab navigator) so they're reachable as a normal stack push
   * from either tab (issue #94).
   */
  Main: undefined;
  AddContact: undefined;
  Chat: { userId: string; email: string };
  /** Reached via a gear icon in both `MainTabs` tabs' headers (issue #125,
   * moved from the retired `ContactsScreen` to both tabs in issue #94). */
  Settings: undefined;
  /**
   * Dev-only (issue #67 spike, `__DEV__`-gated in App.tsx/LoginScreen.tsx):
   * proves `packages/quic-relay-client`'s generated TurboModule is callable
   * from RN. Never part of the real, authenticated app flow.
   */
  QuicSpike: undefined;
};

/**
 * Param list for the post-login bottom tab navigator nested under the root
 * stack's `Main` route. `Conversations`/`Friends` are temporary placeholder
 * screens as of issue #94 -- real implementations land in follow-up issues
 * and fully replace, rather than extend, these placeholders.
 */
export type MainTabParamList = {
  Conversations: undefined;
  Friends: undefined;
};
