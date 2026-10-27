import { redis } from './redis.js';

/*
 * Key layout (all values are strings, JSON where structured):
 *   kv:<name>                 settings and other small values
 *   chats                     hash: jid -> chat JSON
 *   msg:seq                   global message id counter
 *   msg:<id>                  message JSON (expires)
 *   chat:<jid>:msgs           list of message ids, oldest first (trimmed)
 *   chat:<jid>:count          messages ever stored in the chat (absolute positions)
 *   chat:<jid>:last           timestamp of the newest message
 *   chat:<jid>:wa:<waId>      WhatsApp id -> message id (dedupe, expires)
 *   chat:<jid>:seen           last message id the agent already considered
 *   chat:<jid>:actions        sorted set of agent reply/react timestamps (rate limit)
 *   chat:<jid>:knowledge      profile and style samples learned from an imported chat export
 *   events                    activity log, newest first (trimmed)
 *   pending                   hash: jid -> "1"/"0" turns handed over to the next worker session
 */

const MSG_TTL = 30 * 24 * 3600;
const KEEP_IDS = 2000;
const KEEP_EVENTS = 500;
const CHAT_CACHE_MS = 30_000;

const r = () => redis();
const parse = (s, fallback) => {
  if (s == null) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

export async function kvGet(key, fallback) {
  return parse(await r().get(`kv:${key}`), fallback);
}

export async function kvSet(key, value) {
  await r().set(`kv:${key}`, JSON.stringify(value));
}

/* ---------- chats ---------- */

const chatCache = new Map(); // jid -> { chat, at }

export async function getChat(jid) {
  return parse(await r().hget('chats', jid), null);
}

async function writeChat(chat) {
  await r().hset('chats', { [chat.jid]: JSON.stringify(chat) });
  chatCache.set(chat.jid, { chat, at: Date.now() });
  return chat;
}

/** Creates the chat if missing and keeps its name fresh. Cached briefly: called for every message. */
export async function ensureChat(jid, { name, isGroup }) {
  const cached = chatCache.get(jid);
  if (cached && Date.now() - cached.at < CHAT_CACHE_MS && (!name || cached.chat.name === name)) return cached.chat;
  const chat = await getChat(jid);
  if (chat && (!name || chat.name === name)) {
    chatCache.set(jid, { chat, at: Date.now() });
    return chat;
  }
  return writeChat({
    jid,
    name: name || chat?.name || null,
    is_group: chat?.is_group ?? !!isGroup,
    settings: chat?.settings || {},
    updated_at: Date.now(),
  });
}

export async function upsertGroupNames(groups) {
  const all = (await r().hgetall('chats')) || {};
  const updates = {};
  for (const g of groups) {
    const cur = parse(all[g.jid], null);
    if (cur && cur.name === g.name) continue;
    updates[g.jid] = JSON.stringify({
      jid: g.jid,
      name: g.name,
      is_group: true,
      settings: cur?.settings || {},
      updated_at: Date.now(),
    });
  }
  if (Object.keys(updates).length) await r().hset('chats', updates);
  chatCache.clear();
}

export async function setChatSettings(jid, settings) {
  const chat = await getChat(jid);
  if (!chat) return null;
  return writeChat({ ...chat, settings, updated_at: Date.now() });
}

export async function listChats() {
  const chats = Object.values((await r().hgetall('chats')) || {})
    .map((s) => parse(s, null))
    .filter(Boolean);
  if (!chats.length) return [];
  const pipe = r().pipeline();
  for (const c of chats) pipe.get(`chat:${c.jid}:count`).get(`chat:${c.jid}:last`);
  const res = await pipe.exec();
  chats.forEach((c, i) => {
    c.message_count = Number(res[2 * i] || 0);
    c.last_ts = res[2 * i + 1] ? Number(res[2 * i + 1]) : null;
  });
  return chats.sort(
    (a, b) =>
      Number(b.is_group) - Number(a.is_group) ||
      (b.last_ts || 0) - (a.last_ts || 0) ||
      String(a.name).localeCompare(String(b.name)),
  );
}

/* ---------- messages ---------- */

/** Returns the stored row, or null when this WhatsApp message id was already stored. */
export async function insertMessage(m) {
  const id = await r().incr('msg:seq');
  const claimed = await r().set(`chat:${m.chatJid}:wa:${m.waId}`, String(id), { nx: true, ex: MSG_TTL });
  if (!claimed) return null;
  const row = {
    id,
    chat_jid: m.chatJid,
    wa_id: m.waId,
    sender_jid: m.senderJid || null,
    sender_name: m.senderName || null,
    text: m.text,
    from_me: m.fromMe ? 1 : 0,
    quoted_wa_id: m.quotedWaId || null,
    quoted_text: m.quotedText || null,
    ts: m.ts,
  };
  const key = `chat:${m.chatJid}`;
  await r()
    .pipeline()
    .set(`msg:${id}`, JSON.stringify(row), { ex: MSG_TTL })
    .rpush(`${key}:msgs`, String(id))
    .incr(`${key}:count`)
    .set(`${key}:last`, String(row.ts))
    .ltrim(`${key}:msgs`, -KEEP_IDS, -1)
    .exec();
  return row;
}

export async function getMessage(id) {
  return parse(await r().get(`msg:${id}`), null);
}

export async function getMessageByWaId(chatJid, waId) {
  const id = await r().get(`chat:${chatJid}:wa:${waId}`);
  return id ? getMessage(id) : null;
}

async function rowsByIds(ids) {
  if (!ids.length) return [];
  const values = await r().mget(...ids.map((id) => `msg:${id}`));
  return values.map((v) => parse(v, null)).filter(Boolean);
}

/**
 * The last ~`size` messages of a chat. The window start only moves in steps of
 * `step` messages, so consecutive requests share a stable prefix (prompt cache hits).
 */
export async function contextWindow(chatJid, size, step = 20) {
  const key = `chat:${chatJid}`;
  const [countRaw, len] = await r().pipeline().get(`${key}:count`).llen(`${key}:msgs`).exec();
  const total = Number(countRaw || 0);
  const start = Math.max(0, Math.ceil((total - size) / step) * step);
  const trimmed = Math.max(0, total - Number(len)); // ids already dropped from the list head
  return rowsByIds(await r().lrange(`${key}:msgs`, Math.max(0, start - trimmed), -1));
}

export async function recentMessages(chatJid, limit) {
  return rowsByIds(await r().lrange(`chat:${chatJid}:msgs`, -limit, -1));
}

export async function getSeen(chatJid) {
  const v = await r().get(`chat:${chatJid}:seen`);
  return v == null ? null : Number(v);
}

export async function setSeen(chatJid, id) {
  await r().set(`chat:${chatJid}:seen`, String(id));
}

/* ---------- turns handed between worker sessions ---------- */

export async function markPending(chatJid, addressed) {
  const prev = await r().hget('pending', chatJid);
  await r().hset('pending', { [chatJid]: addressed || prev === '1' ? '1' : '0' });
}

export async function takePending() {
  const all = await r().hgetall('pending');
  if (!all) return [];
  await r().del('pending');
  return Object.entries(all).map(([jid, a]) => ({ jid, addressed: a === '1' }));
}

/* ---------- activity ---------- */

export async function logEvent(chatJid, type, detail = {}) {
  const ts = Date.now();
  const pipe = r()
    .pipeline()
    .lpush('events', JSON.stringify({ ts, chat_jid: chatJid || null, type, detail }))
    .ltrim('events', 0, KEEP_EVENTS - 1);
  if (chatJid && (type === 'reply' || type === 'react')) {
    const key = `chat:${chatJid}:actions`;
    pipe.zadd(key, { score: ts, member: `${ts}:${Math.random()}` }).zremrangebyscore(key, 0, ts - 2 * 3600_000);
  }
  await pipe.exec();
}

export async function listEvents(limit = 100) {
  return (await r().lrange('events', 0, limit - 1)).map((s) => parse(s, null)).filter(Boolean);
}

export async function countBotActionsSince(chatJid, sinceTs) {
  return Number(await r().zcount(`chat:${chatJid}:actions`, sinceTs, '+inf'));
}

/* ---------- knowledge from an imported chat export (see knowledge.js) ---------- */

const knowledgeCache = new Map(); // jid -> { value, at }; read on every turn

export async function getKnowledge(jid) {
  const cached = knowledgeCache.get(jid);
  if (cached && Date.now() - cached.at < CHAT_CACHE_MS) return cached.value;
  const value = parse(await r().get(`chat:${jid}:knowledge`), null);
  knowledgeCache.set(jid, { value, at: Date.now() });
  return value;
}

export async function setKnowledge(jid, knowledge) {
  await r().set(`chat:${jid}:knowledge`, JSON.stringify(knowledge));
  knowledgeCache.set(jid, { value: knowledge, at: Date.now() });
  return knowledge;
}

export async function clearKnowledge(jid) {
  await r().del(`chat:${jid}:knowledge`);
  knowledgeCache.delete(jid);
}
