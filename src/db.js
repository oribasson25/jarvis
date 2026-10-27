import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chats (
    jid        TEXT PRIMARY KEY,
    name       TEXT,
    is_group   INTEGER NOT NULL,
    settings   TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_jid     TEXT NOT NULL,
    wa_id        TEXT NOT NULL,
    sender_jid   TEXT,
    sender_name  TEXT,
    text         TEXT NOT NULL,
    from_me      INTEGER NOT NULL DEFAULT 0,
    quoted_wa_id TEXT,
    quoted_text  TEXT,
    ts           INTEGER NOT NULL,
    UNIQUE (chat_jid, wa_id)
  );
  CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_jid, id);

  CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    chat_jid TEXT,
    type     TEXT NOT NULL,
    detail   TEXT NOT NULL DEFAULT '{}'
  );
`);

const stmts = {
  kvGet: db.prepare('SELECT value FROM kv WHERE key = ?'),
  kvSet: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

  chatGet: db.prepare('SELECT * FROM chats WHERE jid = ?'),
  chatInsert: db.prepare(
    'INSERT INTO chats (jid, name, is_group, settings, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(jid) DO NOTHING',
  ),
  chatRename: db.prepare('UPDATE chats SET name = ? WHERE jid = ?'),
  chatSetSettings: db.prepare('UPDATE chats SET settings = ?, updated_at = ? WHERE jid = ?'),
  chatList: db.prepare(`
    SELECT c.*,
           (SELECT MAX(ts) FROM messages m WHERE m.chat_jid = c.jid) AS last_ts,
           (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = c.jid) AS message_count
    FROM chats c
    ORDER BY c.is_group DESC, last_ts DESC NULLS LAST, c.name
  `),

  msgInsert: db.prepare(`
    INSERT INTO messages (chat_jid, wa_id, sender_jid, sender_name, text, from_me, quoted_wa_id, quoted_text, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_jid, wa_id) DO NOTHING
  `),
  msgById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  msgByWaId: db.prepare('SELECT * FROM messages WHERE chat_jid = ? AND wa_id = ?'),
  msgCount: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_jid = ?'),
  msgWindow: db.prepare('SELECT * FROM messages WHERE chat_jid = ? ORDER BY id LIMIT -1 OFFSET ?'),
  msgRecent: db.prepare('SELECT * FROM messages WHERE chat_jid = ? ORDER BY id DESC LIMIT ?'),
  msgLastId: db.prepare('SELECT MAX(id) AS id FROM messages WHERE chat_jid = ?'),

  eventInsert: db.prepare('INSERT INTO events (ts, chat_jid, type, detail) VALUES (?, ?, ?, ?)'),
  eventList: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?'),
  eventCountSince: db.prepare('SELECT COUNT(*) AS n FROM events WHERE chat_jid = ? AND type IN (?, ?) AND ts >= ?'),
};

const parse = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

export function kvGet(key, fallback) {
  const row = stmts.kvGet.get(key);
  return row ? parse(row.value, fallback) : fallback;
}

export function kvSet(key, value) {
  stmts.kvSet.run(key, JSON.stringify(value));
}

function chatRow(row) {
  return row && { ...row, is_group: !!row.is_group, settings: parse(row.settings, {}) };
}

export function getChat(jid) {
  return chatRow(stmts.chatGet.get(jid));
}

/** Creates the chat if missing (with the given initial settings) and keeps its name fresh. */
export function ensureChat(jid, { name, isGroup, settings }) {
  stmts.chatInsert.run(jid, name || null, isGroup ? 1 : 0, JSON.stringify(settings || {}), Date.now());
  if (name) stmts.chatRename.run(name, jid);
  return getChat(jid);
}

export function setChatSettings(jid, settings) {
  stmts.chatSetSettings.run(JSON.stringify(settings), Date.now(), jid);
  return getChat(jid);
}

export function listChats() {
  return stmts.chatList.all().map(chatRow);
}

/** Returns the stored row, or null when this WhatsApp message id was already stored. */
export function insertMessage(m) {
  const res = stmts.msgInsert.run(
    m.chatJid,
    m.waId,
    m.senderJid || null,
    m.senderName || null,
    m.text,
    m.fromMe ? 1 : 0,
    m.quotedWaId || null,
    m.quotedText || null,
    m.ts,
  );
  return res.changes ? stmts.msgById.get(res.lastInsertRowid) : null;
}

export function getMessage(id) {
  return stmts.msgById.get(id);
}

export function getMessageByWaId(chatJid, waId) {
  return stmts.msgByWaId.get(chatJid, waId);
}

export function lastMessageId(chatJid) {
  return stmts.msgLastId.get(chatJid).id || 0;
}

/**
 * The last ~`size` messages of a chat. The window start only moves in steps of
 * `step` messages, so consecutive requests share a stable prefix (prompt cache hits).
 */
export function contextWindow(chatJid, size, step = 20) {
  const total = stmts.msgCount.get(chatJid).n;
  const start = Math.max(0, Math.ceil((total - size) / step) * step);
  return stmts.msgWindow.all(chatJid, start);
}

export function recentMessages(chatJid, limit) {
  return stmts.msgRecent.all(chatJid, limit).reverse();
}

export function logEvent(chatJid, type, detail = {}) {
  stmts.eventInsert.run(Date.now(), chatJid || null, type, JSON.stringify(detail));
}

export function listEvents(limit = 100) {
  return stmts.eventList.all(limit).map((e) => ({ ...e, detail: parse(e.detail, {}) }));
}

export function countBotActionsSince(chatJid, sinceTs) {
  return stmts.eventCountSince.get(chatJid, 'reply', 'react', sinceTs).n;
}
