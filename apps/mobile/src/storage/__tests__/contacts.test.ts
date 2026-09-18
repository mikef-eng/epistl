/**
 * `expo-sqlite`'s native module isn't available under Jest, so this mocks it
 * with a real SQLite engine (Node's built-in `node:sqlite`) rather than a
 * hand-rolled JS stand-in -- copied verbatim from `messages.test.ts`'s mock
 * (see that file's doc comment for why) so both modules exercise genuine
 * SQLite semantics against the same in-memory database.
 */
jest.mock('expo-sqlite', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- inside a jest.mock factory, which must be synchronous.
  const { DatabaseSync: RealDatabaseSync } = require('node:sqlite');
  const globalScope = globalThis as unknown as {
    __mockSqliteDatabases?: Map<string, InstanceType<typeof RealDatabaseSync>>;
  };
  globalScope.__mockSqliteDatabases ??= new Map();
  const databases = globalScope.__mockSqliteDatabases;

  function isReadStatement(source: string): boolean {
    const match = /^\s*([a-zA-Z]+)/.exec(source);
    const keyword = (match?.[1] ?? '').toUpperCase();
    return ['SELECT', 'PRAGMA', 'WITH', 'EXPLAIN'].includes(keyword);
  }

  function wrap(raw: InstanceType<typeof RealDatabaseSync>) {
    return {
      execSync: (source: string) => {
        raw.exec(source);
      },
      getAllSync: (source: string, params: unknown[] = []) => {
        return raw.prepare(source).all(...params);
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
    let raw = databases.get(name);
    if (!raw) {
      raw = new RealDatabaseSync(':memory:');
      databases.set(name, raw);
    }
    return wrap(raw);
  }

  return { openDatabaseSync };
});

function clearMockDatabases(): void {
  const globalScope = globalThis as unknown as {
    __mockSqliteDatabases?: Map<string, unknown>;
  };
  globalScope.__mockSqliteDatabases?.clear();
}

/** Loads a fresh copy of the module against a brand-new in-memory database. */
function loadContactsModule(): typeof import('../contacts') {
  jest.resetModules();
  clearMockDatabases();
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-require after jest.resetModules() to pick up a fresh module instance.
  return require('../contacts');
}

describe('upsertContacts / getCachedContactUsername', () => {
  let contacts: typeof import('../contacts');

  beforeEach(() => {
    contacts = loadContactsModule();
  });

  it('inserts a row for a user_id not already present', async () => {
    await contacts.upsertContacts([{ userId: 'alice-id', username: 'alice' }]);

    await expect(contacts.getCachedContactUsername('alice-id')).resolves.toBe('alice');
  });

  it('populates a row per contact for a multi-contact list', async () => {
    await contacts.upsertContacts([
      { userId: 'alice-id', username: 'alice' },
      { userId: 'bob-id', username: 'bob' },
    ]);

    await expect(contacts.getCachedContactUsername('alice-id')).resolves.toBe('alice');
    await expect(contacts.getCachedContactUsername('bob-id')).resolves.toBe('bob');
  });

  it('updates the existing row rather than creating a duplicate when a username changes', async () => {
    await contacts.upsertContacts([{ userId: 'alice-id', username: 'alice' }]);

    await contacts.upsertContacts([{ userId: 'alice-id', username: 'alice-new-name' }]);

    await expect(contacts.getCachedContactUsername('alice-id')).resolves.toBe('alice-new-name');

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- reaching past the module under test to assert on the raw table row count.
    const SQLite = require('expo-sqlite');
    const raw = SQLite.openDatabaseSync('epistl.db') as unknown as {
      getAllSync: <T>(sql: string, params?: unknown[]) => T[];
    };
    const rows = raw.getAllSync<{ user_id: string }>(
      'SELECT user_id FROM contacts WHERE user_id = ?',
      ['alice-id']
    );
    expect(rows).toHaveLength(1);
  });

  it('returns null for a user_id that was never cached', async () => {
    await expect(contacts.getCachedContactUsername('never-cached-id')).resolves.toBeNull();
  });

  it('leaves other rows untouched when upserting a different user_id', async () => {
    await contacts.upsertContacts([{ userId: 'alice-id', username: 'alice' }]);

    await contacts.upsertContacts([{ userId: 'bob-id', username: 'bob' }]);

    await expect(contacts.getCachedContactUsername('alice-id')).resolves.toBe('alice');
    await expect(contacts.getCachedContactUsername('bob-id')).resolves.toBe('bob');
  });
});
