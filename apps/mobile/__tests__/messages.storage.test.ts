/**
 * Tests for the on-device message history store (src/storage/messages.ts).
 *
 * `expo-sqlite` is a native module with no real SQLite engine available in
 * the Jest/Node environment, so it is mocked here with a minimal in-memory
 * SQL engine that understands exactly the statements messages.ts issues.
 * The mock's row storage lives on `globalThis` (not module scope) so that
 * it survives `jest.resetModules()` — this is what lets the "persists
 * across restart" test simulate a real app restart by re-importing the
 * module in a fresh module registry while keeping the "on-disk" data.
 */

const MOCK_GLOBAL_STORE_KEY = '__epistlMockSqliteDatabases__';

interface MockRow {
  id: number;
  contact_user_id: string;
  direction: string;
  body_b64: string;
  created_at: string;
}

interface MockDatabaseState {
  rows: MockRow[];
  nextId: number;
}

/** Resets all mock "on-disk" SQLite state between test files/isolation. */
function mockResetSqliteDatabases(): void {
  const globalWithStore = globalThis as unknown as {
    [MOCK_GLOBAL_STORE_KEY]?: Map<string, MockDatabaseState>;
  };
  globalWithStore[MOCK_GLOBAL_STORE_KEY]?.clear();
}

jest.mock('expo-sqlite', () => {
  function mockGetDatabases(): Map<string, MockDatabaseState> {
    const globalWithStore = globalThis as unknown as {
      [MOCK_GLOBAL_STORE_KEY]?: Map<string, MockDatabaseState>;
    };
    if (!globalWithStore[MOCK_GLOBAL_STORE_KEY]) {
      globalWithStore[MOCK_GLOBAL_STORE_KEY] = new Map();
    }
    return globalWithStore[MOCK_GLOBAL_STORE_KEY];
  }

  function openDatabaseSync(name: string) {
    const databases = mockGetDatabases();
    if (!databases.has(name)) {
      databases.set(name, { rows: [], nextId: 1 });
    }
    const state = databases.get(name)!;

    return {
      execSync(_source: string) {
        // Statements issued here are CREATE TABLE IF NOT EXISTS and (since
        // messages.ts's read_at migration) ALTER TABLE ... ADD COLUMN
        // read_at; the table already implicitly exists once `state` is
        // created above, and this mock doesn't model columns at all, so
        // both are no-ops.
      },
      getAllSync(source: string, _params?: unknown[]) {
        if (source.startsWith('PRAGMA table_info')) {
          // Reported as columnless so messages.ts's read_at migration guard
          // always (harmlessly) issues its ALTER TABLE, since this mock
          // doesn't track columns. See detailed migration coverage in
          // src/storage/__tests__/messages.test.ts.
          return [];
        }
        throw new Error(`unsupported mock getAllSync source: ${source}`);
      },
      async runAsync(source: string, params: unknown[]) {
        if (source.startsWith('INSERT INTO messages')) {
          const [contactUserId, direction, bodyB64, createdAt] = params as string[];
          state.rows.push({
            id: state.nextId++,
            contact_user_id: contactUserId,
            direction,
            body_b64: bodyB64,
            created_at: createdAt,
          });
          return { lastInsertRowId: state.nextId - 1, changes: 1 };
        }
        throw new Error(`unsupported mock runAsync source: ${source}`);
      },
      async getAllAsync(source: string, params: unknown[]) {
        if (source.startsWith('SELECT') && source.includes('FROM messages')) {
          const [contactUserId] = params as string[];
          return state.rows
            .filter((row) => row.contact_user_id === contactUserId)
            .slice()
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
        }
        throw new Error(`unsupported mock getAllAsync source: ${source}`);
      },
    };
  }

  return { openDatabaseSync };
});

describe('messages storage', () => {
  beforeEach(() => {
    jest.resetModules();
    mockResetSqliteDatabases();
  });

  it('saves then retrieves messages for one contact', async () => {
    const { saveMessage, getMessages } = require('../src/storage/messages') as typeof import('../src/storage/messages');

    await saveMessage({
      contactUserId: 'contact-1',
      direction: 'outgoing',
      bodyB64: 'Ym9keQ==',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const messages = await getMessages('contact-1');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      contactUserId: 'contact-1',
      direction: 'outgoing',
      bodyB64: 'Ym9keQ==',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(typeof messages[0].id).toBe('number');
  });

  it('orders messages by created_at ascending', async () => {
    const { saveMessage, getMessages } = require('../src/storage/messages') as typeof import('../src/storage/messages');

    await saveMessage({
      contactUserId: 'contact-1',
      direction: 'incoming',
      bodyB64: 'Yw==',
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    await saveMessage({
      contactUserId: 'contact-1',
      direction: 'outgoing',
      bodyB64: 'YQ==',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await saveMessage({
      contactUserId: 'contact-1',
      direction: 'incoming',
      bodyB64: 'Yg==',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const messages = await getMessages('contact-1');

    expect(messages.map((message) => message.bodyB64)).toEqual(['YQ==', 'Yg==', 'Yw==']);
  });

  it('isolates messages between different contacts', async () => {
    const { saveMessage, getMessages } = require('../src/storage/messages') as typeof import('../src/storage/messages');

    await saveMessage({
      contactUserId: 'contact-1',
      direction: 'outgoing',
      bodyB64: 'Zm9yLWNvbnRhY3Qx',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await saveMessage({
      contactUserId: 'contact-2',
      direction: 'incoming',
      bodyB64: 'Zm9yLWNvbnRhY3Qy',
      createdAt: '2026-01-01T00:00:01.000Z',
    });

    const contact1Messages = await getMessages('contact-1');
    const contact2Messages = await getMessages('contact-2');

    expect(contact1Messages).toHaveLength(1);
    expect(contact1Messages[0].bodyB64).toBe('Zm9yLWNvbnRhY3Qx');
    expect(contact2Messages).toHaveLength(1);
    expect(contact2Messages[0].bodyB64).toBe('Zm9yLWNvbnRhY3Qy');
  });

  it('persists messages across a simulated app restart', async () => {
    const firstImport = require('../src/storage/messages') as typeof import('../src/storage/messages');
    await firstImport.saveMessage({
      contactUserId: 'contact-1',
      direction: 'outgoing',
      bodyB64: 'cGVyc2lzdGVudA==',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    // Simulate an app restart: fresh module registry, same "on-disk" store.
    jest.resetModules();
    const secondImport = require('../src/storage/messages') as typeof import('../src/storage/messages');

    const messages = await secondImport.getMessages('contact-1');

    expect(messages).toHaveLength(1);
    expect(messages[0].bodyB64).toBe('cGVyc2lzdGVudA==');
  });
});
