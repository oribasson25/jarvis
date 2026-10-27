import crypto from 'node:crypto';
import express from 'express';
import { waitUntil } from '@vercel/functions';
import * as db from './db.js';
import { apiKeyInfo, clearApiKey, describeError, saveApiKey } from './agent.js';
import { clearAuth } from './auth-state.js';
import { kickWorker, markDashboardActive, publishState, readControl, sendCommand } from './control.js';
import { buildKnowledge, digestPart, jobState } from './knowledge.js';
import { hasPersistentStore } from './redis.js';
import { simulate } from './router.js';
import { logger } from './logger.js';
import {
  CHAT_FIELDS,
  DEFAULTS,
  EFFORTS,
  LEVELS,
  MODELS,
  MODES,
  effectiveSettings,
  getSettings,
  sanitizeChatSettings,
  updateSettings,
} from './settings.js';

const log = logger.child({ module: 'app' });
const onVercel = !!process.env.VERCEL;

/**
 * Dashboard password, sent by the page as HTTP Basic auth. Required on Vercel, where the dashboard
 * is on the public internet. No WWW-Authenticate header: the page shows its own login form.
 */
function requirePassword(req, res, next) {
  const password = process.env.DASHBOARD_PASSWORD || '';
  if (!password) {
    if (process.env.VERCEL) {
      return res.status(503).json({ code: 'no_password', error: 'צריך להגדיר DASHBOARD_PASSWORD במשתני הסביבה של Vercel' });
    }
    return next(); // local development
  }
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  const given = Buffer.from(
    scheme === 'Basic' ? Buffer.from(encoded || '', 'base64').toString('utf8').split(':').slice(1).join(':') : '',
  );
  const expected = Buffer.from(password);
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
  res.status(401).json({ code: 'auth', error: 'סיסמה שגויה' });
}

