/**
 * Tap-to-open-conversation (issue #169). `useLastNotificationResponse`
 * covers foregrounded, backgrounded, and cold-start taps. The tapped
 * notification's `data.fromUserId` is resolved to a `username` via the local
 * SQLite contact cache (no network call); a sender with no cache entry (or
 * a cache read failure) falls back to the Conversations tab.
 */
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';

import type { RootStackParamList } from '../navigation/types';
import { getCachedContactUsername } from '../storage/contacts';

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
          const username = await getCachedContactUsername(fromUserId);
          if (username !== null) {
            navigate('Chat', { userId: fromUserId, username });
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
