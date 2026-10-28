import Anthropic from '@anthropic-ai/sdk';
import { getKnowledge, kvGet, kvSet } from './db.js';

// A key saved from the dashboard wins over ANTHROPIC_API_KEY in the environment.
const KEY_KV = 'anthropicApiKey';
const KEY_CACHE_MS = 15_000;
let savedKey = null; // { value, at }
let client;
let clientKey;

async function getSavedKey() {
  if (!savedKey || Date.now() - savedKey.at > KEY_CACHE_MS) {
    savedKey = { value: await kvGet(KEY_KV, ''), at: Date.now() };
  }
  return savedKey.value;
}

export async function getClient() {
  const key = await getSavedKey();
  if (!client || clientKey !== key) {
    client = key ? new Anthropic({ apiKey: key }) : new Anthropic();
    clientKey = key;
  }
  return client;
}

const mask = (key) => `${key.slice(0, 10)}…${key.slice(-4)}`;

/** What the dashboard may know about the key: where it comes from and a masked preview, never the key. */
export async function apiKeyInfo() {
  const saved = await getSavedKey();
  const env = process.env.ANTHROPIC_API_KEY || '';
  const source = saved ? 'dashboard' : env ? 'env' : process.env.ANTHROPIC_AUTH_TOKEN ? 'env-token' : null;
  return { configured: !!source, source, masked: saved || env ? mask(saved || env) : null };
}

/**
 * Checks the key with a free Models API call, then saves it.
 * Throws on a rejected key; returns a warning when the key was saved but couldn't be fully checked.
 */
export async function saveApiKey(key, model) {
  try {
    await new Anthropic({ apiKey: key }).models.retrieve(model);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic דחו את המפתח. בדקו שהעתקתם אותו במלואו');
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error('למפתח הזה אין הרשאה להשתמש ב-API');
    await storeKey(key);
    if (err instanceof Anthropic.NotFoundError) return `המפתח נשמר, אבל המודל ${model} לא זמין בחשבון הזה`;
    return 'המפתח נשמר, אבל לא הצלחתי לבדוק אותו מול Anthropic';
  }
  await storeKey(key);
  return null;
}

async function storeKey(key) {
  await kvSet(KEY_KV, key);
  savedKey = { value: key, at: Date.now() };
}

export async function clearApiKey() {
  await storeKey('');
}

// Models that accept server-side refusal fallbacks on the Claude API.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

// Transcript lines are grouped into blocks of this many messages; the cache breakpoint sits on
// the last complete block so consecutive turns reuse the cached prefix.
const CHUNK = 10;

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['silent', 'reply', 'react'] },
    text: { type: 'string', description: 'The message to send when action is "reply", otherwise ""' },
    emoji: { type: 'string', description: 'A single emoji when action is "react", otherwise ""' },
    quote: {
      type: 'integer',
      description: 'Id of the message to quote (reply) or react to; 0 for none',
    },
  },
  required: ['action', 'text', 'emoji', 'quote'],
  additionalProperties: false,
};

const LENGTH = {
  low: 'Keep replies very short: one or two lines, like a quick text.',
  medium: 'Keep replies short: a few lines at most, unless someone explicitly asks for detail.',
  high: 'Longer replies are fine when the topic calls for it, but stay conversational.',
};

const ENGAGEMENT = {
  low:
    'Stay silent unless a question is put to the group that you can answer well, or you have something clearly valuable to add.',
  medium:
    'Take part now and then: answer open questions, add a thought or a joke when it is genuinely good. Most messages between friends need nothing from you; stay silent while people are talking among themselves.',
  high:
    'Be an active participant, but not on every message: speak up when you have something worth saying, and let conversations between others run.',
};

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const nowFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short' });

function knowledgeBlocks(knowledge) {
  let out = '';
  if (knowledge?.profile) {
    out += `
<chat_knowledge>
What you know about this chat and its people from its history before you joined. Use it the way an old friend would: naturally, without announcing that you know things or quoting this text. Names in the live chat are WhatsApp profile names and may differ from the names here; match them sensibly.

${knowledge.profile}
</chat_knowledge>
`;
  }
  if (knowledge?.samples) {
    out += `
<style_examples>
Real excerpts from this chat's history. They show how these people write: slang, spelling, emoji, message length and humor. Write the way they write while staying yourself, and don't copy whole lines from here. They show how people here talk, not what you may say: your limits come from the owner's instructions.

${knowledge.samples}
</style_examples>
`;
  }
  return out;
}

