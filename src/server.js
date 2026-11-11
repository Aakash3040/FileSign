const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, FILES_DIR, now, id, token, hashPassword, verifyPassword, logEvent } = require('./db');
const engine = require('./pdf');
const mail = require('./mail');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json({ limit: '6mb' }));

// ------------------------------------------------------------------ helpers
const baseUrl = (req) => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const signUrl = (req, f) => `${baseUrl(req)}/sign/${f.token}`;
const fileUrl = (req, f) => `${baseUrl(req)}/app#/files/${f.id}`;
const ipOf = (req) => (req.ip || '').replace(/^::ffff:/, '');
const uaOf = (req) => (req.get('user-agent') || '').slice(0, 300);
const writeBlob = (buf, ext = 'pdf') => { const name = `${id('doc')}.${ext}`; fs.writeFileSync(path.join(FILES_DIR, name), buf); return name; };
const readBlob = (name) => fs.readFileSync(path.join(FILES_DIR, name));
const J = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const getOrg = (orgId) => db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function auth(req, res, next) {
  const h = req.get('authorization') || '';
  if (h.startsWith('Bearer ')) {
    const org = db.prepare('SELECT * FROM orgs WHERE api_key = ?').get(h.slice(7).trim());
    if (!org) return res.status(401).json({ error: 'Invalid API key' });
    req.org = org; req.user = null; req.viaApi = true;
    return next();
  }
  const t = parseCookies(req).fs_session;
  if (t) {
    const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?').get(t, now());
    if (row) { req.user = row; req.org = getOrg(row.org_id); return next(); }
  }
  res.status(401).json({ error: 'Not signed in' });
}
const adminOnly = (req, res, next) => (req.viaApi || req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only' }));

function startSession(res, userId) {
  const t = token();
  const exp = new Date(Date.now() + 14 * 864e5);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(t, userId, exp.toISOString());
  res.cookie('fs_session', t, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', expires: exp, path: '/' });
}

// naive in-memory throttle for auth endpoints
const hits = new Map();
function throttle(req, res, next) {
  const k = ipOf(req), t = Date.now();
  const arr = (hits.get(k) || []).filter((x) => t - x < 10 * 60e3);
  arr.push(t); hits.set(k, arr);
  if (arr.length > 30) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  next();
}

function fireWebhook(org, event, file) {
  if (!org.webhook_url) return;
  const body = JSON.stringify({ event, created_at: now(), file: publicFile(file) });
  const sig = crypto.createHmac('sha256', org.webhook_secret).update(body).digest('hex');
  fetch(org.webhook_url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-filesign-signature': `sha256=${sig}`, 'x-filesign-event': event }, body, signal: AbortSignal.timeout(8000) })
    .then((r) => logEvent(file.id, 'webhook', { detail: `${event} → ${r.status}` }))
    .catch((e) => logEvent(file.id, 'webhook', { detail: `${event} failed: ${e.message}` }));
}

function publicFile(f, req) {
  const tpl = db.prepare('SELECT name FROM templates WHERE id = ?').get(f.template_id);
  return {
    id: f.id, ref: f.ref, status: f.status, client_name: f.client_name, client_email: f.client_email,
    template_id: f.template_id, template_name: tpl?.name, message: f.message,
    created_at: f.created_at, sent_at: f.sent_at, viewed_at: f.viewed_at, signed_at: f.signed_at,
    voided_at: f.voided_at, expires_at: f.expires_at, decline_reason: f.decline_reason,
    reminder_count: f.reminder_count, prepared_sha256: f.prepared_sha256, signed_sha256: f.signed_sha256,
    ...(req ? { signing_url: ['sent', 'viewed', 'completed'].includes(f.status) ? signUrl(req, f) : null } : {}),
  };
}

const EVENT_LABELS = {
  created: 'Envelope created', countersigned: 'Countersigned by sender', email_sent: 'Signing request emailed', link_created: 'Signing link generated',
  opened: 'Document opened by signer', consent: 'Signer consented to electronic signatures',
  signed: 'Document signed', completed: 'Signed PDF sealed and certificate generated', declined: 'Signer declined',
  voided: 'Envelope voided', reminder: 'Reminder sent', expired: 'Signing link expired', downloaded: 'Signed copy downloaded by signer',
};

// ------------------------------------------------------------------ auth
app.post('/api/auth/signup', throttle, wrap(async (req, res) => {
  const { orgName, name, email, password } = req.body || {};
  if (!orgName?.trim() || !name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 8)
    throw new HttpError(400, 'Company name, your name, a valid email and a password of at least 8 characters are required.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) throw new HttpError(409, 'An account with that email already exists. Sign in instead.');
  const orgId = id('org'), userId = id('usr');
  db.prepare('INSERT INTO orgs (id, name, api_key, webhook_secret, reply_to, created_at) VALUES (?,?,?,?,?,?)')
    .run(orgId, orgName.trim(), `fs_live_${token(24)}`, token(24), email.toLowerCase(), now());
  db.prepare('INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(userId, orgId, email.toLowerCase(), name.trim(), hashPassword(password), 'admin', now());
  startSession(res, userId);
  res.json({ ok: true });
}));

app.post('/api/auth/login', throttle, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!u || !verifyPassword(String(password || ''), u.password_hash)) throw new HttpError(401, 'Incorrect email or password.');
  startSession(res, u.id);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => {
  const t = parseCookies(req).fs_session;
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.clearCookie('fs_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const o = req.org;
  res.json({
    user: req.user && { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role },
    org: { id: o.id, name: o.name, reminder_days: o.reminder_days, link_expiry_days: o.link_expiry_days, webhook_url: o.webhook_url, reply_to: o.reply_to },
    email_enabled: mail.enabled(),
  });
});

// ------------------------------------------------------------------ org settings
app.get('/api/org', auth, adminOnly, (req, res) => {
  const o = req.org;
  res.json({ ...o, users: db.prepare('SELECT id, name, email, role, created_at FROM users WHERE org_id = ? ORDER BY created_at').all(o.id) });
});
app.put('/api/org', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const o = req.org;
  const webhook = b.webhook_url === undefined ? o.webhook_url : (String(b.webhook_url).trim() || null);
  if (webhook && !/^https?:\/\//.test(webhook)) throw new HttpError(400, 'Webhook URL must start with http:// or https://');
  db.prepare('UPDATE orgs SET name = ?, webhook_url = ?, reminder_days = ?, link_expiry_days = ?, reply_to = ? WHERE id = ?').run(
    String(b.name ?? o.name).trim() || o.name, webhook,
    Math.max(0, Math.min(30, parseInt(b.reminder_days ?? o.reminder_days, 10) || 0)),
    Math.max(1, Math.min(365, parseInt(b.link_expiry_days ?? o.link_expiry_days, 10) || 30)),
    b.reply_to === undefined ? o.reply_to : (String(b.reply_to).trim() || null), o.id);
  res.json({ ok: true });
});
app.post('/api/org/rotate-key', auth, adminOnly, (req, res) => {
  const key = `fs_live_${token(24)}`;
  db.prepare('UPDATE orgs SET api_key = ? WHERE id = ?').run(key, req.org.id);
  res.json({ api_key: key });
});
app.post('/api/org/users', auth, adminOnly, (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 8) throw new HttpError(400, 'Name, valid email and a temporary password (8+ characters) are required.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) throw new HttpError(409, 'That email is already in use.');
  db.prepare('INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id('usr'), req.org.id, email.toLowerCase(), name.trim(), hashPassword(password), role === 'admin' ? 'admin' : 'member', now());
  res.json({ ok: true });
});
app.delete('/api/org/users/:id', auth, adminOnly, (req, res) => {
  if (req.user && req.params.id === req.user.id) throw new HttpError(400, 'You cannot remove yourself.');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  const r = db.prepare('DELETE FROM users WHERE id = ? AND org_id = ?').run(req.params.id, req.org.id);
  res.json({ ok: r.changes > 0 });
});

// ------------------------------------------------------------------ templates
const tplOut = (t) => ({
  id: t.id, name: t.name, source_name: t.source_name, page_count: t.page_count, pages: J(t.pages_json, []),
  fields: J(t.fields_json, []), detection: J(t.detection_json, {}), is_default: !!t.is_default,
  sha256: t.sha256, created_at: t.created_at, updated_at: t.updated_at,
});
const getTpl = (req, tid) => {
  const t = db.prepare('SELECT * FROM templates WHERE id = ? AND org_id = ? AND archived = 0').get(tid, req.org.id);
  if (!t) throw new HttpError(404, 'Template not found');
  return t;
};

app.get('/api/templates', auth, (req, res) => {
  const rows = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM files f WHERE f.template_id = t.id) AS uses
    FROM templates t WHERE org_id = ? AND archived = 0 ORDER BY is_default DESC, updated_at DESC`).all(req.org.id);
  res.json(rows.map((t) => ({ ...tplOut(t), uses: t.uses })));
});

const prettyName = (n) => {
  let s = String(n).replace(/\.(pdf|docx|txt)$/i, '').replace(/[_]+|(?<=\w)-(?=\w)/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === s.toLowerCase()) s = s.replace(/\b\w/g, (c) => c.toUpperCase());
  return s.slice(0, 120) || 'Client agreement';
};

async function createTemplateFromBuffer(req, buf, filename, name) {
  if (!buf?.length) throw new HttpError(400, 'No file received.');
  let pdf;
  try { pdf = await engine.normalizeToPdf(buf, filename); } catch (e) {
    throw new HttpError(400, /encrypt/i.test(e.message) ? 'This PDF is password-protected. Remove the password and upload it again.' : e.message);
  }
  let analysis = await engine.analyzePdf(pdf, { orgName: req.org.name });
  let { pages, fields } = analysis;
  const notes = [...analysis.notes];
  if (!analysis.hasClientSig) {
    const appended = await engine.appendSignaturePage(pdf, pages);
    pdf = appended.pdf; pages = appended.pages; fields = [...fields, ...appended.fields];
    notes.push('No client signature line was found, so a signature page was added at the end. You can move or remove fields below.');
  }
  if (pages.some((p) => p.rotate)) notes.push('Some pages are rotated. Check field positions carefully before sending.');
  const tid = id('tpl');
  const isFirst = !db.prepare('SELECT 1 FROM templates WHERE org_id = ? AND archived = 0').get(req.org.id);
  db.prepare(`INSERT INTO templates (id, org_id, name, source_name, pdf_path, page_count, pages_json, fields_json, detection_json, sha256, is_default, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tid, req.org.id, prettyName(name || filename || 'Client agreement'),
    filename || null, writeBlob(pdf), pages.length, JSON.stringify(pages), JSON.stringify(fields),
    JSON.stringify({ notes, detected: fields.length, scanned: analysis.scanned }), engine.sha256(pdf), isFirst ? 1 : 0, req.user?.id || null, now(), now());
  return db.prepare('SELECT * FROM templates WHERE id = ?').get(tid);
}

app.post('/api/templates', auth, express.raw({ type: () => true, limit: '25mb' }), wrap(async (req, res) => {
  let buf = req.body, filename = req.query.filename || req.get('x-filename') || '', name = req.query.name;
  // API clients may send JSON { filename, name, content_base64 }
  if (req.is('application/json')) {
    const b = J(buf.toString('utf8'), {});
    buf = Buffer.from(b.content_base64 || '', 'base64'); filename = b.filename || filename; name = b.name || name;
  }
  const t = await createTemplateFromBuffer(req, buf, decodeURIComponent(filename), name);
  res.json(tplOut(t));
}));

app.get('/api/templates/:id', auth, (req, res) => res.json(tplOut(getTpl(req, req.params.id))));
app.get('/api/templates/:id/pdf', auth, (req, res) => {
  const t = getTpl(req, req.params.id);
  res.type('application/pdf').send(readBlob(t.pdf_path));
});

const FIELD_TYPES = ['signature', 'initials', 'date', 'name', 'email', 'text', 'checkbox'];
const SOURCES = ['client_name', 'client_email', 'file_ref', 'today', 'sender_name', 'sender_email', 'sender_signature', 'custom'];
function cleanFields(fields, pages) {
  if (!Array.isArray(fields)) throw new HttpError(400, 'fields must be an array');
  return fields.slice(0, 300).map((f, i) => {
    const page = Math.max(0, Math.min(pages.length - 1, parseInt(f.page, 10) || 0));
    const pg = pages[page];
    const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
    const role = f.role === 'sender' ? 'sender' : 'client';
    const w = Math.max(8, Math.min(pg.w, +f.w || 100)), h = Math.max(8, Math.min(pg.h, +f.h || 16));
    return {
      id: String(f.id || `f${i + 1}`).slice(0, 20), type, role,
      label: String(f.label || type).slice(0, 60), required: !!f.required,
      page, x: Math.max(0, Math.min(pg.w - w, +f.x || 0)), y: Math.max(0, Math.min(pg.h - h, +f.y || 0)), w, h,
      source: role === 'sender' ? (SOURCES.includes(f.source) ? f.source : 'custom') : null,
      whiteout: !!f.whiteout, detectedFrom: f.detectedFrom ? String(f.detectedFrom).slice(0, 80) : null,
    };
  });
}

app.put('/api/templates/:id', auth, (req, res) => {
  const t = getTpl(req, req.params.id);
  const b = req.body || {};
  const pages = J(t.pages_json, []);
  const fields = b.fields ? cleanFields(b.fields, pages) : J(t.fields_json, []);
  const ids = new Set(); fields.forEach((f) => { while (ids.has(f.id)) f.id += 'x'; ids.add(f.id); });
  if (b.is_default) db.prepare('UPDATE templates SET is_default = 0 WHERE org_id = ?').run(req.org.id);
  db.prepare('UPDATE templates SET name = ?, fields_json = ?, is_default = ?, updated_at = ? WHERE id = ?')
    .run(String(b.name ?? t.name).trim().slice(0, 120) || t.name, JSON.stringify(fields), b.is_default ? 1 : t.is_default, now(), t.id);
  res.json(tplOut(db.prepare('SELECT * FROM templates WHERE id = ?').get(t.id)));
});

app.delete('/api/templates/:id', auth, (req, res) => {
  const t = getTpl(req, req.params.id);
  db.prepare('UPDATE templates SET archived = 1, is_default = 0 WHERE id = ?').run(t.id);
  const next = db.prepare('SELECT id FROM templates WHERE org_id = ? AND archived = 0 ORDER BY updated_at DESC').get(req.org.id);
  if (t.is_default && next) db.prepare('UPDATE templates SET is_default = 1 WHERE id = ?').run(next.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ files (envelopes)
function nextRef(orgId) {
  const n = db.prepare('SELECT COUNT(*) AS c FROM files WHERE org_id = ?').get(orgId).c + 1;
  return `F-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

async function createFile(req, input) {
  const org = req.org;
  const client_name = String(input.client_name || '').trim();
  const client_email = String(input.client_email || '').trim().toLowerCase();
  if (!client_name) throw new HttpError(400, 'Client name is required.');
  if (!/^\S+@\S+\.\S+$/.test(client_email)) throw new HttpError(400, 'A valid client email is required.');
  const t = input.template_id ? getTpl(req, input.template_id)
    : db.prepare('SELECT * FROM templates WHERE org_id = ? AND archived = 0 ORDER BY is_default DESC, updated_at DESC').get(org.id);
  if (!t) throw new HttpError(400, 'Upload your client agreement first.');
  const fields = J(t.fields_json, []);
  if (!fields.some((f) => f.role === 'client')) throw new HttpError(400, 'This agreement has no fields for the client to complete. Add a signature field in the template editor.');
  const ref = String(input.ref || '').trim().slice(0, 60) || nextRef(org.id);
  const senderName = req.user?.name || org.name;
  const senderEmail = req.user?.email || org.reply_to || '';
  const custom = input.values || {};
  const values = {};
  const missing = [];
  for (const f of fields.filter((x) => x.role === 'sender')) {
    let v;
    switch (f.source) {
      case 'client_name': v = client_name; break;
      case 'client_email': v = client_email; break;
      case 'file_ref': v = ref; break;
      case 'today': v = engine.fmtDate(); break;
      case 'sender_name': v = senderName; break;
      case 'sender_email': v = senderEmail; break;
      case 'sender_signature': v = senderName; break;
      default: v = custom[f.id] ?? custom[f.label];
    }
    if (f.type === 'checkbox') v = v === true || v === 'true' || v === 'on';
    else if (v !== undefined && v !== null) v = String(v).slice(0, 300);
    if (f.required && (v === undefined || v === '' || v === false)) missing.push(f.label);
    values[f.id] = v;
  }
  if (missing.length) throw new HttpError(400, `Please fill in: ${missing.join(', ')}`, { missing });

  const pages = J(t.pages_json, []);
  const prepared = await engine.prepareDocument(readBlob(t.pdf_path), pages, fields, values, { templateName: t.name, clientName: client_name, ref });
  const fid = id('file');
  const expires = new Date(Date.now() + org.link_expiry_days * 864e5).toISOString();
  db.prepare(`INSERT INTO files (id, org_id, template_id, ref, client_name, client_email, message, status, token, fields_json, sender_values_json,
    prepared_path, prepared_sha256, created_by, created_at, sent_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    fid, org.id, t.id, ref, client_name, client_email, String(input.message || '').slice(0, 1000) || null, 'sent', token(),
    JSON.stringify(fields), JSON.stringify(values), writeBlob(prepared.pdf), prepared.sha256, req.user?.id || null, now(), now(), expires);
  const actor = req.user ? `${req.user.name} <${req.user.email}>` : `API (${org.name})`;
  logEvent(fid, 'created', { actor, ip: ipOf(req), ua: uaOf(req), detail: `Document SHA-256 ${prepared.sha256}` });
  if (fields.some((f) => f.role === 'sender' && f.source === 'sender_signature')) logEvent(fid, 'countersigned', { actor, detail: `Signed for ${org.name} by ${senderName} when sending` });
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(fid);
  let emailed = false;
  if (input.send_email !== false && mail.enabled()) {
    const m = mail.templates.request({ org: org.name, clientName: client_name, docName: t.name, message: f.message, url: signUrl(req, f), senderName });
    const r = await mail.send({ to: client_email, ...m, replyTo: senderEmail || org.reply_to });
    emailed = r.sent;
    logEvent(fid, r.sent ? 'email_sent' : 'link_created', { actor: 'system', detail: r.sent ? `To ${client_email}` : `Email failed: ${r.reason}` });
  } else {
    logEvent(fid, 'link_created', { actor: 'system', detail: mail.enabled() ? 'Email not requested' : 'Email not configured — link shared by sender' });
  }
  fireWebhook(org, 'file.sent', f);
  return { file: f, emailed };
}

app.get('/api/files', auth, (req, res) => {
  const { status, q } = req.query;
  let sql = 'SELECT * FROM files WHERE org_id = ?';
  const args = [req.org.id];
  if (status === 'pending') sql += " AND status IN ('sent','viewed')";
  else if (status) { sql += ' AND status = ?'; args.push(status); }
  if (q) { sql += ' AND (client_name LIKE ? OR client_email LIKE ? OR ref LIKE ?)'; const l = `%${q}%`; args.push(l, l, l); }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  res.json(db.prepare(sql).all(...args).map((f) => publicFile(f, req)));
});

app.get('/api/stats', auth, (req, res) => {
  const rows = db.prepare('SELECT status, COUNT(*) c FROM files WHERE org_id = ? GROUP BY status').all(req.org.id);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.c]));
  const avg = db.prepare("SELECT AVG((julianday(signed_at) - julianday(sent_at)) * 24) h FROM files WHERE org_id = ? AND status = 'completed'").get(req.org.id).h;
  res.json({ ...by, pending: (by.sent || 0) + (by.viewed || 0), total: rows.reduce((a, r) => a + r.c, 0), avg_hours_to_sign: avg });
});

app.post('/api/files', auth, wrap(async (req, res) => {
  const { file, emailed } = await createFile(req, req.body || {});
  res.json({ ...publicFile(file, req), emailed });
}));

// Bulk: create many files at once (CSV import / practice-management sync)
app.post('/api/files/bulk', auth, wrap(async (req, res) => {
  const rows = (req.body?.files || []).slice(0, 200);
  const results = [];
  for (const r of rows) {
    try { const { file, emailed } = await createFile(req, { ...r, template_id: r.template_id || req.body.template_id, send_email: req.body.send_email ?? r.send_email }); results.push({ ok: true, ...publicFile(file, req), emailed }); }
    catch (e) { results.push({ ok: false, client_name: r.client_name, client_email: r.client_email, error: e.message }); }
  }
  res.json({ results });
}));

const getFile = (req) => {
  const f = db.prepare('SELECT * FROM files WHERE id = ? AND org_id = ?').get(req.params.id, req.org.id);
  if (!f) throw new HttpError(404, 'File not found');
  return f;
};

app.get('/api/files/:id', auth, (req, res) => {
  const f = getFile(req);
  const events = db.prepare('SELECT * FROM events WHERE file_id = ? ORDER BY id').all(f.id)
    .map((e) => ({ ...e, label: EVENT_LABELS[e.type] || e.type }));
  const creator = f.created_by && db.prepare('SELECT name, email FROM users WHERE id = ?').get(f.created_by);
  res.json({ ...publicFile(f, req), events, created_by: creator || null, fields: J(f.fields_json, []), sender_values: J(f.sender_values_json, {}) });
});

app.get('/api/files/:id/document.pdf', auth, (req, res) => {
  const f = getFile(req);
  const signed = f.status === 'completed' && f.signed_path;
  res.type('application/pdf');
  if (req.query.download) res.set('Content-Disposition', `attachment; filename="${(f.ref + ' ' + f.client_name).replace(/[^\w .-]/g, '')}${signed ? ' (signed)' : ''}.pdf"`);
  res.send(readBlob(signed ? f.signed_path : f.prepared_path));
});

app.post('/api/files/:id/remind', auth, wrap(async (req, res) => {
  const f = getFile(req);
  if (!['sent', 'viewed'].includes(f.status)) throw new HttpError(400, 'Only files waiting for a signature can be reminded.');
  if (!mail.enabled()) throw new HttpError(400, 'Email is not configured on this server. Copy the signing link and send it to the client directly.');
  const r = await sendReminder(f, baseUrl(req));
  if (!r.sent) throw new HttpError(502, `Could not send email: ${r.reason}`);
  res.json({ ok: true });
}));

app.post('/api/files/:id/void', auth, (req, res) => {
  const f = getFile(req);
  if (!['sent', 'viewed'].includes(f.status)) throw new HttpError(400, 'Only files waiting for a signature can be voided.');
  db.prepare("UPDATE files SET status = 'voided', voided_at = ? WHERE id = ?").run(now(), f.id);
  logEvent(f.id, 'voided', { actor: req.user ? req.user.name : 'API', ip: ipOf(req), detail: String(req.body?.reason || '').slice(0, 300) || null });
  fireWebhook(req.org, 'file.voided', { ...f, status: 'voided' });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ signer
function getByToken(tok) {
  const f = db.prepare('SELECT * FROM files WHERE token = ?').get(tok);
  if (!f) throw new HttpError(404, 'This signing link is not valid.');
  if (['sent', 'viewed'].includes(f.status) && f.expires_at < now()) {
    db.prepare("UPDATE files SET status = 'expired' WHERE id = ?").run(f.id);
    logEvent(f.id, 'expired', { actor: 'system' });
    f.status = 'expired';
  }
  return f;
}

app.get('/api/sign/:token', (req, res) => {
  const f = getByToken(req.params.token);
  const org = getOrg(f.org_id);
  const t = db.prepare('SELECT name, pages_json FROM templates WHERE id = ?').get(f.template_id);
  if (['sent', 'viewed'].includes(f.status)) {
    if (f.status === 'sent') { db.prepare("UPDATE files SET status = 'viewed', viewed_at = ? WHERE id = ?").run(now(), f.id); fireWebhook(org, 'file.viewed', { ...f, status: 'viewed' }); }
    logEvent(f.id, 'opened', { actor: f.client_email, ip: ipOf(req), ua: uaOf(req) });
  }
  res.json({
    status: f.status === 'sent' ? 'viewed' : f.status, org_name: org.name, client_name: f.client_name, client_email: f.client_email,
    document_name: t.name, ref: f.ref, message: f.message, signed_at: f.signed_at, expires_at: f.expires_at,
    pages: J(t.pages_json, []), fields: J(f.fields_json, []).filter((x) => x.role === 'client'),
  });
});

app.get('/api/sign/:token/document.pdf', (req, res) => {
  const f = getByToken(req.params.token);
  if (['voided', 'expired'].includes(f.status)) throw new HttpError(410, 'This document is no longer available.');
  const signed = f.status === 'completed';
  if (signed && req.query.download) logEvent(f.id, 'downloaded', { actor: f.client_email, ip: ipOf(req) });
  res.type('application/pdf');
  if (req.query.download) res.set('Content-Disposition', `attachment; filename="${f.ref.replace(/[^\w .-]/g, '')}${signed ? '-signed' : ''}.pdf"`);
  res.send(readBlob(signed ? f.signed_path : f.prepared_path));
});

app.post('/api/sign/:token/consent', (req, res) => {
  const f = getByToken(req.params.token);
  if (!['sent', 'viewed'].includes(f.status)) throw new HttpError(409, 'This document can no longer be signed.');
  logEvent(f.id, 'consent', { actor: f.client_email, ip: ipOf(req), ua: uaOf(req), detail: 'Agreed to ESIGN consumer disclosure' });
  res.json({ ok: true });
});

app.post('/api/sign/:token/decline', (req, res) => {
  const f = getByToken(req.params.token);
  if (!['sent', 'viewed'].includes(f.status)) throw new HttpError(409, 'This document can no longer be declined.');
  const reason = String(req.body?.reason || '').slice(0, 500);
  db.prepare("UPDATE files SET status = 'declined', decline_reason = ? WHERE id = ?").run(reason || null, f.id);
  logEvent(f.id, 'declined', { actor: f.client_email, ip: ipOf(req), ua: uaOf(req), detail: reason || null });
  const org = getOrg(f.org_id);
  notifySender(f, org, 'declined', baseUrl(req), { reason });
  fireWebhook(org, 'file.declined', { ...f, status: 'declined', decline_reason: reason });
  res.json({ ok: true });
});

const signing = new Set(); // guards against double-submit
app.post('/api/sign/:token/submit', wrap(async (req, res) => {
  const f = getByToken(req.params.token);
  if (f.status === 'completed') throw new HttpError(409, 'This document has already been signed.');
  if (!['sent', 'viewed'].includes(f.status)) throw new HttpError(409, 'This document can no longer be signed.');
  if (signing.has(f.id)) throw new HttpError(409, 'Signing is already in progress.');
  const b = req.body || {};
  if (!b.consent) throw new HttpError(400, 'You must agree to sign electronically.');
  const fields = J(f.fields_json, []).filter((x) => x.role === 'client');
  const values = {};
  const signedDate = engine.fmtDate(new Date(), typeof b.timezone === 'string' && b.timezone.length < 60 ? safeTz(b.timezone) : 'UTC');
  let signatureImage = null;
  for (const fd of fields) {
    let v = (b.values || {})[fd.id];
    if (fd.type === 'signature' || fd.type === 'initials') {
      if (v && !(typeof v === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < 700000)) throw new HttpError(400, `Invalid ${fd.label}.`);
      if (fd.type === 'signature' && v && !signatureImage) signatureImage = v;
    } else if (fd.type === 'date') v = signedDate; // server-controlled signing date
    else if (fd.type === 'checkbox') v = v === true;
    else if (v != null) v = String(v).slice(0, 300).trim();
    if (fd.required && (v === undefined || v === null || v === '' || v === false)) throw new HttpError(400, `Please complete: ${fd.label}`);
    values[fd.id] = v;
  }
  signing.add(f.id);
  try {
    const org = getOrg(f.org_id);
    const t = db.prepare('SELECT name, pages_json, page_count FROM templates WHERE id = ?').get(f.template_id);
    const signedAt = now();
    logEvent(f.id, 'signed', { actor: f.client_email, ip: ipOf(req), ua: uaOf(req), detail: `Method: ${b.signature_method === 'draw' ? 'drawn' : 'typed'}` });
    const creator = f.created_by && db.prepare('SELECT name, email FROM users WHERE id = ?').get(f.created_by);
    const evs = db.prepare('SELECT * FROM events WHERE file_id = ? AND type NOT IN (\'webhook\') ORDER BY id').all(f.id);
    const consentEv = [...evs].reverse().find((e) => e.type === 'consent');
    const result = await engine.finalizeDocument(readBlob(f.prepared_path), J(t.pages_json, []), J(f.fields_json, []), values, {
      fileId: f.id, templateName: t.name, ref: f.ref, orgName: org.name,
      senderName: creator?.name || `${org.name} (API)`, senderEmail: creator?.email || org.reply_to || '',
      pageCount: t.page_count, preparedSha: f.prepared_sha256,
      clientName: f.client_name, clientEmail: f.client_email, signedAt: signedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC'),
      ip: ipOf(req), userAgent: uaOf(req), signatureMethod: b.signature_method === 'draw' ? 'Drawn on screen' : 'Typed name adopted as signature',
      consentAt: (consentEv?.created_at || signedAt).replace('T', ' ').replace(/\.\d+Z$/, ' UTC'), signatureImage,
      events: [...evs.map((e) => ({ at: e.created_at, label: EVENT_LABELS[e.type] || e.type, actor: e.actor === 'system' ? null : e.actor, ip: e.ip })),
        { at: signedAt, label: 'Signed PDF sealed and certificate generated', actor: null, ip: null }],
    });
    db.prepare("UPDATE files SET status = 'completed', signed_at = ?, signer_values_json = ?, signed_path = ?, signed_sha256 = ? WHERE id = ?")
      .run(signedAt, JSON.stringify(values), writeBlob(result.pdf), result.sha256, f.id);
    logEvent(f.id, 'completed', { actor: 'system', detail: `Signed PDF SHA-256 ${result.sha256}` });
    const done = db.prepare('SELECT * FROM files WHERE id = ?').get(f.id);
    // notify both parties with the signed copy
    if (mail.enabled()) {
      const att = [{ filename: `${f.ref}-signed.pdf`, content: result.pdf }];
      const m1 = mail.templates.completedSigner({ org: org.name, clientName: f.client_name, docName: t.name, url: signUrl(req, f) });
      mail.send({ to: f.client_email, ...m1, attachments: att, replyTo: org.reply_to });
      notifySender(done, org, 'completed', baseUrl(req), { attachments: att });
    }
    fireWebhook(org, 'file.completed', done);
    res.json({ ok: true, signed_sha256: result.sha256 });
  } finally { signing.delete(f.id); }
}));

function safeTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; } }

function notifySender(f, org, kind, base, extra = {}) {
  if (!mail.enabled()) return;
  const creator = f.created_by && db.prepare('SELECT email FROM users WHERE id = ?').get(f.created_by);
  const to = creator?.email || org.reply_to;
  if (!to) return;
  const t = db.prepare('SELECT name FROM templates WHERE id = ?').get(f.template_id);
  const args = { org: org.name, clientName: f.client_name, docName: t.name, ref: f.ref, url: `${base}/app#/files/${f.id}`, reason: extra.reason };
  const m = kind === 'completed' ? mail.templates.completedSender(args) : mail.templates.declined(args);
  mail.send({ to, ...m, attachments: extra.attachments });
}

async function sendReminder(f, base) {
  const org = getOrg(f.org_id);
  const t = db.prepare('SELECT name FROM templates WHERE id = ?').get(f.template_id);
  const m = mail.templates.reminder({ org: org.name, clientName: f.client_name, docName: t.name, url: `${base}/sign/${f.token}` });
  const r = await mail.send({ to: f.client_email, ...m, replyTo: org.reply_to });
  if (r.sent) {
    db.prepare('UPDATE files SET last_reminder_at = ?, reminder_count = reminder_count + 1 WHERE id = ?').run(now(), f.id);
    logEvent(f.id, 'reminder', { actor: 'system', detail: `To ${f.client_email}` });
  }
  return r;
}

// Automatic reminders + expiry sweep
async function sweep() {
  try {
    const expired = db.prepare("SELECT id FROM files WHERE status IN ('sent','viewed') AND expires_at < ?").all(now());
    for (const e of expired) { db.prepare("UPDATE files SET status = 'expired' WHERE id = ?").run(e.id); logEvent(e.id, 'expired', { actor: 'system' }); }
    if (!mail.enabled() || !process.env.APP_URL) return;
    const due = db.prepare(`SELECT f.* FROM files f JOIN orgs o ON o.id = f.org_id WHERE f.status IN ('sent','viewed') AND o.reminder_days > 0
      AND f.reminder_count < 3 AND julianday('now') - julianday(COALESCE(f.last_reminder_at, f.sent_at)) >= o.reminder_days`).all();
    for (const f of due) await sendReminder(f, process.env.APP_URL.replace(/\/$/, ''));
  } catch (e) { console.error('sweep failed', e); }
}
setInterval(sweep, 15 * 60e3).unref();

// ------------------------------------------------------------------ verification
app.post('/api/verify', express.raw({ type: () => true, limit: '30mb' }), (req, res) => {
  if (!req.body?.length) throw new HttpError(400, 'Upload a PDF to verify.');
  const h = engine.sha256(req.body);
  const f = db.prepare('SELECT f.*, o.name org_name FROM files f JOIN orgs o ON o.id = f.org_id WHERE signed_sha256 = ?').get(h);
  if (!f) return res.json({ valid: false, sha256: h });
  const t = db.prepare('SELECT name FROM templates WHERE id = ?').get(f.template_id);
  res.json({ valid: true, sha256: h, envelope_id: f.id, document: t.name, organization: f.org_name, signer: f.client_name, signed_at: f.signed_at });
});

// ------------------------------------------------------------------ pages
const pub = path.join(__dirname, '..', 'public');
const jsMime = (res, p) => { if (p.endsWith('.mjs')) res.set('Content-Type', 'text/javascript; charset=utf-8'); };
app.use('/vendor/pdfjs', express.static(path.join(require.resolve('pdfjs-dist/package.json'), '..', 'build'), { maxAge: '7d', setHeaders: jsMime }));
app.use(express.static(pub, { extensions: ['html'], setHeaders: jsMime }));
app.get('/signup', (req, res) => res.sendFile(path.join(pub, 'login.html')));
app.get('/sign/:token', (req, res) => res.sendFile(path.join(pub, 'sign.html')));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 413 ? 'That file is too large (max 25 MB).' : status >= 500 ? 'Something went wrong. Please try again.' : err.message, ...(err.extra || {}) });
});

if (require.main === module) app.listen(PORT, () => console.log(`FileSign listening on http://localhost:${PORT}`));
module.exports = app;
