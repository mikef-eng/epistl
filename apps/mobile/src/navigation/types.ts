/**
 * Shared param list for the app's single native stack navigator. Screens
 * added by later issues (Contacts, AddContact, Chat) should extend their
 * entries here as they gain real params instead of introducing a second
 * source of truth.
 */
export type RootStackParamList = {
  Login: undefined;
  Contacts: undefined;
  AddContact: undefined;
  Chat: { userId: string; email: string };
  /**
   * Dev-only (issue #67 spike, `__DEV__`-gated in App.tsx/LoginScreen.tsx):
   * proves `packages/quic-relay-client`'s generated TurboModule is callable
   * from RN. Never part of the real, authenticated app flow.
   */
  QuicSpike: undefined;
};
