import { api, esc, toast, modal, fmtDateTime, fmtDate, badge, LOGO, copy } from '/common.js';
import { renderPdf } from '/pdfview.js';
import { mountEditor } from '/editor.js';

const view = document.getElementById('view');
document.getElementById('logo').insertAdjacentHTML('afterbegin', LOGO);
let ME;

document.getElementById('logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login'; };

async function boot() {
  ME = await api('/api/me');
  document.getElementById('who').textContent = `${ME.user.name} · ${ME.org.name}`;
  window.addEventListener('hashchange', route);
  route();
}

let cleanup = null;
function route() {
  cleanup?.(); cleanup = null;
  const h = location.hash.replace(/^#/, '') || '/';
  const parts = h.split('?')[0].split('/').filter(Boolean);
  const nav = parts[0] === 'templates' ? 'templates' : parts[0] === 'settings' ? 'settings' : 'files';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === nav));
  window.scrollTo(0, 0);
  const go = (p) => p.catch((e) => { view.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; });
  if (!parts.length) return go(dashboard());
  if (parts[0] === 'files' && parts[1] === 'new') return go(newFile());
  if (parts[0] === 'files' && parts[1]) return go(fileDetail(parts[1]));
  if (parts[0] === 'templates' && parts[1]) return go(editTemplate(parts[1]));
  if (parts[0] === 'templates') return go(templates());
  if (parts[0] === 'settings') return go(settings());
  view.innerHTML = '<div class="empty"><h2>Not found</h2><a href="#/">Back to files</a></div>';
}

// ------------------------------------------------------------- dashboard
async function dashboard() {
  const [stats, tpls] = await Promise.all([api('/api/stats'), api('/api/templates')]);
  if (!tpls.length) return onboarding();
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const status = q.get('status') || '';
  view.innerHTML = `
    <div class="pagehead"><h1>Files</h1><div class="spacer"></div>
      <a class="btn primary" href="#/files/new">+ New file</a></div>
    <div class="stats">
      <div class="card stat"><div class="n">${stats.pending || 0}</div><div class="l">Waiting for signature</div></div>
      <div class="card stat"><div class="n">${stats.completed || 0}</div><div class="l">Signed</div></div>
      <div class="card stat"><div class="n">${(stats.declined || 0) + (stats.expired || 0)}</div><div class="l">Declined or expired</div></div>
      <div class="card stat"><div class="n">${stats.avg_hours_to_sign == null ? '—' : stats.avg_hours_to_sign < 1 ? Math.max(1, Math.round(stats.avg_hours_to_sign * 60)) + 'm' : stats.avg_hours_to_sign.toFixed(1) + 'h'}</div><div class="l">Average time to sign</div></div>
    </div>
    <div class="card">
      <div class="row wrap" style="padding:12px 16px;border-bottom:1px solid var(--line)">
        <div class="row" style="gap:4px" id="filters">
          ${[['', 'All'], ['pending', 'Waiting'], ['completed', 'Signed'], ['declined', 'Declined'], ['expired', 'Expired'], ['voided', 'Voided']]
            .map(([v, l]) => `<button class="btn sm ${status === v ? 'primary' : 'ghost'}" data-s="${v}">${l}</button>`).join('')}
        </div>
        <div class="spacer"></div>
        <input id="q" placeholder="Search client, email or file #" style="max-width:260px;height:32px">
      </div>
      <div id="list"></div>
    </div>`;
  view.querySelectorAll('#filters button').forEach((b) => b.onclick = () => { location.hash = b.dataset.s ? `#/?status=${b.dataset.s}` : '#/'; });
  const load = async () => {
    const qs = new URLSearchParams({ ...(status && { status }), ...(view.querySelector('#q').value && { q: view.querySelector('#q').value }) });
    const files = await api(`/api/files?${qs}`);
    const list = view.querySelector('#list');
    if (!files.length) {
      list.innerHTML = `<div class="empty"><h2>${status || qs.get('q') ? 'No matching files' : 'No files yet'}</h2>
        <p class="muted">Open a file for a new client and FileSign sends them your agreement to sign.</p>
        <a class="btn primary" href="#/files/new">+ New file</a></div>`;
      return;
    }
    list.innerHTML = `<div style="overflow-x:auto"><table class="list"><thead><tr><th>File</th><th>Client</th><th>Agreement</th><th>Status</th><th>Sent</th><th>Signed</th></tr></thead><tbody>
      ${files.map((f) => `<tr class="click" data-id="${esc(f.id)}"><td class="mono nowrap">${esc(f.ref)}</td>
        <td><b>${esc(f.client_name)}</b><div class="small muted">${esc(f.client_email)}</div></td>
        <td class="small">${esc(f.template_name)}</td><td>${badge(f.status)}</td>
        <td class="small nowrap">${fmtDate(f.sent_at)}</td><td class="small nowrap">${fmtDate(f.signed_at)}</td></tr>`).join('')}
      </tbody></table></div>`;
    list.querySelectorAll('tr[data-id]').forEach((tr) => tr.onclick = () => { location.hash = `#/files/${tr.dataset.id}`; });
  };
  let t; view.querySelector('#q').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  await load();
  const timer = setInterval(() => document.visibilityState === 'visible' && load().catch(() => {}), 15000);
  cleanup = () => clearInterval(timer);
}

