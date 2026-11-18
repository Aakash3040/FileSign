// Document engine: normalise uploads to PDF, auto-detect signing fields in an
// unseen agreement, stamp values onto it, and build the audit certificate.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const mammoth = require('mammoth');
const crypto = require('crypto');

let pdfjsPromise;
const pdfjs = () => (pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'));

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------- conversion

function sniffType(buf, filename = '') {
  if (buf.slice(0, 5).toString() === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && /\.docx$/i.test(filename || '.docx')) return 'docx';
  if (/\.(txt|md)$/i.test(filename)) return 'txt';
  return null;
}

// Characters outside WinAnsi cannot be drawn with the standard fonts.
const CHAR_MAP = { '‐': '-', '‑': '-', '‒': '-', '−': '-', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '​': '', '☐': '[ ]', '☑': '[X]', '☒': '[X]', '✓': 'X', '✔': 'X', '': '•', '\t': '    ' };
function safeText(font, text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const c = CHAR_MAP[ch] ?? ch;
    try { font.encodeText(c); out += c; } catch { out += '?'; }
  }
  return out;
}

function wrap(font, size, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (font.widthOfTextAtSize(test, size) <= maxWidth || !line.trim()) {
        // hard-break very long tokens (e.g. long underscore runs)
        if (font.widthOfTextAtSize(test, size) > maxWidth && !line.trim()) {
          let chunk = '';
          for (const ch of test) {
            if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) { lines.push(chunk); chunk = ''; }
            chunk += ch;
          }
          line = chunk;
        } else line = test;
      } else {
        lines.push(line.trimEnd());
        line = w.trimStart();
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// Render structured blocks (from DOCX/TXT) into a clean Letter-size PDF.
async function blocksToPdf(blocks, title) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 64, maxW = W - M * 2;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  for (const b of blocks) {
    if (b.cells) { // table row: lay cells out in equal columns
      const n = Math.max(1, b.cells.length), gap = 18, colW = (maxW - gap * (n - 1)) / n, size = 10.5, lh = size * 1.45;
      const cols = b.cells.map((t) => wrap(regular, size, safeText(regular, t), colW));
      const rows = Math.max(1, ...cols.map((c) => c.length));
      if (y - rows * lh < M) newPage();
      cols.forEach((lines, i) => lines.forEach((ln, j) => page.drawText(ln, { x: M + i * (colW + gap), y: y - size - j * lh, size, font: regular, color: rgb(0.1, 0.1, 0.12) })));
      y -= rows * lh + size * 0.9;
      continue;
    }
    const font = b.bold || b.heading ? bold : regular;
    const size = b.heading === 1 ? 16 : b.heading ? 13 : 10.5;
    const indent = b.list ? 16 : 0;
    const text = safeText(font, (b.list ? '•  ' : '') + b.text);
    const lines = wrap(font, size, text, maxW - indent);
    const lh = size * 1.45;
    if (b.heading) y -= size * 0.6;
    for (const ln of lines) {
      if (y - lh < M) newPage();
      page.drawText(ln, { x: M + indent, y: y - size, size, font, color: rgb(0.1, 0.1, 0.12) });
      y -= lh;
    }
    y -= b.heading ? 4 : size * 0.6;
  }
  doc.setTitle(title || 'Agreement');
  return Buffer.from(await doc.save());
}

function htmlToBlocks(html) {
  const decode = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  const blocks = [];
  // table rows → one line per row with cells separated
  html = html.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => decode(m[1].replace(/<\/p>\s*<p[^>]*>/gi, ' ')).trim());
    return `<p data-row="${encodeURIComponent(JSON.stringify(cells))}"></p>`;
  });
  const re = /<(h[1-6]|p|li)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    const row = m[2].match(/data-row="([^"]*)"/);
    if (row) { blocks.push({ cells: JSON.parse(decodeURIComponent(row[1])) }); continue; }
    m.splice(2, 1);
    const tag = m[1].toLowerCase();
    const inner = m[2];
    const text = decode(inner).trim();
    if (!text) { blocks.push({ text: '' }); continue; }
    const allBold = /^<strong>[\s\S]*<\/strong>$/.test(inner.trim());
    blocks.push({
      text,
      heading: tag[0] === 'h' ? Math.min(2, +tag[1]) : 0,
      bold: allBold,
      list: tag === 'li',
    });
  }
  return blocks;
}

