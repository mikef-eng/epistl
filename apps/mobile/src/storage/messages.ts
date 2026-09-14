/**
 * Local, on-device message history store backed by `expo-sqlite`. This is
 * the only place chat message content is stored durably on the client (see
 * docs/decisions/0001-message-content-never-in-postgres.md for why the
 * backend never persists it). Independent of any screen so it can be unit
 * tested in isolation.
 *
 * `bodyB64` is opaque base64 ciphertext with the same shape as the WS relay
 * payload — this module never inspects or transforms it.
 */
import * as SQLite from 'expo-sqlite';

export const DATABASE_NAME = 'epistl.db';

export type MessageDirection = 'outgoing' | 'incoming';

export interface StoredMessage {
  id: number;
  contactUserId: string;
  direction: MessageDirection;
  bodyB64: string;
  createdAt: string;
}

export interface SaveMessageInput {
  contactUserId: string;
  direction: MessageDirection;
  bodyB64: string;
  createdAt: string;
}

interface MessageRow {
  id: number;
  contact_user_id: string;
  direction: MessageDirection;
  body_b64: string;
  created_at: string;
}

/**
 * One row per contact, summarizing that contact's most recent message and
 * whether they have any unread incoming messages. Backs the Conversations
 * screen's list.
 */
export interface ConversationSummary {
  contactUserId: string;
  lastBodyB64: string;
  lastDirection: MessageDirection;
  lastCreatedAt: string;
  hasUnread: boolean;
}

interface ConversationSummaryRow {
  contact_user_id: string;
  body_b64: string;
  direction: MessageDirection;
  created_at: string;
  has_unread: number;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_user_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  body_b64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

// One row per contact_user_id: the most recent message (by created_at, with
// id as a tiebreaker), plus whether that contact has any unread incoming
// message. Grouped via a window function rather than fetch-all-then-group in
// JS so this scales with message count instead of contact count in memory.
const GET_CONVERSATION_SUMMARIES_SQL = `
WITH ranked AS (
  SELECT
    contact_user_id,
    body_b64,
    direction,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY contact_user_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM messages
),
unread AS (
  SELECT DISTINCT contact_user_id
  FROM messages
  WHERE direction = 'incoming' AND read_at IS NULL
)
SELECT
  ranked.contact_user_id AS contact_user_id,
  ranked.body_b64 AS body_b64,
  ranked.direction AS direction,
  ranked.created_at AS created_at,
  CASE WHEN unread.contact_user_id IS NOT NULL THEN 1 ELSE 0 END AS has_unread
FROM ranked
LEFT JOIN unread ON unread.contact_user_id = ranked.contact_user_id
WHERE ranked.rn = 1
ORDER BY ranked.created_at DESC
`;

const db = SQLite.openDatabaseSync(DATABASE_NAME);
db.execSync(CREATE_TABLE_SQL);
ensureReadAtColumn();

/**
 * Adds the nullable `read_at` column to `messages` if it isn't already
 * present. Guarded via `PRAGMA table_info` so this is safe to run every time
 * the module loads, including against a database created before this column
 * existed.
 */
function ensureReadAtColumn(): void {
  const columns = db.getAllSync<{ name: string }>('PRAGMA table_info(messages)');
  const hasReadAtColumn = columns.some((column) => column.name === 'read_at');
  if (!hasReadAtColumn) {
    db.execSync('ALTER TABLE messages ADD COLUMN read_at TEXT');
  }
}

function rowToMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    contactUserId: row.contact_user_id,
    direction: row.direction,
    bodyB64: row.body_b64,
    createdAt: row.created_at,
  };
}

function rowToConversationSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    contactUserId: row.contact_user_id,
    lastBodyB64: row.body_b64,
    lastDirection: row.direction,
    lastCreatedAt: row.created_at,
    hasUnread: row.has_unread === 1,
  };
}

/** Inserts one message row. */
export async function saveMessage(input: SaveMessageInput): Promise<void> {
  await db.runAsync(
    'INSERT INTO messages (contact_user_id, direction, body_b64, created_at) VALUES (?, ?, ?, ?)',
    [input.contactUserId, input.direction, input.bodyB64, input.createdAt]
  );
}

/** Returns all messages for a contact, ordered by `created_at` ascending. */
export async function getMessages(contactUserId: string): Promise<StoredMessage[]> {
  const rows = await db.getAllAsync<MessageRow>(
    'SELECT id, contact_user_id, direction, body_b64, created_at FROM messages WHERE contact_user_id = ? ORDER BY created_at ASC',
    [contactUserId]
  );
  return rows.map(rowToMessage);
}

/**
 * Marks every unread incoming message from `contactUserId` as read, setting
 * `read_at` to the current timestamp. Outgoing rows and rows for other
 * contacts are untouched. Safe to call repeatedly (a no-op once there is
 * nothing unread left).
 */
export async function markContactMessagesRead(contactUserId: string): Promise<void> {
  await db.runAsync(
    "UPDATE messages SET read_at = ? WHERE contact_user_id = ? AND direction = 'incoming' AND read_at IS NULL",
    [new Date().toISOString(), contactUserId]
  );
}

/**
 * Returns one summary per contact — their most recent message and whether
 * they have any unread incoming messages — ordered by most recent message
 * first.
 */
export async function getConversationSummaries(): Promise<ConversationSummary[]> {
  const rows = await db.getAllAsync<ConversationSummaryRow>(GET_CONVERSATION_SUMMARIES_SQL);
  return rows.map(rowToConversationSummary);
}