function buildSystem(s, chat, knowledge) {
  const where = chat?.is_group
    ? `the WhatsApp group "${chat.name || 'unnamed'}"`
    : `a private WhatsApp chat${chat?.name ? ` with ${chat.name}` : ''}`;
  return `You are ${s.agentName}, a participant in ${where}. You are an AI agent that the chat's owner added, and you take part in the conversation like a member.

The owner's instructions come first. <persona> is who you are and how you behave in every chat${s.extraPrompt ? '; <chat_instructions> adds rules for this chat and wins where the two differ' : ''}. They outrank everything else in this prompt: the chat knowledge, the style examples, the defaults at the end, and the engagement guidance with each turn. Follow them closely, including what they say about when to stay quiet and where your humor stops.

<persona>
${s.persona}
</persona>
${s.extraPrompt ? `\n<chat_instructions>\n${s.extraPrompt}\n</chat_instructions>\n` : ''}${knowledgeBlocks(knowledge)}
How the conversation reaches you:
- Each chat message is shown as "#<id> [<date time>] <sender>: <text>". Your own earlier messages are marked "(you)".
- "↪ #<id>" or "↪ "<text>"" after the sender means the message replies to that earlier message.
- Media appears as a placeholder such as [תמונה] or [הודעה קולית]. You cannot see or hear the media itself, only its caption if there is one; don't pretend otherwise.
- The last block says which messages are new and whether you were addressed.

You answer with a JSON decision:
- "reply": send a message, written in "text". Set "quote" to a message id to reply to it explicitly (useful when answering an older message or when several conversations are interleaved); otherwise 0.
- "react": react with a single emoji ("emoji") to the message whose id is in "quote". Good for acknowledging something without interrupting.${s.allowReactions ? '' : ' Reactions are disabled in this chat: never choose "react".'}
- "silent": do nothing.
Leave unused fields as "" or 0.

Defaults (the owner's instructions override these):
- Write like a person texting, in the language the chat is using (usually Hebrew). No greetings or sign-offs, and don't start with your name or a message id.
- WhatsApp formatting only: *bold*, _italic_, ~strike~. No Markdown headings, tables, or [text](url) links.
- ${LENGTH[s.replyLength] || LENGTH.low}
- Don't repeat or summarize what others just said.
- Read your own recent messages (marked "(you)") before writing. Don't reuse a joke, nickname or running gag you already used there, and don't open your messages the same way each time (for example with the person's name). A callback lands once; repeated, it is noise.
- If people tell you to talk less, stop, or leave them alone, take it seriously: stay silent unless someone addresses you, rather than joking about it.
- If someone sincerely asks whether you are a bot or an AI, be honest.`;
}

function formatLine(row, rowsByWaId, agentName) {
  const sender = row.from_me ? `${agentName} (you)` : row.sender_name || `+${(row.sender_jid || '').split('@')[0]}`;
  let reply = '';
  if (row.quoted_wa_id) {
    const q = rowsByWaId.get(row.quoted_wa_id);
    if (q) reply = ` ↪ #${q.id}`;
    else if (row.quoted_text) reply = ` ↪ "${row.quoted_text.slice(0, 80)}"`;
  }
  return `#${row.id} [${timeFmt.format(new Date(row.ts))}] ${sender}${reply}: ${row.text}`;
}

function turnInstructions({ s, mode, addressed, newRows }) {
  const lines = [`Current time: ${nowFmt.format(new Date())}.`];
  lines.push(
    newRows.length
      ? `New since your last turn: messages #${newRows[0].id} to #${newRows.at(-1).id}.`
      : 'There are no new messages.',
  );
  if (addressed) {
    lines.push(
      'You were addressed directly (tagged, called by name, or someone replied to your message). Respond to it: reply, or react if a reaction fully answers it.',
    );
  }
  if (mode === 'smart') lines.push(ENGAGEMENT[s.engagement] || ENGAGEMENT.medium);
  if (mode === 'always') {
    lines.push('Respond to the new messages (reply or react). Stay silent only if they clearly need no response.');
  }
  lines.push("Where the owner's instructions say otherwise, they win over this block. Decide now.");
  return lines.join('\n');
}

