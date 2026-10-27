import type { ChatMessage, MessageMeta } from "../../shared/api";
import type { Database } from "../db/database";
import { newId } from "../domain/context";

function rowToMessage(r: Record<string, unknown>): ChatMessage {
  let meta: MessageMeta = {};
  try {
    meta = JSON.parse(String(r.meta ?? "{}")) as MessageMeta;
  } catch {
    meta = {};
  }
  return { id: String(r.id), role: r.role as ChatMessage["role"], content: String(r.content), meta, createdAt: String(r.created_at) };
}

export function addMessage(db: Database, role: ChatMessage["role"], content: string, meta: MessageMeta = {}): ChatMessage {
  const msg: ChatMessage = { id: newId("msg", 10), role, content, meta, createdAt: new Date().toISOString() };
  db.run(
    "INSERT INTO messages (id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)",
    msg.id,
    msg.role,
    msg.content,
    JSON.stringify(meta),
    msg.createdAt,
  );
  return msg;
}

export function updateMessageMeta(db: Database, id: string, meta: MessageMeta) {
  db.run("UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify(meta), id);
}

export function getMessage(db: Database, id: string): ChatMessage | null {
  const r = db.get("SELECT * FROM messages WHERE id = ?", id);
  return r ? rowToMessage(r) : null;
}

/** Most recent messages, oldest first. */
export function recentMessages(db: Database, limit = 200): ChatMessage[] {
  return db
    .all("SELECT * FROM messages ORDER BY created_at DESC, rowid DESC LIMIT ?", limit)
    .map(rowToMessage)
    .reverse();
}

export function clearConversation(db: Database) {
  db.tx(() => {
    db.run("DELETE FROM messages");
    db.run("UPDATE proposals SET status = 'discarded', resolved_at = ? WHERE status = 'pending'", new Date().toISOString());
  });
}
