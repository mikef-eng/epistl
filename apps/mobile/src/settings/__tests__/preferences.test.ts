import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  saveThemePreference,
  getThemePreference,
  saveNotificationsEnabled,
  getNotificationsEnabled,
  THEME_PREFERENCE_KEY,
  NOTIFICATIONS_ENABLED_KEY,
} from '../preferences';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(),
  getItem: jest.fn(),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

describe('preferences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('theme preference', () => {
    it('defaults to "system" when unset', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);

      await expect(getThemePreference()).resolves.toBe('system');
      expect(mockAsyncStorage.getItem).toHaveBeenCalledWith(THEME_PREFERENCE_KEY);
    });

    it('round-trips a saved preference', async () => {
      await saveThemePreference('dark');
      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(THEME_PREFERENCE_KEY, 'dark');

      mockAsyncStorage.getItem.mockResolvedValueOnce('dark');
      await expect(getThemePreference()).resolves.toBe('dark');
    });

    it('round-trips "light"', async () => {
      await saveThemePreference('light');
      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(THEME_PREFERENCE_KEY, 'light');

      mockAsyncStorage.getItem.mockResolvedValueOnce('light');
      await expect(getThemePreference()).resolves.toBe('light');
    });
  });

  describe('notifications enabled', () => {
    it('defaults to false when unset', async () => {
      mockAsyncStorage.getItem.mockResolvedValueOnce(null);

      await expect(getNotificationsEnabled()).resolves.toBe(false);
      expect(mockAsyncStorage.getItem).toHaveBeenCalledWith(NOTIFICATIONS_ENABLED_KEY);
    });

    it('round-trips save/get for true', async () => {
      await saveNotificationsEnabled(true);
      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(NOTIFICATIONS_ENABLED_KEY, 'true');

      mockAsyncStorage.getItem.mockResolvedValueOnce('true');
      await expect(getNotificationsEnabled()).resolves.toBe(true);
    });

    it('round-trips save/get for false', async () => {
      await saveNotificationsEnabled(false);
      expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(NOTIFICATIONS_ENABLED_KEY, 'false');

      mockAsyncStorage.getItem.mockResolvedValueOnce('false');
      await expect(getNotificationsEnabled()).resolves.toBe(false);
    });
  });
});
