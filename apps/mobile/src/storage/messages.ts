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

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_user_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  body_b64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const db = SQLite.openDatabaseSync(DATABASE_NAME);
db.execSync(CREATE_TABLE_SQL);

function rowToMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    contactUserId: row.contact_user_id,
    direction: row.direction,
    bodyB64: row.body_b64,
    createdAt: row.created_at,
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
