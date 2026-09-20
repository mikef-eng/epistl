import { renderHook, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';

import { listContacts } from '../../api/client';
import { getCachedContactUsername } from '../../storage/contacts';
import { useNotificationTapNavigation } from '../useNotificationTapNavigation';

jest.mock('expo-notifications', () => ({
  useLastNotificationResponse: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
}));

jest.mock('../../api/client', () => ({ listContacts: jest.fn() }));
jest.mock('../../storage/contacts', () => ({ getCachedContactUsername: jest.fn() }));

const mockUseLast = Notifications.useLastNotificationResponse as jest.Mock;
const mockListContacts = listContacts as jest.Mock;
const mockGetUsername = getCachedContactUsername as jest.Mock;

function response(data: unknown, actionIdentifier = Notifications.DEFAULT_ACTION_IDENTIFIER) {
  return { actionIdentifier, notification: { request: { content: { data } } } };
}

describe('useNotificationTapNavigation', () => {
  const navigate = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseLast.mockReturnValue(null);
    mockGetUsername.mockImplementation(async (id: string) => (id === 'u-1' ? 'alice' : null));
  });

  it('navigates to Chat for a known contact from data.fromUserId', async () => {
    mockUseLast.mockReturnValue(response({ type: 'message', fromUserId: 'u-1' }));
    await renderHook(() => useNotificationTapNavigation(navigate));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('Chat', { userId: 'u-1', username: 'alice' }),
    );
    expect(mockListContacts).not.toHaveBeenCalled();
  });

  it('falls back to the Conversations tab for an unknown contact', async () => {
    mockUseLast.mockReturnValue(response({ type: 'message', fromUserId: 'nope' }));
    await renderHook(() => useNotificationTapNavigation(navigate));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('Main', { screen: 'Conversations' }));
    expect(mockListContacts).not.toHaveBeenCalled();
  });

  it('falls back to Conversations when the cache lookup fails', async () => {
    mockGetUsername.mockRejectedValue(new Error('db error'));
    mockUseLast.mockReturnValue(response({ type: 'message', fromUserId: 'u-1' }));
    await renderHook(() => useNotificationTapNavigation(navigate));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('Main', { screen: 'Conversations' }));
  });

  it('falls back to Conversations when data has no fromUserId', async () => {
    mockUseLast.mockReturnValue(response({}));
    await renderHook(() => useNotificationTapNavigation(navigate));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('Main', { screen: 'Conversations' }));
  });

  it('ignores non-default actions and no response', async () => {
    mockUseLast.mockReturnValue(response({ fromUserId: 'u-1' }, 'other'));
    await renderHook(() => useNotificationTapNavigation(navigate));
    mockUseLast.mockReturnValue(null);
    await renderHook(() => useNotificationTapNavigation(navigate));
    await Promise.resolve();

    expect(navigate).not.toHaveBeenCalled();
  });

  it('handles the same response only once across re-renders', async () => {
    const r = response({ fromUserId: 'u-1' });
    mockUseLast.mockReturnValue(r);
    const { rerender } = await renderHook(() => useNotificationTapNavigation(navigate));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    await rerender({});
    await Promise.resolve();

    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
