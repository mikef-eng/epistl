import { render, screen, waitFor } from '@testing-library/react-native';
import { colorScheme } from 'nativewind';

import App from '../App';
import { getThemePreference } from '../src/settings/preferences';

// `App.tsx` mounts every screen's module (including `ChatScreen`, which
// pulls in `../storage/messages.ts` -> `expo-sqlite`, and `QuicSpikeScreen`,
// whose `quic-relay-client` TurboModule doesn't exist in the Jest
// environment). None of those are under test here -- this file only
// exercises `App.tsx`'s own cold-start theme-application logic -- so each
// is mocked wholesale to keep this file's scope to that.
jest.mock('../global.css', () => ({}));
jest.mock('../src/storage/messages', () => ({
  getMessages: jest.fn(),
  saveMessage: jest.fn(),
}));
jest.mock('../src/transport/store', () => {
  const { Store } = jest.requireActual('@tanstack/react-store');
  return {
    transportStore: new Store(
      { status: 'connecting', activeTransport: null, lastFrame: null },
      () => ({ connect: jest.fn(), send: jest.fn(), close: jest.fn() })
    ),
  };
});
jest.mock('../src/api/client', () => ({
  listContacts: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
}));
jest.mock('../src/api/session', () => ({
  getToken: jest.fn(),
  getUserId: jest.fn(),
  getEmail: jest.fn(),
  saveUserId: jest.fn(),
  clearSession: jest.fn(),
}));
jest.mock('../src/screens/QuicSpikeScreen', () => ({
  __esModule: true,
  default: function QuicSpikeScreen() {
    return null;
  },
}));

jest.mock('../src/settings/preferences', () => ({
  getThemePreference: jest.fn(),
  saveThemePreference: jest.fn(),
  getNotificationsEnabled: jest.fn(),
  saveNotificationsEnabled: jest.fn(),
}));

jest.mock('nativewind', () => ({
  colorScheme: { set: jest.fn() },
}));

const mockedGetThemePreference = getThemePreference as jest.Mock;
const mockedColorSchemeSet = colorScheme.set as jest.Mock;

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

jest.setTimeout(20000);

describe('App', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('applies the persisted theme preference via colorScheme.set before the navigation tree first renders', async () => {
    const deferred = makeDeferred<'dark'>();
    mockedGetThemePreference.mockReturnValueOnce(deferred.promise);

    await render(<App />);

    // Nothing from the navigation tree (e.g. LoginScreen's "Epistl" title)
    // has rendered yet -- still gated on the preference load.
    expect(screen.queryByText('Epistl')).toBeNull();
    expect(mockedColorSchemeSet).not.toHaveBeenCalled();

    deferred.resolve('dark');

    await waitFor(() => {
      expect(mockedColorSchemeSet).toHaveBeenCalledWith('dark');
    });
    await waitFor(() => {
      expect(screen.getByText('Epistl')).toBeTruthy();
    });
  });

  it('applies the "system" preference on a cold start with no stored preference', async () => {
    mockedGetThemePreference.mockResolvedValueOnce('system');

    await render(<App />);

    await waitFor(() => {
      expect(mockedColorSchemeSet).toHaveBeenCalledWith('system');
    });
    await waitFor(() => {
      expect(screen.getByText('Epistl')).toBeTruthy();
    });
  });
});
