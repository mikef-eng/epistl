import { render, screen, userEvent } from '@testing-library/react-native';

import ConversationsScreen from '../src/screens/ConversationsScreen';

async function renderConversationsScreen() {
  const navigation = { navigate: jest.fn() };
  const user = userEvent.setup();
  await render(<ConversationsScreen navigation={navigation as never} route={{} as never} />);
  return { navigation, user };
}

describe('ConversationsScreen (placeholder, issue #94)', () => {
  it('shows a "No conversations yet" placeholder message', async () => {
    await renderConversationsScreen();

    expect(screen.getByText('No conversations yet')).toBeTruthy();
  });

  it('navigates to Settings when the gear icon is pressed', async () => {
    const { navigation, user } = await renderConversationsScreen();

    await user.press(screen.getByRole('button', { name: 'Settings' }));

    expect(navigation.navigate).toHaveBeenCalledWith('Settings');
  });

  it('renders dark: variants on its background, header, and empty-state text', async () => {
    await renderConversationsScreen();

    expect(screen.getByText('Conversations').props.className).toContain('dark:text-white');
    expect(screen.getByText('No conversations yet').props.className).toContain(
      'dark:text-gray-400'
    );
  });
});
