// SQLite persistence using Node's built-in driver (no native build step).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'signflow.db'));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  webhook_url TEXT,
  webhook_secret TEXT NOT NULL,
  reminder_days INTEGER NOT NULL DEFAULT 3,
  link_expiry_days INTEGER NOT NULL DEFAULT 30,
  reply_to TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  source_name TEXT,
  pdf_path TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  pages_json TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  detection_json TEXT,
  sha256 TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  template_id TEXT NOT NULL REFERENCES templates(id),
  ref TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  fields_json TEXT NOT NULL,
  sender_values_json TEXT NOT NULL,
  signer_values_json TEXT,
  prepared_path TEXT NOT NULL,
  prepared_sha256 TEXT NOT NULL,
  signed_path TEXT,
  signed_sha256 TEXT,
  decline_reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  viewed_at TEXT,
  signed_at TEXT,
  voided_at TEXT,
  last_reminder_at TEXT,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_org ON files(org_id, created_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL REFERENCES files(id),
  type TEXT NOT NULL,
  actor TEXT,
  ip TEXT,
  user_agent TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_file ON events(file_id, id);
`);

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function logEvent(fileId, type, { actor = null, ip = null, ua = null, detail = null } = {}) {
  db.prepare(
    'INSERT INTO events (file_id, type, actor, ip, user_agent, detail, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(fileId, type, actor, ip, ua, detail, now());
}

module.exports = { db, DATA_DIR, FILES_DIR, now, id, token, hashPassword, verifyPassword, logEvent };
