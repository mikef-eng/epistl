/**
 * `expo-sqlite`'s native module isn't available under Jest, so this mocks it
 * with a real SQLite engine (Node's built-in `node:sqlite`) rather than a
 * hand-rolled JS stand-in. That way `getConversationSummaries`'s window-
 * function SQL is exercised against genuine SQLite semantics, not a fake.
 */
jest.mock('expo-sqlite', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- inside a jest.mock factory, which must be synchronous.
  const { DatabaseSync: RealDatabaseSync } = require('node:sqlite');
  // Kept on `globalThis` (rather than closure-scoped) so it survives
  // `jest.resetModules()`, which re-runs this factory. That lets tests
  // choose whether "reloading the module" means a fresh database (the
  // common case — clear it first) or reopening the same on-disk database
  // across a simulated app restart (the migration-idempotency case below).
  const globalScope = globalThis as unknown as {
    __mockSqliteDatabases?: Map<string, InstanceType<typeof RealDatabaseSync>>;
  };
  globalScope.__mockSqliteDatabases ??= new Map();
  const databases = globalScope.__mockSqliteDatabases;

  function wrap(raw: InstanceType<typeof RealDatabaseSync>) {
    return {
      execSync: (source: string) => {
        raw.exec(source);
      },
      getAllSync: (source: string, params: unknown[] = []) => {
        return raw.prepare(source).all(...params);
      },
      runAsync: async (source: string, params: unknown[] = []) => {
        const info = raw.prepare(source).run(...params);
        return { lastInsertRowId: Number(info.lastInsertRowid), changes: info.changes };
      },
      getAllAsync: async (source: string, params: unknown[] = []) => {
        return raw.prepare(source).all(...params);
      },
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
function loadMessagesModule(): typeof import('../messages') {
  jest.resetModules();
  clearMockDatabases();
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-require after jest.resetModules() to pick up a fresh module instance.
  return require('../messages');
}

describe('markContactMessagesRead', () => {
  let messages: typeof import('../messages');

  beforeEach(() => {
    messages = loadMessagesModule();
  });

  it('sets read_at on incoming unread rows for the target contact only', async () => {
    await messages.saveMessage({
      contactUserId: 'alice',
      direction: 'incoming',
      bodyB64: 'a1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    await messages.saveMessage({
      contactUserId: 'alice',
      direction: 'outgoing',
      bodyB64: 'a2',
      createdAt: '2024-01-01T00:01:00.000Z',
    });
    await messages.saveMessage({
      contactUserId: 'bob',
      direction: 'incoming',
      bodyB64: 'b1',
      createdAt: '2024-01-01T00:02:00.000Z',
    });

    await messages.markContactMessagesRead('alice');

    const summaries = await messages.getConversationSummaries();
    const alice = summaries.find((s) => s.contactUserId === 'alice');
    const bob = summaries.find((s) => s.contactUserId === 'bob');

    expect(alice?.hasUnread).toBe(false);
    expect(bob?.hasUnread).toBe(true);
  });

  it('leaves already-read rows and outgoing rows untouched (idempotent)', async () => {
    await messages.saveMessage({
      contactUserId: 'alice',
      direction: 'incoming',
      bodyB64: 'a1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    await messages.saveMessage({
      contactUserId: 'alice',
      direction: 'outgoing',
      bodyB64: 'a2',
      createdAt: '2024-01-01T00:01:00.000Z',
    });

    await messages.markContactMessagesRead('alice');
    const first = await messages.getConversationSummaries();

    await messages.markContactMessagesRead('alice');
    const second = await messages.getConversationSummaries();

    expect(first).toEqual(second);
    expect(second.find((s) => s.contactUserId === 'alice')?.hasUnread).toBe(false);
  });
});

describe('getConversationSummaries', () => {
  let messages: typeof import('../messages');

  beforeEach(() => {
    messages = loadMessagesModule();
  });

  it('returns one row per contact with that contact\'s most recent message', async () => {
    await messages.saveMessage({
      contactUserId: 'alice',
      direction: 'incoming',
      bodyB64: 'old',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    await messages.saveMessage({
      contactUserId: 'alice',
      direction: 'outgoing',
      bodyB64: 'new',
      createdAt: '2024-01-02T00:00:00.000Z',
    });

    const summaries = await messages.getConversationSummaries();

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      contactUserId: 'alice',
      lastBodyB64: 'new',
      lastDirection: 'outgoing',
      lastCreatedAt: '2024-01-02T00:00:00.000Z',
    });
  });

  it('orders results by lastCreatedAt descending across multiple contacts', async () => {
    await messages.saveMessage({
      contactUserId: 'alice',
      direction: 'incoming',
      bodyB64: 'a1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    await messages.saveMessage({
      contactUserId: 'bob',
      direction: 'incoming',
      bodyB64: 'b1',
      createdAt: '2024-01-03T00:00:00.000Z',
    });
    await messages.saveMessage({
      contactUserId: 'carol',
      direction: 'incoming',
      bodyB64: 'c1',
      createdAt: '2024-01-02T00:00:00.000Z',
    });

    const summaries = await messages.getConversationSummaries();

    expect(summaries.map((s) => s.contactUserId)).toEqual(['bob', 'carol', 'alice']);
  });

  it('flags hasUnread true when any unread incoming message exists for the contact', async () => {
    await messages.saveMessage({
      contactUserId: 'alice',
      direction: 'incoming',
      bodyB64: 'a1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    await messages.saveMessage({
      contactUserId: 'alice',
      direction: 'outgoing',
      bodyB64: 'a2',
      createdAt: '2024-01-02T00:00:00.000Z',
    });

    const summaries = await messages.getConversationSummaries();

    expect(summaries[0].hasUnread).toBe(true);
  });

  it('flags hasUnread false when there are no incoming messages at all', async () => {
    await messages.saveMessage({
      contactUserId: 'alice',
      direction: 'outgoing',
      bodyB64: 'a1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    const summaries = await messages.getConversationSummaries();

    expect(summaries[0].hasUnread).toBe(false);
  });

  it('flags hasUnread false once the only unread incoming message has been read', async () => {
    await messages.saveMessage({
      contactUserId: 'alice',
      direction: 'incoming',
      bodyB64: 'a1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    await messages.markContactMessagesRead('alice');
    const summaries = await messages.getConversationSummaries();

    expect(summaries[0].hasUnread).toBe(false);
  });

  it('returns an empty array when there are no messages', async () => {
    const summaries = await messages.getConversationSummaries();

    expect(summaries).toEqual([]);
  });
});

describe('read_at migration', () => {
  it('adds a read_at column to an already-created messages table without erroring', async () => {
    jest.resetModules();
    clearMockDatabases();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-require after jest.resetModules() to pick up a fresh module instance.
    const SQLite = require('expo-sqlite');
    // Matches messages.ts's exported DATABASE_NAME constant.
    const raw = SQLite.openDatabaseSync('epistl.db') as unknown as {
      execSync: (sql: string) => void;
      getAllSync: <T>(sql: string, params?: unknown[]) => T[];
    };

    // Simulate the pre-existing schema, from before this migration existed.
    raw.execSync(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_user_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        body_b64 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    raw.execSync(
      "INSERT INTO messages (contact_user_id, direction, body_b64, created_at) VALUES ('carol', 'incoming', 'hi', '2024-01-01T00:00:00.000Z')"
    );

    // Loading the module (without an intervening resetModules) must migrate
    // the existing table in place rather than erroring on a duplicate column
    // or a missing one.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-require after jest.resetModules() to pick up a fresh module instance.
    const messages: typeof import('../messages') = require('../messages');

    const columns = raw.getAllSync<{ name: string }>('PRAGMA table_info(messages)');
    expect(columns.some((c) => c.name === 'read_at')).toBe(true);

    await expect(messages.markContactMessagesRead('carol')).resolves.toBeUndefined();

    const rows = raw.getAllSync<{ read_at: string | null }>(
      'SELECT read_at FROM messages WHERE contact_user_id = ?',
      ['carol']
    );
    expect(rows[0].read_at).not.toBeNull();
  });

  it('is safe to run again against a table that already has read_at', () => {
    // First load creates the table (with read_at) against a fresh database.
    jest.resetModules();
    clearMockDatabases();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-require after jest.resetModules() to pick up a fresh module instance.
    require('../messages');

    // Reload the module against that *same* underlying database (no
    // clearMockDatabases in between), simulating an app restart reopening
    // an existing on-disk database that already has the column. The guard
    // must not error on a duplicate `ALTER TABLE ... ADD COLUMN`.
    expect(() => {
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-require after jest.resetModules() to pick up a fresh module instance.
      require('../messages');
    }).not.toThrow();
  });
});