function onboarding() {
  view.innerHTML = `
    <div class="card pad" style="max-width:720px;margin:20px auto">
      <h1>Welcome to FileSign, ${esc(ME.user.name.split(' ')[0])}</h1>
      <p class="muted">Let's get your client agreement set up. You only do this once — after that, every new file takes seconds.</p>
      <ol class="steps" style="margin:22px 0">
        <li><b>Upload the agreement every client signs</b> (PDF or Word). We'll find the signature, name and date lines automatically.</li>
        <li><b>Check the fields</b> and adjust anything we missed.</li>
        <li><b>Open your first file</b> — enter a client's name and email and they'll get it to sign.</li>
      </ol>
      ${uploader()}
    </div>`;
  bindUploader();
}

// ------------------------------------------------------------- templates
function uploader() {
  return `<div class="dropzone" id="drop">
      <input type="file" id="fileinput" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
      <div style="font-size:15px;font-weight:600">Drop your agreement here, or click to choose a file</div>
      <div class="muted small" style="margin-top:6px">PDF or Word (.docx), up to 25 MB</div>
    </div>
    <div id="upstatus" class="hidden notice" style="margin-top:12px"></div>`;
}
function bindUploader() {
  const drop = view.querySelector('#drop'), input = view.querySelector('#fileinput'), st = view.querySelector('#upstatus');
  const upload = async (file) => {
    if (!file) return;
    st.className = 'notice'; st.textContent = `Uploading ${file.name} and detecting fields…`;
    try {
      const t = await api(`/api/templates?filename=${encodeURIComponent(file.name)}`, { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
      location.hash = `#/templates/${t.id}?new=1`;
    } catch (e) { st.className = 'notice bad'; st.textContent = e.message; }
  };
  drop.onclick = () => input.click();
  input.onchange = () => upload(input.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files[0]); };
}

async function templates() {
  const tpls = await api('/api/templates');
  view.innerHTML = `
    <div class="pagehead"><h1>Agreements</h1><div class="spacer"></div></div>
    <p class="muted" style="margin-top:-8px">The documents clients sign when a file is opened. The <b>default</b> agreement is used automatically for new files and API requests.</p>
    ${tpls.length ? `<div class="card" style="margin-bottom:20px"><table class="list"><thead><tr><th>Agreement</th><th>Fields</th><th>Used on</th><th>Updated</th><th></th></tr></thead><tbody>
      ${tpls.map((t) => `<tr><td><a href="#/templates/${t.id}"><b>${esc(t.name)}</b></a> ${t.is_default ? '<span class="badge sent">Default</span>' : ''}
          <div class="small muted">${t.page_count} page${t.page_count > 1 ? 's' : ''}${t.source_name ? ' · ' + esc(t.source_name) : ''}</div></td>
        <td class="small">${t.fields.filter((f) => f.role === 'client').length} client · ${t.fields.filter((f) => f.role === 'sender').length} auto-filled</td>
        <td class="small">${t.uses} file${t.uses === 1 ? '' : 's'}</td><td class="small">${fmtDate(t.updated_at)}</td>
        <td class="nowrap" style="text-align:right"><a class="btn sm" href="#/templates/${t.id}">Edit fields</a> ${t.is_default ? '' : `<button class="btn sm ghost" data-default="${t.id}">Make default</button>`}
          <button class="btn sm ghost danger" data-del="${t.id}">Archive</button></td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="card pad"><h3>Upload ${tpls.length ? 'another' : 'your'} agreement</h3>${uploader()}</div>`;
  bindUploader();
  view.querySelectorAll('[data-default]').forEach((b) => b.onclick = async () => { await api(`/api/templates/${b.dataset.default}`, { method: 'PUT', body: { is_default: true } }); toast('Default agreement updated'); templates(); });
  view.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Archive this agreement? Existing files keep their documents; it just won\'t be offered for new files.')) return;
    await api(`/api/templates/${b.dataset.del}`, { method: 'DELETE' }); templates();
  });
}