async function normalizeToPdf(buf, filename) {
  const type = sniffType(buf, filename);
  if (type === 'pdf') {
    // Re-save through pdf-lib to verify it is parseable and not encrypted.
    const doc = await PDFDocument.load(buf, { ignoreEncryption: false, updateMetadata: false });
    if (doc.getPageCount() === 0) throw new Error('The PDF has no pages.');
    return Buffer.from(await doc.save());
  }
  if (type === 'docx') {
    const { value } = await mammoth.convertToHtml({ buffer: buf });
    const blocks = htmlToBlocks(value);
    if (!blocks.some((b) => b.text)) throw new Error('The Word document appears to be empty.');
    return blocksToPdf(blocks, filename);
  }
  if (type === 'txt') {
    const blocks = buf.toString('utf8').split(/\r?\n/).map((t) => ({ text: t }));
    return blocksToPdf(blocks, filename);
  }
  throw new Error('Unsupported file. Upload a PDF or Word (.docx) document.');
}

// ---------------------------------------------------------------- detection

const KW = {
  initials: /\binitials?\b/i,
  signature: /\b(signature|signed|sign here|sign)\b|^\s*by\s*:?\s*$|\bby\s*:/i,
  date: /\bdate[d]?\b/i,
  email: /\be-?mail\b/i,
  name: /\b(print(ed)?\s+name|full\s+name|name)\b/i,
  title: /\b(title|position|capacity)\b/i,
  phone: /\b(phone|telephone|mobile)\b/i,
  address: /\baddress\b/i,
};
const SENDER_WORDS = 'company|firm|provider|service provider|agency|consultant|contractor|attorney|counsel|law firm|vendor|supplier|licensor|for and on behalf of|authori[sz]ed (?:signatory|representative)|representative';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function senderPartyRe(orgName) {
  const words = String(orgName || '').split(/[^A-Za-z0-9&]+/)
    .filter((w) => w.length >= 3 && !/^(inc|llc|ltd|corp|the|and|group|co)$/i.test(w)).map(escapeRe);
  return new RegExp(`\\b(${[SENDER_WORDS, ...words].join('|')})\\b`, 'i');
}
const CLIENT_PARTY = /\b(client|customer|claimant|patient|policyholder|homeowner|insured|buyer|purchaser|licensee|you|undersigned|guarantor|participant|member)\b/i;

// Helvetica advance widths (per 1000 em) — a good proxy for most body fonts,
// used to locate a substring inside a pdf.js text run far better than char counts.
const HW = ' 278!278"355#556$556%889&667\'191(333)333*389+584,278-333.278/278:278;278<584=584>584?556@1015A667B667C722D722E667F611G778H722I278J500K667L556M833N722O778P667Q778R722S667T611U722V667W944X667Y667Z611[278\\278]278^469_556`333a556b556c500d556e556f278g556h556i222j222k500l222m833n556o556p556q556r333s500t278u556v500w722x500y500z500{334|260}334~584';
const WMAP = {};
for (let i = 0; i < HW.length;) { const ch = HW[i]; const m = HW.slice(i + 1).match(/^\d+/); WMAP[ch] = +m[0]; i += 1 + m[0].length; }
for (let d = 0; d <= 9; d++) WMAP[String(d)] = 556;
const strW = (s) => { let w = 0; for (const ch of s) w += WMAP[ch] ?? 556; return w; };
// x offset and width (in item units) of str.slice(start, start+len)
function subRange(it, start, len) {
  const total = strW(it.str) || 1;
  return { x: it.x + it.w * (strW(it.str.slice(0, start)) / total), w: it.w * (strW(it.str.slice(start, start + len)) / total) };
}

