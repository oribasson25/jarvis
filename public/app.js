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
  action: { reply: 'עונה', react: 'מגיב באימוג׳י', silent: 'שותק', error: 'שגיאה', limited: 'הוגבל' },
  status: {
    starting: 'מתחיל…',
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

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
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
    const { whatsapp: wa, apiKey } = await api('/api/status');
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
    const { apiKey, warning } = await api('/api/apikey', { method: 'PUT', body: { key: form.key.value } });
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
  const { apiKey } = await api('/api/apikey', { method: 'DELETE' });
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
  try {
    const { code } = await api('/api/pair', { method: 'POST', body: { phone: $('#pair-phone').value } });
    const el = $('#pair-code');
    el.textContent = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    el.hidden = false;
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  if (!confirm('לנתק את הסוכן מוואטסאפ? יהיה צריך לסרוק QR מחדש.')) return;
  await api('/api/logout', { method: 'POST' });
  toast('נותק');
  refreshStatus();
});

/* ---------- settings ---------- */
function fillSelect(select, values, labels, withDefault) {
  select.innerHTML = '';
  if (withDefault !== undefined) select.append(new Option(withDefault, ''));
  for (const v of values) select.append(new Option(labels?.[v] || v, v));
}

async function loadSettings() {
  const { settings, options } = await api('/api/settings');
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
  $('#agent-title').textContent = settings.agentName || 'סוכן וואטסאפ';
  $('#mode-help').innerHTML = options.MODES.map(
    (m) => `<div><b>${esc(LABELS.mode[m])}</b>${esc(LABELS.modeHelp[m])}</div>`,
  ).join('');
  fillSelect($('#play-mode'), options.MODES.filter((m) => m !== 'off'), LABELS.mode, 'לפי ההגדרה של השיחה');
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    body[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  }
  try {
    await api('/api/settings', { method: 'PUT', body });
    toast('נשמר ✓');
    loadSettings();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- chats ---------- */
async function loadChats() {
  const data = await api('/api/chats');
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
  </div>`;
}

function renderChats() {
  $('#chats-list').innerHTML = chats.map(chatCard).join('');
  $('#chats-empty').hidden = chats.length > 0;
}

$('#chats-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.chat-card');
  const jid = card.dataset.jid;
  if (btn.dataset.act === 'save') {
    const body = {};
    for (const el of $$('select, textarea', card)) body[el.name] = el.value;
    body.allowReactions = body.allowReactions === '' ? null : body.allowReactions === 'on';
    try {
      await api(`/api/chats/${encodeURIComponent(jid)}`, { method: 'PUT', body });
      toast('נשמר ✓');
      loadChats();
    } catch (err) {
      toast(err.message, true);
    }
  }
  if (btn.dataset.act === 'messages') {
    const box = $('.messages', card);
    if (!box.hidden) return (box.hidden = true);
    const { messages } = await api(`/api/chats/${encodeURIComponent(jid)}/messages?limit=80`);
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

$('#refresh-groups').addEventListener('click', async () => {
  try {
    const { groups } = await api('/api/groups/refresh', { method: 'POST' });
    toast(`נמצאו ${groups.length} קבוצות`);
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
    const r = await api('/api/playground', {
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
  const [{ events }] = await Promise.all([api('/api/events?limit=150'), chats.length ? null : loadChats()]);
  const names = new Map(chats.map((c) => [c.jid, c.name || c.jid]));
  $('#events').innerHTML = events
    .map((ev) => {
      const d = ev.detail || {};
      let out = '';
      if (ev.type === 'reply') out = `<div class="out">← ${esc(d.text)}</div>`;
      if (ev.type === 'react') out = `<div class="out">← ${esc(d.emoji)}</div>`;
      if (ev.type === 'error') out = `<div class="out error">${esc(d.message)}</div>`;
      if (ev.type === 'limited') out = `<div class="out">${esc(d.reason)}</div>`;
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
