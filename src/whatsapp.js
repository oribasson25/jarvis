import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
} from 'baileys';
import { clearAuth, useRedisAuthState } from './auth-state.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'whatsapp' });

/**
 * One linked-device connection to WhatsApp (like WhatsApp Web).
 * Emits: 'state' (connection state changed), 'message' (parsed incoming/outgoing message),
 * 'groups' (list of { jid, name } the account participates in).
 * `fatal` is set when the session must end (another connection replaced this one).
 */
export class WhatsApp extends EventEmitter {
  sock = null;
  state = { status: 'starting', qr: null, me: null, error: null };
  names = new Map(); // user id (no device / server) -> display name
  groupCache = new Map(); // group jid -> metadata, reused by Baileys when sending
  fatal = null;
  #auth = null;
  #stopping = false;

  /** @param {{ selfName: () => string }} opts  how the agent is shown when someone tags it */
  constructor({ selfName }) {
    super();
    this.selfName = selfName;
  }

  async start() {
    this.#stopping = false;
    await this.#auth?.flush(); // a reconnect must read the keys the previous socket wrote
    this.#auth = await useRedisAuthState();
    const { state, saveCreds } = this.#auth;
    const baileysLogger = logger.child({ module: 'baileys' }, { level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
      log.warn({ err: err.message }, 'could not fetch latest WA version, using bundled default');
    }

    const groupCache = this.groupCache;
    const sock = makeWASocket({
      ...(version && { version }),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
      logger: baileysLogger,
      markOnlineOnConnect: false, // keep phone notifications working
      syncFullHistory: false,
      cachedGroupMetadata: async (jid) => groupCache.get(jid),
    });
    this.sock = sock;
    this.#setState({ status: 'connecting', qr: null, error: null });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        this.#setState({ status: 'qr', qr: dataUrl });
      }
      if (connection === 'open') {
        const me = {
          id: jidNormalizedUser(sock.user.id),
          lid: sock.user.lid ? jidNormalizedUser(sock.user.lid) : null,
          name: sock.user.name || sock.user.notify || null,
        };
        this.#setState({ status: 'open', qr: null, me, error: null });
        log.info({ me }, 'connected');
        this.refreshGroups().catch((err) => log.warn({ err: err.message }, 'group fetch failed'));
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (this.#stopping) return;
        if (code === DisconnectReason.connectionReplaced) {
          log.warn('another connection replaced this one - ending the session');
          this.fatal = 'replaced';
          return;
        }
        if (code === DisconnectReason.loggedOut) {
          log.warn('logged out from the phone - clearing session, a new QR will be shown');
          this.#setState({ status: 'logged_out', me: null, error: 'החיבור נותק מהטלפון' });
          await clearAuth();
        } else {
          log.warn({ code, err: lastDisconnect?.error?.message }, 'connection closed, reconnecting');
          this.#setState({ status: 'connecting', error: lastDisconnect?.error?.message || null });
        }
        setTimeout(() => {
          if (!this.#stopping) this.start().catch((err) => log.error(err, 'restart failed'));
        }, 2000);
      }
    });

    sock.ev.on('groups.upsert', (groups) => {
      for (const g of groups) groupCache.set(g.id, g);
      this.emit('groups', groups.map((g) => ({ jid: g.id, name: g.subject })));
    });
    sock.ev.on('groups.update', (updates) => updates.forEach((u) => u.id && this.refreshGroup(u.id)));
    sock.ev.on('group-participants.update', (ev) => this.refreshGroup(ev.id));

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const raw of messages) {
        const msg = this.#parse(raw);
        if (msg) this.emit('message', { ...msg, live: type === 'notify' });
      }
    });
  }

  /** Closes the socket and waits until the session keys are saved, so the next session can resume. */
  async stop() {
    this.#stopping = true;
    this.sock?.end(undefined);
    await this.#auth?.flush();
  }

  async logout() {
    this.#stopping = true;
    try {
      await this.sock?.logout();
    } catch {
      this.sock?.end(undefined);
    }
    await this.#auth?.flush();
    await clearAuth();
    this.#setState({ status: 'logged_out', me: null, qr: null });
  }

  get linked() {
    return !!this.sock?.authState?.creds?.me;
  }

  /** Link with an 8-character code instead of a QR scan. Phone: digits with country code. */
  async requestPairingCode(phone) {
    if (!this.sock) throw new Error('not started');
    if (this.sock.authState.creds.registered) throw new Error('כבר מחובר');
    return this.sock.requestPairingCode(phone.replace(/\D/g, ''));
  }

  async refreshGroups() {
    const all = await this.sock.groupFetchAllParticipating();
    for (const g of Object.values(all)) this.groupCache.set(g.id, g);
    const groups = Object.values(all).map((g) => ({ jid: g.id, name: g.subject }));
    this.emit('groups', groups);
    return groups;
  }

  async refreshGroup(jid) {
    try {
      const meta = await this.sock.groupMetadata(jid);
      this.groupCache.set(jid, meta);
      this.emit('groups', [{ jid, name: meta.subject }]);
    } catch (err) {
      log.debug({ jid, err: err.message }, 'group metadata failed');
    }
  }

  /** Sends text, optionally quoting a stored message row. Returns the WhatsApp message id. */
  async sendText(chatJid, text, quotedRow) {
    const opts = quotedRow ? { quoted: toWAMessage(chatJid, quotedRow) } : undefined;
    const sent = await this.sock.sendMessage(chatJid, { text }, opts);
    return sent?.key?.id;
  }

  async react(chatJid, row, emoji) {
    await this.sock.sendMessage(chatJid, { react: { text: emoji, key: toWAMessage(chatJid, row).key } });
  }

  async setTyping(chatJid, on) {
    try {
      await this.sock.sendPresenceUpdate(on ? 'composing' : 'paused', chatJid);
    } catch {
      // presence is cosmetic
    }
  }

  isMe(jid) {
    if (!jid || !this.state.me) return false;
    const user = userOf(jid);
    return user === userOf(this.state.me.id) || (!!this.state.me.lid && user === userOf(this.state.me.lid));
  }

  nameOf(jid) {
    if (this.isMe(jid)) return null;
    return this.names.get(userOf(jid)) || null;
  }

  #setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  #parse(raw) {
    const key = raw.key;
    const chatJid = key?.remoteJid;
    if (!chatJid || chatJid === 'status@broadcast' || chatJid.endsWith('@newsletter')) return null;

    const content = normalizeMessageContent(raw.message);
    if (!content) return null;
    const type = getContentType(content);
    const body = content[type];
    const { text, ctx } = describe(type, body);
    if (text == null) return null;

    const isGroup = !!isJidGroup(chatJid);
    const senderJid = key.fromMe ? this.state.me?.id : isGroup ? key.participant : chatJid;
    if (raw.pushName && !key.fromMe) {
      for (const jid of [key.participant, key.participantAlt, key.remoteJid, key.remoteJidAlt]) {
        if (jid && !isJidGroup(jid)) this.names.set(userOf(jid), raw.pushName);
      }
    }

    const quoted = ctx?.quotedMessage && normalizeMessageContent(ctx.quotedMessage);
    const quotedType = quoted && getContentType(quoted);
    const mentioned = (ctx?.mentionedJid || []).filter(Boolean);
    return {
      chatJid,
      isGroup,
      waId: key.id,
      fromMe: !!key.fromMe,
      senderJid,
      senderName: key.fromMe ? null : raw.pushName || this.nameOf(senderJid),
      text: this.#readableMentions(text, mentioned),
      quotedWaId: ctx?.stanzaId || null,
      quotedText: quotedType ? describe(quotedType, quoted[quotedType]).text : null,
      mentionsMe: mentioned.some((j) => this.isMe(j)),
      repliesToMe: !!ctx?.participant && this.isMe(ctx.participant),
      ts: Number(raw.messageTimestamp || 0) * 1000 || Date.now(),
    };
  }

  /** "@972501234567" / "@123456789012345" -> "@Name" so the model sees who was tagged. */
  #readableMentions(text, mentioned) {
    let out = text;
    for (const jid of mentioned) {
      const num = userOf(jid);
      const name = this.isMe(jid) ? this.selfName() : this.nameOf(jid);
      if (name) out = out.replaceAll(`@${num}`, `@${name}`);
    }
    return out;
  }
}

