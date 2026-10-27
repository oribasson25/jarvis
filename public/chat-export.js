/*
 * Reads a WhatsApp "Export chat" file in the browser and prepares it for import: parses the
 * messages, splits them into parts small enough for one API call each, and picks real excerpts
 * that show how the group writes. The file never leaves the browser whole, which keeps every
 * request under Vercel's body size limit.
 */
(function () {
  // Directional marks WhatsApp sprinkles into exports, especially around Hebrew text.
  const MARKS = /[‎‏‪-‮⁦-⁩﻿]/g;
  // "[27/10/2026, 14:03:12] Name: text" (iPhone) or "27.10.2026, 14:03 - Name: text" (Android),
  // in any of the date orders and 12/24-hour styles WhatsApp uses.
  const HEADER =
    /^\[?(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?(?:\s*([AaPp]\.?\s*[Mm]\.?|לפנה[״"']?צ|אחה[״"']?צ))?\]?\s*(?:[-–]\s+)?(.*)$/;
  const PLACEHOLDER =
    /^<[^<>]{1,60}>$|\b(?:image|video|audio|sticker|GIF|document|Contact card) omitted$|\((?:file attached|קובץ מצורף)\)$|הושמט|^(?:This message was deleted|You deleted this message|ההודעה (?:הזו )?נמחקה|מחקת את ההודעה)\.?$|^null$/i;
  const NOTICE = /end-to-end encrypted|מוצפנות מקצה לקצה/i;
  const EDITED = /\s*<(?:This message was edited|ההודעה נערכה|הודעה זו נערכה)>$/i;

  const CHUNK_CHARS = 120_000; // ~60-80K tokens of Hebrew: stays in Haiku's cheaper price tier
  const MAX_CHUNKS = 40; // larger histories keep only the most recent part
  const RECENT_CHARS = 100_000; // raw recent messages the final step reads directly
  const SAMPLE_CHARS = 16_000; // style excerpts that go into every prompt
  const SAMPLE_COUNT = 24;

  /** Text of an exported chat: a .txt file, or the .zip WhatsApp makes on iPhone. */
  async function readFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const isZip = buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
    return new TextDecoder('utf-8').decode(isZip ? await chatFromZip(buf) : buf);
  }

  /** Minimal zip reader: finds the chat .txt via the central directory and inflates it. */
  async function chatFromZip(buf) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('קובץ ה-zip פגום');
    const entries = [];
    let p = view.getUint32(eocd + 16, true);
    for (let n = view.getUint16(eocd + 10, true); n > 0; n--) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const nameLen = view.getUint16(p + 28, true);
      entries.push({
        method: view.getUint16(p + 10, true),
        size: view.getUint32(p + 20, true),
        offset: view.getUint32(p + 42, true),
        name: new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen)),
      });
      p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    const texts = entries.filter((e) => /\.txt$/i.test(e.name) && !e.name.startsWith('__MACOSX'));
    const entry = texts.find((e) => /_chat\.txt$/i.test(e.name)) || texts.sort((a, b) => b.size - a.size)[0];
    if (!entry) throw new Error('לא נמצא קובץ צ׳אט בתוך ה-zip');
    const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
    const data = buf.subarray(start, start + entry.size);
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw new Error('פורמט דחיסה לא נתמך');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Messages in the export, oldest first: { ts, sender, text }. Skips system lines and media. */
  function parse(raw) {
    // iPhone marks system lines and attachments ("‎image omitted", "‎X added Y") with a leading LRM;
    // flag them before the marks are stripped
    const lines = raw.replace(/: \u200e/g, ': \u0000').replace(MARKS, '').split(/\r?\n/);
    const heads = lines.map((l) => HEADER.exec(l));
    // 03/04/2025 is ambiguous; a day above 12 anywhere in the file settles the order
    let dayFirst = true;
    if (!heads.some((h) => h && h[1].length < 4 && +h[1] > 12) && heads.some((h) => h && +h[2] > 12)) dayFirst = false;

    const messages = [];
    let current = null;
    lines.forEach((line, i) => {
      const h = heads[i];
      if (!h) {
        if (current && line.trim()) current.text += '\n' + line.trim();
        return;
      }
      current = null;
      const rest = h[7];
      const colon = rest.indexOf(': ');
      if (colon <= 0 || colon > 60) return; // "X added Y", encryption notice, ...
      let [y, m, d] = h[1].length === 4 ? [h[1], h[2], h[3]] : dayFirst ? [h[3], h[2], h[1]] : [h[3], h[1], h[2]];
      y = +y < 100 ? 2000 + +y : +y;
      let hour = +h[4] % (h[6] ? 12 : 24);
      if (h[6] && /^p|אחה/i.test(h[6])) hour += 12;
      const ts = new Date(y, +m - 1, +d, hour, +h[5]).getTime();
      current = { ts: Number.isNaN(ts) ? null : ts, sender: rest.slice(0, colon).trim(), text: rest.slice(colon + 2) };
      messages.push(current);
    });
    return messages
      .map((msg) => ({ ...msg, text: msg.text.replace(EDITED, '').trim() }))
      .filter(
        (msg) =>
          msg.text &&
          !msg.text.startsWith('\u0000') &&
          !NOTICE.test(msg.text) &&
          !(msg.text.length <= 80 && PLACEHOLDER.test(msg.text)),
      );
  }

  const pad = (n) => String(n).padStart(2, '0');
  function stamp(ts, withTime = true) {
    if (!ts) return '';
    const d = new Date(ts);
    const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)}`;
    return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
  }
  const line = (msg) => `[${stamp(msg.ts)}] ${msg.sender}: ${msg.text.replace(/\n+/g, ' ↵ ')}`;

  /** Real conversation bursts with several people talking, spread over the recent history. */
  function pickSamples(messages) {
    const bursts = [];
    let burst = [];
    messages.forEach((msg, i) => {
      const prev = messages[i - 1];
      const gap = prev?.ts && msg.ts ? msg.ts - prev.ts > 30 * 60_000 : burst.length >= 20;
      if (gap && burst.length) {
        bursts.push(burst);
        burst = [];
      }
      burst.push(msg);
    });
    if (burst.length) bursts.push(burst);

    const good = bursts
      .map((b) => b.slice(0, 14))
      .filter((b) => b.length >= 6 && new Set(b.map((msg) => msg.sender)).size >= 2 && b.every((msg) => msg.text.length < 400))
      .slice(-300);
    const step = Math.max(1, good.length / SAMPLE_COUNT);
    const picked = [];
    for (let i = good.length - 1; i >= 0 && picked.length < SAMPLE_COUNT; i -= step) picked.unshift(good[Math.floor(i)]);

    const blocks = [];
    let size = 0;
    for (const b of picked.reverse()) {
      const block = `--- ${stamp(b[0].ts, false)}\n` + b.map((msg) => `${msg.sender}: ${msg.text.replace(/\n+/g, ' ↵ ')}`).join('\n');
      if (size + block.length > SAMPLE_CHARS) break;
      blocks.unshift(block);
      size += block.length;
    }
    return blocks.join('\n\n');
  }

  /** Everything the import needs, plus numbers for the confirmation screen. */
  function plan(messages) {
    let chunks = [];
    let chunk = null;
    for (const msg of messages) {
      const l = line(msg);
      if (!chunk || chunk.chars + l.length > CHUNK_CHARS) {
        chunk = { lines: [], chars: 0, from: msg.ts, to: msg.ts, count: 0 };
        chunks.push(chunk);
      }
      chunk.lines.push(l);
      chunk.chars += l.length + 1;
      chunk.to = msg.ts;
      chunk.count++;
    }
    const skipped = chunks.length > MAX_CHUNKS ? chunks.slice(0, -MAX_CHUNKS) : [];
    chunks = chunks.slice(-MAX_CHUNKS);

    const recent = [];
    for (let i = messages.length - 1, size = 0; i >= 0; i--) {
      const l = line(messages[i]);
      if (size + l.length > RECENT_CHARS) break;
      recent.unshift(l);
      size += l.length + 1;
    }

    const counts = {};
    for (const msg of messages) counts[msg.sender] = (counts[msg.sender] || 0) + 1;
    const chars = chunks.reduce((n, c) => n + c.chars, 0);
    const tokens = Math.round(chars / 2); // Hebrew runs about two characters per token
    // Haiku 5.5 reads the parts ($0.10/$0.50 per MTok), Opus 5.5 writes the profile ($4/$20)
    const cost = (tokens * 0.1 + chunks.length * 4000 * 0.5 + (chunks.length * 4000 + RECENT_CHARS / 2) * 4 + 12000 * 20) / 1e6;

    return {
      parts: chunks.map((c, i) => ({
        part: i + 1,
        from: stamp(c.from, false),
        to: stamp(c.to, false),
        text: c.lines.join('\n'),
      })),
      recent: recent.join('\n'),
      samples: pickSamples(messages),
      stats: {
        messages: messages.length,
        used: chunks.reduce((n, c) => n + c.count, 0),
        skippedBefore: skipped.length ? stamp(skipped.at(-1).to, false) : null,
        from: stamp(messages[0]?.ts, false),
        to: stamp(messages.at(-1)?.ts, false),
        participants: Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([name, n]) => ({ name, messages: n })),
        tokens,
        cost: Math.round(cost * 100) / 100,
      },
    };
  }

  globalThis.ChatExport = { readFile, parse, plan };
})();
