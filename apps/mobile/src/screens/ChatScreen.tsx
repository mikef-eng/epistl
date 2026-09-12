import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';

import { getToken } from '../api/session';
import { createChatSocket, type IncomingFrame } from '../api/ws';
import type { RootStackParamList } from '../navigation/types';
import { getMessages, saveMessage, type MessageDirection } from '../storage/messages';
import { base64ToUtf8, utf8ToBase64 } from '../utils/base64';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

interface ChatListItem {
  key: string;
  direction: MessageDirection;
  bodyB64: string;
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

export default function ChatScreen({ route }: Props) {
  const { userId: contactUserId, email } = route.params;

  const [messages, setMessages] = useState<ChatListItem[]>([]);
  const [draft, setDraft] = useState('');
  const [connected, setConnected] = useState(true);

  const socketRef = useRef<WebSocket | null>(null);
  const lastSentKeyRef = useRef<string | null>(null);
  const listRef = useRef<FlatList<ChatListItem> | null>(null);

  // Load existing history for this contact on mount.
  useEffect(() => {
    let cancelled = false;
    getMessages(contactUserId).then((rows) => {
      if (cancelled) {
        return;
      }
      setMessages(
        rows.map((row) => ({
          key: `db-${row.id}`,
          direction: row.direction,
          bodyB64: row.bodyB64,
          createdAt: row.createdAt,
        }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [contactUserId]);

  function handleFrame(frame: IncomingFrame) {
    if (frame.type === 'message') {
      if (frame.from !== contactUserId) {
        return;
      }
      const createdAt = new Date().toISOString();
      const item: ChatListItem = {
        key: nextLocalKey(),
        direction: 'incoming',
        bodyB64: frame.body_b64,
        createdAt,
      };
      setMessages((prev) => [...prev, item]);
      saveMessage({ contactUserId, direction: 'incoming', bodyB64: frame.body_b64, createdAt });
      return;
    }

    if (frame.type === 'error' && frame.code === 'recipient_offline') {
      const failedKey = lastSentKeyRef.current;
      if (!failedKey) {
        return;
      }
      setMessages((prev) =>
        prev.map((item) => (item.key === failedKey ? { ...item, deliveryFailed: true } : item))
      );
    }
  }

  // Open the WebSocket connection on mount, close it on unmount. No
  // reconnect logic by design (see issue #10 out-of-scope).
  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;

    getToken().then((token) => {
      if (cancelled) {
        return;
      }
      if (!token) {
        setConnected(false);
        return;
      }

      socket = createChatSocket(token);
      socketRef.current = socket;

      socket.onmessage = (event: { data: unknown }) => {
        let frame: IncomingFrame;
        try {
          frame = JSON.parse(String(event.data)) as IncomingFrame;
        } catch {
          return;
        }
        handleFrame(frame);
      };
      socket.onclose = () => {
        if (!cancelled) {
          setConnected(false);
        }
      };
      socket.onerror = () => {
        if (!cancelled) {
          setConnected(false);
        }
      };
    });

    return () => {
      cancelled = true;
      socket?.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactUserId]);

  function handleSend() {
    const text = draft.trim();
    if (!text || !socketRef.current) {
      return;
    }

    const bodyB64 = utf8ToBase64(text);
    const createdAt = new Date().toISOString();
    const key = nextLocalKey();

    socketRef.current.send(
      JSON.stringify({ type: 'send', to: contactUserId, body_b64: bodyB64 })
    );

    setMessages((prev) => [...prev, { key, direction: 'outgoing', bodyB64, createdAt }]);
    lastSentKeyRef.current = key;
    saveMessage({ contactUserId, direction: 'outgoing', bodyB64, createdAt });
    setDraft('');
  }

  return (
    <View className="flex-1 bg-white">
      <View className="border-b border-gray-200 px-4 py-3">
        <Text className="text-lg font-semibold">{email}</Text>
      </View>

      {!connected ? (
        <View testID="disconnected-banner" className="bg-red-100 px-4 py-2">
          <Text className="text-center text-red-700">Disconnected</Text>
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
                item.direction === 'outgoing' ? 'bg-blue-500' : 'bg-gray-200'
              }`}
            >
              <Text className={item.direction === 'outgoing' ? 'text-white' : 'text-black'}>
                {base64ToUtf8(item.bodyB64)}
              </Text>
            </View>
            {item.deliveryFailed ? (
              <Text className="mt-1 text-xs text-red-500">
                Not delivered: contact is offline
              </Text>
            ) : null}
          </View>
        )}
      />

      <View className="flex-row items-center border-t border-gray-200 px-4 py-3">
        <TextInput
          className="mr-3 flex-1 rounded-lg border border-gray-300 px-4 py-2 text-base"
          placeholder="Message"
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
