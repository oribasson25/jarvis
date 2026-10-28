const LABELS = {
  mode: {
    off: 'כבוי',
    mention: 'רק כשפונים אליו',
    smart: 'מחליט לבד',
    always: 'מגיב לכל הודעה',
  },
  modeHelp: {
    off: 'קורא את השיחה אבל לא כותב כלום.',
    mention: 'עונה רק כשמתייגים אותו, קוראים לו בשם או עונים להודעה שלו.',
    smart: 'קורא הכל ומחליט מתי יש לו מה להוסיף, לפי רמת המעורבות.',
    always: 'מגיב על כל רצף הודעות. מתאים לשיחה פרטית או לקבוצה קטנה.',
  },
  engagement: { low: 'נמוכה, מתערב לעיתים רחוקות', medium: 'בינונית', high: 'גבוהה, משתתף פעיל' },
  length: { low: 'קצר (שורה-שתיים)', medium: 'בינוני', high: 'ארוך כשצריך' },
  effort: { low: 'מהיר (מומלץ לצ׳אט)', medium: 'בינוני', high: 'עמוק' },
  model: {
    'claude-opus-5-5': 'Claude Opus 5.5 · הכי חכם',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5 · מאוזן',
    'claude-haiku-5-5': 'Claude Haiku 5.5 · הכי זול ומהיר',
  },
  action: { reply: 'עונה', react: 'מגיב באימוג׳י', silent: 'שותק', error: 'שגיאה', limited: 'הוגבל', knowledge: 'למד מייבוא צ׳אט' },
  status: {
    starting: 'מתחיל…',
    waking: 'מעיר את הסוכן…',
    connecting: 'מתחבר…',
    qr: 'ממתין לסריקה',
    open: 'מחובר',
    logged_out: 'מנותק',
  },
};

let OPTIONS = null;
let chats = [];
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ---------- API + dashboard password ---------- */
const API = '/api/v1';
let password = '';
try {
  password = localStorage.getItem('dashPass') || '';
} catch {}
let loginPromise = null;

const basic = (pass) => 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(':' + pass)));

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(password && { Authorization: basic(password) }) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === 'auth') {
    await askPassword(!!password);
    return api(path, opts);
  }
  if (res.status === 503 && data.code === 'no_password') showBlocker(data.error);
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Shows the login screen once, however many requests are waiting for it. */
function askPassword(wrong) {
  loginPromise ??= new Promise((resolve) => {
    const box = $('#login');
    box.hidden = false;
    $('#login-error').hidden = !wrong;
    const form = $('#login-form');
    form.pass.value = '';
    form.pass.focus();
    form.onsubmit = (e) => {
      e.preventDefault();
      password = form.pass.value;
      try {
        localStorage.setItem('dashPass', password);
      } catch {}
      box.hidden = true;
      loginPromise = null;
      resolve();
    };
  });
  return loginPromise;
}

function showBlocker(text) {
  $('#blocker-text').textContent = text;
  $('#blocker').hidden = false;
}