function classify(context) {
  for (const t of ['initials', 'signature', 'date', 'email', 'name', 'title', 'phone', 'address']) {
    if (KW[t].test(context)) return t;
  }
  return 'text';
}

const TYPE_DEFAULTS = {
  signature: { h: 30, minW: 140, label: 'Signature' },
  initials: { h: 24, minW: 50, label: 'Initials' },
  date: { h: 16, minW: 90, label: 'Date' },
  name: { h: 16, minW: 140, label: 'Full name' },
  email: { h: 16, minW: 160, label: 'Email' },
  text: { h: 16, minW: 80, label: 'Text' },
  checkbox: { h: 14, minW: 14, label: 'Checkbox' },
};

function placeholderSource(label) {
  const l = label.toLowerCase().replace(/[_\-.]+/g, ' ');
  if (/sign/.test(l)) return { role: 'client', type: 'signature' };
  if (/initial/.test(l)) return { role: 'client', type: 'initials' };
  if (/(client|customer|claimant|insured|patient).*(e-?mail)|^e-?mail/.test(l)) return { role: 'sender', source: 'client_email' };
  if (/(client|customer|claimant|insured|patient|homeowner|policyholder).*(name)|^(full )?name$/.test(l)) return { role: 'sender', source: 'client_name' };
  if (/\b(file|matter|case|job|reference|ref)\b/.test(l) && !/(policy|claim|account|tax|license|phone)/.test(l)) return { role: 'sender', source: 'file_ref' };
  if (/date/.test(l)) return { role: 'sender', source: 'today' };
  return { role: 'sender', source: 'custom' };
}