let lastKick = 0;

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' })); // Vercel rejects request bodies over 4.5MB

  const api = express.Router();
  api.use(requirePassword);

  api.get('/status', async (req, res) => {
    await markDashboardActive();
    const { state, running } = await readControl();
    // Nobody holds the connection right now: start a session instead of waiting for the cron.
    if (!running && onVercel && Date.now() - lastKick > 20_000) {
      lastKick = Date.now();
      waitUntil(kickWorker().catch((err) => log.warn({ err: err.message }, 'worker kick failed')));
    }
    const whatsapp = running && state ? state : { status: running ? 'connecting' : 'waking', qr: null, me: state?.me ?? null };
    res.json({ whatsapp, running, apiKey: await apiKeyInfo(), persistent: hasPersistentStore() });
  });

  api.put('/apikey', async (req, res) => {
    const key = String(req.body?.key || '').trim();
    if (!key) return res.status(400).json({ error: 'צריך להדביק מפתח' });
    if (/\s/.test(key) || key.length < 20) return res.status(400).json({ error: 'זה לא נראה כמו מפתח API' });
    try {
      const warning = await saveApiKey(key, (await getSettings()).model);
      res.json({ apiKey: await apiKeyInfo(), warning });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  api.delete('/apikey', async (req, res) => {
    await clearApiKey();
    res.json({ apiKey: await apiKeyInfo() });
  });

  api.get('/settings', async (req, res) => {
    res.json({ settings: await getSettings(), defaults: DEFAULTS, options: { MODES, MODELS, EFFORTS, LEVELS } });
  });

  api.put('/settings', async (req, res) => {
    res.json({ settings: await updateSettings(req.body || {}) });
  });

  api.get('/chats', async (req, res) => {
    const chats = await db.listChats();
    res.json({
      fields: CHAT_FIELDS,
      chats: await Promise.all(
        chats.map(async (c) => {
          const k = await db.getKnowledge(c.jid);
          const knowledge = k && { importedAt: k.importedAt || null, stats: k.stats || null, job: jobState(k) };
          return { ...c, effective: await effectiveSettings(c), knowledge };
        }),
      ),
    });
  });

  api.put('/chats/:jid', async (req, res) => {
    const chat = await db.getChat(req.params.jid);
    if (!chat) return res.status(404).json({ error: 'שיחה לא נמצאה' });
    const updated = await db.setChatSettings(chat.jid, sanitizeChatSettings(req.body || {}, chat.settings));
    res.json({ chat: { ...updated, effective: await effectiveSettings(updated) } });
  });

  api.get('/chats/:jid/messages', async (req, res) => {
    res.json({ messages: await db.recentMessages(req.params.jid, Math.min(Number(req.query.limit) || 50, 500)) });
  });

  api.get('/chats/:jid/knowledge', async (req, res) => {
    const k = await db.getKnowledge(req.params.jid);
    res.json({ knowledge: k && { ...k, job: jobState(k) } });
  });

  // Edits from the dashboard: the profile and samples are plain text the owner may correct.
  api.put('/chats/:jid/knowledge', async (req, res) => {
    const k = await db.getKnowledge(req.params.jid);
    if (!k) return res.status(404).json({ error: 'עוד לא יובא צ׳אט לשיחה הזו' });
    const profile = String(req.body?.profile ?? k.profile ?? '').slice(0, 60_000);
    const samples = String(req.body?.samples ?? k.samples ?? '').slice(0, 30_000);
    res.json({ knowledge: await db.setKnowledge(req.params.jid, { ...k, profile, samples }) });
  });

  api.delete('/chats/:jid/knowledge', async (req, res) => {
    await db.clearKnowledge(req.params.jid);
    res.json({ ok: true });
  });

  // Step 1 of an import: notes on one part of the export (the browser sends the parts one by one).
  api.post('/knowledge/digest', async (req, res) => {
    const { chatName, part, parts, from, to, text } = req.body || {};
    if (!String(text || '').trim()) return res.status(400).json({ error: 'חלק ריק' });
    try {
      res.json(await digestPart({ chatName, part, parts, from, to, text: String(text) }));
    } catch (err) {
      log.warn({ err }, 'digest failed');
      res.status(500).json({ error: describeError(err) });
    }
  });

  // Step 2: merge the notes into a profile. Runs in the background; the dashboard polls the job.
  api.post('/chats/:jid/knowledge', async (req, res) => {
    const chat = await db.getChat(req.params.jid);
    if (!chat) return res.status(404).json({ error: 'שיחה לא נמצאה' });
    const { notes, recent, samples, stats } = req.body || {};
    if (!Array.isArray(notes) || !notes.some((n) => n?.notes)) return res.status(400).json({ error: 'אין סיכומים לבנות מהם פרופיל' });
    const job = buildKnowledge(chat, {
      notes: notes.map((n) => ({ part: n.part, from: n.from, to: n.to, notes: String(n.notes || '') })),
      recent: String(recent || ''),
      samples: String(samples || '').slice(0, 30_000),
      stats: stats || null,
    });
    waitUntil(job);
    res.status(202).json({ started: true });
  });

  api.post('/groups/refresh', async (req, res) => {
    const { state, running } = await readControl();
    if (!running || state?.status !== 'open') return res.status(409).json({ error: 'וואטסאפ לא מחובר כרגע' });
    const answer = await sendCommand('refreshGroups', {}, 40_000);
    if (!answer) return res.status(504).json({ error: 'הסוכן לא ענה בזמן, נסו שוב' });
    if (answer.error) return res.status(500).json({ error: answer.error });
    res.json(answer);
  });

  api.get('/events', async (req, res) => {
    res.json({ events: await db.listEvents(Math.min(Number(req.query.limit) || 100, 500)) });
  });

  api.post('/pair', async (req, res) => {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (phone.length < 9) return res.status(400).json({ error: 'מספר עם קידומת מדינה, למשל 972501234567' });
    const { state, running } = await readControl();
    if (!running) return res.status(409).json({ error: 'החיבור עוד עולה, נסו שוב בעוד דקה' });
    if (state?.status === 'open') return res.status(409).json({ error: 'כבר מחובר' });
    const answer = await sendCommand('pair', { phone }, 25_000);
    if (!answer) return res.status(504).json({ error: 'הסוכן לא ענה בזמן, נסו שוב' });
    if (answer.error) return res.status(500).json({ error: answer.error });
    res.json({ code: answer.code });
  });

  api.post('/logout', async (req, res) => {
    const { running } = await readControl();
    if (running) {
      if (!(await sendCommand('logout', {}, 40_000))) return res.status(504).json({ error: 'הסוכן לא ענה בזמן, נסו שוב' });
    } else {
      await clearAuth();
      await publishState({ status: 'logged_out', me: null, qr: null });
    }
    res.json({ ok: true });
  });

  api.post('/playground', async (req, res) => {
    const { chatJid, senderName, text, addressed, mode } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ error: 'צריך לכתוב הודעה' });
    if (mode && !MODES.includes(mode)) return res.status(400).json({ error: 'מצב לא מוכר' });
    try {
      res.json(await simulate({ chatJid: chatJid || null, senderName, text, addressed, mode }));
    } catch (err) {
      log.warn({ err }, 'playground failed');
      res.status(500).json({ error: describeError(err) });
    }
  });

  app.use('/api/v1', api);
  app.use((err, req, res, next) => {
    log.error({ err }, 'request failed');
    res.status(500).json({ error: err.message });
  });
  return app;
}

export default createApp();
