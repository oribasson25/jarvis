import crypto from 'node:crypto';
import express from 'express';
import * as db from './db.js';
import { config } from './config.js';
import { apiKeyInfo, clearApiKey, describeError, saveApiKey } from './agent.js';
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

const log = logger.child({ module: 'server' });

function basicAuth(password) {
  const expected = Buffer.from(password);
  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    const given = scheme === 'Basic' ? Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':') : '';
    const givenBuf = Buffer.from(given);
    const ok = givenBuf.length === expected.length && crypto.timingSafeEqual(givenBuf, expected);
    if (ok) return next();
    res.set('WWW-Authenticate', 'Basic realm="wh-agent", charset="UTF-8"').status(401).send('נדרשת סיסמה');
  };
}

export function startServer({ wa, router }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  if (config.dashboardPassword) app.use(basicAuth(config.dashboardPassword));
  app.use(express.static(config.publicDir));

  app.get('/api/status', (req, res) => {
    res.json({ whatsapp: wa.state, apiKey: apiKeyInfo() });
  });

  app.put('/api/apikey', async (req, res) => {
    const key = String(req.body?.key || '').trim();
    if (!key) return res.status(400).json({ error: 'צריך להדביק מפתח' });
    if (/\s/.test(key) || key.length < 20) return res.status(400).json({ error: 'זה לא נראה כמו מפתח API' });
    try {
      const warning = await saveApiKey(key, getSettings().model);
      res.json({ apiKey: apiKeyInfo(), warning });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/apikey', (req, res) => {
    clearApiKey();
    res.json({ apiKey: apiKeyInfo() });
  });

  app.get('/api/settings', (req, res) => {
    res.json({ settings: getSettings(), defaults: DEFAULTS, options: { MODES, MODELS, EFFORTS, LEVELS } });
  });

  app.put('/api/settings', (req, res) => {
    res.json({ settings: updateSettings(req.body || {}) });
  });

  app.get('/api/chats', (req, res) => {
    res.json({
      fields: CHAT_FIELDS,
      chats: db.listChats().map((c) => ({ ...c, effective: effectiveSettings(c) })),
    });
  });

  app.put('/api/chats/:jid', (req, res) => {
    const chat = db.getChat(req.params.jid);
    if (!chat) return res.status(404).json({ error: 'שיחה לא נמצאה' });
    const updated = db.setChatSettings(chat.jid, sanitizeChatSettings(req.body || {}, chat.settings));
    res.json({ chat: { ...updated, effective: effectiveSettings(updated) } });
  });

  app.get('/api/chats/:jid/messages', (req, res) => {
    res.json({ messages: db.recentMessages(req.params.jid, Math.min(Number(req.query.limit) || 50, 500)) });
  });

  app.post('/api/groups/refresh', async (req, res) => {
    if (wa.state.status !== 'open') return res.status(409).json({ error: 'וואטסאפ לא מחובר' });
    try {
      res.json({ groups: await wa.refreshGroups() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/events', (req, res) => {
    res.json({ events: db.listEvents(Math.min(Number(req.query.limit) || 100, 500)) });
  });

  app.post('/api/pair', async (req, res) => {
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (phone.length < 9) return res.status(400).json({ error: 'מספר עם קידומת מדינה, למשל 972501234567' });
    try {
      res.json({ code: await wa.requestPairingCode(phone) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/logout', async (req, res) => {
    await wa.logout();
    res.json({ ok: true });
  });

  app.post('/api/playground', async (req, res) => {
    const { chatJid, senderName, text, addressed, mode } = req.body || {};
    if (!text?.trim()) return res.status(400).json({ error: 'צריך לכתוב הודעה' });
    if (mode && !MODES.includes(mode)) return res.status(400).json({ error: 'מצב לא מוכר' });
    try {
      res.json(await router.simulate({ chatJid: chatJid || null, senderName, text, addressed, mode }));
    } catch (err) {
      log.warn({ err }, 'playground failed');
      res.status(500).json({ error: describeError(err) });
    }
  });

  app.listen(config.port, config.host, () => {
    log.info(`dashboard: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  });
}