function toast(text, bad = false) {
  const el = $('#toast');
  el.textContent = text;
  el.className = bad ? 'toast bad' : 'toast';
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

const fmtTime = (ts) =>
  new Date(ts).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/* ---------- tabs ---------- */
function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  try {
    localStorage.setItem('tab', name);
  } catch {}
  if (name === 'chats') loadChats();
  if (name === 'activity') loadEvents();
  if (name === 'playground') loadChats();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

/* ---------- status / connection ---------- */
async function refreshStatus() {
  try {
    const { whatsapp: wa, apiKey } = await api('/status');
    $('#wait-text').textContent =
      wa.status === 'waking' ? 'מעיר את הסוכן, זה לוקח עד דקה…' : 'מתחבר לוואטסאפ…';
    renderApiKey(apiKey);
    const pill = $('#wa-pill');
    pill.textContent = `וואטסאפ: ${LABELS.status[wa.status] || wa.status}`;
    pill.className = 'pill' + (wa.status === 'open' ? ' ok' : wa.status === 'qr' || wa.status === 'logged_out' ? ' warn' : '');

    $('#connect-open').hidden = wa.status !== 'open';
    $('#connect-qr').hidden = wa.status !== 'qr';
    $('#connect-wait').hidden = wa.status === 'open' || wa.status === 'qr';
    if (wa.status === 'qr' && wa.qr && $('#qr-img').src !== wa.qr) $('#qr-img').src = wa.qr;
    if (wa.status === 'open' && wa.me) {
      const number = wa.me.id.split('@')[0];
      $('#me-line').textContent = `${wa.me.name || ''} · +${number}`;
    }
    $('#wa-error').hidden = !wa.error || wa.status === 'open';
    $('#wa-error').textContent = wa.error || '';
  } catch {
    $('#wa-pill').textContent = 'השרת לא זמין';
    $('#wa-pill').className = 'pill warn';
  }
}

/* ---------- API key ---------- */
const KEY_LINK = '<a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">platform.claude.com</a>';

function renderApiKey(info) {
  $('#api-warning').hidden = info.configured;
  const status = $('#apikey-status');
  status.textContent = info.configured ? `✓ מוגדר${info.masked ? ' · ' + info.masked : ''}` : 'לא הוגדר';
  status.className = 'pill ' + (info.configured ? 'ok' : 'warn');
  status.dir = 'auto';
  $('#apikey-clear').hidden = info.source !== 'dashboard';
  const hints = {
    dashboard: 'המפתח שמור במחשב הזה בלבד (data/agent.db) ולא יוצג שוב במלואו. כדי להחליף, מדביקים מפתח חדש.',
    env: 'המפתח נלקח מקובץ ‎.env. מפתח שתשמרו כאן יחליף אותו.',
    'env-token': 'מוגדר טוקן גישה בסביבה. מפתח שתשמרו כאן יחליף אותו.',
  };
  $('#apikey-hint').innerHTML =
    hints[info.source] || `בלי מפתח הסוכן לא יכול לענות. יוצרים מפתח ב-${KEY_LINK} ← API keys, ומדביקים כאן.`;
}

$('#apikey-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = $('button[type=submit]', form);
  btn.disabled = true;
  btn.textContent = 'בודק…';
  try {
    const { apiKey, warning } = await api('/apikey', { method: 'PUT', body: { key: form.key.value } });
    form.key.value = '';
    renderApiKey(apiKey);
    toast(warning || 'המפתח תקין ונשמר ✓', !!warning);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'שמירה ובדיקה';
  }
});

$('#apikey-clear').addEventListener('click', async () => {
  if (!confirm('להסיר את המפתח מהדשבורד?')) return;
  const { apiKey } = await api('/apikey', { method: 'DELETE' });
  renderApiKey(apiKey);
  toast('המפתח הוסר');
});

$('#api-warning').addEventListener('click', () => {
  showTab('connect');
  $('#apikey-form').key.focus();
});

$('#pair-btn').addEventListener('click', async () => {
  const btn = $('#pair-btn');
  btn.disabled = true;
  btn.textContent = 'מבקש קוד…';
  try {
    const { code } = await api('/pair', { method: 'POST', body: { phone: $('#pair-phone').value } });
    const el = $('#pair-code');
    el.textContent = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    el.hidden = false;
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'קבלת קוד';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  if (!confirm('לנתק את הסוכן מוואטסאפ? יהיה צריך לסרוק QR מחדש.')) return;
  toast('מנתק… (עד חצי דקה)');
  try {
    await api('/logout', { method: 'POST' });
    toast('נותק');
  } catch (err) {
    toast(err.message, true);
  }
  refreshStatus();
});

/* ---------- settings ---------- */
function fillSelect(select, values, labels, withDefault) {
  select.innerHTML = '';
  if (withDefault !== undefined) select.append(new Option(withDefault, ''));
  for (const v of values) select.append(new Option(labels?.[v] || v, v));
}

// The form as last loaded. A save sends only what differs from it, so a page left open on another
// device can't put back values that were changed elsewhere since.
let savedSettings = {};

function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    values[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  }
  return values;
}

