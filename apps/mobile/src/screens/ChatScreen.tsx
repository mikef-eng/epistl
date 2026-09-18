import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useStore } from '@tanstack/react-store';
import { useColorScheme } from 'nativewind';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type Contact, listContacts } from '../api/client';
import { bundleFromContact, type ContactKeyBundle } from '../api/contactBundle';
import { getToken, getUserId } from '../api/session';
import Avatar from '../components/Avatar';
import { ensureLocalIdentity, type Identity } from '../crypto/identity';
import { encodeHandshakeEnvelope, encodeRatchetEnvelope } from '../crypto/envelope';
import {
  deriveNextSendingMessageKey,
  initiateSession,
  loadSession,
  saveSession,
  verifyPrekeyBundle,
  type RatchetState,
} from '../crypto/session';
import { inboxStore, type InboxEvent } from '../inbox/listener';
import type { RootStackParamList } from '../navigation/types';
import {
  getMessages,
  markContactMessagesRead,
  saveMessage,
  type MessageDirection,
} from '../storage/messages';
import { transportStore, type IncomingFrame } from '../transport/store';
import { bytesToBase64, utf8ToBytes } from '../utils/base64';

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

let localKeySeq = 0;
/** Generates a stable React key for messages that don't have a DB row id
 * yet (optimistic sends, freshly received messages). */
function nextLocalKey(): string {
  localKeySeq += 1;
  return `local-${localKeySeq}`;
}

const CANNOT_VERIFY_CONTACT_ERROR = "Cannot verify this contact's keys";

/** First letter of the contact's email, uppercased, for the header avatar
 * circle -- matches `FriendsScreen`/`ConversationsScreen`'s `initialFor`. */
function initialFor(email: string): string {
  return email.trim().charAt(0).toUpperCase() || '?';
}

/** Short absolute clock time (e.g. "3:45 PM") for the per-message
 * timestamp label -- deliberately not the relative "2h ago" style
 * `ConversationsScreen`'s `formatRelativeTime` uses for list rows, since a
 * per-message context reads better with a fixed time-of-day. */