async function analyzePdf(pdfBuf, { orgName } = {}) {
  const SENDER_PARTY = senderPartyRe(orgName);
  const { getDocument } = await pdfjs();
  const task = getDocument({ data: new Uint8Array(pdfBuf), useSystemFonts: false, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  const fields = [];
  const notes = [];
  let textChars = 0;
  let fid = 0;
  const add = (f) => {
    const d = TYPE_DEFAULTS[f.type] || TYPE_DEFAULTS.text;
    if (f.role === 'sender' && !f.source) {
      f.source = { signature: 'sender_signature', initials: 'sender_signature', name: 'sender_name', date: 'today', email: 'sender_email' }[f.type] || 'custom';
      if (f.type === 'checkbox') f.source = 'custom';
    }
    const field = {
      id: `f${++fid}`,
      type: f.type,
      role: f.role || 'client',
      label: f.label || d.label,
      required: f.required ?? f.type !== 'text',
      page: f.page,
      x: Math.max(0, f.x), y: Math.max(0, f.y),
      w: f.exactW ? f.w : Math.max(d.minW, f.w || d.minW), h: f.h || d.h,
      source: f.source || null,
      whiteout: !!f.whiteout,
      detectedFrom: f.detectedFrom || null,
    };
    // drop near-duplicates (same page, heavily overlapping)
    const dup = fields.find((o) => o.page === field.page &&
      Math.abs(o.x - field.x) < 25 && Math.abs(o.y - field.y) < 12);
    if (!dup) fields.push(field);
  };

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    pages.push({ w: vp.width, h: vp.height, rotate: page.rotate || 0, view: page.view });
    const tc = await page.getTextContent();
    // Items in top-left viewport coordinates
    const items = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      textChars += it.str.trim().length;
      const [x, yTop] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      items.push({ str: it.str, x, base: yTop, size, w: it.width });
    }
    // group into lines by baseline
    items.sort((a, b) => a.base - b.base || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const line = lines.find((l) => Math.abs(l.base - it.base) < Math.max(2.5, it.size * 0.35));
      if (line) line.items.push(it); else lines.push({ base: it.base, items: [it] });
    }
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      l.text = l.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
      l.x0 = l.items[0].x;
      l.x1 = Math.max(...l.items.map((i) => i.x + i.w));
    }
    lines.sort((a, b) => a.base - b.base);

    // Determine party (client vs firm) from the nearest heading above in the same column.
    const partyFor = (lineIdx, x) => {
      for (let k = lineIdx; k >= 0 && lines[lineIdx].base - lines[k].base < 220; k--) {
        const segs = lines[k].items.filter((i) => Math.abs(i.x - x) < 160 || (i.x <= x && i.x + i.w >= x));
        const txt = (segs.length ? segs : lines[k].items).map((i) => i.str).join(' ');
        if (k === lineIdx) continue;
        if (CLIENT_PARTY.test(txt) && !SENDER_PARTY.test(txt)) return 'client';
        if (SENDER_PARTY.test(txt) && !CLIENT_PARTY.test(txt)) return 'sender';
        // Two-column block where only the other column is recognisably the client
        // (e.g. "CLIENT" | "NORTHWIND ADVISORY LLC"): this column is the other party.
        const others = lines[k].items.filter((i) => !segs.includes(i)).map((i) => i.str).join(' ');
        if (segs.length && txt.trim().length <= 60 && !/_{4,}/.test(txt) && !/[a-z]{3,}.*:/.test(txt)
          && CLIENT_PARTY.test(others) && !SENDER_PARTY.test(others)) return 'sender';
      }
      return 'client';
    };

    lines.forEach((line, li) => {
      // 1) explicit placeholders: [Client Name], {{file_number}}, <<Date>>
      for (const it of line.items) {
        const re = /\[([^\]\n]{1,48})\]|\{\{\s*([^}\n]{1,48}?)\s*\}\}|<<([^>\n]{2,48})>>/g;
        let m;
        while ((m = re.exec(it.str))) {
          const label = (m[1] || m[2] || m[3]).trim();
          if (/^\s*[x ]?\s*$/i.test(label)) { // [ ] checkbox
            const cx = subRange(it, m.index, m[0].length).x;
            add({ type: 'checkbox', page: p - 1, x: cx, y: it.base - it.size, w: it.size, h: it.size, role: partyFor(li, cx), label: 'Checkbox', required: false, detectedFrom: m[0], whiteout: true });
            continue;
          }
          if (!/[a-z]/i.test(label) || label.split(/\s+/).length > 6) continue;
          const src = placeholderSource(label);
          const { x, w } = subRange(it, m.index, m[0].length);
          const type = src.type || (src.source === 'today' ? 'date' : 'text');
          add({
            type, role: src.role, source: src.source || null, page: p - 1,
            x, y: it.base - it.size * (type === 'signature' ? 2 : 1.05), w, h: type === 'signature' ? it.size * 2.6 : it.size * 1.35,
            label: label.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), whiteout: true, exactW: true, required: true, detectedFrom: m[0],
          });
        }
      }

      // 2) underscore runs (blank lines to write on)
      for (const it of line.items) {
        const re = /_{4,}/g;
        let m;
        while ((m = re.exec(it.str))) {
          const { x, w } = subRange(it, m.index, m[0].length);
          // context: text before the run on this line, else caption on line below, else line above
          const before = (line.items.filter((o) => o.x + o.w <= x + 2 && o !== it).map((o) => o.str).join(' ') + ' ' + it.str.slice(0, m.index))
            .replace(/_+/g, ' ').trim();
          const lastLabel = before.split(/\s{2,}|_{2,}/).pop() || '';
          let context = lastLabel.slice(-40);
          const below = lines[li + 1] && lines[li + 1].base - line.base < 26
            ? lines[li + 1].items.filter((o) => o.x < x + w && o.x + o.w > x - 10).map((o) => o.str).join(' ') : '';
          if (!classifyStrong(context) && below) context = below;
          const type = classify(context);
          const fType = ['title', 'phone', 'address'].includes(type) ? 'text' : type;
          const d = TYPE_DEFAULTS[fType];
          const label = type === 'text' ? (context.replace(/[:\s]+$/, '').slice(-30) || 'Text')
            : type === 'title' ? 'Title' : type === 'phone' ? 'Phone' : type === 'address' ? 'Address' : d.label;
          add({
            type: fType, page: p - 1, x, w,
            y: line.base - d.h + 2, h: d.h,
            role: partyFor(li, x), label, required: fType !== 'text', detectedFrom: (context + ' ' + m[0]).trim(),
          });
        }
      }

      // 3) bare labels like "Signature:" / "Date:" with nothing written after
      const m = line.text.match(/^(.{0,30}?)(client signature|signature|initials|date|print(?:ed)? name|full name|name|e-?mail|title)\s*:\s*$/i);
      if (m && !/_{4,}/.test(line.text)) {
        const type = classify(m[2]);
        const fType = type === 'title' ? 'text' : type;
        const d = TYPE_DEFAULTS[fType];
        const last = line.items[line.items.length - 1];
        const x = last.x + last.w + 6;
        add({
          type: fType, page: p - 1, x, w: Math.min(Math.max(d.minW, 200), vp.width - x - 36),
          y: line.base - d.h + 2, h: d.h, role: partyFor(li, line.x0),
          label: type === 'title' ? 'Title' : d.label, detectedFrom: line.text,
        });
      }
    });
  }

  // Name/date fields next to a signature inherit its role; text fields default optional.
  const scanned = textChars < 40;
  if (scanned) notes.push('This document has no readable text (it may be a scan), so fields could not be detected automatically.');
  const hasClientSig = fields.some((f) => f.role === 'client' && f.type === 'signature');
  await doc.destroy();
  return { pages, fields, notes, scanned, hasClientSig };
}