async function editTemplate(tid) {
  const t = await api(`/api/templates/${tid}`);
  const isNew = /new=1/.test(location.hash);
  cleanup = await mountEditor(view, t, { isNew, onSaved: (saved, next) => { if (next) location.hash = `#/files/new?template=${saved.id}`; } });
}

// ------------------------------------------------------------- new file
async function newFile() {
  const tpls = await api('/api/templates');
  if (!tpls.length) { location.hash = '#/'; return; }
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  let tpl = tpls.find((t) => t.id === qs.get('template')) || tpls.find((t) => t.is_default) || tpls[0];
  view.innerHTML = `
    <div class="pagehead"><div><a href="#/" class="small">← Files</a><h1>New file</h1></div></div>
    <div class="card" style="max-width:760px">
      <div class="tabs"><button class="on" data-tab="one">Single client</button><button data-tab="bulk">Bulk import (CSV)</button></div>
      <form id="f1" class="stack" style="padding:22px">
        <label class="field"><span>Agreement</span><select name="template_id">${tpls.map((t) => `<option value="${t.id}" ${t.id === tpl.id ? 'selected' : ''}>${esc(t.name)}${t.is_default ? ' (default)' : ''}</option>`).join('')}</select></label>
        <div class="grid2">
          <label class="field"><span>Client full name</span><input name="client_name" required autocomplete="off" placeholder="Jordan Example"></label>
          <label class="field"><span>Client email</span><input name="client_email" type="email" required autocomplete="off" placeholder="jordan@example.com"></label>
        </div>
        <label class="field"><span>File / case number</span><input name="ref" autocomplete="off" placeholder="Leave blank to auto-number"><div class="hint">Your internal job or case reference.</div></label>
        <div id="custom"></div>
        <label class="field"><span>Message to client <span class="muted">(optional)</span></span><textarea name="message" placeholder="Thanks for choosing us — please review and sign so we can get started."></textarea></label>
        <label class="row" style="gap:8px"><input type="checkbox" name="send_email" ${ME.email_enabled ? 'checked' : 'disabled'}> <span>Email the signing link to the client</span></label>
        ${ME.email_enabled ? '' : '<div class="notice warn small">Email delivery is not configured on this server, so you\'ll get a signing link to share with the client yourself (copy it into your own email, text or portal).</div>'}
        <div id="err" class="notice bad hidden"></div>
        <div class="row"><button class="btn primary lg" id="go">Send for signature</button><span class="muted small" id="preview"></span></div>
      </form>
      <form id="f2" class="stack hidden" style="padding:22px">
        <p class="muted" style="margin:0">Paste one client per line: <code>name, email, file number</code> (file number optional). Each client gets their own file and signing link using the selected agreement.</p>
        <label class="field"><span>Agreement</span><select name="template_id">${tpls.map((t) => `<option value="${t.id}" ${t.id === tpl.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
        <textarea name="csv" style="min-height:160px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px" placeholder="Jordan Example, jordan@example.com, F-1001&#10;Sam Sample, sam@example.com, F-1002"></textarea>
        <label class="row" style="gap:8px"><input type="checkbox" name="send_email" ${ME.email_enabled ? 'checked' : 'disabled'}> <span>Email each client their signing link</span></label>
        <div><button class="btn primary">Create files</button></div>
        <div id="bulkout"></div>
      </form>
    </div>`;
  view.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
    view.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    view.querySelector('#f1').classList.toggle('hidden', b.dataset.tab !== 'one');
    view.querySelector('#f2').classList.toggle('hidden', b.dataset.tab !== 'bulk');
  });
  const f1 = view.querySelector('#f1');
  const renderCustom = () => {
    const custom = tpl.fields.filter((f) => f.role === 'sender' && f.source === 'custom');
    const auto = tpl.fields.filter((f) => f.role === 'sender' && f.source !== 'custom');
    view.querySelector('#custom').innerHTML = custom.length ? `<div class="stack"><div class="small muted" style="font-weight:600">Fields you complete for this agreement</div>
      ${custom.map((f) => f.type === 'checkbox'
        ? `<label class="row" style="gap:8px"><input type="checkbox" data-cf="${esc(f.id)}"> ${esc(f.label)}</label>`
        : `<label class="field"><span>${esc(f.label)}${f.required ? '' : ' <span class="muted">(optional)</span>'}</span><input data-cf="${esc(f.id)}" ${f.required ? 'required' : ''}></label>`).join('')}</div>` : '';
    const clientCount = tpl.fields.filter((f) => f.role === 'client').length;
    view.querySelector('#preview').textContent = `${clientCount} field${clientCount === 1 ? '' : 's'} for the client${auto.length ? ` · ${auto.length} filled automatically` : ''}`;
  };
  renderCustom();
  f1.template_id.onchange = () => { tpl = tpls.find((t) => t.id === f1.template_id.value); renderCustom(); };
  f1.onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f1));
    const values = {};
    f1.querySelectorAll('[data-cf]').forEach((i) => { values[i.dataset.cf] = i.type === 'checkbox' ? i.checked : i.value; });
    const btn = view.querySelector('#go'); btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const r = await api('/api/files', { method: 'POST', body: { ...fd, values, send_email: !!f1.send_email.checked } });
      location.hash = `#/files/${r.id}?created=1${r.emailed ? '&emailed=1' : ''}`;
    } catch (err) {
      const el = view.querySelector('#err'); el.textContent = err.message; el.classList.remove('hidden');
      btn.disabled = false; btn.textContent = 'Send for signature';
    }
  };
  const f2 = view.querySelector('#f2');
  f2.onsubmit = async (e) => {
    e.preventDefault();
    const rows = f2.csv.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .filter((l) => !/^name\s*,/i.test(l))
      .map((l) => { const [client_name, client_email, ref] = l.split(/[,\t;]/).map((s) => (s || '').trim().replace(/^"|"$/g, '')); return { client_name, client_email, ref }; });
    if (!rows.length) return toast('Paste at least one line', true);
    const out = view.querySelector('#bulkout'); out.innerHTML = '<div class="notice">Creating files…</div>';
    const r = await api('/api/files/bulk', { method: 'POST', body: { template_id: f2.template_id.value, send_email: !!f2.send_email.checked, files: rows } });
    const ok = r.results.filter((x) => x.ok).length;
    out.innerHTML = `<div class="notice ${ok === r.results.length ? 'ok' : 'warn'}">${ok} of ${r.results.length} files created.</div>
      <table class="list" style="margin-top:10px"><tbody>${r.results.map((x) => `<tr><td>${esc(x.client_name)}<div class="small muted">${esc(x.client_email)}</div></td>
      <td>${x.ok ? `<a href="#/files/${x.id}">${esc(x.ref)}</a>` : `<span style="color:var(--bad)">${esc(x.error)}</span>`}</td>
      <td>${x.ok ? `<button class="btn sm" data-copy="${esc(x.signing_url)}">Copy link</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
    out.querySelectorAll('[data-copy]').forEach((b) => b.onclick = () => copy(b.dataset.copy));
  };
}

// ------------------------------------------------------------- file detail
async function fileDetail(fid) {
  const f = await api(`/api/files/${fid}`);
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const pending = ['sent', 'viewed'].includes(f.status);
  view.innerHTML = `
    <div class="pagehead"><div><a href="#/" class="small">← Files</a>
      <h1>${esc(f.client_name)} ${badge(f.status)}</h1>
      <div class="muted">File <span class="mono">${esc(f.ref)}</span> · ${esc(f.template_name)}</div></div>
      <div class="spacer"></div>
      <div class="row wrap">
        ${f.status === 'completed' ? `<a class="btn primary" href="/api/files/${f.id}/document.pdf?download=1">Download signed PDF</a>` : ''}
        ${pending ? `<button class="btn" id="remind">Send reminder</button><button class="btn danger" id="void">Void</button>` : ''}
      </div>
    </div>
    ${qs.get('created') && pending ? `<div class="notice ok" style="margin-bottom:16px"><b>File opened.</b> ${qs.get('emailed') ? `We emailed the agreement to ${esc(f.client_email)}.` : 'Share the signing link below with your client.'}</div>` : ''}
    ${f.status === 'declined' ? `<div class="notice bad" style="margin-bottom:16px"><b>The client declined to sign.</b> Reason: ${esc(f.decline_reason || 'none given')}. Open a new file to send a corrected agreement.</div>` : ''}
    ${f.status === 'expired' ? `<div class="notice warn" style="margin-bottom:16px">The signing link expired before the client signed. Open a new file to resend.</div>` : ''}
    <div class="editor-wrap">
      <div class="stack">
        ${f.signing_url && pending ? `<div class="card pad"><h3>Signing link</h3><p class="muted small">Unique to ${esc(f.client_name)}. Anyone with this link can sign as the client, so only send it to them. Expires ${fmtDate(f.expires_at)}.</p>
          <div class="linkbox"><input readonly value="${esc(f.signing_url)}" id="link"><button class="btn" id="copy">Copy</button><a class="btn" href="${esc(f.signing_url)}" target="_blank" rel="noopener">Open</a></div></div>` : ''}
        <div class="card pad"><div class="row"><h3 style="margin:0">${f.status === 'completed' ? 'Signed document' : 'Document sent to client'}</h3><div class="spacer"></div>
          <a class="small" href="/api/files/${f.id}/document.pdf" target="_blank">Open PDF ↗</a></div>
          <div id="pdf" class="pdf-pages" style="margin-top:14px;background:#eceef3;padding:14px;border-radius:8px;max-height:720px;overflow:auto"></div></div>
      </div>
      <div class="stack">
        <div class="card pad"><h3>Details</h3>
          <table style="width:100%;font-size:13px"><tbody>
            <tr><td class="muted">Client</td><td>${esc(f.client_name)}<br><span class="muted">${esc(f.client_email)}</span></td></tr>
            <tr><td class="muted">Sent by</td><td>${esc(f.created_by?.name || 'API')}</td></tr>
            <tr><td class="muted">Sent</td><td>${fmtDateTime(f.sent_at)}</td></tr>
            <tr><td class="muted">Opened</td><td>${fmtDateTime(f.viewed_at)}</td></tr>
            <tr><td class="muted">Signed</td><td>${fmtDateTime(f.signed_at)}</td></tr>
            <tr><td class="muted">Reminders</td><td>${f.reminder_count}</td></tr>
          </tbody></table>
          ${f.signed_sha256 ? `<div class="small muted" style="margin-top:12px">Signed PDF SHA-256<div class="mono" style="word-break:break-all;color:var(--ink-2)">${esc(f.signed_sha256)}</div></div>` : ''}
        </div>
        <div class="card pad"><h3>Audit trail</h3><ul class="timeline">
          ${f.events.filter((e) => e.type !== 'webhook').map((e) => `<li><div style="font-weight:550">${esc(e.label)}</div>
            <div class="small muted">${fmtDateTime(e.created_at)}${e.ip ? ' · ' + esc(e.ip) : ''}</div>${e.detail ? `<div class="small muted" style="word-break:break-all">${esc(e.detail)}</div>` : ''}</li>`).join('')}
        </ul></div>
      </div>
    </div>`;
  view.querySelector('#copy')?.addEventListener('click', () => copy(f.signing_url));
  view.querySelector('#remind')?.addEventListener('click', async () => {
    try { await api(`/api/files/${f.id}/remind`, { method: 'POST' }); toast('Reminder sent'); fileDetail(fid); } catch (e) { toast(e.message, true); }
  });
  view.querySelector('#void')?.addEventListener('click', () => modal(`<h2>Void this file's agreement?</h2><p class="muted">The signing link stops working immediately. This can't be undone.</p>
    <label class="field"><span>Reason (optional)</span><input id="reason"></label>
    <div class="row" style="margin-top:18px;justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ok">Void agreement</button></div>`,
  { onMount: (m, close) => m.querySelector('#ok').onclick = async () => { await api(`/api/files/${f.id}/void`, { method: 'POST', body: { reason: m.querySelector('#reason').value } }); close(); toast('Voided'); fileDetail(fid); } }));
  renderPdf(view.querySelector('#pdf'), `/api/files/${f.id}/document.pdf`, { maxWidth: 680 }).catch(() => {});
  if (pending) {
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      const n = await api(`/api/files/${fid}`).catch(() => null);
      if (n && n.status !== f.status) fileDetail(fid);
    }, 8000);
    cleanup = () => clearInterval(timer);
  }
}

// ------------------------------------------------------------- settings
async function settings() {
  if (ME.user.role !== 'admin') { view.innerHTML = '<div class="notice">Only workspace admins can change settings.</div>'; return; }
  const o = await api('/api/org');
  const base = location.origin;
  view.innerHTML = `
    <div class="pagehead"><h1>Settings</h1></div>
    <div class="stack" style="max-width:820px">
      <form class="card pad stack" id="orgf"><h2>Workspace</h2>
        <div class="grid2">
          <label class="field"><span>Company name</span><input name="name" value="${esc(o.name)}"><div class="hint">Shown to clients on the signing page and emails.</div></label>
          <label class="field"><span>Reply-to email</span><input name="reply_to" type="email" value="${esc(o.reply_to || '')}"><div class="hint">Where client replies go.</div></label>
          <label class="field"><span>Automatic reminder every (days)</span><input name="reminder_days" type="number" min="0" max="30" value="${o.reminder_days}"><div class="hint">0 turns reminders off. Up to 3 reminders per file.${ME.email_enabled ? '' : ' Requires email to be configured.'}</div></label>
          <label class="field"><span>Signing links expire after (days)</span><input name="link_expiry_days" type="number" min="1" max="365" value="${o.link_expiry_days}"></label>
        </div>
        <div><button class="btn primary">Save</button></div></form>

      <div class="card pad stack"><h2>Team</h2>
        <table class="list"><tbody>${o.users.map((u) => `<tr><td><b>${esc(u.name)}</b><div class="small muted">${esc(u.email)}</div></td><td class="small">${u.role}</td>
          <td style="text-align:right">${u.id === ME.user.id ? '<span class="small muted">You</span>' : `<button class="btn sm ghost danger" data-rm="${u.id}">Remove</button>`}</td></tr>`).join('')}</tbody></table>
        <form id="userf" class="grid2" style="align-items:end">
          <label class="field"><span>Name</span><input name="name" required></label>
          <label class="field"><span>Email</span><input name="email" type="email" required></label>
          <label class="field"><span>Temporary password</span><input name="password" required minlength="8"></label>
          <label class="field"><span>Role</span><select name="role"><option value="member">Member — send and track files</option><option value="admin">Admin — also manage settings</option></select></label>
          <div><button class="btn">Add teammate</button></div>
        </form></div>

      <div class="card pad stack"><h2>Integrations (API &amp; webhooks)</h2>
        <p class="muted" style="margin:0">Open files automatically from your case or practice management system. When a new file is created there, call the API and the client gets the agreement without anyone touching FileSign.</p>
        <label class="field"><span>API key</span><div class="linkbox"><input readonly value="${esc(o.api_key)}" id="key"><button class="btn" id="copykey" type="button">Copy</button><button class="btn" id="rotate" type="button">Rotate</button></div></label>
        <form id="hookf" class="stack">
          <label class="field"><span>Webhook URL</span><input name="webhook_url" placeholder="https://your-system.example.com/filesign" value="${esc(o.webhook_url || '')}">
          <div class="hint">We POST <code>file.sent</code>, <code>file.viewed</code>, <code>file.completed</code>, <code>file.declined</code> and <code>file.voided</code> events, signed with HMAC-SHA256 in the <code>X-FileSign-Signature</code> header.</div></label>
          <label class="field"><span>Webhook signing secret</span><input readonly value="${esc(o.webhook_secret)}"></label>
          <div><button class="btn">Save webhook</button></div>
        </form>
        <div><div class="small muted" style="font-weight:600;margin-bottom:6px">Open a file from your system</div>
<pre class="mono" style="background:#0f1424;color:#dfe6ff;padding:14px;border-radius:8px;overflow:auto;margin:0">curl -X POST ${esc(base)}/api/files \\
  -H "Authorization: Bearer ${esc(o.api_key)}" \\
  -H "Content-Type: application/json" \\
  -d '{"client_name":"Jordan Example","client_email":"jordan@example.com","ref":"F-1001"}'</pre>
        <p class="small muted" style="margin-top:8px">Returns the file with its <code>signing_url</code>. Uses your default agreement unless you pass <code>template_id</code>. Values for custom fields go in <code>values</code> keyed by field label. See the <a href="/developers" target="_blank">API reference</a>.</p></div>
      </div>
    </div>`;
  view.querySelector('#orgf').onsubmit = async (e) => { e.preventDefault(); await api('/api/org', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('Saved'); ME = await api('/api/me'); document.getElementById('who').textContent = `${ME.user.name} · ${ME.org.name}`; };
  view.querySelector('#hookf').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/org', { method: 'PUT', body: { webhook_url: e.target.webhook_url.value } }); toast('Webhook saved'); } catch (err) { toast(err.message, true); } };
  view.querySelector('#userf').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/org/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Teammate added — share their temporary password with them'); settings(); } catch (err) { toast(err.message, true); } };
  view.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => { if (confirm('Remove this teammate?')) { await api(`/api/org/users/${b.dataset.rm}`, { method: 'DELETE' }); settings(); } });
  view.querySelector('#copykey').onclick = () => copy(o.api_key);
  view.querySelector('#rotate').onclick = async () => { if (confirm('Rotate the API key? Integrations using the old key stop working immediately.')) { await api('/api/org/rotate-key', { method: 'POST' }); settings(); } };
}

boot().catch((e) => { view.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; });
