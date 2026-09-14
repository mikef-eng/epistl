import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';

import { type Contact, listContacts } from '../api/client';
import { getToken, getUserId } from '../api/session';
import { ensureLocalIdentity, type Identity } from '../crypto/identity';
import {
  decodeHandshakeEnvelope,
  decodeRatchetEnvelope,
  encodeHandshakeEnvelope,
  encodeRatchetEnvelope,
  HANDSHAKE_ENVELOPE_VERSION,
  RATCHET_ENVELOPE_VERSION,
  type EnvelopeDecodeResult,
} from '../crypto/envelope';
import {
  deriveNextSendingMessageKey,
  initiateSession,
  loadSession,
  saveSession,
  verifyPrekeyBundle,
  type RatchetState,
} from '../crypto/session';
import type { RootStackParamList } from '../navigation/types';
import {
  getMessages,
  markContactMessagesRead,
  saveMessage,
  type MessageDirection,
} from '../storage/messages';
import { transportStore, type IncomingFrame } from '../transport/store';
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from '../utils/base64';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

interface ChatListItem {
  key: string;
  direction: MessageDirection;
  /** The plaintext to render, or `null` for a live message that could not
   * be decrypted/verified (see the "could not be verified" UI state
   * below). History rows loaded from SQLite always have a non-null
   * `text`: per `docs/decisions/0007-local-history-stores-plaintext.md`,
   * only successfully sent/verified messages are ever persisted. */
  text: string | null;
  verified: boolean;
  createdAt: string;
  deliveryFailed?: boolean;
}

/** This device's view of a contact's server-reported PQXDH key bundle,
 * decoded from base64 (issue #35's `user_keys` fields via `listContacts`). */
interface ContactKeyBundle {
  x25519PublicKey: Uint8Array;
  kyberPublicKey: Uint8Array;
  dilithiumPublicKey: Uint8Array;
  prekeySignature: Uint8Array;
}

function bundleFromContact(contact: Contact): ContactKeyBundle | null {
  if (
    contact.x25519_public_key_b64 === null ||
    contact.kyber_public_key_b64 === null ||
    contact.dilithium_public_key_b64 === null ||
    contact.prekey_signature_b64 === null
  ) {
    return null;
  }
  return {
    x25519PublicKey: base64ToBytes(contact.x25519_public_key_b64),
    kyberPublicKey: base64ToBytes(contact.kyber_public_key_b64),
    dilithiumPublicKey: base64ToBytes(contact.dilithium_public_key_b64),
    prekeySignature: base64ToBytes(contact.prekey_signature_b64),
  };
}

let localKeySeq = 0;
/** Generates a stable React key for messages that don't have a DB row id
 * yet (optimistic sends, freshly received messages). */
function nextLocalKey(): string {
  localKeySeq += 1;
  return `local-${localKeySeq}`;
}

const CANNOT_VERIFY_CONTACT_ERROR = "Cannot verify this contact's keys";