function classifyStrong(ctx) {
  return /signature|signed|initial|date|name|e-?mail|title|by\s*:|phone|address/i.test(ctx);
}

// When an agreement has no detectable client signature block, append a
// signature page so any document can still be executed.
async function appendSignaturePage(pdfBuf, pages) {
  const doc = await PDFDocument.load(pdfBuf);
  const last = doc.getPage(doc.getPageCount() - 1);
  const { width: W, height: H } = last.getSize();
  const page = doc.addPage([W, H]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const M = 72;
  page.drawText('SIGNATURE PAGE', { x: M, y: H - M - 16, size: 16, font: bold });
  const intro = 'By signing below, the Client confirms they have read, understood and agree to be bound by the terms of the preceding agreement.';
  wrap(reg, 10.5, intro, W - 2 * M).forEach((ln, i) => page.drawText(ln, { x: M, y: H - M - 44 - i * 15, size: 10.5, font: reg }));
  const rows = [['Client signature', 150], ['Full name', 205], ['Date', 260]];
  for (const [label, off] of rows) {
    const y = H - M - off;
    page.drawLine({ start: { x: M, y }, end: { x: M + 280, y }, thickness: 0.8, color: rgb(0.3, 0.3, 0.3) });
    page.drawText(label, { x: M, y: y - 13, size: 9, font: reg, color: rgb(0.35, 0.35, 0.4) });
  }
  const out = Buffer.from(await doc.save());
  const pi = pages.length;
  const newPages = [...pages, { w: W, h: H, rotate: 0, view: [0, 0, W, H] }];
  const fields = [
    { type: 'signature', label: 'Signature', off: 150, h: 32 },
    { type: 'name', label: 'Full name', off: 205, h: 16 },
    { type: 'date', label: 'Date', off: 260, h: 16 },
  ].map((f, i) => ({
    id: `p${i + 1}`, type: f.type, role: 'client', label: f.label, required: true, page: pi,
    x: M, y: M + f.off - f.h + 2, w: 280, h: f.h, source: null, whiteout: false, detectedFrom: 'Added signature page',
  }));
  return { pdf: out, pages: newPages, fields };
}

// ---------------------------------------------------------------- stamping

const fmtDate = (d = new Date(), tz) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: tz || 'UTC' });

function toPdfRect(page, meta, f) {
  // meta.view = [x0, y0, x1, y1]; field coordinates are top-left based in points.
  const [x0, , , y1] = meta.view || [0, 0, meta.w, meta.h];
  return { x: x0 + f.x, y: y1 - f.y - f.h, w: f.w, h: f.h };
}

