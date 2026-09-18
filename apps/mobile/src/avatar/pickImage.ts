import * as ImagePicker from 'expo-image-picker';

/**
 * Result of `pickAvatarImage()` -- a discriminated union so callers can
 * switch on `status` instead of separately tracking a `canceled` boolean
 * and an `assets` array the way `expo-image-picker`'s raw result does.
 * Extracted from `SettingsScreen.tsx`'s original inline `handlePickAvatar`
 * (issue #182) so `SetupProfileScreen.tsx` (issue #216) can reuse the exact
 * same permission + picker flow without duplicating it.
 */
export type PickAvatarResult =
  | { status: 'picked'; uri: string }
  | { status: 'canceled' }
  | { status: 'permission_denied' };

/**
 * Opens the device's photo library (library only -- no camera capture) and
 * resolves with the outcome. Deliberately does not upload anything -- that
 * remains a separate step (`../api/client.ts`'s `uploadAvatar`), left
 * entirely to the caller: `SettingsScreen` uploads immediately on pick
 * (issue #182), while `SetupProfileScreen` defers the actual upload until
 * after the account exists (issue #216), since `uploadAvatar` requires an
 * authenticated session that doesn't exist yet at pick time there.
 */
export async function pickAvatarImage(): Promise<PickAvatarResult> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return { status: 'permission_denied' };
  }

  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
  if (result.canceled || result.assets.length === 0) {
    return { status: 'canceled' };
  }

  return { status: 'picked', uri: result.assets[0].uri };
}