function formatMessageTime(createdAt: string): string {
  return new Date(createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function ChatScreen({ navigation, route }: Props) {
  const { userId: contactUserId, email } = route.params;
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  // Matches the header's existing `text-black dark:text-white` convention --
  // `Ionicons`' `color` prop can't take a NativeWind `className`.
  const headerIconColor = colorScheme === 'dark' ? '#FFFFFF' : '#000000';

  const [messages, setMessages] = useState<ChatListItem[]>([]);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);

  const status = useStore(transportStore, (s) => s.status);
  const lastFrame = useStore(transportStore, (s) => s.lastFrame);
  const lastInboxEvent = useStore(inboxStore, (s) => s.lastEvent);

  const lastSentKeyRef = useRef<string | null>(null);
  const listRef = useRef<FlatList<ChatListItem> | null>(null);
  // Frames already routed through `handleFrame` below, keyed by object
  // identity. `transportStore` is a module-wide singleton whose `lastFrame`
  // can carry over from a previous mount of this same screen (e.g.
  // navigating away from and back to the same contact); without this guard
  // that stale frame would be reprocessed on remount. Seeded with whatever
  // `lastFrame` already holds at mount time so only frames that arrive
  // *after* mount are treated as new. Only `'error'` frames reach
  // `handleFrame` now -- `'message'` frames are decoded exactly once, for
  // every contact, by the app-level `../inbox/listener.ts` (issue #165),
  // never here.
  const processedFrameRef = useRef<IncomingFrame | null>(transportStore.state.lastFrame);
  // Same dedupe pattern as `processedFrameRef` above, but for
  // `inboxStore`'s published decode outcomes (see the effect below) rather
  // than raw transport frames.
  const processedInboxEventRef = useRef<InboxEvent | null>(inboxStore.state.lastEvent);

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

  function handleFrame(frame: IncomingFrame) {
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

  /** Renders one of `../inbox/listener.ts`'s published decode outcomes for
   * *this* contact -- ignores events for every other contact. See the
   * effect below for why `ChatScreen` observes `inboxStore` this way
   * instead of decoding anything itself. */
  function handleInboxEvent(event: InboxEvent) {
    if (event.contactUserId !== contactUserId) {
      return;
    }
    if (event.status === 'unverifiable') {
      appendUnverifiable('incoming', event.createdAt);
      return;
    }
    setMessages((prev) => [
      ...prev,
      {
        key: nextLocalKey(),
        direction: 'incoming',
        text: event.text,
        verified: true,
        createdAt: event.createdAt,
      },
    ]);
  }

  // Loads crypto context (self identity + contact key bundle, needed for
  // `handleSend` below) and this contact's message history on mount. The
  // transport connection itself is no longer opened/closed here -- it is
  // owned at the app level by `../inbox/appSession.ts`
  // (`../navigation/MainTabs.tsx`'s mount/unmount, issue #165), independent
  // of which contact's chat (if any) is currently open.
  useEffect(() => {
    let cancelled = false;

    async function setup() {
      const token = await getToken();
      if (cancelled) {
        return;
      }
      if (!token) {
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
      // received message (that would be the inbox-event effect below,
      // which deliberately does not call this). See
      // docs/superpowers/specs/2026-09-13-friends-conversations-ux-design.md,
      // "Read semantics".
      await markContactMessagesRead(contactUserId);
    }

    setup();

    return () => {
      cancelled = true;
    };
  }, [contactUserId]);

  // Routes each newly-arrived frame through `handleFrame`, exactly as the
  // old `onMessage` callback did — see `processedFrameRef`'s comment above
  // for why a plain `[lastFrame]` dependency alone isn't enough. Only
  // `'error'` frames reach `handleFrame` now (see that function).
  useEffect(() => {
    if (lastFrame && lastFrame !== processedFrameRef.current) {
      processedFrameRef.current = lastFrame;
      handleFrame(lastFrame);
    }
  }, [lastFrame]);

  // Reflects this contact's newly-decoded incoming messages, without
  // decoding anything itself: `../inbox/listener.ts` (issue #165) is the
  // only place that decodes a live frame, for every contact, independent of
  // which `ChatScreen` (if any) is mounted; this effect just renders
  // whichever of its published outcomes belong to *this* contact.
  useEffect(() => {
    if (lastInboxEvent && lastInboxEvent !== processedInboxEventRef.current) {
      processedInboxEventRef.current = lastInboxEvent;
      handleInboxEvent(lastInboxEvent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastInboxEvent, contactUserId]);

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
      <View
        style={{ paddingTop: insets.top }}
        className="flex-row items-center border-b border-gray-200 px-4 py-3 dark:border-gray-700"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => navigation.goBack()}
          className="mr-3"
        >
          <Ionicons name="arrow-back" size={24} color={headerIconColor} />
        </Pressable>
        <Avatar
          userId={contactUserId}
          fallbackText={initialFor(email)}
          wrapperClassName="mr-2 h-8 w-8 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700"
          imageClassName="h-8 w-8 rounded-full"
          textClassName="text-sm font-semibold text-black dark:text-white"
        />
        <Text className="text-lg font-semibold text-black dark:text-white">{email}</Text>
      </View>

      {status === 'reconnecting' || status === 'disconnected' ? (
        <View testID="disconnected-banner" className="bg-red-100 px-4 py-2 dark:bg-red-950">
          <Text className="text-center text-red-700 dark:text-red-300">
            {status === 'reconnecting' ? 'Reconnecting...' : 'Disconnected'}
          </Text>
        </View>
      ) : null}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.key}
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => (
          <View
            className={`px-4 py-2 ${item.direction === 'outgoing' ? 'items-end' : 'items-start'}`}
          >
            <Text className="mb-1 text-xs text-gray-400 dark:text-gray-500">
              {formatMessageTime(item.createdAt)}
            </Text>
            <View
              className={`rounded-lg px-3 py-2 ${
                item.verified
                  ? item.direction === 'outgoing'
                    ? 'bg-[#8B2F4B]'
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

      <View
        style={{ paddingBottom: insets.bottom }}
        className="flex-row items-center border-t border-gray-200 px-4 py-3 dark:border-gray-700"
      >
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
          className="rounded-lg bg-[#8B2F4B] px-4 py-2"
        >
          <Text className="text-base font-semibold text-white">Send</Text>
        </Pressable>
      </View>
    </View>
  );
}
