import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

import { registerPushToken } from '../../api/client';
import { startPushRegistration } from '../pushRegistration';

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  addPushTokenListener: jest.fn(),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: null, easConfig: null },
}));

jest.mock('../../api/client', () => ({ registerPushToken: jest.fn() }));

const notif = Notifications as jest.Mocked<typeof Notifications>;
const mockRegister = registerPushToken as jest.Mock;
const constants = Constants as unknown as {
  expoConfig: unknown;
  easConfig: unknown;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('startPushRegistration', () => {
  let remove: jest.Mock;
  let tokenListener: (value: unknown) => void;

  beforeEach(() => {
    jest.clearAllMocks();
    remove = jest.fn();
    notif.addPushTokenListener.mockImplementation(((l: (value: unknown) => void) => {
      tokenListener = l;
      return { remove };
    }) as never);
    constants.expoConfig = { extra: { eas: { projectId: 'proj-1' } } };
    constants.easConfig = null;
    notif.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', granted: false } as never);
    notif.requestPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true } as never);
    notif.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExpoTok', type: 'expo' } as never);
    mockRegister.mockResolvedValue(undefined);
  });

  it('requests permission when undetermined, then registers the token with the projectId from Constants', async () => {
    startPushRegistration();
    await flush();

    expect(notif.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(notif.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(mockRegister).toHaveBeenCalledWith('ExpoTok');
  });

  it('does not re-request permission when already granted, but still registers', async () => {
    notif.getPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true } as never);
    startPushRegistration();
    await flush();

    expect(notif.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockRegister).toHaveBeenCalledWith('ExpoTok');
  });

  it('does nothing further when permission was previously denied', async () => {
    notif.getPermissionsAsync.mockResolvedValue({ status: 'denied', granted: false } as never);
    startPushRegistration();
    await flush();

    expect(notif.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(notif.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('does not fetch a token when the permission request is denied', async () => {
    notif.requestPermissionsAsync.mockResolvedValue({ status: 'denied', granted: false } as never);
    startPushRegistration();
    await flush();

    expect(notif.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('falls back to Constants.easConfig.projectId', async () => {
    constants.expoConfig = { extra: {} };
    constants.easConfig = { projectId: 'proj-eas' };
    startPushRegistration();
    await flush();

    expect(notif.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-eas' });
  });

  it('is best-effort with no projectId: no token fetch, no throw', async () => {
    constants.expoConfig = null;
    constants.easConfig = null;
    expect(() => startPushRegistration()).not.toThrow();
    await flush();

    expect(notif.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('swallows a failed registration request without retrying', async () => {
    mockRegister.mockRejectedValue(new Error('boom'));
    startPushRegistration();
    await flush();
    await flush();

    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it('swallows a token-fetch failure', async () => {
    notif.getExpoPushTokenAsync.mockRejectedValue(new Error('no fcm'));
    startPushRegistration();
    await flush();

    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('re-registers when the push token rotates', async () => {
    notif.getPermissionsAsync.mockResolvedValue({ status: 'granted', granted: true } as never);
    startPushRegistration();
    await flush();
    notif.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExpoTok2', type: 'expo' } as never);

    tokenListener({});
    await flush();

    expect(mockRegister).toHaveBeenLastCalledWith('ExpoTok2');
  });

  it('returns a cleanup that removes the token listener', () => {
    const stop = startPushRegistration();
    stop();
    expect(remove).toHaveBeenCalled();
  });
});
