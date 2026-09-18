import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import Avatar from '../Avatar';
import { getToken } from '../../api/session';

jest.mock('../../api/session', () => ({
  getToken: jest.fn(),
}));

const mockedGetToken = getToken as jest.Mock;

const WRAPPER_CLASSNAME = 'mr-3 h-10 w-10 items-center justify-center rounded-full bg-gray-200';
const IMAGE_CLASSNAME = 'h-10 w-10 rounded-full';
const TEXT_CLASSNAME = 'text-base font-semibold text-black';

describe('Avatar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the fallback text while the session token has not loaded yet', async () => {
    mockedGetToken.mockReturnValue(new Promise(() => {})); // never resolves

    await render(
      <Avatar
        userId="u1"
        fallbackText="A"
        wrapperClassName={WRAPPER_CLASSNAME}
        imageClassName={IMAGE_CLASSNAME}
        textClassName={TEXT_CLASSNAME}
      />
    );

    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.queryByTestId('avatar-image-u1')).toBeNull();
  });

  it('renders the fallback text when there is no stored session token', async () => {
    mockedGetToken.mockResolvedValueOnce(null);

    await render(
      <Avatar
        userId="u1"
        fallbackText="A"
        wrapperClassName={WRAPPER_CLASSNAME}
        imageClassName={IMAGE_CLASSNAME}
        textClassName={TEXT_CLASSNAME}
      />
    );

    await waitFor(() => {
      expect(mockedGetToken).toHaveBeenCalled();
    });
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.queryByTestId('avatar-image-u1')).toBeNull();
  });

  it('renders the avatar image pointed at GET /api/avatar/{userId} with the bearer token attached once loaded', async () => {
    mockedGetToken.mockResolvedValueOnce('tok-1');

    await render(
      <Avatar
        userId="u1"
        fallbackText="A"
        wrapperClassName={WRAPPER_CLASSNAME}
        imageClassName={IMAGE_CLASSNAME}
        textClassName={TEXT_CLASSNAME}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('avatar-image-u1')).toBeTruthy();
    });
    expect(screen.queryByText('A')).toBeNull();
    expect(screen.getByTestId('avatar-image-u1').props.source).toEqual({
      uri: 'http://localhost:3000/api/avatar/u1',
      headers: { Authorization: 'Bearer tok-1' },
    });
  });

  it('falls back to the fallback text when the image fails to load', async () => {
    mockedGetToken.mockResolvedValueOnce('tok-1');

    await render(
      <Avatar
        userId="u1"
        fallbackText="A"
        wrapperClassName={WRAPPER_CLASSNAME}
        imageClassName={IMAGE_CLASSNAME}
        textClassName={TEXT_CLASSNAME}
      />
    );

    const image = await waitFor(() => screen.getByTestId('avatar-image-u1'));
    fireEvent(image, 'error');

    await waitFor(() => {
      expect(screen.getByText('A')).toBeTruthy();
    });
    expect(screen.queryByTestId('avatar-image-u1')).toBeNull();
  });

  it('appends cacheBust as a query string and re-attempts the image after it changes', async () => {
    mockedGetToken.mockResolvedValue('tok-1');

    const { rerender } = await render(
      <Avatar
        userId="u1"
        fallbackText="A"
        wrapperClassName={WRAPPER_CLASSNAME}
        imageClassName={IMAGE_CLASSNAME}
        textClassName={TEXT_CLASSNAME}
        cacheBust={1}
      />
    );

    const image = await waitFor(() => screen.getByTestId('avatar-image-u1'));
    expect(image.props.source.uri).toBe('http://localhost:3000/api/avatar/u1?v=1');

    fireEvent(image, 'error');
    await waitFor(() => {
      expect(screen.getByText('A')).toBeTruthy();
    });

    await rerender(
      <Avatar
        userId="u1"
        fallbackText="A"
        wrapperClassName={WRAPPER_CLASSNAME}
        imageClassName={IMAGE_CLASSNAME}
        textClassName={TEXT_CLASSNAME}
        cacheBust={2}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('avatar-image-u1').props.source.uri).toBe(
        'http://localhost:3000/api/avatar/u1?v=2'
      );
    });
  });
});
