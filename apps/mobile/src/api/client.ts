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

export async function addContact(email: string): Promise<Contact> {
  const token = await requireToken();

  const response = await fetch(`${API_BASE_URL}/api/contacts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) {
    await throwApiError(response);
  }

  return (await response.json()) as Contact;
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
