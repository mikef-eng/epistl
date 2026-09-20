import 'react-native-get-random-values';

import { act, fireEvent, render, screen, userEvent, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { concatBytes } from '@noble/hashes/utils.js';

import { getToken } from '../src/api/session';
import { ensureLocalIdentity, PREKEY_SIGNATURE_CONTEXT } from '../src/crypto/identity';
import { encodeHandshakeEnvelope, encodeRatchetEnvelope } from '../src/crypto/envelope';
import { deriveNextSendingMessageKey, initiateSession } from '../src/crypto/session';
import { inboxStore, startInboxListener, stopInboxListener } from '../src/inbox/listener';
import ChatScreen from '../src/screens/ChatScreen';
import { getMessages, markContactMessagesRead, saveMessage } from '../src/storage/messages';
import { transportStore, type ConnectionStatus, type IncomingFrame } from '../src/transport/store';
import { base64ToBytes, bytesToBase64, utf8ToBytes } from '../src/utils/base64';

// `transportStore` is mocked wholesale here, backed by a real
// `@tanstack/react-store` `Store` instance (so `ChatScreen`'s real
// `useStore(transportStore, ...)` subscriptions work unmodified) but with
// test-controllable `connect`/`send`/`close` actions in place of the real
// ones -- the mocked-module equivalent of "the socket delivers a frame" /
// "the connection status changes", without needing a real WebSocket or the
// real reconnect-with-backoff timers. That logic (retry scheduling, jitter,
// the 4001 terminal case, etc.) is unit-tested directly against the real
// store implementation in `src/transport/__tests__/store.test.ts`; this
// file only checks that `ChatScreen` wires the four statuses to the banner
// correctly and that message handling is unaffected by reconnects.
//
// `../src/inbox/listener.ts` itself is *not* mocked here: since it
// consumes this same mocked `transportStore` instance (Jest mocks are keyed
// by resolved file path, so `ChatScreen.tsx`'s and `listener.ts`'s both
// resolve to this one mock) and this file already mocks/exercises every one
// of the listener's other dependencies (`../src/api/client`'s
// `listContacts`, `../src/api/session`'s `getUserId`, `../src/storage/messages`'s
// `saveMessage`) the same way `ChatScreen.tsx` itself does, running the real
// listener end-to-end reproduces exactly what `../src/navigation/MainTabs.tsx`
// does in the real app (issue #165): `socket.receive(...)` below decodes via
// the real listener, which publishes to `inboxStore`, which `ChatScreen`
// renders -- not a direct decode inside `ChatScreen` anymore.
jest.mock('../src/transport/store', () => {
  const { Store } = jest.requireActual('@tanstack/react-store');
  return {
    transportStore: new Store(
      { status: 'connecting', activeTransport: null, lastFrame: null },
      () => ({
        connect: jest.fn(),
        send: jest.fn(),
        close: jest.fn(),
      })
    ),
  };
});

jest.mock('../src/api/session', () => ({
  getToken: jest.fn(),
  getUserId: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  listContacts: jest.fn(),
  // `../src/components/Avatar.tsx` (issue #182) also imports `API_BASE_URL`
  // from this module -- since this whole module is mocked in this file,
  // that import would otherwise resolve to `undefined` rather than the
  // real client's computed default.
  API_BASE_URL: 'http://localhost:3000',
}));

jest.mock('../src/storage/messages', () => ({
  getMessages: jest.fn(),
  saveMessage: jest.fn(),
  markContactMessagesRead: jest.fn(),
}));

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

const mockSecureStore = SecureStore as unknown as { __store: Map<string, string> };
const mockedConnect = transportStore.actions.connect as jest.Mock;
const mockedGetToken = getToken as jest.Mock;
// `getUserId` is mocked via the same `../src/api/session` factory above.
const { getUserId: mockedGetUserId } = jest.requireMock('../src/api/session');
const { listContacts: mockedListContacts } = jest.requireMock('../src/api/client');
const mockedGetMessages = getMessages as jest.Mock;
const mockedSaveMessage = saveMessage as jest.Mock;
const mockedMarkContactMessagesRead = markContactMessagesRead as jest.Mock;

// See ContactsScreen.test.tsx (issue #26) for why this file needs more
// headroom than Jest's default 5000ms per-test timeout under CI load; the
// real PQXDH/Double-Ratchet crypto this file now exercises (issue #41)
// needs the same headroom.
jest.setTimeout(20000);

const ALICE_USER_ID = 'alice-user-id';
const CONTACT_USER_ID = 'contact-1';

/** Test double for driving the mocked `transportStore`'s reactive state
 * directly, standing in for what a real WebSocket delivering frames/status
 * changes would do to it. See the `jest.mock('../src/transport/store', ...)`
 * call above for why this is safe to do without going through the real
 * `connect`/reconnect machinery. */
interface ChatSocketHarness {
  send: jest.Mock;
  close: jest.Mock;
  receive: (frame: IncomingFrame) => void;
  setStatus: (status: ConnectionStatus) => void;
}

function createChatSocketHarness(): ChatSocketHarness {
  // Mirrors the real store's `connect` action succeeding immediately, so
  // tests that don't care about connection-status transitions can
  // send/receive right away; tests that do care call `setStatus(...)`
  // explicitly to override this.
  transportStore.setState(() => ({
    status: 'connected',
    activeTransport: 'ws',
    lastFrame: null,
  }));

  return {
    send: transportStore.actions.send as jest.Mock,
    close: transportStore.actions.close as jest.Mock,
    receive: (frame) => transportStore.setState((s) => ({ ...s, lastFrame: frame })),
    setStatus: (status) =>
      transportStore.setState((s) => ({
        ...s,
        status,
        activeTransport: status === 'connected' ? 'ws' : null,
      })),
  };
}

/** Builds a "Bob" (the contact) identity independent of Alice's on-device
 * identity, plus the server-shaped `Contact` bundle `listContacts()` would
 * report for Bob, and a self-signed valid prekey signature matching
 * `verifyPrekeyBundle`'s expectations. `userId`/`email` are overridable so
 * the same builder can stand in for a second, distinct contact (e.g. Carol)
 * when a test needs two independently-verifiable contacts. */
function buildContact(userId = CONTACT_USER_ID, email = 'bob@example.com') {
  const x25519Keys = x25519.keygen();
  const kyberKeys = ml_kem768.keygen();
  const dilithiumKeys = ml_dsa65.keygen();
  const prekeySignature = ml_dsa65.sign(
    concatBytes(utf8ToBytes(PREKEY_SIGNATURE_CONTEXT), x25519Keys.publicKey, kyberKeys.publicKey),
    dilithiumKeys.secretKey
  );

  return {
    x25519Keys,
    kyberKeys,
    dilithiumKeys,
    contact: {
      user_id: userId,
      email,
      added_at: '2026-01-01T00:00:00.000Z',
      x25519_public_key_b64: bytesToBase64(x25519Keys.publicKey),
      kyber_public_key_b64: bytesToBase64(kyberKeys.publicKey),
      dilithium_public_key_b64: bytesToBase64(dilithiumKeys.publicKey),
      prekey_signature_b64: bytesToBase64(prekeySignature),
    },
  };
}

const ROUTE = { params: { userId: CONTACT_USER_ID, username: 'bob' } };
const CAROL_USER_ID = 'carol-user-id';
const CAROL_ROUTE = { params: { userId: CAROL_USER_ID, username: 'carol' } };

/** Jest has no native safe-area module; seed metrics so the provider
 * renders children immediately instead of waiting forever. */
const SAFE_AREA_METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

async function renderChatScreen(socket: ChatSocketHarness = createChatSocketHarness()) {
  const navigation = { navigate: jest.fn() };
  const view = await render(
    <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
      <ChatScreen navigation={navigation as never} route={ROUTE as never} />
    </SafeAreaProvider>
  );
  const user = userEvent.setup();
  await waitFor(() => expect(mockedGetMessages).toHaveBeenCalledWith(CONTACT_USER_ID));
  return { navigation, user, socket, unmount: view.unmount };
}

describe('ChatScreen', () => {
  let bob: ReturnType<typeof buildContact>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSecureStore.__store.clear();
    // Fresh start for the listener's own caches (identity/self-user-id,
    // contacts) each test -- see the `jest.mock('../src/transport/store', ...)`
    // comment above for why the real listener is used, unmocked, in this
    // file. `stopInboxListener()` before `startInboxListener()` also drops
    // any subscription left over from the previous test.
    stopInboxListener();
    mockedGetToken.mockResolvedValue('token-123');
    mockedGetUserId.mockResolvedValue(ALICE_USER_ID);
    mockedGetMessages.mockResolvedValue([]);
    mockedSaveMessage.mockResolvedValue(undefined);
    mockedMarkContactMessagesRead.mockResolvedValue(undefined);
    startInboxListener();
    bob = buildContact();
    mockedListContacts.mockResolvedValue({ contacts: [bob.contact] });
  });

  it('renders dark: variants on its header, message input, and container', async () => {
    await renderChatScreen();

    expect(screen.getByText('bob').props.className).toContain('dark:text-white');
    expect(screen.getByPlaceholderText('Message').props.className).toContain('dark:text-white');
  });

  it('shows the contact username and its initial in the header', async () => {
    const alice = { params: { userId: CONTACT_USER_ID, username: 'alice' } };
    const navigation = { navigate: jest.fn() };
    await render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ChatScreen navigation={navigation as never} route={alice as never} />
      </SafeAreaProvider>
    );

    expect(screen.getByText('alice')).toBeTruthy();
    // Avatar falls back to the derived initial once its image fails to load.
    fireEvent(screen.getByTestId(`avatar-image-${CONTACT_USER_ID}`), 'error');
    expect(await screen.findByText('A')).toBeTruthy();
  });

  it('loads existing history on mount and renders it (plaintext, per ADR 0007)', async () => {
    mockedGetMessages.mockResolvedValueOnce([
      {
        id: 1,
        contactUserId: CONTACT_USER_ID,
        direction: 'outgoing',
        body: 'hi',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 2,
        contactUserId: CONTACT_USER_ID,
        direction: 'incoming',
        body: 'hello',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ]);

    await renderChatScreen();

    await waitFor(() => {
      expect(screen.getByText('hi')).toBeTruthy();
      expect(screen.getByText('hello')).toBeTruthy();
    });
  });

  describe('header avatar (issue #182)', () => {
    it('attempts the real avatar image for the contact and falls back to the initial circle on load failure', async () => {
      await renderChatScreen();

      const image = await waitFor(() => screen.getByTestId(`avatar-image-${CONTACT_USER_ID}`));
      expect(image.props.source).toEqual({
        uri: `http://localhost:3000/api/avatar/${CONTACT_USER_ID}`,
        headers: { Authorization: 'Bearer token-123' },
      });
      expect(screen.queryByText('B')).toBeNull();

      fireEvent(image, 'error');

      await waitFor(() => {
        expect(screen.getByText('B')).toBeTruthy();
      });
      expect(screen.queryByTestId(`avatar-image-${CONTACT_USER_ID}`)).toBeNull();
    });

    it('renders the initial circle directly when there is no session token yet', async () => {
      // A null token also short-circuits `ChatScreen`'s own crypto/history
      // setup (`setup()`'s early `if (!token) return`) -- rendered here
      // directly rather than via `renderChatScreen()`'s helper, which waits
      // on `getMessages` having been called, so this test only asserts on
      // the header avatar's fallback.
      mockedGetToken.mockResolvedValue(null);
      const navigation = { navigate: jest.fn() };

      await render(
        <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
          <ChatScreen navigation={navigation as never} route={ROUTE as never} />
        </SafeAreaProvider>
      );

      await waitFor(() => {
        expect(screen.getByText('B')).toBeTruthy();
      });
      expect(screen.queryByTestId(`avatar-image-${CONTACT_USER_ID}`)).toBeNull();
    });
  });

  it('marks the contact\'s messages read exactly once on mount, alongside loading history', async () => {
    await renderChatScreen();

    await waitFor(() => {
      expect(mockedMarkContactMessagesRead).toHaveBeenCalledWith(CONTACT_USER_ID);
    });
    expect(mockedMarkContactMessagesRead).toHaveBeenCalledTimes(1);
  });

  it('sends a message: appends the real plaintext optimistically, sends a real handshake-init envelope, and persists plaintext locally', async () => {
    const { user, socket } = await renderChatScreen();

    await user.type(screen.getByPlaceholderText('Message'), 'hey there');
    await user.press(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('hey there')).toBeTruthy();
    });

    expect(socket.send).toHaveBeenCalledTimes(1);
    const sentFrame = socket.send.mock.calls[0][0] as { type: string; to: string; body_b64: string };
    expect(sentFrame).toEqual({
      type: 'send',
      to: CONTACT_USER_ID,
      body_b64: expect.any(String),
    });
    // No session existed yet, so the very first send is a real
    // handshake-init envelope (version 0x02), not plaintext.
    const envelopeBytes = base64ToBytes(sentFrame.body_b64);
    expect(envelopeBytes[0]).toBe(0x02);
    expect(envelopeBytes.length).toBeGreaterThan(1088 + 32 + 3309);

    await waitFor(() => {
      expect(mockedSaveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          contactUserId: CONTACT_USER_ID,
          direction: 'outgoing',
          body: 'hey there',
        })
      );
    });
  });

  it('decrypts a real incoming handshake-init envelope, renders the plaintext, and persists plaintext (not ciphertext) locally', async () => {
    const { socket } = await renderChatScreen();
    const aliceIdentity = await ensureLocalIdentity();

    const { state: bobState, ea, kyberCiphertext } = initiateSession({
      contactUserId: ALICE_USER_ID,
      selfUserId: CONTACT_USER_ID,
      contactBundle: {
        x25519PublicKey: aliceIdentity.x25519PublicKey,
        kyberPublicKey: aliceIdentity.kyberPublicKey,
      },
    });
    const send0 = deriveNextSendingMessageKey(bobState);
    const envelope = encodeHandshakeEnvelope({
      ea,
      kyberCiphertext,
      messageKey: send0.messageKey,
      plaintext: utf8ToBytes('hello alice, this is bob'),
      selfUserId: CONTACT_USER_ID,
      contactUserId: ALICE_USER_ID,
      signingSecretKey: bob.dilithiumKeys.secretKey,
    });

    await act(async () => {
      socket.receive({
          type: 'message',
          from: CONTACT_USER_ID,
          body_b64: bytesToBase64(envelope),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('hello alice, this is bob')).toBeTruthy();
    });
    expect(mockedSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contactUserId: CONTACT_USER_ID,
        direction: 'incoming',
        body: 'hello alice, this is bob',
      })
    );
  });

  it('establishes then continues a session across a multi-message exchange', async () => {
    const { user, socket } = await renderChatScreen();
    const aliceIdentity = await ensureLocalIdentity();

    // Bob establishes the session with a handshake-init.
    const { state: bobStateAfterHandshake, ea, kyberCiphertext } = initiateSession({
      contactUserId: ALICE_USER_ID,
      selfUserId: CONTACT_USER_ID,
      contactBundle: {
        x25519PublicKey: aliceIdentity.x25519PublicKey,
        kyberPublicKey: aliceIdentity.kyberPublicKey,
      },
    });
    const bobSend0 = deriveNextSendingMessageKey(bobStateAfterHandshake);
    const handshakeEnvelope = encodeHandshakeEnvelope({
      ea,
      kyberCiphertext,
      messageKey: bobSend0.messageKey,
      plaintext: utf8ToBytes('hi alice'),
      selfUserId: CONTACT_USER_ID,
      contactUserId: ALICE_USER_ID,
      signingSecretKey: bob.dilithiumKeys.secretKey,
    });
    await act(async () => {
      socket.receive({
          type: 'message',
          from: CONTACT_USER_ID,
          body_b64: bytesToBase64(handshakeEnvelope),
      });
    });
    await waitFor(() => expect(screen.getByText('hi alice')).toBeTruthy());

    // Alice replies (now sends a ratchet envelope, continuing the session).
    await user.type(screen.getByPlaceholderText('Message'), 'hi bob, good to hear from you');
    await user.press(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('hi bob, good to hear from you')).toBeTruthy());
    const secondSentFrame = socket.send.mock.calls[0][0] as { body_b64: string };
    const secondEnvelopeBytes = base64ToBytes(secondSentFrame.body_b64);
    expect(secondEnvelopeBytes[0]).toBe(0x03);

    // Bob sends a second message on the same (unratcheted) chain.
    const bobSend1 = deriveNextSendingMessageKey(bobSend0.nextState);
    const ratchetEnvelope = encodeRatchetEnvelope({
      header: bobSend1.header,
      messageKey: bobSend1.messageKey,
      plaintext: utf8ToBytes('glad you got my message'),
      selfUserId: CONTACT_USER_ID,
      contactUserId: ALICE_USER_ID,
      signingSecretKey: bob.dilithiumKeys.secretKey,
    });
    await act(async () => {
      socket.receive({
          type: 'message',
          from: CONTACT_USER_ID,
          body_b64: bytesToBase64(ratchetEnvelope),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('glad you got my message')).toBeTruthy();
    });
  });

  it('shows the verification-failure UI state for a tampered incoming envelope, without persisting it to history', async () => {
    const { socket } = await renderChatScreen();
    const aliceIdentity = await ensureLocalIdentity();

    const { state: bobState, ea, kyberCiphertext } = initiateSession({
      contactUserId: ALICE_USER_ID,
      selfUserId: CONTACT_USER_ID,
      contactBundle: {
        x25519PublicKey: aliceIdentity.x25519PublicKey,
        kyberPublicKey: aliceIdentity.kyberPublicKey,
      },
    });
    const send0 = deriveNextSendingMessageKey(bobState);
    const envelope = encodeHandshakeEnvelope({
      ea,
      kyberCiphertext,
      messageKey: send0.messageKey,
      plaintext: utf8ToBytes('this should never be shown'),
      selfUserId: CONTACT_USER_ID,
      contactUserId: ALICE_USER_ID,
      signingSecretKey: bob.dilithiumKeys.secretKey,
    });
    const tampered = Uint8Array.from(envelope);
    tampered[tampered.length - 1] ^= 0xff; // corrupt the signature

    await act(async () => {
      socket.receive({
          type: 'message',
          from: CONTACT_USER_ID,
          body_b64: bytesToBase64(tampered),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('unverifiable-message')).toBeTruthy();
    });
    expect(screen.queryByText('this should never be shown')).toBeNull();
    expect(mockedSaveMessage).not.toHaveBeenCalled();
  });

  it('blocks sending when the contact\'s prekey bundle fails verification, without sending an envelope or persisting history', async () => {
    // Tamper with Bob's server-reported prekey signature so
    // `verifyPrekeyBundle` fails, simulating a compromised/incorrect
    // key bundle from the server.
    const tamperedContact = {
      ...bob.contact,
      prekey_signature_b64: bytesToBase64(
        Uint8Array.from(base64ToBytes(bob.contact.prekey_signature_b64 as string)).map(
          (byte, index) => (index === 0 ? byte ^ 0xff : byte)
        )
      ),
    };
    mockedListContacts.mockResolvedValue({ contacts: [tamperedContact] });

    const { user, socket } = await renderChatScreen();

    await user.type(screen.getByPlaceholderText('Message'), 'this should never be sent');
    await user.press(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByTestId('send-error')).toHaveTextContent("Cannot verify this contact's keys");
    });
    expect(socket.send).not.toHaveBeenCalled();
    expect(screen.queryByText('this should never be sent')).toBeNull();
    expect(mockedSaveMessage).not.toHaveBeenCalled();
  });

  it('shows an inline "not delivered" note on a queue_unavailable error, without removing the message', async () => {
    const { user, socket } = await renderChatScreen();

    await user.type(screen.getByPlaceholderText('Message'), 'hi');
    await user.press(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('hi')).toBeTruthy();
    });

    await act(async () => {
      socket.receive({ type: 'error', code: 'queue_unavailable' });
    });

    await waitFor(() => {
      expect(screen.getByText('Not delivered: message could not be queued')).toBeTruthy();
    });
    expect(screen.getByText('hi')).toBeTruthy();
  });

  it('shows a "Reconnecting..." banner while reconnecting, and a distinct "Disconnected" banner if reconnection is abandoned', async () => {
    const { socket } = await renderChatScreen();

    expect(screen.queryByTestId('disconnected-banner')).toBeNull();

    await act(async () => {
      socket.setStatus('reconnecting');
    });
    await waitFor(() => {
      expect(screen.getByTestId('disconnected-banner')).toHaveTextContent('Reconnecting...');
    });

    await act(async () => {
      socket.setStatus('disconnected');
    });
    await waitFor(() => {
      expect(screen.getByTestId('disconnected-banner')).toHaveTextContent('Disconnected');
    });
  });

  it('renders dark: variants on the disconnected/reconnecting banner (issue #142)', async () => {
    const { socket } = await renderChatScreen();

    await act(async () => {
      socket.setStatus('reconnecting');
    });
    await waitFor(() => {
      expect(screen.getByTestId('disconnected-banner')).toHaveTextContent('Reconnecting...');
    });

    expect(screen.getByTestId('disconnected-banner').props.className).toContain(
      'dark:bg-red-950'
    );
    expect(screen.getByText('Reconnecting...').props.className).toContain('dark:text-red-300');
  });

  it('clears the banner after a reconnect succeeds, and renders a message delivered on the new connection exactly like a pre-reconnect one', async () => {
    const { socket } = await renderChatScreen();
    const aliceIdentity = await ensureLocalIdentity();

    // The connection drops...
    await act(async () => {
      socket.setStatus('reconnecting');
    });
    await waitFor(() => {
      expect(screen.getByTestId('disconnected-banner')).toHaveTextContent('Reconnecting...');
    });

    // ...then a new underlying socket reconnects successfully. From
    // `ChatScreen`'s perspective this is just another status update: the
    // transport store's `connect` action owns swapping out the underlying
    // WebSocket instance (see `src/transport/__tests__/store.test.ts` for
    // that).
    await act(async () => {
      socket.setStatus('connected');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('disconnected-banner')).toBeNull();
    });

    // A message delivered on the reconnected socket (e.g. a server-side
    // catch-up delivery per issue #54) goes through the exact same
    // decrypt/render path as any other incoming frame — no special
    // "post-reconnect" branch.
    const { state: bobState, ea, kyberCiphertext } = initiateSession({
      contactUserId: ALICE_USER_ID,
      selfUserId: CONTACT_USER_ID,
      contactBundle: {
        x25519PublicKey: aliceIdentity.x25519PublicKey,
        kyberPublicKey: aliceIdentity.kyberPublicKey,
      },
    });
    const send0 = deriveNextSendingMessageKey(bobState);
    const envelope = encodeHandshakeEnvelope({
      ea,
      kyberCiphertext,
      messageKey: send0.messageKey,
      plaintext: utf8ToBytes('caught up while you were away'),
      selfUserId: CONTACT_USER_ID,
      contactUserId: ALICE_USER_ID,
      signingSecretKey: bob.dilithiumKeys.secretKey,
    });

    await act(async () => {
      socket.receive({
        type: 'message',
        from: CONTACT_USER_ID,
        body_b64: bytesToBase64(envelope),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('caught up while you were away')).toBeTruthy();
    });
  });

  it('does not open or close the transport connection itself (ownership moved to the app level, issue #165)', async () => {
    const { socket, unmount } = await renderChatScreen();

    await unmount();

    // `../src/inbox/appSession.ts` (`../src/navigation/MainTabs.tsx`'s
    // mount/unmount) now owns `connect`/`close` -- `ChatScreen` mounting or
    // unmounting must not touch either action, so the connection stays open
    // across navigating away from a contact's chat.
    expect(mockedConnect).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('does not drop a legitimate frame for a newly-opened contact after switching directly from a different contact\'s chat', async () => {
    // Both `transportStore` and `inboxStore` are module-wide singletons
    // (see the `jest.mock` at the top of this file, mirroring the real
    // `../src/transport/store`): neither's last-published value is reset on
    // unmount, exactly like the real store's `close()` action (which now,
    // post-issue-#165, isn't even called by `ChatScreen` unmounting -- see
    // the test above). This reproduces that carry-over instead of the
    // `createChatSocketHarness()` helper's usual reset, so both
    // `ChatScreen.tsx`'s `processedFrameRef` guard (for `transportStore`'s
    // `lastFrame`) and its `processedInboxEventRef` guard (for
    // `inboxStore`'s `lastEvent`) get genuinely stale values (Bob's) seeded
    // into a freshly-mounted screen for a *different* contact (Carol) -- the
    // scenario both guards' comments say they must not mishandle.
    const { socket: bobSocket, unmount } = await renderChatScreen();
    const aliceIdentity = await ensureLocalIdentity();

    const bobHandshake = initiateSession({
      contactUserId: ALICE_USER_ID,
      selfUserId: CONTACT_USER_ID,
      contactBundle: {
        x25519PublicKey: aliceIdentity.x25519PublicKey,
        kyberPublicKey: aliceIdentity.kyberPublicKey,
      },
    });
    const bobSend0 = deriveNextSendingMessageKey(bobHandshake.state);
    const bobEnvelope = encodeHandshakeEnvelope({
      ea: bobHandshake.ea,
      kyberCiphertext: bobHandshake.kyberCiphertext,
      messageKey: bobSend0.messageKey,
      plaintext: utf8ToBytes('hi from bob'),
      selfUserId: CONTACT_USER_ID,
      contactUserId: ALICE_USER_ID,
      signingSecretKey: bob.dilithiumKeys.secretKey,
    });
    await act(async () => {
      bobSocket.receive({
        type: 'message',
        from: CONTACT_USER_ID,
        body_b64: bytesToBase64(bobEnvelope),
      });
    });
    await waitFor(() => expect(screen.getByText('hi from bob')).toBeTruthy());

    // Leave Bob's chat. This is the real `close()` action's behavior too:
    // it does not clear `transportStore`'s `lastFrame`, so Bob's frame (and
    // `inboxStore`'s published outcome for it) are still sitting there.
    await unmount();
    expect(transportStore.state.lastFrame).toEqual(
      expect.objectContaining({ type: 'message', from: CONTACT_USER_ID })
    );
    expect(inboxStore.state.lastEvent).toEqual(
      expect.objectContaining({ contactUserId: CONTACT_USER_ID, status: 'saved' })
    );

    // Switch directly to a different contact's (Carol's) chat.
    const carol = buildContact(CAROL_USER_ID, 'carol@example.com');
    mockedListContacts.mockResolvedValue({ contacts: [carol.contact] });
    const navigation = { navigate: jest.fn() };
    await render(
      <SafeAreaProvider initialMetrics={SAFE_AREA_METRICS}>
        <ChatScreen navigation={navigation as never} route={CAROL_ROUTE as never} />
      </SafeAreaProvider>
    );
    await waitFor(() => expect(mockedGetMessages).toHaveBeenCalledWith(CAROL_USER_ID));

    // A genuinely new frame from Carol, delivered after Carol's screen has
    // mounted, must still be rendered -- not swallowed because it happens
    // to arrive into stores whose `lastFrame`/`lastEvent` were both
    // non-null (Bob's) at mount time.
    const carolHandshake = initiateSession({
      contactUserId: ALICE_USER_ID,
      selfUserId: CAROL_USER_ID,
      contactBundle: {
        x25519PublicKey: aliceIdentity.x25519PublicKey,
        kyberPublicKey: aliceIdentity.kyberPublicKey,
      },
    });
    const carolSend0 = deriveNextSendingMessageKey(carolHandshake.state);
    const carolEnvelope = encodeHandshakeEnvelope({
      ea: carolHandshake.ea,
      kyberCiphertext: carolHandshake.kyberCiphertext,
      messageKey: carolSend0.messageKey,
      plaintext: utf8ToBytes('hi from carol'),
      selfUserId: CAROL_USER_ID,
      contactUserId: ALICE_USER_ID,
      signingSecretKey: carol.dilithiumKeys.secretKey,
    });
    await act(async () => {
      transportStore.setState((s) => ({
        ...s,
        lastFrame: { type: 'message', from: CAROL_USER_ID, body_b64: bytesToBase64(carolEnvelope) },
      }));
    });

    await waitFor(() => expect(screen.getByText('hi from carol')).toBeTruthy());
  });
});
