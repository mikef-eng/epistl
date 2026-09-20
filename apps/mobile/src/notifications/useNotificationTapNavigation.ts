/**
 * Tap-to-open-conversation (issue #169). `useLastNotificationResponse`
 * covers foregrounded, backgrounded, and cold-start taps. The tapped
 * notification's `data.fromUserId` is resolved against the caller's contacts
 * (which carry the `email` that `Chat` needs); anything unresolvable falls
 * back to the Conversations tab.
 */
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';

import { listContacts } from '../api/client';
import type { RootStackParamList } from '../navigation/types';

type Navigate = NativeStackNavigationProp<RootStackParamList>['navigate'];

export function useNotificationTapNavigation(navigate: Navigate): void {
  const response = Notifications.useLastNotificationResponse();
  const handled = useRef<unknown>(null);

  useEffect(() => {
    if (!response || handled.current === response) {
      return;
    }
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
      return;
    }
    handled.current = response;

    const data: unknown = response.notification.request.content.data;
    const fromUserId =
      data !== null && typeof data === 'object' && 'fromUserId' in data
        ? (data as { fromUserId: unknown }).fromUserId
        : null;

    void (async () => {
      if (typeof fromUserId === 'string') {
        try {
          const { contacts } = await listContacts();
          const contact = contacts.find((c) => c.user_id === fromUserId);
          if (contact) {
            navigate('Chat', { userId: contact.user_id, email: contact.email });
            return;
          }
        } catch {
          // Fall through to the Conversations fallback.
        }
      }
      navigate('Main', { screen: 'Conversations' });
    })();
  }, [response, navigate]);
}