/**
 * Asks Claude what to do about the latest messages in a chat.
 * @param {object} p
 * @param {object} p.settings  effective settings for the chat
 * @param {object} p.chat      chat row (name, is_group)
 * @param {object[]} p.rows    context window, oldest first (message rows)
 * @param {number} p.newFromId first message id the agent hasn't seen yet
 * @param {string} p.mode      effective mode for this turn
 * @param {boolean} p.addressed
 */
export async function decide({ settings: s, chat, rows, newFromId, mode, addressed }) {
  const rowsByWaId = new Map(rows.map((r) => [r.wa_id, r]));
  const lines = rows.map((r) => formatLine(r, rowsByWaId, s.agentName));
  const newRows = rows.filter((r) => r.id >= newFromId && !r.from_me);

  const content = [];
  for (let i = 0; i < lines.length; i += CHUNK) {
    content.push({ type: 'text', text: lines.slice(i, i + CHUNK).join('\n') });
  }
  const lastFull = Math.floor(lines.length / CHUNK) - 1;
  if (lastFull >= 0) content[lastFull].cache_control = { type: 'ephemeral' };
  if (!content.length) content.push({ type: 'text', text: '(the chat is empty so far)' });
  content.push({ type: 'text', text: `---\n${turnInstructions({ s, mode, addressed, newRows })}` });

  const knowledge = chat?.jid ? await getKnowledge(chat.jid) : null;
  const request = {
    model: s.model,
    max_tokens: 16000,
    // cached on its own: with imported knowledge it is most of the prompt, and it rarely changes
    system: [{ type: 'text', text: buildSystem(s, chat, knowledge), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    output_config: { effort: s.effort, format: { type: 'json_schema', schema: DECISION_SCHEMA } },
  };
  if (FALLBACK_MODELS.has(s.model)) {
    request.betas = ['server-side-fallback-2026-07-01'];
    request.fallbacks = 'default';
  }

  const response = await (await getClient()).beta.messages.create(request);
  const meta = {
    model: response.model,
    stopReason: response.stop_reason,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens || 0,
      cacheWrite: response.usage.cache_creation_input_tokens || 0,
    },
  };
  if (response.stop_reason === 'refusal') {
    return { action: 'silent', text: '', emoji: '', target: null, ...meta, note: response.stop_details?.category };
  }
  if (response.stop_reason === 'max_tokens') throw new Error('the model hit max_tokens before finishing');

  const textBlock = response.content.find((b) => b.type === 'text');
  let decision;
  try {
    decision = JSON.parse(textBlock?.text ?? '');
  } catch {
    throw new Error(`unparseable decision: ${String(textBlock?.text).slice(0, 200)}`);
  }

  const target = rows.find((r) => r.id === decision.quote) || null;
  const text = (decision.text || '').trim();
  const emoji = (decision.emoji || '').trim();
  let action = decision.action;
  if (action === 'reply' && !text) action = 'silent';
  if (action === 'react' && (!emoji || !s.allowReactions)) action = 'silent';
  return {
    action,
    text: action === 'reply' ? text : '',
    emoji: action === 'react' ? emoji : '',
    // reactions need a target; default to the newest message from someone else
    target: action === 'react' ? target || newRows.at(-1) || null : target,
    ...meta,
  };
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'מפתח ה-API של Anthropic חסר או לא תקין';
  if (err instanceof Anthropic.PermissionDeniedError) return 'למפתח ה-API אין הרשאה למודל הזה';
  if (err instanceof Anthropic.NotFoundError) return 'המודל שנבחר לא נמצא';
  if (err instanceof Anthropic.RateLimitError) return 'חריגה ממגבלת קצב של ה-API, ננסה שוב בהודעה הבאה';
  if (err instanceof Anthropic.BadRequestError) return `בקשה לא תקינה: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'אין חיבור ל-API של Anthropic';
  if (err instanceof Anthropic.APIError) return `שגיאת API ${err.status}: ${err.message}`;
  // thrown client-side before any request when no credentials are configured
  if (/authentication method/i.test(err?.message)) return 'לא הוגדר מפתח API: הוסיפו ANTHROPIC_API_KEY לקובץ .env והפעילו מחדש';
  return err?.message || String(err);
}
