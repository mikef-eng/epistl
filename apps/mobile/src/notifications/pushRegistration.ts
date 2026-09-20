/**
 * Best-effort push notification setup (issue #169): asks for OS permission
 * if not yet determined, fetches the Expo push token, and registers it with
 * the server. Every failure (denied permission, missing EAS projectId,
 * network error) is swallowed -- no user-visible error, no retry loop.
 */
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

import { registerPushToken } from '../api/client';

function resolveProjectId(): string | null {
  const fromExpo: unknown = Constants.expoConfig?.extra?.eas?.projectId;
  if (typeof fromExpo === 'string' && fromExpo.length > 0) {
    return fromExpo;
  }
  const fromEas: unknown = Constants.easConfig?.projectId;
  if (typeof fromEas === 'string' && fromEas.length > 0) {
    return fromEas;
  }
  return null;
}

async function ensurePermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.status === 'granted') {
    return true;
  }
  if (current.status !== 'undetermined') {
    return false;
  }
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === 'granted';
}

async function fetchAndRegisterToken(): Promise<void> {
  const projectId = resolveProjectId();
  if (projectId === null) {
    return;
  }
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  await registerPushToken(data);
}

async function requestPermissionAndRegister(): Promise<void> {
  try {
    if (await ensurePermission()) {
      await fetchAndRegisterToken();
    }
  } catch {
    // Best-effort -- see module doc comment.
  }
}

/** Kicks off permission + registration once and re-registers whenever the
 * device push token rotates. Returns a cleanup that removes the listener. */
export function startPushRegistration(): () => void {
  void requestPermissionAndRegister();

  let subscription: { remove: () => void } | null = null;
  try {
    subscription = Notifications.addPushTokenListener(() => {
      void (async () => {
        try {
          await fetchAndRegisterToken();
        } catch {
          // Best-effort.
        }
      })();
    });
  } catch {
    // Best-effort.
  }

  return () => {
    subscription?.remove();
  };
}
