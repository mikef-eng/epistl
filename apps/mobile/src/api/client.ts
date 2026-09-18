/**
 * Typed client for the Epistl backend REST API. Every function here either
 * resolves with the parsed JSON response body or rejects with an `ApiError`
 * carrying the backend's `error` code string and the HTTP status.
 *
 * The base URL is read from `EXPO_PUBLIC_API_URL` in exactly one place
 * (`API_BASE_URL` below), defaulting to `http://localhost:3000`. It is
 * exported so other transports that talk to the same backend (e.g. `./ws.ts`
 * for the chat WebSocket relay) can derive their URL from it instead of
 * introducing a second, independent env var.
 */
import { getToken, saveEmail, saveToken } from './session';

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

/** Thrown by every function in this module on a non-2xx response, and by
 * the contacts functions locally when no session token is stored. */
export class ApiError extends Error {
  /** The backend's `error` field (or a local code, e.g. `"no_session"`). */
  readonly code: string;
  /** The HTTP status of the failed response, or `0` for local errors that
   * never reached the network (e.g. no stored session token). */
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export interface AuthUser {
  [key: string]: unknown;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface Contact {
  user_id: string;
  email: string;
  added_at: string;
  x25519_public_key_b64: string | null;
  kyber_public_key_b64: string | null;
  dilithium_public_key_b64: string | null;
  prekey_signature_b64: string | null;
}

export interface ContactsResponse {
  contacts: Contact[];
}

/** One pending contact request as returned by `GET /api/contacts/requests`
 * (either side of the pair -- `FriendsScreen`'s Requests section renders
 * `incoming` with Accept/Decline actions and `outgoing` read-only). */
export interface ContactRequestParty {
  id: string;
  user_id: string;
  email: string;
  created_at: string;
}

export interface ContactRequestsResponse {
  incoming: ContactRequestParty[];
  outgoing: ContactRequestParty[];
}

/** The row returned by issue #79's `POST /api/contacts/requests` on success
 * (`201`). */
export interface ContactRequestCreated {
  id: string;
  requester_user_id: string;
  recipient_user_id: string;
  status: string;
  created_at: string;
}

/** Thrown by `sendContactRequest` specifically for the `409
 * incoming_request_exists` crossed-request case, carrying the pending
 * incoming request's id so the caller can offer to accept it (issue #80's
 * `POST /api/contacts/requests/{id}/accept`) without a second round trip. */
export class IncomingRequestExistsError extends ApiError {
  readonly requestId: string;

  constructor(requestId: string) {
    super('incoming_request_exists', 409);
    this.name = 'IncomingRequestExistsError';
    this.requestId = requestId;
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCodeFrom(body: unknown): string {
  if (
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'string'
  ) {
    return (body as { error: string }).error;
  }
  return 'unknown_error';
}

async function throwApiError(response: Response): Promise<never> {
  const body = await parseJson(response);
  throw new ApiError(errorCodeFrom(body), response.status);
}

/** Extracts the authenticated user's email from an `AuthResponse.user`,
 * whose shape is otherwise opaque to this app (it passes through
 * better-auth's user object as-is) -- mirrors `LoginScreen.tsx`'s
 * `userIdOf` for the same object. */
function emailOf(user: AuthUser): string | null {
  return typeof user.email === 'string' ? user.email : null;
}

async function requireToken(): Promise<string> {
  const token = await getToken();
  if (!token) {
    throw new ApiError('no_session', 0);
  }
  return token;
}

export async function signup(email: string, password: string): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE_URL}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  const data = (await response.json()) as AuthResponse;
  await saveToken(data.token);
  const signupEmail = emailOf(data.user);
  if (signupEmail !== null) {
    await saveEmail(signupEmail);
  }
  return data;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  const data = (await response.json()) as AuthResponse;
  await saveToken(data.token);
  const loginEmail = emailOf(data.user);
  if (loginEmail !== null) {
    await saveEmail(loginEmail);
  }
  return data;
}

export async function listContacts(): Promise<ContactsResponse> {
  const token = await requireToken();

  const response = await fetch(`${API_BASE_URL}/api/contacts`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  return (await response.json()) as ContactsResponse;
}

/** Sends a contact request by email (issue #79's
 * `POST /api/contacts/requests`), replacing the former `addContact`'s
 * exact-match immediate-add call. Resolves with the created request row on
 * `201`. On the crossed-request case (`409 incoming_request_exists` -- the
 * target already sent the caller a pending request) rejects with an
 * `IncomingRequestExistsError` carrying that request's id instead of a
 * plain `ApiError`, so the caller can offer to accept it directly. */
export async function sendContactRequest(email: string): Promise<ContactRequestCreated> {
  const token = await requireToken();

  const response = await fetch(`${API_BASE_URL}/api/contacts/requests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) {
    const body = await parseJson(response);
    const code = errorCodeFrom(body);
    if (
      code === 'incoming_request_exists' &&
      body !== null &&
      typeof body === 'object' &&
      'request_id' in body &&
      typeof (body as { request_id: unknown }).request_id === 'string'
    ) {
      throw new IncomingRequestExistsError((body as { request_id: string }).request_id);
    }
    throw new ApiError(code, response.status);
  }

  return (await response.json()) as ContactRequestCreated;
}

export async function registerKeys(
  x25519PublicKeyB64: string,
  kyberPublicKeyB64: string,
  dilithiumPublicKeyB64: string,
  prekeySignatureB64: string
): Promise<void> {
  const token = await requireToken();

  const response = await fetch(`${API_BASE_URL}/api/keys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      x25519_public_key_b64: x25519PublicKeyB64,
      kyber_public_key_b64: kyberPublicKeyB64,
      dilithium_public_key_b64: dilithiumPublicKeyB64,
      prekey_signature_b64: prekeySignatureB64,
    }),
  });