export default function ChatScreen({ route }: Props) {
  const { userId: contactUserId, email } = route.params;

  const [messages, setMessages] = useState<ChatListItem[]>([]);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);

  const status = useStore(transportStore, (s) => s.status);
  const lastFrame = useStore(transportStore, (s) => s.lastFrame);

  const lastSentKeyRef = useRef<string | null>(null);
  const listRef = useRef<FlatList<ChatListItem> | null>(null);
  // Frames already routed through `handleFrame` below, keyed by object
  // identity. `transportStore` is a module-wide singleton whose `lastFrame`
  // can carry over from a previous mount of this same screen (e.g.
  // navigating away from and back to the same contact); without this guard
  // that stale frame would be reprocessed (and its message re-appended) on
  // remount. Seeded with whatever `lastFrame` already holds at mount time
  // so only frames that arrive *after* mount are treated as new.
  const processedFrameRef = useRef<IncomingFrame | null>(transportStore.state.lastFrame);

  // Crypto context needed to send/receive, loaded once on mount below.
  const identityRef = useRef<Identity | null>(null);
  const contactBundleRef = useRef<ContactKeyBundle | null>(null);
  const selfUserIdRef = useRef<string | null>(null);

  function appendUnverifiable(direction: MessageDirection, createdAt: string) {
    setMessages((prev) => [
      ...prev,
      { key: nextLocalKey(), direction, text: null, verified: false, createdAt },
    ]);
  }

  /** Decodes+verifies a live incoming envelope (received over the open WS
   * connection), persists the advanced ratchet state on success, and
   * persists the decrypted plaintext to local history — never the
   * ciphertext, and never on any failure. See
   * `docs/decisions/0007-local-history-stores-plaintext.md`. */
  async function handleIncomingEnvelope(bodyB64: string) {
    const createdAt = new Date().toISOString();
    const contact = contactBundleRef.current;
    const identity = identityRef.current;
    const selfUserId = selfUserIdRef.current;

    if (!contact || !identity || !selfUserId) {
      appendUnverifiable('incoming', createdAt);
      return;
    }

    const envelope = base64ToBytes(bodyB64);
    const version = envelope[0];

    let result: EnvelopeDecodeResult | null = null;
    if (version === HANDSHAKE_ENVELOPE_VERSION) {
      result = decodeHandshakeEnvelope(envelope, {
        contactUserId,
        selfUserId,
        selfX25519SecretKey: identity.x25519SecretKey,
        selfKyberSecretKey: identity.kyberSecretKey,
        senderDilithiumPublicKey: contact.dilithiumPublicKey,
      });
    } else if (version === RATCHET_ENVELOPE_VERSION) {
      const session = await loadSession(contactUserId);
      if (session !== null) {
        result = decodeRatchetEnvelope(envelope, {
          state: session,
          senderDilithiumPublicKey: contact.dilithiumPublicKey,
          selfUserId,
          contactUserId,
        });
      }
    }

    if (result === null || !result.ok) {
      appendUnverifiable('incoming', createdAt);
      return;
    }

    await saveSession(contactUserId, result.nextState);
    const text = bytesToUtf8(result.plaintext);
    setMessages((prev) => [
      ...prev,
      { key: nextLocalKey(), direction: 'incoming', text, verified: true, createdAt },
    ]);
    await saveMessage({
      contactUserId,
      direction: 'incoming',
      body: text,
      createdAt,
    });
  }

  function handleFrame(frame: IncomingFrame) {
    if (frame.type === 'message') {
      if (frame.from !== contactUserId) {
        return;
      }
      void handleIncomingEnvelope(frame.body_b64);
      return;
    }

    if (frame.type === 'error' && frame.code === 'queue_unavailable') {
      const failedKey = lastSentKeyRef.current;
      if (!failedKey) {
        return;
      }
      setMessages((prev) =>
        prev.map((item) => (item.key === failedKey ? { ...item, deliveryFailed: true } : item))
      );
    }
  }

  // Loads crypto context (self identity + contact key bundle) and message
  // history, then opens the connection through `transportStore`, all on
  // mount. Reconnect-with-backoff lives in the store's `connect` action
  // (`../transport/store.ts`, issue #74, superseding issue #55's
  // `createReconnectingChatSocket`).
  useEffect(() => {
    let cancelled = false;

    async function setup() {
      const token = await getToken();
      if (cancelled) {
        return;
      }
      if (!token) {
        transportStore.actions.close();
        return;
      }

      const [userId, identity, contactsResponse] = await Promise.all([
        getUserId(),
        ensureLocalIdentity(),
        listContacts().catch(() => ({ contacts: [] as Contact[] })),
      ]);
      if (cancelled) {
        return;
      }

      selfUserIdRef.current = userId;
      identityRef.current = identity;
      const contact = contactsResponse.contacts.find((c) => c.user_id === contactUserId) ?? null;
      contactBundleRef.current = contact ? bundleFromContact(contact) : null;

      const rows = await getMessages(contactUserId);
      if (cancelled) {
        return;
      }
      setMessages(
        rows.map((row) => ({
          key: `db-${row.id}`,
          direction: row.direction,
          text: row.body,
          verified: true,
          createdAt: row.createdAt,
        }))
      );
      // "Read on open": opening this contact's history marks their
      // incoming messages read exactly once per mount, not once per
      // received message (that would be `handleIncomingEnvelope`, which
      // deliberately does not call this). See
      // docs/superpowers/specs/2026-09-13-friends-conversations-ux-design.md,
      // "Read semantics".
      await markContactMessagesRead(contactUserId);
      if (cancelled) {
        return;
      }

      transportStore.actions.connect(getToken);
    }

    setup();

    return () => {
      cancelled = true;
      transportStore.actions.close();
    };
  }, [contactUserId]);

  // Routes each newly-arrived frame through `handleFrame`, exactly as the
  // old `onMessage` callback did — see `processedFrameRef`'s comment above
  // for why a plain `[lastFrame]` dependency alone isn't enough.
  useEffect(() => {
    if (lastFrame && lastFrame !== processedFrameRef.current) {
      processedFrameRef.current = lastFrame;
      handleFrame(lastFrame);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFrame]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || status !== 'connected') {
      return;
    }

    const contact = contactBundleRef.current;
    const identity = identityRef.current;
    const selfUserId = selfUserIdRef.current;
    if (!contact || !identity || !selfUserId) {
      setSendError(CANNOT_VERIFY_CONTACT_ERROR);
      return;
    }

    const plaintextBytes = utf8ToBytes(text);
    let envelopeBytes: Uint8Array;
    let nextState: RatchetState;

    const session = await loadSession(contactUserId);
    if (session === null) {
      const trusted = verifyPrekeyBundle({
        x25519PublicKey: contact.x25519PublicKey,
        kyberPublicKey: contact.kyberPublicKey,
        dilithiumPublicKey: contact.dilithiumPublicKey,
        prekeySignature: contact.prekeySignature,
      });
      if (!trusted) {
        setSendError(CANNOT_VERIFY_CONTACT_ERROR);
        return;
      }

      const initiated = initiateSession({
        contactUserId,
        selfUserId,
        contactBundle: {
          x25519PublicKey: contact.x25519PublicKey,
          kyberPublicKey: contact.kyberPublicKey,
        },
      });
      const send0 = deriveNextSendingMessageKey(initiated.state);
      envelopeBytes = encodeHandshakeEnvelope({
        ea: initiated.ea,
        kyberCiphertext: initiated.kyberCiphertext,
        messageKey: send0.messageKey,
        plaintext: plaintextBytes,
        selfUserId,
        contactUserId,
        signingSecretKey: identity.dilithiumSecretKey,
      });
      nextState = send0.nextState;
    } else {
      const send = deriveNextSendingMessageKey(session);
      envelopeBytes = encodeRatchetEnvelope({
        header: send.header,
        messageKey: send.messageKey,
        plaintext: plaintextBytes,
        selfUserId,
        contactUserId,
        signingSecretKey: identity.dilithiumSecretKey,
      });
      nextState = send.nextState;
    }

    const bodyB64 = bytesToBase64(envelopeBytes);
    const createdAt = new Date().toISOString();
    const key = nextLocalKey();

    transportStore.actions.send({ type: 'send', to: contactUserId, body_b64: bodyB64 });

    // The optimistic, locally-appended copy renders the real plaintext
    // immediately — no round trip needed to see your own sent message.
    setMessages((prev) => [...prev, { key, direction: 'outgoing', text, verified: true, createdAt }]);
    lastSentKeyRef.current = key;
    setSendError(null);
    setDraft('');

    await saveSession(contactUserId, nextState);
    // Only the plaintext is persisted locally, and only now that the
    // envelope has actually been sent — see
    // docs/decisions/0007-local-history-stores-plaintext.md.
    await saveMessage({
      contactUserId,
      direction: 'outgoing',
      body: text,
      createdAt,
    });
  }

  return (
    <View className="flex-1 bg-white dark:bg-black">
      <View className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <Text className="text-lg font-semibold text-black dark:text-white">{email}</Text>
      </View>

      {status === 'reconnecting' || status === 'disconnected' ? (
        <View testID="disconnected-banner" className="bg-red-100 px-4 py-2">
          <Text className="text-center text-red-700">
            {status === 'reconnecting' ? 'Reconnecting...' : 'Disconnected'}
          </Text>
        </View>
      ) : null}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.key}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => (
          <View
            className={`px-4 py-2 ${item.direction === 'outgoing' ? 'items-end' : 'items-start'}`}
          >
            <View
              className={`rounded-lg px-3 py-2 ${
                item.verified
                  ? item.direction === 'outgoing'
                    ? 'bg-blue-500'
                    : 'bg-gray-200 dark:bg-gray-700'
                  : 'bg-red-50 dark:bg-red-950'
              }`}
            >
              {item.verified && item.text !== null ? (
                <Text
                  className={
                    item.direction === 'outgoing' ? 'text-white' : 'text-black dark:text-white'
                  }
                >
                  {item.text}
                </Text>
              ) : (
                <Text testID="unverifiable-message" className="italic text-red-500">
                  Could not verify this message
                </Text>
              )}
            </View>
            {item.deliveryFailed ? (
              <Text className="mt-1 text-xs text-red-500">
                Not delivered: message could not be queued
              </Text>
            ) : null}
          </View>
        )}
      />

      {sendError !== null ? (
        <View className="px-4 py-1">
          <Text testID="send-error" className="text-sm text-red-500">
            {sendError}
          </Text>
        </View>
      ) : null}

      <View className="flex-row items-center border-t border-gray-200 px-4 py-3 dark:border-gray-700">
        <TextInput
          className="mr-3 flex-1 rounded-lg border border-gray-300 px-4 py-2 text-base text-black dark:border-gray-700 dark:text-white"
          placeholder="Message"
          placeholderTextColor="#9CA3AF"
          value={draft}
          onChangeText={setDraft}
        />
        <Pressable
          accessibilityRole="button"
          onPress={handleSend}
          className="rounded-lg bg-blue-500 px-4 py-2"
        >
          <Text className="text-base font-semibold text-white">Send</Text>
        </Pressable>
      </View>
    </View>
  );
}
