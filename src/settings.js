import { kvGet, kvSet } from './db.js';

export const MODES = ['off', 'mention', 'smart', 'always'];
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
export const EFFORTS = ['low', 'medium', 'high'];
export const LEVELS = ['low', 'medium', 'high'];

export const DEFAULTS = {
  agentName: 'ג׳ארוויס',
  persona:
    'אתה חבר בקבוצת וואטסאפ של חברים. אתה שנון, קליל וחם, עם הומור ישראלי. ' +
    'אתה לא עוזר רשמי ולא נשמע כמו בוט – אתה מדבר כמו עוד חבר בקבוצה. ' +
    'כשמבקשים ממך מידע או עזרה, אתה עונה בצורה מדויקת ותמציתית.',
  triggerWords: ['ג׳ארוויס', 'גארוויס', 'jarvis'],
  model: 'claude-opus-5-5',
  effort: 'low',
  replyLength: 'low', // low = one-liners, high = longer answers
  engagement: 'medium', // smart mode: how eager to join the conversation
  allowReactions: true,
  contextMessages: 60,
  debounceSeconds: 4,
  maxActionsPerHour: 20,
  defaultGroupMode: 'mention',
  defaultDmMode: 'off',
  quietFrom: '', // "23:30" - empty disables quiet hours
  quietTo: '',
};

/** Fields a single chat may override. */
export const CHAT_FIELDS = ['mode', 'extraPrompt', 'engagement', 'replyLength', 'allowReactions'];

// The worker reads settings on every message; dashboard edits reach it within this window.
// The dashboard reads fresh: another server instance may have saved a newer version.
const CACHE_MS = 15_000;
let cache = null;

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = { ...DEFAULTS, ...(await kvGet('settings', {})) };
  cache = { value, at: Date.now() };
  return value;
}

export async function updateSettings(patch) {
  cache = null;
  const next = { ...(await getSettings()) };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] === undefined) continue;
    next[key] = coerce(key, patch[key], DEFAULTS[key]);
  }
  await kvSet('settings', next);
  cache = { value: next, at: Date.now() };
  return next;
}

export function sanitizeChatSettings(patch, current = {}) {
  const next = { ...current };
  for (const key of CHAT_FIELDS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === '') {
      delete next[key]; // fall back to the global value
    } else if (key === 'mode') {
      if (MODES.includes(value)) next.mode = value;
    } else if (key === 'engagement' || key === 'replyLength') {
      if (LEVELS.includes(value)) next[key] = value;
    } else if (key === 'allowReactions') {
      next.allowReactions = !!value;
    } else {
      next[key] = String(value).slice(0, 4000);
    }
  }
  return next;
}

/** Global settings merged with one chat's overrides. */
export async function effectiveSettings(chat) {
  const global = await getSettings();
  const fallbackMode = chat?.is_group ? global.defaultGroupMode : global.defaultDmMode;
  return { ...global, mode: fallbackMode, extraPrompt: '', ...(chat?.settings || {}) };
}

export function inQuietHours(settings, now = new Date()) {
  const toMinutes = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const from = toMinutes(settings.quietFrom);
  const to = toMinutes(settings.quietTo);
  if (from === null || to === null || from === to) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

function coerce(key, value, def) {
  if (Array.isArray(def)) {
    const list = Array.isArray(value) ? value : String(value).split(',');
    return list.map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
  }
  if (typeof def === 'number') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : def;
  }
  if (typeof def === 'boolean') return !!value;
  if (key === 'defaultGroupMode' || key === 'defaultDmMode') return MODES.includes(value) ? value : def;
  if (key === 'engagement' || key === 'replyLength') return LEVELS.includes(value) ? value : def;
  if (key === 'effort') return EFFORTS.includes(value) ? value : def;
  return String(value).slice(0, 20000);
}