const changedSettings = () =>
  Object.fromEntries(Object.entries(formValues($('#settings-form'))).filter(([k, v]) => v !== savedSettings[k]));

async function loadSettings() {
  const { settings, options } = await api('/settings');
  OPTIONS = options;
  const form = $('#settings-form');
  for (const select of $$('select[data-options]', form)) {
    const values = [...options[select.dataset.options]];
    if (select.name === 'model' && !values.includes(settings.model)) values.push(settings.model);
    const labelSet = select.dataset.labels ? LABELS[select.dataset.labels] : LABELS.mode;
    fillSelect(select, values, labelSet);
  }
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    const v = settings[el.name];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = Array.isArray(v) ? v.join(', ') : v;
  }
  savedSettings = formValues(form);
  $('#agent-title').textContent = settings.agentName || 'סוכן וואטסאפ';
  $('#mode-help').innerHTML = options.MODES.map(
    (m) => `<div><b>${esc(LABELS.mode[m])}</b>${esc(LABELS.modeHelp[m])}</div>`,
  ).join('');
  fillSelect($('#play-mode'), options.MODES.filter((m) => m !== 'off'), LABELS.mode, 'לפי ההגדרה של השיחה');
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = changedSettings();
  if (!Object.keys(body).length) return toast('אין שינויים לשמור');
  try {
    await api('/settings', { method: 'PUT', body });
    toast('נשמר ✓');
    loadSettings();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- chats ---------- */
async function loadChats() {
  const data = await api('/chats');
  chats = data.chats;
  renderChats();
  const play = $('#play-chat');
  const current = play.value;
  play.innerHTML = '<option value="">שיחה ריקה</option>';
  for (const c of chats) play.append(new Option(c.name || c.jid, c.jid));
  play.value = current;
}

function chatCard(c) {
  const s = c.settings;
  const eff = c.effective;
  const opt = (values, labels, selected, defLabel) =>
    `<option value="">${esc(defLabel)}</option>` +
    values.map((v) => `<option value="${v}" ${selected === v ? 'selected' : ''}>${esc(labels[v])}</option>`).join('');
  const reactSel = s.allowReactions === undefined ? '' : s.allowReactions ? 'on' : 'off';
  const mode = OPTIONS?.MODES || ['off', 'mention', 'smart', 'always'];
  const levels = OPTIONS?.LEVELS || ['low', 'medium', 'high'];
  return `
  <div class="card chat-card" data-jid="${esc(c.jid)}">
    <div class="head">
      <h3>${esc(c.name || c.jid)}
        <span class="badge">${c.is_group ? 'קבוצה' : 'פרטי'}</span>
        <span class="badge mode-${eff.mode}">${esc(LABELS.mode[eff.mode])}</span>
      </h3>
      <span class="meta">${c.message_count} הודעות${c.last_ts ? ' · אחרונה ' + fmtTime(c.last_ts) : ''}</span>
    </div>
    <div class="grid three">
      <label>מצב
        <select name="mode">${opt(mode, LABELS.mode, s.mode, 'ברירת מחדל')}</select>
      </label>
      <label>רמת מעורבות
        <select name="engagement">${opt(levels, LABELS.engagement, s.engagement, 'ברירת מחדל')}</select>
      </label>
      <label>אורך תשובות
        <select name="replyLength">${opt(levels, LABELS.length, s.replyLength, 'ברירת מחדל')}</select>
      </label>
    </div>
    <label>הנחיות מיוחדות לשיחה הזו
      <textarea name="extraPrompt" rows="3" placeholder="למשל: זו קבוצת הכדורגל של יום שלישי. תעזור לארגן מי מגיע ותצחק על מי שמבריז.">${esc(s.extraPrompt || '')}</textarea>
    </label>
    <div class="row" style="align-items:center; justify-content:space-between; flex-wrap:wrap">
      <label class="check" style="margin:0">אימוג׳י:
        <select name="allowReactions" style="width:auto">
          <option value="" ${reactSel === '' ? 'selected' : ''}>ברירת מחדל</option>
          <option value="on" ${reactSel === 'on' ? 'selected' : ''}>מותר</option>
          <option value="off" ${reactSel === 'off' ? 'selected' : ''}>אסור</option>
        </select>
      </label>
      <div class="row">
        <button class="btn" data-act="messages">הודעות אחרונות</button>
        <button class="btn primary" data-act="save">שמירה</button>
      </div>
    </div>
    <div class="messages" hidden></div>
    ${knowledgeSection(c)}
  </div>`;
}

/* ---------- knowledge from a chat export ---------- */
const imports = new Map(); // jid -> import in progress, survives re-rendering the cards
const fmtDate = (ts) => new Date(ts).toLocaleDateString('he-IL');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function knowledgeSummary(k) {
  if (k?.job?.status === 'building') return 'כותב פרופיל מהשיחה… זה לוקח כמה דקות.';
  if (k?.job?.status === 'error') return `הייבוא האחרון נכשל: ${esc(k.job.error)}`;
  if (k?.importedAt) {
    const st = k.stats || {};
    return `למד מ-${st.messages ?? '?'} הודעות (${esc(st.from)}–${esc(st.to)}) · יובא ב-${fmtDate(k.importedAt)}`;
  }
  return 'עוד לא יובא צ׳אט. בוואטסאפ: פרטי הקבוצה ← ייצוא צ׳אט ← בלי מדיה, ומעלים כאן את הקובץ (zip או txt).';
}

function knowledgeSection(c) {
  const k = c.knowledge;
  return `
    <div class="knowledge">
      <div class="knowledge-head">
        <div>
          <b>ידע על הקבוצה</b>
          <div class="meta k-summary">${knowledgeSummary(k)}</div>
        </div>
        <div class="row">
          <label class="btn">ייבוא צ׳אט<input type="file" accept=".txt,.zip,text/plain,application/zip" data-act="import-file" hidden></label>
          ${k?.importedAt ? '<button class="btn" data-act="knowledge">צפייה ועריכה</button>' : ''}
        </div>
      </div>
      <div class="k-progress" ${imports.has(c.jid) ? '' : 'hidden'}>${importView(imports.get(c.jid))}</div>
      <div class="k-editor" hidden></div>
    </div>`;
}

function importView(job) {
  if (!job) return '';
  if (job.phase === 'confirm') {
    const st = job.plan.stats;
    const people = st.participants.slice(0, 8).map((p) => esc(p.name)).join(', ');
    const minutes = Math.ceil((job.plan.parts.length / 3) * 0.6 + 3);
    return `
      <div>נמצאו <b>${st.messages}</b> הודעות מ-${st.participants.length} משתתפים, ${esc(st.from)}–${esc(st.to)}.</div>
      <div class="muted">${people}${st.participants.length > 8 ? '…' : ''}</div>
      ${st.skippedBefore ? `<div class="muted">השיחה ארוכה, אז הסוכן ילמד מההודעות שאחרי ${esc(st.skippedBefore)}.</div>` : ''}
      <div>זה ייקח בערך ${minutes} דקות ויעלה בערך $${st.cost.toFixed(2)} ב-API. צריך להשאיר את הדף פתוח עד שזה נגמר.</div>
      <div class="row">
        <button class="btn primary" data-act="import-start">התחלה</button>
        <button class="btn" data-act="import-cancel">ביטול</button>
      </div>`;
  }
  if (job.phase === 'digest') {
    return `
      <div>קורא את השיחה: ${job.done} מתוך ${job.total} חלקים</div>
      <div class="progress"><div style="width:${Math.round((job.done / job.total) * 90)}%"></div></div>`;
  }
  if (job.phase === 'build') {
    return `
      <div>כותב את הפרופיל של הקבוצה… (כמה דקות)</div>
      <div class="progress"><div style="width:95%"></div></div>`;
  }
  return `<div class="error">${esc(job.error)}</div><div class="row"><button class="btn" data-act="import-cancel">סגירה</button></div>`;
}

function renderImport(jid) {
  const card = $$('.chat-card').find((el) => el.dataset.jid === jid);
  if (!card) return;
  const box = $('.k-progress', card);
  box.innerHTML = importView(imports.get(jid));
  box.hidden = !imports.has(jid);
}

async function prepareImport(jid, file) {
  try {
    const messages = ChatExport.parse(await ChatExport.readFile(file));
    if (messages.length < 20) throw new Error('לא נמצאו הודעות בקובץ. צריך את הקובץ מ"ייצוא צ׳אט" של וואטסאפ.');
    imports.set(jid, { phase: 'confirm', plan: ChatExport.plan(messages) });
  } catch (err) {
    imports.set(jid, { phase: 'error', error: err.message });
  }
  renderImport(jid);
}

async function runImport(jid) {
  const job = imports.get(jid);
  const { parts, recent, samples, stats } = job.plan;
  const chatName = chats.find((c) => c.jid === jid)?.name || '';
  Object.assign(job, { phase: 'digest', done: 0, total: parts.length });
  renderImport(jid);
  window.onbeforeunload = () => true;
  try {
    const notes = new Array(parts.length);
    let next = 0;
    const digestNext = async () => {
      for (let i; (i = next++) < parts.length; ) {
        const p = parts[i];
        for (let attempt = 1; ; attempt++) {
          try {
            const res = await api('/knowledge/digest', { method: 'POST', body: { chatName, parts: parts.length, ...p } });
            notes[i] = { part: p.part, from: p.from, to: p.to, notes: res.notes };
            break;
          } catch (err) {
            if (attempt >= 3) throw err;
            await sleep(3000 * attempt);
          }
        }
        job.done++;
        renderImport(jid);
      }
    };
    await Promise.all([digestNext(), digestNext(), digestNext()]);

    job.phase = 'build';
    renderImport(jid);
    await api(`/chats/${encodeURIComponent(jid)}/knowledge`, { method: 'POST', body: { notes, recent, samples, stats } });
    window.onbeforeunload = null; // the server finishes on its own from here
    for (;;) {
      await sleep(5000);
      const { knowledge } = await api(`/chats/${encodeURIComponent(jid)}/knowledge`);
      if (knowledge?.job?.status === 'error') throw new Error(knowledge.job.error);
      if (knowledge && !knowledge.job) break;
    }
    imports.delete(jid);
    toast('הסוכן למד את הקבוצה ✓');
    loadChats();
  } catch (err) {
    Object.assign(job, { phase: 'error', error: `הייבוא נכשל: ${err.message}` });
    renderImport(jid);
  } finally {
    window.onbeforeunload = null;
  }
}

async function toggleKnowledgeEditor(card) {
  const box = $('.k-editor', card);
  if (!box.hidden) return (box.hidden = true);
  const { knowledge } = await api(`/chats/${encodeURIComponent(card.dataset.jid)}/knowledge`);
  box.innerHTML = `
    <label>מה הסוכן יודע על הקבוצה <small>(אפשר לתקן ולהוסיף)</small>
      <textarea name="profile" rows="16">${esc(knowledge?.profile || '')}</textarea>
    </label>
    <label>דוגמאות מהשיחה <small>(קטעים אמיתיים שמלמדים אותו איך אתם כותבים)</small>
      <textarea name="samples" rows="8">${esc(knowledge?.samples || '')}</textarea>
    </label>
    <div class="row" style="justify-content:space-between">
      <button class="btn danger" data-act="knowledge-clear">מחיקת הידע</button>
      <button class="btn primary" data-act="knowledge-save">שמירה</button>
    </div>`;
  box.hidden = false;
}

// Each card's fields as rendered; like the settings form, a save sends only what changed.
const savedCards = new Map(); // jid -> card values

function cardValues(card) {
  return Object.fromEntries($$('select, textarea[name=extraPrompt]', card).map((el) => [el.name, el.value]));
}

function changedCard(card) {
  const saved = savedCards.get(card.dataset.jid) || {};
  return Object.fromEntries(Object.entries(cardValues(card)).filter(([k, v]) => v !== saved[k]));
}

/** Unsaved card edits or an open knowledge editor, which a re-render would throw away. */
const chatsBusy = () =>
  $$('.chat-card').some((card) => Object.keys(changedCard(card)).length || !$('.k-editor', card)?.hidden);

function renderChats() {
  $('#chats-list').innerHTML = chats.map(chatCard).join('');
  savedCards.clear();
  for (const card of $$('.chat-card')) savedCards.set(card.dataset.jid, cardValues(card));
  $('#chats-empty').hidden = chats.length > 0;
  const building = chats.some((c) => c.knowledge?.job?.status === 'building' && !imports.has(c.jid));
  clearTimeout(renderChats.poll);
  if (building) renderChats.poll = setTimeout(() => $('#tab-chats').classList.contains('active') && loadChats(), 10_000);
}

$('#chats-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.chat-card');
  const jid = card.dataset.jid;
  const act = btn.dataset.act;
  if (act === 'import-start') return runImport(jid);
  if (act === 'import-cancel') {
    imports.delete(jid);
    return renderImport(jid);
  }
  if (act === 'knowledge') return toggleKnowledgeEditor(card).catch((err) => toast(err.message, true));
  if (act === 'knowledge-save' || act === 'knowledge-clear') {
    try {
      const path = `/chats/${encodeURIComponent(jid)}/knowledge`;
      if (act === 'knowledge-clear') {
        if (!confirm('למחוק את כל מה שהסוכן למד על השיחה הזו?')) return;
        await api(path, { method: 'DELETE' });
        toast('הידע נמחק');
        return loadChats();
      }
      const box = $('.k-editor', card);
      await api(path, { method: 'PUT', body: { profile: $('[name=profile]', box).value, samples: $('[name=samples]', box).value } });
      toast('נשמר ✓');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  if (act === 'save') {
    const body = changedCard(card);
    if (!Object.keys(body).length) return toast('אין שינויים לשמור');
    if ('allowReactions' in body) body.allowReactions = body.allowReactions === '' ? null : body.allowReactions === 'on';
    try {
      await api(`/chats/${encodeURIComponent(jid)}`, { method: 'PUT', body });
      toast('נשמר ✓');
      loadChats();
    } catch (err) {
      toast(err.message, true);
    }
  }
  if (btn.dataset.act === 'messages') {
    const box = $('.messages', card);
    if (!box.hidden) return (box.hidden = true);
    const { messages } = await api(`/chats/${encodeURIComponent(jid)}/messages?limit=80`);
    box.innerHTML = messages.length
      ? messages
          .map(
            (m) => `<div class="msg ${m.from_me ? 'me' : ''}"><span class="who">${esc(m.from_me ? 'הסוכן' : m.sender_name || m.sender_jid)}<span class="when">${fmtTime(m.ts)}</span></span>${esc(m.text)}</div>`,
          )
          .join('')
      : '<p class="muted">אין הודעות שמורות עדיין.</p>';
    box.hidden = false;
    box.scrollTop = box.scrollHeight;
  }
});

$('#chats-list').addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'import-file' || !e.target.files[0]) return;
  const jid = e.target.closest('.chat-card').dataset.jid;
  if (imports.get(jid)?.phase === 'digest' || imports.get(jid)?.phase === 'build') return toast('כבר יש ייבוא שרץ', true);
  prepareImport(jid, e.target.files[0]);
  e.target.value = '';
});