function drawFittedText(page, font, text, r, { maxSize = 11, color = rgb(0.05, 0.1, 0.35) } = {}) {
  text = safeText(font, text);
  let size = Math.min(maxSize, r.h * 0.8);
  while (size > 5 && font.widthOfTextAtSize(text, size) > r.w - 2) size -= 0.5;
  page.drawText(text, { x: r.x + 1, y: r.y + (r.h - size) / 2 + size * 0.22, size, font, color });
}

async function stamp(pdfBuf, pagesMeta, fields, values, { whiteoutOnly = false } = {}) {
  const doc = await PDFDocument.load(pdfBuf);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const script = await doc.embedFont(StandardFonts.TimesRomanBoldItalic);
  const pdfPages = doc.getPages();
  for (const f of fields) {
    const page = pdfPages[f.page];
    if (!page) continue;
    const r = toPdfRect(page, pagesMeta[f.page], f);
    const v = values[f.id];
    if (f.whiteout) page.drawRectangle({ x: r.x - 1, y: r.y - 1, width: r.w + 2, height: r.h + 2, color: rgb(1, 1, 1) });
    if (whiteoutOnly || v === undefined || v === null || v === '') continue;
    if ((f.type === 'signature' || f.type === 'initials') && typeof v === 'string' && v.startsWith('data:image/png;base64,')) {
      const png = await doc.embedPng(Buffer.from(v.split(',')[1], 'base64'));
      const scale = Math.min(r.w / png.width, r.h / png.height);
      const w = png.width * scale, h = png.height * scale;
      page.drawImage(png, { x: r.x, y: r.y + (r.h - h) / 2, width: w, height: h });
    } else if (f.type === 'signature' || f.type === 'initials') {
      drawFittedText(page, script, v, r, { maxSize: 20 });
    } else if (f.type === 'checkbox') {
      if (v === true || v === 'true') {
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, borderColor: rgb(0.05, 0.1, 0.35), borderWidth: 0.8 });
        page.drawLine({ start: { x: r.x + r.w * 0.2, y: r.y + r.h * 0.5 }, end: { x: r.x + r.w * 0.42, y: r.y + r.h * 0.2 }, thickness: 1.4, color: rgb(0.05, 0.1, 0.35) });
        page.drawLine({ start: { x: r.x + r.w * 0.42, y: r.y + r.h * 0.2 }, end: { x: r.x + r.w * 0.85, y: r.y + r.h * 0.85 }, thickness: 1.4, color: rgb(0.05, 0.1, 0.35) });
      }
    } else {
      drawFittedText(page, helv, String(v), r);
    }
  }
  return doc;
}

async function prepareDocument(templatePdf, pagesMeta, fields, senderValues, meta) {
  const senderFields = fields.filter((f) => f.role === 'sender');
  const clientWhiteouts = fields.filter((f) => f.role === 'client' && f.whiteout);
  let doc = await stamp(templatePdf, pagesMeta, senderFields, senderValues);
  const buf = Buffer.from(await doc.save());
  doc = await stamp(buf, pagesMeta, clientWhiteouts, {}, { whiteoutOnly: true });
  doc.setTitle(`${meta.templateName} – ${meta.clientName}`);
  doc.setSubject(`File ${meta.ref}`);
  doc.setProducer('FileSign');
  const out = Buffer.from(await doc.save());
  return { pdf: out, sha256: sha256(out) };
}

async function finalizeDocument(preparedPdf, pagesMeta, fields, signerValues, cert) {
  const clientFields = fields.filter((f) => f.role === 'client').map((f) => ({ ...f, whiteout: false }));
  const doc = await stamp(preparedPdf, pagesMeta, clientFields, signerValues);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const label = `FileSign Envelope ID: ${cert.fileId}`;
    page.drawText(label, { x: 18, y: height - 12, size: 6.5, font: helv, color: rgb(0.45, 0.45, 0.5) });
    void width;
  }
  await addCertificate(doc, helv, bold, cert);
  doc.setTitle(`${cert.templateName} – ${cert.clientName} (signed)`);
  doc.setProducer('FileSign');
  doc.setModificationDate(new Date());
  const out = Buffer.from(await doc.save());
  return { pdf: out, sha256: sha256(out) };
}

