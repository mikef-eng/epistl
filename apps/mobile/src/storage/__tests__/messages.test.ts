/**
 * `expo-sqlite`'s native module isn't available under Jest, so this mocks it
 * with a real SQLite engine (Node's built-in `node:sqlite`) rather than a
 * hand-rolled JS stand-in. That way both `getConversationSummaries`'
 * window-function SQL and `drizzle-orm`'s expo-sqlite driver (which drives
 * the mock through the same synchronous `prepareSync`/`execSync` surface
 * real `expo-sqlite` exposes) are exercised against genuine SQLite
 * semantics, not a fake.
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

  // Classifies a SQL statement as read-only (SELECT/PRAGMA/WITH/EXPLAIN) vs.
  // mutating, since node:sqlite's `Statement.run()`/`.all()` don't
  // distinguish the two the way real expo-sqlite's `executeSync()` result
  // does (changes/lastInsertRowId for writes, row data for reads).
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
      // Mirrors real expo-sqlite's synchronous prepared-statement API,
      // which is what drizzle-orm's expo-sqlite driver calls directly.
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

  it('does not set read_at on outgoing rows for the target contact', async () => {
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

    // getConversationSummaries()'s hasUnread flag only ever looks at incoming
    // rows, so it can't tell us whether the outgoing row was also (wrongly)
    // touched. Go straight at the raw column via the same underlying
    // database the module under test just wrote to.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- reaching past the module under test to assert on the raw column.
    const SQLite = require('expo-sqlite');
    const raw = SQLite.openDatabaseSync('epistl.db') as unknown as {
      getAllSync: <T>(sql: string, params?: unknown[]) => T[];
    };
    const rows = raw.getAllSync<{ direction: string; read_at: string | null }>(
      'SELECT direction, read_at FROM messages WHERE contact_user_id = ? ORDER BY created_at ASC',
      ['alice']
    );

    expect(rows.find((r) => r.direction === 'incoming')?.read_at).not.toBeNull();
    expect(rows.find((r) => r.direction === 'outgoing')?.read_at).toBeNull();
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

describe('drizzle-kit migrations', () => {
  it('applies the baseline migration once, creating the messages table', async () => {
    const messages = loadMessagesModule();

    await expect(
      messages.saveMessage({
        contactUserId: 'carol',
        direction: 'incoming',
        bodyB64: 'hi',
        createdAt: '2024-01-01T00:00:00.000Z',
      })
    ).resolves.toBeUndefined();

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- reaching past the module under test to assert on drizzle's own bookkeeping table.
    const SQLite = require('expo-sqlite');
    const raw = SQLite.openDatabaseSync('epistl.db') as unknown as {
      getAllSync: <T>(sql: string) => T[];
    };
    const migrationRows = raw.getAllSync<{ hash: string }>('SELECT hash FROM __drizzle_migrations');
    expect(migrationRows.length).toBeGreaterThan(0);
  });

  it('is safe to reload the module against an already-migrated database (simulated app restart)', async () => {
    // First load creates the table and applies the baseline migration
    // against a fresh database.
    const firstLoad = loadMessagesModule();
    await firstLoad.saveMessage({
      contactUserId: 'carol',
      direction: 'incoming',
      bodyB64: 'hi',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    // Reload the module against that *same* underlying database (no
    // clearMockDatabases in between), simulating an app restart reopening
    // an existing on-disk database that has already been migrated. Must not
    // error, and must not lose the previously-saved row.
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-require after jest.resetModules() to pick up a fresh module instance.
    const secondLoad: typeof import('../messages') = require('../messages');

    const rows = await secondLoad.getMessages('carol');
    expect(rows).toHaveLength(1);
    expect(rows[0].bodyB64).toBe('hi');
  });
});
