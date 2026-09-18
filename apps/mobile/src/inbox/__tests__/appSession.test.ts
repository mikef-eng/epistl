/**
 * `../appSession.ts` is pure wiring (issue #165): it must call the
 * transport store's `connect`/`close` actions and the shared inbox
 * listener's `start`/`stop` functions together, so this mocks both
 * dependencies at the module boundary rather than exercising the real
 * transport/listener (already covered by `../transport/__tests__/store.test.ts`
 * and `./listener.test.ts` respectively).
 */
import { getToken } from '../../api/session';
import { transportStore } from '../../transport/store';
import { startAppSession, stopAppSession } from '../appSession';
import { startInboxListener, stopInboxListener } from '../listener';

jest.mock('../../api/session', () => ({
  getToken: jest.fn(),
}));

jest.mock('../../transport/store', () => ({
  transportStore: { actions: { connect: jest.fn(), close: jest.fn() } },
}));

jest.mock('../listener', () => ({
  startInboxListener: jest.fn(),
  stopInboxListener: jest.fn(),
}));

describe('appSession', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('startAppSession opens the transport connection with getToken and starts the inbox listener', () => {
    startAppSession();

    expect(transportStore.actions.connect).toHaveBeenCalledWith(getToken);
    expect(startInboxListener).toHaveBeenCalledTimes(1);
  });

  it('stopAppSession closes the transport connection and stops the inbox listener', () => {
    stopAppSession();

    expect(transportStore.actions.close).toHaveBeenCalledTimes(1);
    expect(stopInboxListener).toHaveBeenCalledTimes(1);
  });
});
