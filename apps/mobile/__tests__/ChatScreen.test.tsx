import 'react-native-get-random-values';

import { act, render, screen, userEvent, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { concatBytes } from '@noble/hashes/utils.js';

import { getToken } from '../src/api/session';
import { createChatSocket } from '../src/api/ws';
import { ensureLocalIdentity, PREKEY_SIGNATURE_CONTEXT } from '../src/crypto/identity';
import { encodeHandshakeEnvelope, encodeRatchetEnvelope } from '../src/crypto/envelope';
import { deriveNextSendingMessageKey, initiateSession } from '../src/crypto/session';
import ChatScreen from '../src/screens/ChatScreen';
import { getMessages, saveMessage } from '../src/storage/messages';
import { base64ToBytes, bytesToBase64, utf8ToBytes } from '../src/utils/base64';

jest.mock('../src/api/ws', () => ({
  createChatSocket: jest.fn(),
}));

jest.mock('../src/api/session', () => ({
  getToken: jest.fn(),
  getUserId: jest.fn(),
}));

jest.mock('../src/api/client', () => ({
  listContacts: jest.fn(),
}));

jest.mock('../src/storage/messages', () => ({
  getMessages: jest.fn(),
  saveMessage: jest.fn(),
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
const mockedCreateChatSocket = createChatSocket as jest.Mock;
const mockedGetToken = getToken as jest.Mock;
// `getUserId` is mocked via the same `../src/api/session` factory above.
const { getUserId: mockedGetUserId } = jest.requireMock('../src/api/session');
const { listContacts: mockedListContacts } = jest.requireMock('../src/api/client');
const mockedGetMessages = getMessages as jest.Mock;
const mockedSaveMessage = saveMessage as jest.Mock;

// See ContactsScreen.test.tsx (issue #26) for why this file needs more
// headroom than Jest's default 5000ms per-test timeout under CI load; the
// real PQXDH/Double-Ratchet crypto this file now exercises (issue #41)
// needs the same headroom.
jest.setTimeout(20000);

const ALICE_USER_ID = 'alice-user-id';
const CONTACT_USER_ID = 'contact-1';

interface MockSocket {
  send: jest.Mock;
  close: jest.Mock;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

function createMockSocket(): MockSocket {
  return {
    send: jest.fn(),
    close: jest.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}

/** Builds a "Bob" (the contact) identity independent of Alice's on-device
 * identity, plus the server-shaped `Contact` bundle `listContacts()` would
 * report for Bob, and a self-signed valid prekey signature matching
 * `verifyPrekeyBundle`'s expectations. */
function buildContact() {
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
      user_id: CONTACT_USER_ID,
      email: 'bob@example.com',
      added_at: '2026-01-01T00:00:00.000Z',
      x25519_public_key_b64: bytesToBase64(x25519Keys.publicKey),
      kyber_public_key_b64: bytesToBase64(kyberKeys.publicKey),
      dilithium_public_key_b64: bytesToBase64(dilithiumKeys.publicKey),
      prekey_signature_b64: bytesToBase64(prekeySignature),
    },
  };
}

const ROUTE = { params: { userId: CONTACT_USER_ID, email: 'bob@example.com' } };

async function renderChatScreen(socket: MockSocket = createMockSocket()) {
  mockedCreateChatSocket.mockReturnValue(socket);
  const navigation = { navigate: jest.fn() };
  const view = await render(<ChatScreen navigation={navigation as never} route={ROUTE as never} />);
  const user = userEvent.setup();
  await waitFor(() => expect(mockedGetMessages).toHaveBeenCalledWith(CONTACT_USER_ID));
  await waitFor(() => expect(mockedCreateChatSocket).toHaveBeenCalledWith('token-123'));
  return { navigation, user, socket, unmount: view.unmount };
}

describe('ChatScreen', () => {
  let bob: ReturnType<typeof buildContact>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSecureStore.__store.clear();
    mockedGetToken.mockResolvedValue('token-123');
    mockedGetUserId.mockResolvedValue(ALICE_USER_ID);
    mockedGetMessages.mockResolvedValue([]);
    mockedSaveMessage.mockResolvedValue(undefined);
    bob = buildContact();
    mockedListContacts.mockResolvedValue({ contacts: [bob.contact] });
  });

  it('loads existing history on mount and renders it (plaintext, per ADR 0007)', async () => {
    mockedGetMessages.mockResolvedValueOnce([
      {
        id: 1,
        contactUserId: CONTACT_USER_ID,
        direction: 'outgoing',
        bodyB64: 'aGk=',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 2,
        contactUserId: CONTACT_USER_ID,
        direction: 'incoming',
        bodyB64: 'aGVsbG8=',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ]);

    await renderChatScreen();

    await waitFor(() => {
      expect(screen.getByText('hi')).toBeTruthy();
      expect(screen.getByText('hello')).toBeTruthy();
    });
  });

  it('sends a message: appends the real plaintext optimistically, sends a real handshake-init envelope, and persists plaintext locally', async () => {
    const { user, socket } = await renderChatScreen();

    await user.type(screen.getByPlaceholderText('Message'), 'hey there');
    await user.press(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('hey there')).toBeTruthy();
    });

    expect(socket.send).toHaveBeenCalledTimes(1);
    const sentFrame = JSON.parse(socket.send.mock.calls[0][0] as string);
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
          bodyB64: bytesToBase64(utf8ToBytes('hey there')),
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
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'message',
          from: CONTACT_USER_ID,
          body_b64: bytesToBase64(envelope),
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('hello alice, this is bob')).toBeTruthy();
    });
    expect(mockedSaveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contactUserId: CONTACT_USER_ID,
        direction: 'incoming',
        bodyB64: bytesToBase64(utf8ToBytes('hello alice, this is bob')),
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
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'message',
          from: CONTACT_USER_ID,
          body_b64: bytesToBase64(handshakeEnvelope),
        }),
      });
    });
    await waitFor(() => expect(screen.getByText('hi alice')).toBeTruthy());

    // Alice replies (now sends a ratchet envelope, continuing the session).
    await user.type(screen.getByPlaceholderText('Message'), 'hi bob, good to hear from you');
    await user.press(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByText('hi bob, good to hear from you')).toBeTruthy());
    const secondSentFrame = JSON.parse(socket.send.mock.calls[0][0] as string);
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
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'message',
          from: CONTACT_USER_ID,
          body_b64: bytesToBase64(ratchetEnvelope),
        }),
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
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'message',
          from: CONTACT_USER_ID,
          body_b64: bytesToBase64(tampered),
        }),
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

  it('shows an inline "not delivered" note on a recipient_offline error, without removing the message', async () => {
    const { user, socket } = await renderChatScreen();

    await user.type(screen.getByPlaceholderText('Message'), 'hi');
    await user.press(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('hi')).toBeTruthy();
    });

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'error', code: 'recipient_offline' }),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Not delivered: contact is offline')).toBeTruthy();
    });
    expect(screen.getByText('hi')).toBeTruthy();
  });

  it('shows a Disconnected banner when the socket closes, with no reconnect attempt', async () => {
    const { socket } = await renderChatScreen();

    expect(screen.queryByTestId('disconnected-banner')).toBeNull();

    await act(async () => {
      socket.onclose?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId('disconnected-banner')).toBeTruthy();
    });
    expect(mockedCreateChatSocket).toHaveBeenCalledTimes(1);
  });

  it('closes the WebSocket connection when the screen unmounts', async () => {
    const { socket, unmount } = await renderChatScreen();

    await unmount();

    expect(socket.close).toHaveBeenCalled();
  });
});
