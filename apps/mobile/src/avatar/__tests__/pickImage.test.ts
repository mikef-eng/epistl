import * as ImagePicker from 'expo-image-picker';

import { pickAvatarImage } from '../pickImage';

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

const mockedRequestPermission = ImagePicker.requestMediaLibraryPermissionsAsync as jest.Mock;
const mockedLaunch = ImagePicker.launchImageLibraryAsync as jest.Mock;

describe('pickAvatarImage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves with "permission_denied" and never opens the picker when permission is refused', async () => {
    mockedRequestPermission.mockResolvedValueOnce({ granted: false });

    const result = await pickAvatarImage();

    expect(result).toEqual({ status: 'permission_denied' });
    expect(mockedLaunch).not.toHaveBeenCalled();
  });

  it('resolves with "canceled" when the user dismisses the picker', async () => {
    mockedRequestPermission.mockResolvedValueOnce({ granted: true });
    mockedLaunch.mockResolvedValueOnce({ canceled: true, assets: null });

    const result = await pickAvatarImage();

    expect(result).toEqual({ status: 'canceled' });
  });

  it('resolves with "canceled" when the result has no assets', async () => {
    mockedRequestPermission.mockResolvedValueOnce({ granted: true });
    mockedLaunch.mockResolvedValueOnce({ canceled: false, assets: [] });

    const result = await pickAvatarImage();

    expect(result).toEqual({ status: 'canceled' });
  });

  it('resolves with "picked" and the selected asset\'s uri on success', async () => {
    mockedRequestPermission.mockResolvedValueOnce({ granted: true });
    mockedLaunch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/photo.jpg' }],
    });

    const result = await pickAvatarImage();

    expect(result).toEqual({ status: 'picked', uri: 'file:///tmp/photo.jpg' });
  });

  it('requests library-only media, not the camera', async () => {
    mockedRequestPermission.mockResolvedValueOnce({ granted: true });
    mockedLaunch.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: 'file:///tmp/photo.jpg' }],
    });

    await pickAvatarImage();

    expect(mockedLaunch).toHaveBeenCalledWith({ mediaTypes: ['images'] });
  });
});
