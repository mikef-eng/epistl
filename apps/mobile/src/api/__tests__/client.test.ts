import * as session from '../session';
import * as contactsStorage from '../../storage/contacts';
import {
  ApiError,
  IncomingRequestExistsError,
  signup,
  login,
  listContacts,
  sendContactRequest,
  registerKeys,
  removeContact,
  deleteAccount,
  listContactRequests,
  acceptContactRequest,
  declineContactRequest,
  searchUsers,
} from '../client';

jest.mock('../session', () => ({
  saveToken: jest.fn(),
  getToken: jest.fn(),
  clearToken: jest.fn(),
  saveEmail: jest.fn(),
}));

jest.mock('../../storage/contacts', () => ({
  upsertContacts: jest.fn(),
}));

const mockSession = session as jest.Mocked<typeof session>;
const mockContactsStorage = contactsStorage as jest.Mocked<typeof contactsStorage>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('client', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (globalThis as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  });

  describe('signup', () => {
    it('POSTs to /signup with the email/password body and default base URL', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(201, { token: 'tok-1', user: { id: 'u1' } }),
      );

      await signup('a@example.com', 'hunter2');

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com', password: 'hunter2' }),
      });
    });

    it('persists the returned token via the session module and resolves the parsed body', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(201, { token: 'tok-1', user: { id: 'u1' } }),
      );

      const result = await signup('a@example.com', 'hunter2');

      expect(mockSession.saveToken).toHaveBeenCalledWith('tok-1');
      expect(result).toEqual({ token: 'tok-1', user: { id: 'u1' } });
    });

    it('throws an ApiError with the "email already registered" code on 409', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, { error: 'email already registered' }),
      );

      await expect(signup('a@example.com', 'hunter2')).rejects.toMatchObject({
        code: 'email already registered',
        status: 409,
      });
      expect(mockSession.saveToken).not.toHaveBeenCalled();
    });

    it('persists the authenticated user\'s email via the session module (issue #125)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(201, { token: 'tok-1', user: { id: 'u1', email: 'a@example.com' } }),
      );

      await signup('a@example.com', 'hunter2');

      expect(mockSession.saveEmail).toHaveBeenCalledWith('a@example.com');
    });

    it('does not persist an email when the user object has no email field', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(201, { token: 'tok-1', user: { id: 'u1' } }));

      await signup('a@example.com', 'hunter2');

      expect(mockSession.saveEmail).not.toHaveBeenCalled();
    });

    it('throws an ApiError with the "invalid input" code on 400', async () => {
      fetchMock.mockResolvedValue(jsonResponse(400, { error: 'invalid input' }));

      await expect(signup('', '')).rejects.toBeInstanceOf(ApiError);
      await expect(signup('', '')).rejects.toMatchObject({
        code: 'invalid input',
        status: 400,
      });
    });
  });

  describe('login', () => {
    it('POSTs to /login with the email/password body', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'tok-2', user: {} }));

      await login('a@example.com', 'hunter2');

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@example.com', password: 'hunter2' }),
      });
    });

    it('persists the returned token via the session module', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'tok-2', user: {} }));

      await login('a@example.com', 'hunter2');

      expect(mockSession.saveToken).toHaveBeenCalledWith('tok-2');
    });

    it('persists the authenticated user\'s email via the session module (issue #125)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { token: 'tok-2', user: { id: 'u1', email: 'a@example.com' } }),
      );

      await login('a@example.com', 'hunter2');

      expect(mockSession.saveEmail).toHaveBeenCalledWith('a@example.com');
    });

    it('does not persist an email when the user object has no email field', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { token: 'tok-2', user: {} }));

      await login('a@example.com', 'hunter2');

      expect(mockSession.saveEmail).not.toHaveBeenCalled();
    });

    it('throws an ApiError with the "invalid credentials" code on 401', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, { error: 'invalid credentials' }),
      );

      await expect(login('a@example.com', 'wrong')).rejects.toMatchObject({
        code: 'invalid credentials',
        status: 401,
      });
      expect(mockSession.saveToken).not.toHaveBeenCalled();
    });
  });

  describe('listContacts', () => {
    it('throws an ApiError with code "no_session" when no token is stored', async () => {
      mockSession.getToken.mockResolvedValueOnce(null);

      await expect(listContacts()).rejects.toMatchObject({ code: 'no_session' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('GETs /api/contacts with the Authorization header', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-3');
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          contacts: [
            {
              user_id: 'u2',
              email: 'b@example.com',
              username: 'bee',
              added_at: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );

      const result = await listContacts();

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/contacts', {
        method: 'GET',
        headers: { Authorization: 'Bearer tok-3' },
      });
      expect(result).toEqual({
        contacts: [
          {
            user_id: 'u2',
            email: 'b@example.com',
            username: 'bee',
            added_at: '2026-01-01T00:00:00Z',
          },
        ],
      });
    });

    it('throws an ApiError with code "unauthorized" on 401', async () => {
      mockSession.getToken.mockResolvedValueOnce('stale-token');
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));

      await expect(listContacts()).rejects.toMatchObject({
        code: 'unauthorized',
        status: 401,
      });
    });

    it('upserts the returned contacts into the local username cache (issue #174)', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-3');
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          contacts: [
            {
              user_id: 'u2',
              email: 'b@example.com',
              username: 'bee',
              added_at: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );

      await listContacts();

      expect(mockContactsStorage.upsertContacts).toHaveBeenCalledWith([
        { userId: 'u2', username: 'bee' },
      ]);
    });

    it('does not throw when the local username cache upsert fails', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-3');
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          contacts: [
            {
              user_id: 'u2',
              email: 'b@example.com',
              username: 'bee',
              added_at: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );
      mockContactsStorage.upsertContacts.mockRejectedValueOnce(new Error('disk full'));

      await expect(listContacts()).resolves.toBeDefined();
    });

    it('does not upsert into the local cache on a failed fetch', async () => {
      mockSession.getToken.mockResolvedValueOnce('stale-token');
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));

      await expect(listContacts()).rejects.toBeInstanceOf(ApiError);

      expect(mockContactsStorage.upsertContacts).not.toHaveBeenCalled();
    });
  });

  describe('searchUsers', () => {
    it('throws an ApiError with code "no_session" when no token is stored', async () => {
      mockSession.getToken.mockResolvedValueOnce(null);

      await expect(searchUsers('ali')).rejects.toMatchObject({ code: 'no_session' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('GETs /api/users/search with the query string and Authorization header', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-9');
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { users: [{ user_id: 'u1', email: 'alice@example.com' }] }),
      );

      const result = await searchUsers('ali');

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/users/search?q=ali', {
        method: 'GET',
        headers: { Authorization: 'Bearer tok-9' },
      });
      expect(result).toEqual({ users: [{ user_id: 'u1', email: 'alice@example.com' }] });
    });

    it('URL-encodes the query string', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-9');
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { users: [] }));

      await searchUsers('a b&c');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/users/search?q=a%20b%26c',
        { method: 'GET', headers: { Authorization: 'Bearer tok-9' } },
      );
    });

    it('throws an ApiError with code "rate_limited" on 429', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-9');
      fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: 'rate_limited' }));

      await expect(searchUsers('ali')).rejects.toMatchObject({
        code: 'rate_limited',
        status: 429,
      });
    });
  });

  describe('sendContactRequest', () => {
    it('POSTs to /api/contacts/requests with the email body and Authorization header', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-4');
      fetchMock.mockResolvedValueOnce(
        jsonResponse(201, {
          id: 'r5',
          requester_user_id: 'u4',
          recipient_user_id: 'u5',
          status: 'pending',
          created_at: '2026-01-01T00:00:00Z',
        }),
      );

      const result = await sendContactRequest('c@example.com');

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/contacts/requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-4',
        },
        body: JSON.stringify({ email: 'c@example.com' }),
      });
      expect(result).toEqual({
        id: 'r5',
        requester_user_id: 'u4',
        recipient_user_id: 'u5',
        status: 'pending',
        created_at: '2026-01-01T00:00:00Z',
      });
    });

    it('throws an ApiError with code "no_session" when no token is stored', async () => {
      mockSession.getToken.mockResolvedValueOnce(null);

      await expect(sendContactRequest('c@example.com')).rejects.toMatchObject({
        code: 'no_session',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws an ApiError with code "cannot_add_self" on 400', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-4');
      fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'cannot_add_self' }));

      await expect(sendContactRequest('me@example.com')).rejects.toMatchObject({
        code: 'cannot_add_self',
        status: 400,
      });
    });

    it('throws an ApiError with code "user_not_found" on 404', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-4');
      fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'user_not_found' }));

      await expect(sendContactRequest('nobody@example.com')).rejects.toMatchObject({
        code: 'user_not_found',
        status: 404,
      });
    });

    it('throws an ApiError with code "already_contact" on 409', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-4');
      fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'already_contact' }));

      await expect(sendContactRequest('c@example.com')).rejects.toMatchObject({
        code: 'already_contact',
        status: 409,
      });
    });

    it('throws an ApiError with code "already_pending" on 409', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-4');
      fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'already_pending' }));

      await expect(sendContactRequest('c@example.com')).rejects.toMatchObject({
        code: 'already_pending',
        status: 409,
      });
    });

    it('throws an IncomingRequestExistsError carrying the request id on 409 incoming_request_exists', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-4');
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, { error: 'incoming_request_exists', request_id: 'r9' }),
      );

      const rejection = await sendContactRequest('c@example.com').catch((err) => err);
      expect(rejection).toBeInstanceOf(IncomingRequestExistsError);
      expect(rejection).toMatchObject({
        code: 'incoming_request_exists',
        status: 409,
        requestId: 'r9',
      });
    });

    it('falls back to a plain ApiError when the 409 incoming_request_exists body is missing request_id', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-4');
      fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'incoming_request_exists' }));

      const rejection = await sendContactRequest('c@example.com').catch((err) => err);
      expect(rejection).toBeInstanceOf(ApiError);
      expect(rejection).not.toBeInstanceOf(IncomingRequestExistsError);
      expect(rejection).toMatchObject({ code: 'incoming_request_exists', status: 409 });
    });
  });

  describe('registerKeys', () => {
    it('throws an ApiError with code "no_session" when no token is stored', async () => {
      mockSession.getToken.mockResolvedValueOnce(null);

      await expect(registerKeys('x25519', 'kyber', 'dilithium', 'sig')).rejects.toMatchObject({
        code: 'no_session',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('POSTs to /api/keys with all four base64 fields and the Authorization header', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-6');
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { user_id: 'u1', updated_at: '2026-01-01T00:00:00Z' }),
      );

      await registerKeys('x25519-b64', 'kyber-b64', 'dilithium-b64', 'sig-b64');

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok-6',
        },
        body: JSON.stringify({
          x25519_public_key_b64: 'x25519-b64',
          kyber_public_key_b64: 'kyber-b64',
          dilithium_public_key_b64: 'dilithium-b64',
          prekey_signature_b64: 'sig-b64',
        }),
      });
    });

    it('resolves without a value on success', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-6');
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { user_id: 'u1', updated_at: '2026-01-01T00:00:00Z' }),
      );

      await expect(
        registerKeys('x25519-b64', 'kyber-b64', 'dilithium-b64', 'sig-b64'),
      ).resolves.toBeUndefined();
    });

    it('throws an ApiError with code "invalid_x25519_key" on 400', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-6');
      fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_x25519_key' }));

      await expect(
        registerKeys('bad', 'kyber-b64', 'dilithium-b64', 'sig-b64'),
      ).rejects.toMatchObject({
        code: 'invalid_x25519_key',
        status: 400,
      });
    });
  });

  describe('removeContact', () => {
    it('DELETEs /api/contacts/{userId} with the Authorization header', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-5');
      fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });

      await removeContact('u9');

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/contacts/u9', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer tok-5' },
      });
    });

    it('throws an ApiError with code "no_session" when no token is stored', async () => {
      mockSession.getToken.mockResolvedValueOnce(null);

      await expect(removeContact('u9')).rejects.toMatchObject({ code: 'no_session' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws an ApiError with code "not_found" on 404', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-5');
      fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'not_found' }));

      await expect(removeContact('u9')).rejects.toMatchObject({
        code: 'not_found',
        status: 404,
      });
    });
  });

  describe('listContactRequests', () => {
    it('throws an ApiError with code "no_session" when no token is stored', async () => {
      mockSession.getToken.mockResolvedValueOnce(null);

      await expect(listContactRequests()).rejects.toMatchObject({ code: 'no_session' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('GETs /api/contacts/requests with the Authorization header', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-7');
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          incoming: [
            { id: 'r1', user_id: 'u1', email: 'a@example.com', created_at: '2026-01-01T00:00:00Z' },
          ],
          outgoing: [],
        }),
      );

      const result = await listContactRequests();

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/contacts/requests', {
        method: 'GET',
        headers: { Authorization: 'Bearer tok-7' },
      });
      expect(result).toEqual({
        incoming: [
          { id: 'r1', user_id: 'u1', email: 'a@example.com', created_at: '2026-01-01T00:00:00Z' },
        ],
        outgoing: [],
      });
    });

    it('throws an ApiError on a non-2xx response', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-7');
      fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'internal_error' }));

      await expect(listContactRequests()).rejects.toMatchObject({
        code: 'internal_error',
        status: 500,
      });
    });
  });

  describe('acceptContactRequest', () => {
    it('throws an ApiError with code "no_session" when no token is stored', async () => {
      mockSession.getToken.mockResolvedValueOnce(null);

      await expect(acceptContactRequest('r1')).rejects.toMatchObject({ code: 'no_session' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('POSTs to /api/contacts/requests/{id}/accept with the Authorization header', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-8');
      fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });

      await acceptContactRequest('r1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/contacts/requests/r1/accept',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer tok-8' },
        },
      );
    });

    it('throws an ApiError with code "not_recipient" on 403', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-8');
      fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'not_recipient' }));

      await expect(acceptContactRequest('r1')).rejects.toMatchObject({
        code: 'not_recipient',
        status: 403,
      });
    });
  });

  describe('declineContactRequest', () => {
    it('throws an ApiError with code "no_session" when no token is stored', async () => {
      mockSession.getToken.mockResolvedValueOnce(null);

      await expect(declineContactRequest('r1')).rejects.toMatchObject({ code: 'no_session' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('POSTs to /api/contacts/requests/{id}/decline with the Authorization header', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-8');
      fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });

      await declineContactRequest('r1');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/api/contacts/requests/r1/decline',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer tok-8' },
        },
      );
    });

    it('throws an ApiError with code "request_not_found" on 404', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-8');
      fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'request_not_found' }));

      await expect(declineContactRequest('r1')).rejects.toMatchObject({
        code: 'request_not_found',
        status: 404,
      });
    });
  });

  describe('deleteAccount', () => {
    it('DELETEs /api/account with the Authorization header', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-9');
      fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: async () => null });

      await deleteAccount();

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/account', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer tok-9' },
      });
    });

    it('throws an ApiError with code "no_session" when no token is stored', async () => {
      mockSession.getToken.mockResolvedValueOnce(null);

      await expect(deleteAccount()).rejects.toMatchObject({ code: 'no_session' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws an ApiError on a non-2xx response', async () => {
      mockSession.getToken.mockResolvedValueOnce('tok-9');
      fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'internal_error' }));

      await expect(deleteAccount()).rejects.toMatchObject({
        code: 'internal_error',
        status: 500,
      });
    });
  });
});