  if (!response.ok) {
    await throwApiError(response);
  }
}

/** Lists the caller's pending contact requests, both directions (issue
 * #79's `GET /api/contacts/requests`). Backs `FriendsScreen`'s Requests
 * section. */
export async function listContactRequests(): Promise<ContactRequestsResponse> {
  const token = await requireToken();

  const response = await fetch(`${API_BASE_URL}/api/contacts/requests`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  return (await response.json()) as ContactRequestsResponse;
}

/** Accepts an incoming pending contact request (issue #80's
 * `POST /api/contacts/requests/{id}/accept`). Resolves on `204`; the caller
 * is responsible for removing the request from local state only after this
 * resolves. */
export async function acceptContactRequest(requestId: string): Promise<void> {
  const token = await requireToken();

  const response = await fetch(
    `${API_BASE_URL}/api/contacts/requests/${encodeURIComponent(requestId)}/accept`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!response.ok) {
    await throwApiError(response);
  }
}

/** Declines an incoming pending contact request (issue #80's
 * `POST /api/contacts/requests/{id}/decline`). Resolves on `204`; the
 * caller is responsible for removing the request from local state only
 * after this resolves. */
export async function declineContactRequest(requestId: string): Promise<void> {
  const token = await requireToken();

  const response = await fetch(
    `${API_BASE_URL}/api/contacts/requests/${encodeURIComponent(requestId)}/decline`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!response.ok) {
    await throwApiError(response);
  }
}

/** Cancels the caller's own pending outgoing contact request (issue #83's
 * `POST /api/contacts/requests/{id}/cancel`, issue #126 part B server-side).
 * Resolves on `204`; the caller is responsible for updating local state
 * only after this resolves. Mirrors `acceptContactRequest`/
 * `declineContactRequest` above verbatim, just against the requester's own
 * outgoing request rather than the recipient's incoming one. */
export async function cancelContactRequest(requestId: string): Promise<void> {
  const token = await requireToken();

  const response = await fetch(
    `${API_BASE_URL}/api/contacts/requests/${encodeURIComponent(requestId)}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!response.ok) {
    await throwApiError(response);
  }
}

export async function removeContact(userId: string): Promise<void> {
  const token = await requireToken();

  const response = await fetch(`${API_BASE_URL}/api/contacts/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    await throwApiError(response);
  }
}

/** One row returned by `GET /api/users/search` (issue #99) -- deliberately
 * just `user_id`/`email`, no relationship status (see that issue's module
 * docs for why). */
export interface SearchUser {
  user_id: string;
  email: string;
}

export interface SearchUsersResponse {
  users: SearchUser[];
}

/** Discover-search (issue #99's `GET /api/users/search`), backing
 * `AddContactScreen`'s search-as-you-type field (issue #100). The caller is
 * responsible for enforcing the minimum query length client-side (this
 * function fires the request regardless of `query`'s length) and for
 * distinguishing a `429 rate_limited` `ApiError` from other failures --
 * this function surfaces both as a plain `ApiError` rather than a
 * dedicated subclass, since the two are otherwise no different from any
 * other endpoint's error shape. */
export async function searchUsers(query: string): Promise<SearchUsersResponse> {
  const token = await requireToken();

  const response = await fetch(
    `${API_BASE_URL}/api/users/search?q=${encodeURIComponent(query)}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!response.ok) {
    await throwApiError(response);
  }

  return (await response.json()) as SearchUsersResponse;
}

/** Deletes the caller's own account server-side (issue #91's endpoint).
 * Resolves on `204`; the caller (`SettingsScreen`'s delete-account flow,
 * issue #92) is responsible for performing the local wipe only after this
 * resolves successfully -- this function itself has no local side effects
 * beyond the `requireToken()` read every other authenticated call already
 * does. */
export async function deleteAccount(): Promise<void> {
  const token = await requireToken();

  const response = await fetch(`${API_BASE_URL}/api/account`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    await throwApiError(response);
  }
}

/** `POST /api/avatar/upload-url`'s response shape (issue #189's step 1) --
 * `uploadUrl` is a short-lived presigned PUT URL against the object
 * storage backend, not this API. */
interface AvatarUploadUrlResponse {
  uploadUrl: string;
  contentType: string;
}

/** `POST /api/avatar/confirm`'s response shape (issue #189's step 3) --
 * `image` is this API's own avatar serving path (`/api/avatar/{user_id}`),
 * the only avatar reference this app ever persists (see
 * `../session.ts`'s `saveAvatarPath`). */
export interface AvatarConfirmResponse {
  image: string;
}

/** Content type inferred from the picked image's file extension, for
 * `uploadAvatar`'s step 1 request below -- mirrors
 * `apps/api/src/avatars.rs`'s `ALLOWED_CONTENT_TYPES` (`image/png`,
 * `image/jpeg`). Anything other than a `.png` extension is sent as
 * `image/jpeg`; a genuine mismatch is still caught by the server's own
 * `400 invalid_content_type` from step 1, which surfaces as a plain
 * `ApiError` to the caller either way. */
function contentTypeFromUri(uri: string): string {
  return uri.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
}

/** Uploads `uri` (a local file URI from `expo-image-picker`) as the
 * caller's avatar, via issue #189's three-step presigned-URL flow:
 * 1. `POST /api/avatar/upload-url` with the inferred content type, via
 *    this file's usual API-base-URL/bearer-token request helper.
 * 2. `PUT` the image bytes directly to the returned `uploadUrl` -- a
 *    plain, unauthenticated HTTP PUT (deliberately not through this
 *    file's `requireToken()`/`API_BASE_URL` helper pattern): `uploadUrl`
 *    targets a different host entirely (the object storage backend, not
 *    this API), and the presigned URL itself is the credential.
 * 3. `POST /api/avatar/confirm` to finalize it, resolving with its
 *    `{ image }` response on success.
 *
 * Rejects with an `ApiError` at whichever step fails first: step 1's
 * `400 invalid_content_type`, a non-2xx step 2 PUT (`upload_failed`, no
 * server-provided code since this response never reaches this API), or
 * step 3's `404`/`400 file_too_large`. */
export async function uploadAvatar(uri: string): Promise<AvatarConfirmResponse> {
  const token = await requireToken();
  const contentType = contentTypeFromUri(uri);
  // Read the picked image's bytes off-device first (a local file/asset
  // URI, not a network request against this API) so they're ready before
  // step 1 -- the order relative to step 1's request doesn't matter
  // functionally, since the two are independent until the PUT below.
  const imageBlob = await (await fetch(uri)).blob();

  const uploadUrlResponse = await fetch(`${API_BASE_URL}/api/avatar/upload-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ contentType }),
  });

  if (!uploadUrlResponse.ok) {
    await throwApiError(uploadUrlResponse);
  }

  const { uploadUrl } = (await uploadUrlResponse.json()) as AvatarUploadUrlResponse;

  const putResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: imageBlob,
  });

  if (!putResponse.ok) {
    throw new ApiError('upload_failed', putResponse.status);
  }

  const confirmResponse = await fetch(`${API_BASE_URL}/api/avatar/confirm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!confirmResponse.ok) {
    await throwApiError(confirmResponse);
  }

  return (await confirmResponse.json()) as AvatarConfirmResponse;
}
