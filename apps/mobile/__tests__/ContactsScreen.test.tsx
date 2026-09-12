import { render, screen, userEvent, waitFor } from '@testing-library/react-native';

import ContactsScreen from '../src/screens/ContactsScreen';
import { listContacts } from '../src/api/client';

jest.mock('../src/api/client', () => {
  class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, status: number) {
      super(code);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  }
  return {
    ApiError,
    listContacts: jest.fn(),
  };
});

const mockedListContacts = listContacts as jest.Mock;

// CI runs each test file in its own worker process, and this file's first
// render pays the one-time cost of registering RN/Reanimated native-module
// mocks in that worker. That cold start intermittently exceeds Jest's
// default 5000ms per-test timeout under CI load (observed in issue #26)
// even though the underlying behavior is correct and passes reliably
// locally. Give this file's tests more headroom rather than chase a
// non-existent app bug.
jest.setTimeout(15000);

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderContactsScreen() {
  const navigation = { navigate: jest.fn() };
  const user = userEvent.setup();
  await render(<ContactsScreen navigation={navigation as never} route={{} as never} />);
  return { navigation, user };
}

describe('ContactsScreen', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('shows a loading indicator while the initial fetch is in flight', async () => {
    const deferred = makeDeferred<{ contacts: never[] }>();
    mockedListContacts.mockReturnValueOnce(deferred.promise);

    await renderContactsScreen();

    expect(screen.getByTestId('contacts-loading')).toBeTruthy();

    deferred.resolve({ contacts: [] });
    await waitFor(() => {
      expect(screen.queryByTestId('contacts-loading')).toBeNull();
    });
  });

  it('renders each contact email once loaded', async () => {
    mockedListContacts.mockResolvedValueOnce({
      contacts: [
        { user_id: 'u1', email: 'alice@example.com', added_at: '2024-01-01T00:00:00Z' },
        { user_id: 'u2', email: 'bob@example.com', added_at: '2024-01-02T00:00:00Z' },
      ],
    });

    await renderContactsScreen();

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
      expect(screen.getByText('bob@example.com')).toBeTruthy();
    });
  });

  it('shows a "No contacts yet" message when the list is empty', async () => {
    mockedListContacts.mockResolvedValueOnce({ contacts: [] });

    await renderContactsScreen();

    await waitFor(() => {
      expect(screen.getByText('No contacts yet')).toBeTruthy();
    });
  });

  it('shows an error message with a retry control that re-calls listContacts', async () => {
    const { ApiError } = jest.requireMock('../src/api/client');
    mockedListContacts.mockRejectedValueOnce(new ApiError('network_error', 0));
    const { user } = await renderContactsScreen();

    await waitFor(() => {
      expect(screen.getByText('network_error')).toBeTruthy();
    });
    expect(mockedListContacts).toHaveBeenCalledTimes(1);

    mockedListContacts.mockResolvedValueOnce({
      contacts: [{ user_id: 'u1', email: 'alice@example.com', added_at: '2024-01-01T00:00:00Z' }],
    });
    await user.press(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });
    expect(mockedListContacts).toHaveBeenCalledTimes(2);
  });

  it('navigates to AddContact when "Add contact" is pressed', async () => {
    mockedListContacts.mockResolvedValueOnce({ contacts: [] });
    const { navigation, user } = await renderContactsScreen();

    await waitFor(() => {
      expect(screen.getByText('No contacts yet')).toBeTruthy();
    });

    await user.press(screen.getByRole('button', { name: 'Add contact' }));

    expect(navigation.navigate).toHaveBeenCalledWith('AddContact');
  });

  it('navigates to Chat with the contact userId and email when a row is tapped', async () => {
    mockedListContacts.mockResolvedValueOnce({
      contacts: [{ user_id: 'u1', email: 'alice@example.com', added_at: '2024-01-01T00:00:00Z' }],
    });
    const { navigation, user } = await renderContactsScreen();

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeTruthy();
    });

    await user.press(screen.getByText('alice@example.com'));

    expect(navigation.navigate).toHaveBeenCalledWith('Chat', {
      userId: 'u1',
      email: 'alice@example.com',
    });
  });
});