async function addCertificate(doc, helv, bold, c) {
  const W = 612, H = 792, M = 54;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const ink = rgb(0.1, 0.1, 0.14), mute = rgb(0.4, 0.42, 0.48), accent = rgb(0.16, 0.32, 0.75);
  const line = () => { page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rgb(0.85, 0.86, 0.9) }); y -= 14; };
  const ensure = (need) => { if (y - need < M) { page = doc.addPage([W, H]); y = H - M; } };
  const kv = (k, v) => {
    const lines = wrap(helv, 9, safeText(helv, v ?? '—'), W - M * 2 - 150);
    ensure(lines.length * 12 + 4);
    page.drawText(safeText(bold, k), { x: M, y, size: 9, font: bold, color: mute });
    lines.forEach((ln, i) => page.drawText(ln, { x: M + 150, y: y - i * 12, size: 9, font: helv, color: ink }));
    y -= lines.length * 12 + 5;
  };
  const section = (t) => { ensure(40); y -= 8; page.drawText(t, { x: M, y, size: 11, font: bold, color: accent }); y -= 8; line(); };

  page.drawText('Certificate of Completion', { x: M, y: y - 18, size: 20, font: bold, color: ink });
  y -= 30;
  page.drawText('Electronic signature record generated by FileSign', { x: M, y: y - 6, size: 9, font: helv, color: mute });
  y -= 26; line();

  section('Envelope');
  kv('Envelope ID', c.fileId);
  kv('Document', c.templateName);
  kv('File reference', c.ref);
  kv('Organization', c.orgName);
  kv('Status', 'Completed');
  kv('Sent by', `${c.senderName} <${c.senderEmail}>`);
  kv('Document pages', String(c.pageCount));
  kv('Document SHA-256', c.preparedSha);
  kv('', 'Fingerprint of the exact document presented to the signer, before signing.');

  section('Signer');
  kv('Name', c.clientName);
  kv('Email', c.clientEmail);
  kv('Signed at', c.signedAt);
  kv('IP address', c.ip);
  kv('Device', c.userAgent);
  kv('Signature method', c.signatureMethod);
  kv('Consent', `Agreed to use electronic records and signatures at ${c.consentAt}`);
  if (c.signatureImage) {
    ensure(70);
    page.drawText('Adopted signature', { x: M, y, size: 9, font: bold, color: mute });
    const png = await doc.embedPng(Buffer.from(c.signatureImage.split(',')[1], 'base64'));
    const s = Math.min(200 / png.width, 50 / png.height);
    page.drawRectangle({ x: M + 148, y: y - 52, width: png.width * s + 8, height: png.height * s + 8, borderColor: rgb(0.85, 0.86, 0.9), borderWidth: 0.5 });
    page.drawImage(png, { x: M + 152, y: y - 48, width: png.width * s, height: png.height * s });
    y -= 66;
  }

  section('Event history (UTC)');
  for (const e of c.events) {
    const text = `${e.label}${e.actor ? ` — ${e.actor}` : ''}${e.ip ? ` — IP ${e.ip}` : ''}`;
    kv(e.at.replace('T', ' ').replace(/\.\d+Z$/, ' UTC'), text);
  }

  section('Legal notice');
  const notice = 'This document was signed electronically. The signer consented to conduct business electronically and adopted the signature shown above as their legal signature, in accordance with the U.S. ESIGN Act (15 U.S.C. 7001 et seq.) and the Uniform Electronic Transactions Act. The SHA-256 fingerprint of this completed PDF is stored by FileSign and can be checked at the verification page to confirm the document has not been altered after signing.';
  for (const ln of wrap(helv, 8.5, notice, W - 2 * M)) { ensure(12); page.drawText(ln, { x: M, y, size: 8.5, font: helv, color: mute }); y -= 12; }
}

module.exports = { sha256, normalizeToPdf, analyzePdf, appendSignaturePage, prepareDocument, finalizeDocument, fmtDate, sniffType };