const userOf = (jid) => jid.split('@')[0].split(':')[0];

function toWAMessage(chatJid, row) {
  return {
    key: {
      remoteJid: chatJid,
      id: row.wa_id,
      fromMe: !!row.from_me,
      ...(isJidGroup(chatJid) && row.sender_jid && !row.from_me && { participant: row.sender_jid }),
    },
    message: { conversation: row.text },
  };
}

function describe(type, body) {
  const ctx = body?.contextInfo;
  const withCaption = (label) => ({ text: body?.caption ? `[${label}] ${body.caption}` : `[${label}]`, ctx });
  switch (type) {
    case 'conversation':
      return { text: body };
    case 'extendedTextMessage':
      return { text: body.text || '', ctx };
    case 'imageMessage':
      return withCaption('תמונה');
    case 'videoMessage':
      return withCaption(body.gifPlayback ? 'GIF' : 'סרטון');
    case 'audioMessage':
      return { text: body.ptt ? '[הודעה קולית]' : '[קובץ שמע]', ctx };
    case 'stickerMessage':
      return { text: '[סטיקר]', ctx };
    case 'documentMessage':
      return { text: `[קובץ: ${body.fileName || 'ללא שם'}]${body.caption ? ' ' + body.caption : ''}`, ctx };
    case 'documentWithCaptionMessage': {
      const inner = body.message?.documentMessage;
      return describe('documentMessage', inner);
    }
    case 'locationMessage':
    case 'liveLocationMessage':
      return { text: `[מיקום${body.name ? ': ' + body.name : ''}]`, ctx };
    case 'contactMessage':
      return { text: `[איש קשר: ${body.displayName || ''}]`, ctx };
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return { text: `[סקר: ${body.name} | ${(body.options || []).map((o) => o.optionName).join(' / ')}]`, ctx };
    default:
      return { text: null }; // reactions, protocol messages, edits, etc.
  }
}
