import { useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';

import { API_BASE_URL } from '../api/client';
import { getToken } from '../api/session';

/**
 * Renders a user's real avatar (`GET /api/avatar/{userId}`, issue #189 --
 * a `302` redirect to a short-lived presigned URL that React Native's
 * `Image` follows transparently, no special redirect-handling code
 * needed), falling back to the existing colored-initial circle whenever
 * there is nothing to show yet: the session token hasn't loaded, the user
 * has no avatar set (the endpoint 404s), or the image otherwise fails to
 * load (network error, or the redirect's presigned URL expiring before
 * the client follows it -- both surface as a plain `Image` `onError`).
 *
 * Shared by `ConversationsScreen`, `FriendsScreen`, `ChatScreen`'s header,
 * and `SettingsScreen`'s own avatar preview/picker control (issue #182).
 * Each caller keeps computing its own fallback initial (`initialFor`) and
 * owns its exact row/header sizing via `wrapperClassName`/`imageClassName`
 * -- this component only decides *whether* to render the image or the
 * fallback text.
 */
interface AvatarProps {
  userId: string;
  /** Precomputed fallback text (e.g. `initialFor(email)`), rendered
   * whenever the real image isn't shown. */
  fallbackText: string;
  /** Full Tailwind classes for the outer circle (size, margin, rounding,
   * background) -- matches whatever markup this replaces at each call
   * site exactly, so the fallback state looks identical to before. */
  wrapperClassName: string;
  /** Tailwind classes for the `Image` itself (size + rounding, no
   * margin -- the margin already lives on `wrapperClassName`). */
  imageClassName: string;
  textClassName: string;
  /** Bumped by a caller (e.g. `SettingsScreen` after a successful upload)
   * to force a fresh request past any client-side image cache for the
   * same `userId` -- appended as a harmless query string the server
   * ignores (see `apps/api/src/avatars.rs`'s `Path` extractor). */
  cacheBust?: number;
}

export default function Avatar({
  userId,
  fallbackText,
  wrapperClassName,
  imageClassName,
  textClassName,
  cacheBust,
}: AvatarProps) {
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getToken().then((stored) => {
      if (!cancelled) {
        setToken(stored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A new userId or a bumped cacheBust both mean "try the image again" --
  // clears any previous load failure so a fresh attempt is made. Adjusted
  // during render (React's documented pattern for resetting state when a
  // prop changes: https://react.dev/learn/you-might-not-need-an-effect),
  // not in an effect, to avoid an extra render pass.
  const retryKey = `${userId}:${cacheBust ?? ''}`;
  const [prevRetryKey, setPrevRetryKey] = useState(retryKey);
  if (retryKey !== prevRetryKey) {
    setPrevRetryKey(retryKey);
    setFailed(false);
  }

  const showImage = token !== null && !failed;
  const uri = `${API_BASE_URL}/api/avatar/${userId}${
    cacheBust !== undefined ? `?v=${cacheBust}` : ''
  }`;

  return (
    <View className={wrapperClassName}>
      {showImage ? (
        <Image
          testID={`avatar-image-${userId}`}
          source={{ uri, headers: { Authorization: `Bearer ${token}` } }}
          className={imageClassName}
          onError={() => setFailed(true)}
        />
      ) : (
        <Text className={textClassName}>{fallbackText}</Text>
      )}
    </View>
  );
}
