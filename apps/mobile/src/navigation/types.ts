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
  /**
   * Reached from `AddContactScreen`'s search results (issue #100) by
   * tapping a result row (as opposed to its separate "+" add button, which
   * sends a contact request directly and does not navigate). Renders
   * `UserProfileScreen` (issue #101), which derives its own
   * relationship-status view from `GET /api/contacts`/`GET
   * /api/contacts/requests` rather than needing anything beyond these two
   * fields as params.
   */
  UserProfile: { userId: string; email: string };
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
 * stack's `Main` route. Both started as issue #94's temporary placeholder
 * screens; `Conversations` was replaced with its real implementation in
 * issue #146, and `Friends` in issue #127.
 */
export type MainTabParamList = {
  Conversations: undefined;
  Friends: undefined;
};
