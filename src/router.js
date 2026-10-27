import * as db from './db.js';
import { decide, describeError } from './agent.js';
import { effectiveSettings, inQuietHours } from './settings.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'router' });

// Messages older than this (e.g. delivered after the agent was offline) never trigger a turn.
const STALE_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripGeresh = (s) => s.replace(/[׳'’`"״]/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the text calls the agent by its name or a trigger word (Hebrew prefixes like ו/ה/ש allowed). */
export function callsAgent(text, s) {
  const words = [s.agentName, ...s.triggerWords].map((w) => stripGeresh(w || '').trim()).filter(Boolean);
  if (!words.length) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])[והלשבכמ]{0,2}(?:${words.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
  return re.test(stripGeresh(text));
}

/** Smart/always chats fall back to mention-only during quiet hours. */
function turnMode(s) {
  if ((s.mode === 'smart' || s.mode === 'always') && inQuietHours(s)) return 'mention';
  return s.mode;
}

/**
 * Wires WhatsApp messages to the agent: stores every message, decides when a chat needs a turn,
 * debounces bursts, and performs the agent's decision.
 */
export function createRouter(wa) {
  const pending = new Map(); // chatJid -> { timer, addressed }
  const busy = new Set();
  const rerun = new Map(); // chatJid -> addressed, for turns requested while one was running
  const seen = new Map(); // chatJid -> last message id the agent already considered

  wa.on('groups', (groups) => {
    for (const g of groups) db.ensureChat(g.jid, { name: g.name, isGroup: true });
  });

  wa.on('message', (m) => {
    try {
      handle(m);
    } catch (err) {
      log.error({ err }, 'failed to handle message');
    }
  });

  function handle(m) {
    const known = db.getChat(m.chatJid);
    const chat = db.ensureChat(m.chatJid, {
      name: !m.isGroup && !m.fromMe ? m.senderName : null,
      isGroup: m.isGroup,
    });
    if (m.isGroup && !known?.name) wa.refreshGroup(m.chatJid);

    const row = db.insertMessage(m);
    if (!row || m.fromMe || !m.live || Date.now() - m.ts > STALE_MS) return;
    if (!seen.has(m.chatJid)) seen.set(m.chatJid, row.id - 1);

    const s = effectiveSettings(chat);
    const mode = turnMode(s);
    if (mode === 'off') return;
    const addressed = m.mentionsMe || m.repliesToMe || callsAgent(m.text, s);
    if (mode === 'mention' && !addressed) return;

    const p = pending.get(m.chatJid) || { addressed: false };
    p.addressed ||= addressed;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      pending.delete(m.chatJid);
      runTurn(m.chatJid, p.addressed);
    }, s.debounceSeconds * 1000);
    pending.set(m.chatJid, p);
  }

  async function runTurn(chatJid, addressed) {
    if (busy.has(chatJid)) {
      rerun.set(chatJid, rerun.get(chatJid) || addressed);
      return;
    }
    busy.add(chatJid);
    try {
      await turn(chatJid, addressed);
    } catch (err) {
      log.error({ err, chatJid }, 'turn failed');
      db.logEvent(chatJid, 'error', { message: describeError(err) });
    } finally {
      wa.setTyping(chatJid, false);
      busy.delete(chatJid);
      if (rerun.has(chatJid)) {
        const again = rerun.get(chatJid);
        rerun.delete(chatJid);
        runTurn(chatJid, again);
      }
    }
  }

  async function turn(chatJid, addressed) {
    if (wa.state.status !== 'open') return;
    const chat = db.getChat(chatJid);
    const s = effectiveSettings(chat);
    const mode = turnMode(s);
    if (mode === 'off' || (mode === 'mention' && !addressed)) return;

    if (s.maxActionsPerHour && db.countBotActionsSince(chatJid, Date.now() - 3600_000) >= s.maxActionsPerHour) {
      db.logEvent(chatJid, 'limited', { reason: `הגיע למגבלה של ${s.maxActionsPerHour} תגובות בשעה` });
      return;
    }

    const rows = db.contextWindow(chatJid, s.contextMessages);
    const lastId = rows.at(-1)?.id || 0;
    const newFromId = (seen.get(chatJid) ?? lastId - 1) + 1;
    const fresh = rows.filter((r) => r.id >= newFromId && !r.from_me);
    if (!fresh.length) return;

    if (addressed) wa.setTyping(chatJid, true);
    const started = Date.now();
    const decision = await decide({ settings: s, chat, rows, newFromId, mode, addressed });
    seen.set(chatJid, lastId);

    if (decision.action === 'reply') {
      if (!addressed) {
        await wa.setTyping(chatJid, true);
        await sleep(Math.min(800 + decision.text.length * 25, 3500));
      }
      const waId = await wa.sendText(chatJid, decision.text, decision.target);
      if (waId) {
        db.insertMessage({
          chatJid,
          waId,
          senderJid: wa.state.me?.id,
          text: decision.text,
          fromMe: true,
          quotedWaId: decision.target?.wa_id,
          quotedText: decision.target?.text,
          ts: Date.now(),
        });
      }
    } else if (decision.action === 'react' && decision.target) {
      await wa.react(chatJid, decision.target, decision.emoji);
    }

    db.logEvent(chatJid, decision.action, {
      text: decision.text || undefined,
      emoji: decision.emoji || undefined,
      target: decision.target?.id,
      trigger: fresh.at(-1).text.slice(0, 120),
      addressed,
      mode,
      model: decision.model,
      usage: decision.usage,
      note: decision.note,
      ms: Date.now() - started,
    });
  }

  /** Dry run for the dashboard playground: what would the agent do with this message? Sends nothing. */
  async function simulate({ chatJid, senderName, text, addressed, mode }) {
    const chat = chatJid ? db.getChat(chatJid) : null;
    const s = effectiveSettings(chat || { is_group: true, settings: {} });
    const rows = chatJid ? db.contextWindow(chatJid, s.contextMessages) : [];
    const fake = {
      id: (rows.at(-1)?.id || 0) + 1,
      wa_id: '__playground__',
      sender_name: senderName || 'חבר',
      text,
      from_me: 0,
      ts: Date.now(),
    };
    rows.push(fake);
    const useMode = mode || s.mode;
    const isAddressed = !!addressed || callsAgent(text, s);
    if ((useMode === 'mention' || useMode === 'off') && !isAddressed) {
      return { action: 'silent', skipped: true, addressed: false };
    }
    const started = Date.now();
    const decision = await decide({
      settings: s,
      chat: chat || { name: 'מגרש ניסויים', is_group: true },
      rows,
      newFromId: fake.id,
      mode: useMode === 'off' ? 'mention' : useMode,
      addressed: isAddressed,
    });
    return {
      ...decision,
      target: decision.target ? { id: decision.target.id, text: decision.target.text } : null,
      addressed: isAddressed,
      ms: Date.now() - started,
    };
  }

  return { simulate };
}
