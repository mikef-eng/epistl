/**
 * Tests for the on-device message history store (src/storage/messages.ts).
 *
 * `expo-sqlite` is a native module with no real SQLite engine available in
 * the Jest/Node environment, so it is mocked here with Node's built-in
 * `node:sqlite` standing in for it, wrapped in the same synchronous
 * `prepareSync`/`execSync` surface real expo-sqlite exposes — this is what
 * `drizzle-orm`'s expo-sqlite driver (and its migrator) actually calls, so a
 * hand-rolled string-matching mock of specific SQL statements (the previous
 * approach, back when this module issued hand-written SQL directly) can't
 * stand in for it anymore. The mock's "on-disk" database lives on
 * `globalThis` (not module scope) so that it survives `jest.resetModules()`
 * — this is what lets the "persists across restart" test simulate a real
 * app restart by re-importing the module in a fresh module registry while
 * keeping the same underlying database.
 */

const MOCK_GLOBAL_STORE_KEY = '__epistlMockSqliteDatabases__';

jest.mock('expo-sqlite', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- inside a jest.mock factory, which must be synchronous.
  const { DatabaseSync } = require('node:sqlite');

  function mockGetDatabases(): Map<string, InstanceType<typeof DatabaseSync>> {
    const globalWithStore = globalThis as unknown as {
      [MOCK_GLOBAL_STORE_KEY]?: Map<string, InstanceType<typeof DatabaseSync>>;
    };
    globalWithStore[MOCK_GLOBAL_STORE_KEY] ??= new Map();
    return globalWithStore[MOCK_GLOBAL_STORE_KEY];
  }

  // Classifies a SQL statement as read-only (SELECT/PRAGMA/WITH/EXPLAIN) vs.
  // mutating, since node:sqlite's `Statement.run()`/`.all()` don't
  // distinguish the two the way real expo-sqlite's `executeSync()` result
  // does (changes/lastInsertRowId for writes, row data for reads).
  function isReadStatement(source: string): boolean {
    const match = /^\s*([a-zA-Z]+)/.exec(source);
    const keyword = (match?.[1] ?? '').toUpperCase();
    return ['SELECT', 'PRAGMA', 'WITH', 'EXPLAIN'].includes(keyword);
  }

  function wrap(raw: InstanceType<typeof DatabaseSync>) {
    return {
      execSync: (source: string) => {
        raw.exec(source);
      },
      prepareSync: (source: string) => {
        const stmt = raw.prepare(source);
        return {
          executeSync: (params: unknown[] = []) => {
            if (isReadStatement(source)) {
              const rows = stmt.all(...params);
              return {
                changes: 0,
                lastInsertRowId: 0,
                getAllSync: () => rows,
                getFirstSync: () => rows[0],
              };
            }
            const info = stmt.run(...params);
            return {
              changes: info.changes,
              lastInsertRowId: Number(info.lastInsertRowid),
              getAllSync: () => [],
              getFirstSync: () => undefined,
            };
          },
          executeForRawResultSync: (params: unknown[] = []) => {
            const rows = stmt.all(...params) as Record<string, unknown>[];
            return { getAllSync: () => rows.map((row) => Object.values(row)) };
          },
        };
      },
      closeSync: () => {},
    };
  }

  function openDatabaseSync(name: string) {
    const databases = mockGetDatabases();
    let raw = databases.get(name);
    if (!raw) {
      raw = new DatabaseSync(':memory:');
      databases.set(name, raw);
    }
    return wrap(raw);
  }

  return { openDatabaseSync };
});

function mockResetSqliteDatabases(): void {
  const globalWithStore = globalThis as unknown as {
    [MOCK_GLOBAL_STORE_KEY]?: Map<string, unknown>;
  };
  globalWithStore[MOCK_GLOBAL_STORE_KEY]?.clear();
}

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
      body: 'body',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const messages = await getMessages('contact-1');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      contactUserId: 'contact-1',
      direction: 'outgoing',
      body: 'body',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(typeof messages[0].id).toBe('number');
  });

  it('orders messages by created_at ascending', async () => {
    const { saveMessage, getMessages } = require('../src/storage/messages') as typeof import('../src/storage/messages');

    await saveMessage({
      contactUserId: 'contact-1',
      direction: 'incoming',
      body: 'c',
      createdAt: '2026-01-03T00:00:00.000Z',
    });
    await saveMessage({
      contactUserId: 'contact-1',
      direction: 'outgoing',
      body: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await saveMessage({
      contactUserId: 'contact-1',
      direction: 'incoming',
      body: 'b',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const messages = await getMessages('contact-1');

    expect(messages.map((message) => message.body)).toEqual(['a', 'b', 'c']);
  });

  it('isolates messages between different contacts', async () => {
    const { saveMessage, getMessages } = require('../src/storage/messages') as typeof import('../src/storage/messages');

    await saveMessage({
      contactUserId: 'contact-1',
      direction: 'outgoing',
      body: 'for-contact1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await saveMessage({
      contactUserId: 'contact-2',
      direction: 'incoming',
      body: 'for-contact2',
      createdAt: '2026-01-01T00:00:01.000Z',
    });

    const contact1Messages = await getMessages('contact-1');
    const contact2Messages = await getMessages('contact-2');

    expect(contact1Messages).toHaveLength(1);
    expect(contact1Messages[0].body).toBe('for-contact1');
    expect(contact2Messages).toHaveLength(1);
    expect(contact2Messages[0].body).toBe('for-contact2');
  });

  it('persists messages across a simulated app restart', async () => {
    const firstImport = require('../src/storage/messages') as typeof import('../src/storage/messages');
    await firstImport.saveMessage({
      contactUserId: 'contact-1',
      direction: 'outgoing',
      body: 'persistent',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    // Simulate an app restart: fresh module registry, same "on-disk" store.
    jest.resetModules();
    const secondImport = require('../src/storage/messages') as typeof import('../src/storage/messages');

    const messages = await secondImport.getMessages('contact-1');

    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('persistent');
  });
});