$('#refresh-groups').addEventListener('click', async () => {
  try {
    toast('מרענן… (עד חצי דקה)');
    const { groups } = await api('/groups/refresh', { method: 'POST' });
    toast(`נמצאו ${groups} קבוצות`);
    loadChats();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- playground ---------- */
$('#play-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('button[type=submit]', f);
  const out = $('#play-result');
  btn.disabled = true;
  out.innerHTML = '<h2>תוצאה</h2><p class="muted"><span class="spinner"></span> הסוכן חושב…</p>';
  try {
    const r = await api('/playground', {
      method: 'POST',
      body: {
        chatJid: f.chatJid.value,
        senderName: f.senderName.value,
        text: f.text.value,
        addressed: f.addressed.checked,
        mode: f.mode.value,
      },
    });
    if (r.skipped) {
      out.innerHTML = `<h2>תוצאה</h2><p class="result-action">שותק</p><p class="muted">במצב "רק כשפונים אליו" הסוכן לא מגיב להודעה שלא מתייגת אותו או קוראת לו בשם. סמנו "ההודעה מתייגת את הסוכן" או בחרו מצב אחר.</p>`;
      return;
    }
    let body = '';
    if (r.action === 'reply') body = `<div class="bubble">${esc(r.text)}</div>`;
    if (r.action === 'react') body = `<div class="bubble" style="font-size:2rem">${esc(r.emoji)}</div>`;
    if (r.action === 'silent') body = `<p class="muted">הסוכן החליט לא להגיב.${r.note ? ' (סירוב: ' + esc(r.note) + ')' : ''}</p>`;
    const target = r.target ? `<p class="muted">${r.action === 'react' ? 'על ההודעה' : 'בציטוט'}: "${esc(r.target.text.slice(0, 80))}"</p>` : '';
    const u = r.usage || {};
    out.innerHTML = `<h2>תוצאה</h2>
      <p class="result-action">${esc(LABELS.action[r.action] || r.action)}${r.addressed ? ' <span class="badge">פנו אליו</span>' : ''}</p>
      ${body}${target}
      <p class="stats">${esc(r.model)} · ${(r.ms / 1000).toFixed(1)} שנ׳ · טוקנים: ${u.input ?? 0} קלט, ${u.cacheRead ?? 0} מהמטמון, ${u.output ?? 0} פלט</p>`;
  } catch (err) {
    out.innerHTML = `<h2>תוצאה</h2><p class="error">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

/* ---------- activity ---------- */
async function loadEvents() {
  const [{ events }] = await Promise.all([api('/events?limit=150'), chats.length ? null : loadChats()]);
  const names = new Map(chats.map((c) => [c.jid, c.name || c.jid]));
  $('#events').innerHTML = events
    .map((ev) => {
      const d = ev.detail || {};
      let out = '';
      if (ev.type === 'reply') out = `<div class="out">← ${esc(d.text)}</div>`;
      if (ev.type === 'react') out = `<div class="out">← ${esc(d.emoji)}</div>`;
      if (ev.type === 'error') out = `<div class="out error">${esc(d.message)}</div>`;
      if (ev.type === 'limited') out = `<div class="out">${esc(d.reason)}</div>`;
      if (ev.type === 'knowledge') out = `<div class="out">נקראו ${esc(d.messages)} הודעות</div>`;
      const u = d.usage ? ` · ${d.usage.input + d.usage.cacheRead + d.usage.cacheWrite}/${d.usage.output} טוקנים` : '';
      return `<div class="event">
        <div class="when">${fmtTime(ev.ts)}</div>
        <div class="body">
          <span class="chat">${esc(names.get(ev.chat_jid) || ev.chat_jid || '')}</span>
          <span class="type ${ev.type}">${esc(LABELS.action[ev.type] || ev.type)}</span>
          ${d.trigger ? `<div class="trigger">"${esc(d.trigger)}"</div>` : ''}
          ${out}
          ${d.model ? `<div class="stats">${esc(d.model)}${u}${d.ms ? ` · ${(d.ms / 1000).toFixed(1)} שנ׳` : ''}</div>` : ''}
        </div>
      </div>`;
    })
    .join('');
  $('#events-empty').hidden = events.length > 0;
}

/* ---------- boot ---------- */
(async function boot() {
  await loadSettings().catch((err) => toast(err.message, true));
  refreshStatus();
  setInterval(refreshStatus, 2500);
  setInterval(() => {
    if ($('#tab-activity').classList.contains('active')) loadEvents();
  }, 5000);
  let tab = 'connect';
  try {
    tab = localStorage.getItem('tab') || tab;
  } catch {}
  showTab(tab);
})();

// A page left open (say, on the phone) still shows what was saved when it loaded: catch up when it
// comes back into view, unless that would throw away edits that aren't saved yet.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!Object.keys(changedSettings()).length) loadSettings().catch(() => {});
  if ($('#tab-chats').classList.contains('active') && !chatsBusy()) loadChats().catch(() => {});
});
