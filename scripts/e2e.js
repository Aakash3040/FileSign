// End-to-end smoke test against a running server: node scripts/e2e.js [baseUrl] [agreement.pdf]
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:3000';
const FILE = process.argv[3] || path.join(__dirname, '..', 'samples', 'two-party-agreement.pdf');
let cookie = '';
async function call(method, url, body, headers = {}) {
  const init = { method, headers: { cookie, ...headers } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) init.body = body;
    else { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  }
  const r = await fetch(BASE + url, init);
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(data)}`);
  return data;
}
// 1x1 transparent PNG stands in for a drawn signature
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
(async () => {
  const email = `test+${Date.now()}@example.com`;
  await call('POST', '/api/auth/signup', { orgName: 'Northwind Advisory LLC', name: 'Test Sender', email, password: 'password123' });
  const tpl = await call('POST', `/api/templates?filename=${encodeURIComponent(path.basename(FILE))}`, fs.readFileSync(FILE), { 'content-type': 'application/octet-stream' });
  console.log(`template ${tpl.id}: ${tpl.fields.length} fields`, tpl.detection.notes);
  const custom = Object.fromEntries(tpl.fields.filter((f) => f.role === 'sender' && f.source === 'custom').map((f) => [f.id, 'Test value']));
  const file = await call('POST', '/api/files', { client_name: 'Jordan Example', client_email: 'jordan@example.com', values: custom });
  console.log(`file ${file.id} ${file.ref} -> ${file.signing_url}`);
  const tok = '/api/sign/' + file.signing_url.split('/').pop();
  const s = await call('GET', tok);
  console.log(`signer sees ${s.fields.length} fields, status ${s.status}`);
  await call('GET', tok + '/document.pdf');
  await call('POST', tok + '/consent');
  const values = {};
  for (const f of s.fields) values[f.id] = ['signature', 'initials'].includes(f.type) ? PNG : f.type === 'checkbox' ? true : f.type === 'name' ? 'Jordan Example' : 'x';
  const done = await call('POST', tok + '/submit', { values, consent: true, signature_method: 'draw', timezone: 'America/Phoenix' });
  const pdf = await call('GET', tok + '/document.pdf?download=1');
  const out = path.join(__dirname, '..', 'samples', `signed-${path.basename(FILE).replace(/\.\w+$/, '')}.pdf`);
  fs.writeFileSync(out, pdf);
  const v = await call('POST', '/api/verify', pdf, { 'content-type': 'application/pdf' });
  const detail = await call('GET', `/api/files/${file.id}`);
  console.log(`signed sha ${done.signed_sha256.slice(0, 12)}... verify=${v.valid} status=${detail.status} events=${detail.events.map((e) => e.type).join(',')}`);
  console.log('wrote', out);
  // API key path
  const org = await call('GET', '/api/org');
  cookie = '';
  const viaApi = await call('POST', '/api/files', { client_name: 'Sam Sample', client_email: 'sam@example.com', ref: 'API-1', values: custom }, { authorization: `Bearer ${org.api_key}` });
  console.log('API-created file', viaApi.ref, viaApi.status);
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
