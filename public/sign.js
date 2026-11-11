import { api, esc, toast, modal } from '/common.js';
import { renderPdf } from '/pdfview.js';

const tokenId = location.pathname.split('/').pop();
const root = document.getElementById('root');
const base = `/api/sign/${encodeURIComponent(tokenId)}`;
let S; // signing session
const values = {};
let adopted = { signature: null, initials: null, method: 'type' };

function shell(inner) {
  root.innerHTML = `<div class="center">${inner}</div>`;
}

async function boot() {
  try { S = await api(base); } catch (e) {
    shell(`<div class="card pad"><h1>Link not valid</h1><p class="muted">${esc(e.message)} If you think this is a mistake, contact the company that sent it.</p></div>`);
    return;
  }
  document.title = `${S.document_name} — ${S.org_name}`;
  if (S.status === 'completed') return doneScreen(false);
  if (S.status === 'declined') return shell(`<div class="card pad"><h1>You declined this agreement</h1><p class="muted">${esc(S.org_name)} has been notified. Contact them if you'd like a new copy.</p></div>`);
  if (S.status === 'voided') return shell(`<div class="card pad"><h1>This agreement was withdrawn</h1><p class="muted">${esc(S.org_name)} cancelled this signing request. Contact them if you have questions.</p></div>`);
  if (S.status === 'expired') return shell(`<div class="card pad"><h1>This link has expired</h1><p class="muted">Ask ${esc(S.org_name)} to send you a new one.</p></div>`);
  consentScreen();
}

function consentScreen() {
  shell(`<div class="card pad stack">
    <div class="muted small">${esc(S.org_name)}</div>
    <h1>Hi ${esc(S.client_name.split(' ')[0])}, please review and sign</h1>
    <p style="margin:0">${esc(S.org_name)} has sent you <b>${esc(S.document_name)}</b>${S.ref ? ` (file ${esc(S.ref)})` : ''}. It takes about two minutes.</p>
    ${S.message ? `<div class="notice">${esc(S.message)}</div>` : ''}
    <details><summary class="small" style="cursor:pointer">Electronic Record and Signature Disclosure</summary>
      <div class="disclosure" style="margin-top:8px">
        <p>By selecting the box below you agree that ${esc(S.org_name)} may provide this agreement and related notices to you electronically, and that you will sign it electronically.</p>
        <p>Your electronic signature has the same legal effect as a handwritten signature under the U.S. ESIGN Act and the Uniform Electronic Transactions Act.</p>
        <p>You may ask ${esc(S.org_name)} for a paper copy, or withdraw your consent and sign on paper instead, by contacting them directly before signing. Withdrawing consent does not affect documents you have already signed.</p>
        <p>To sign you need a device with a current web browser. You can download and keep a PDF copy of the signed agreement.</p>
      </div></details>
    <label class="row" style="gap:10px;align-items:flex-start"><input type="checkbox" id="agree" style="margin-top:2px"> <span>I agree to use electronic records and signatures.</span></label>
    <div class="row wrap"><button class="btn primary lg" id="go" disabled>Review document</button><div class="spacer"></div><button class="btn ghost danger" id="decline">Decline to sign</button></div>
  </div>
  <p class="small muted" style="text-align:center;margin-top:14px">Secured by FileSign · Link sent to ${esc(S.client_email)}</p>`);
  const agree = document.getElementById('agree'), go = document.getElementById('go');
  agree.onchange = () => { go.disabled = !agree.checked; };
  go.onclick = async () => {
    go.disabled = true;
    try { await api(`${base}/consent`, { method: 'POST' }); signingScreen(); } catch (e) { toast(e.message, true); go.disabled = false; }
  };
  document.getElementById('decline').onclick = declineFlow;
}

function declineFlow() {
  modal(`<h2>Decline to sign?</h2><p class="muted">${esc(S.org_name)} will be told you declined. Letting them know why helps them fix the issue.</p>
    <label class="field"><span>Reason</span><textarea id="reason" placeholder="e.g. The fee in section 3 is not what we discussed."></textarea></label>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" data-close>Go back</button><button class="btn primary" id="ok" style="background:var(--bad);border-color:var(--bad)">Decline</button></div>`,
  { onMount: (m, close) => m.querySelector('#ok').onclick = async () => {
    await api(`${base}/decline`, { method: 'POST', body: { reason: m.querySelector('#reason').value } }); close();
    shell(`<div class="card pad"><h1>You declined</h1><p class="muted">We've let ${esc(S.org_name)} know. You can close this page.</p></div>`);
  } });
}

const todayStr = () => new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const isDone = (f) => {
  const v = values[f.id];
  if (f.type === 'date') return true;
  if (f.type === 'checkbox') return v === true;
  return v !== undefined && v !== null && String(v).trim() !== '';
};
const required = () => S.fields.filter((f) => f.required);

async function signingScreen() {
  root.innerHTML = `
    <div class="signbar">
      <div class="doc"><b>${esc(S.document_name)}</b><span class="small muted">${esc(S.org_name)} · <span id="progtxt" style="display:inline"></span></span></div>
      <div class="progress"><i id="prog"></i></div>
      <button class="btn ghost sm" id="decline">Decline</button>
      <button class="btn primary" id="next">Start</button>
    </div>
    <div class="doc-area"><div class="pdf-pages" id="pages"></div></div>`;
  document.getElementById('decline').onclick = declineFlow;
  for (const f of S.fields) {
    if (f.type === 'name') values[f.id] = S.client_name;
    if (f.type === 'email') values[f.id] = S.client_email;
    if (f.type === 'date') values[f.id] = todayStr();
  }
  const pages = await renderPdf(document.getElementById('pages'), `${base}/document.pdf`, { maxWidth: 900 });
  for (const f of S.fields) {
    const p = pages[f.page];
    if (!p) continue;
    const el = document.createElement('div');
    el.className = 'sf';
    el.dataset.id = f.id;
    Object.assign(el.style, { left: `${f.x * p.scale}px`, top: `${f.y * p.scale}px`, width: `${f.w * p.scale}px`, height: `${f.h * p.scale}px` });
    const fs = Math.max(7, Math.min(16, f.h * p.scale * 0.68));
    if (f.type === 'signature' || f.type === 'initials') {
      el.innerHTML = `<button class="sigbtn" type="button" aria-label="${esc(f.label)}">✎ ${f.type === 'signature' ? 'Sign' : 'Initial'}</button>`;
      el.querySelector('button').style.fontSize = `${Math.max(10, Math.min(13, fs))}px`;
      el.onclick = () => applySignature(f, el);
    } else if (f.type === 'date') {
      el.innerHTML = `<span class="datev" style="font-size:${fs}px">${esc(values[f.id])}</span>`;
      el.title = 'Filled in automatically with today\'s date';
    } else if (f.type === 'checkbox') {
      el.innerHTML = '<input type="checkbox">';
      el.querySelector('input').onchange = (e) => { values[f.id] = e.target.checked; refresh(); };
    } else {
      el.innerHTML = `<input type="text" style="font-size:${fs}px" placeholder="${esc(f.label)}" value="${esc(values[f.id] || '')}" maxlength="300">`;
      el.querySelector('input').oninput = (e) => { values[f.id] = e.target.value; refresh(); };
    }
    if (f.required && f.type !== 'date') el.insertAdjacentHTML('afterbegin', `<span class="flag" style="top:${Math.max(0, f.h * p.scale / 2 - 10)}px">${f.type === 'signature' ? 'Sign' : f.type === 'initials' ? 'Initial' : 'Fill in'}</span>`);
    p.layer.appendChild(el);
  }
  document.getElementById('next').onclick = next;
  refresh();
}

function refresh() {
  const req = required();
  const done = req.filter(isDone).length;
  document.getElementById('prog').style.width = `${req.length ? (done / req.length) * 100 : 100}%`;
  document.getElementById('progtxt').textContent = `${done} of ${req.length} required`;
  for (const f of S.fields) {
    const el = document.querySelector(`.sf[data-id="${CSS.escape(f.id)}"]`);
    if (!el) continue;
    const d = isDone(f);
    el.classList.toggle('done', d); el.classList.toggle('todo', !d); el.classList.toggle('opt', !f.required);
    const flag = el.querySelector('.flag'); if (flag) flag.style.display = d ? 'none' : '';
  }
  const btn = document.getElementById('next');
  const allDone = done === req.length;
  btn.textContent = allDone ? 'Finish' : done === 0 && !btn.dataset.started ? 'Start' : 'Next';
  btn.style.background = allDone ? 'var(--ok)' : ''; btn.style.borderColor = allDone ? 'var(--ok)' : '';
}

function next() {
  const btn = document.getElementById('next'); btn.dataset.started = '1';
  const pending = required().filter((f) => !isDone(f)).sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  if (!pending.length) return finish();
  const f = pending[0];
  const el = document.querySelector(`.sf[data-id="${CSS.escape(f.id)}"]`);
  document.querySelectorAll('.sf.focus').forEach((x) => x.classList.remove('focus'));
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('focus');
  setTimeout(() => el.classList.remove('focus'), 2500);
  const input = el.querySelector('input[type=text]'); if (input) setTimeout(() => input.focus({ preventScroll: true }), 350);
  if (f.type === 'signature' || f.type === 'initials') setTimeout(() => applySignature(f, el), 450);
  refresh();
}

function setSigValue(f, el, png) {
  values[f.id] = png;
  el.querySelector('.sigbtn')?.remove();
  el.querySelector('img')?.remove();
  const img = new Image(); img.src = png; img.alt = f.label; el.appendChild(img);
  img.onclick = (e) => { e.stopPropagation(); adoptModal(f.type, () => setSigValue(f, el, adopted[f.type])); };
  refresh();
}

function applySignature(f, el) {
  if (values[f.id]) return;
  if (adopted[f.type]) return setSigValue(f, el, adopted[f.type]);
  adoptModal(f.type, () => setSigValue(f, el, adopted[f.type]));
}

const initialsOf = (n) => n.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 4);

async function renderTyped(text) {
  try { await document.fonts.load('600 64px "Dancing Script"'); } catch { /* fallback font */ }
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '600 64px "Dancing Script", "Caveat", "Brush Script MT", cursive';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 30;
  c.width = Math.max(w, 60); c.height = 100;
  ctx.font = font; ctx.fillStyle = '#0d1a59'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 15, 52);
  return c.toDataURL('image/png');
}

function adoptModal(kind, done) {
  const isSig = kind === 'signature';
  const defText = isSig ? S.client_name : initialsOf(S.client_name);
  modal(`<h2>${isSig ? 'Adopt your signature' : 'Adopt your initials'}</h2>
    <div class="tabs" style="padding:0;margin-bottom:14px"><button class="on" data-m="type">Type</button><button data-m="draw">Draw</button></div>
    <div id="m-type" class="stack">
      <label class="field"><span>${isSig ? 'Full name' : 'Initials'}</span><input id="t" value="${esc(defText)}" maxlength="${isSig ? 60 : 4}"></label>
      <div class="typed" id="preview">${esc(defText)}</div>
    </div>
    <div id="m-draw" class="stack hidden">
      <canvas class="sigpad" id="pad"></canvas>
      <div class="row"><span class="small muted">Draw with your mouse, finger or stylus.</span><div class="spacer"></div><button class="btn sm ghost" id="clear" type="button">Clear</button></div>
    </div>
    <p class="small muted" style="margin:14px 0 0">By selecting Adopt and Sign, I agree that this ${isSig ? 'signature' : 'set of initials'} will be the electronic representation of my ${isSig ? 'signature' : 'initials'} for all purposes when I use it on this document, just as if I signed by hand.</p>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" data-close>Cancel</button><button class="btn primary" id="adopt">Adopt and sign</button></div>`,
  { onMount: (m, close) => {
    let mode = 'type', drawn = false;
    const t = m.querySelector('#t'), prev = m.querySelector('#preview');
    t.oninput = () => { prev.textContent = t.value; };
    m.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => {
      mode = b.dataset.m;
      m.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b));
      m.querySelector('#m-type').classList.toggle('hidden', mode !== 'type');
      m.querySelector('#m-draw').classList.toggle('hidden', mode !== 'draw');
      if (mode === 'draw') setupPad();
    });
    const pad = m.querySelector('#pad');
    let ctx, padReady = false;
    function setupPad() {
      if (padReady) return; padReady = true;
      const r = pad.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      pad.width = r.width * dpr; pad.height = r.height * dpr;
      ctx = pad.getContext('2d'); ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0d1a59';
      let drawing = false, last;
      const pt = (e) => { const b = pad.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
      pad.onpointerdown = (e) => { drawing = true; last = pt(e); pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = '#0d1a59'; ctx.fill(); drawn = true; };
      pad.onpointermove = (e) => { if (!drawing) return; const p = pt(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drawn = true; };
      pad.onpointerup = pad.onpointercancel = () => { drawing = false; };
      m.querySelector('#clear').onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; };
    }
    function trimmed() {
      const w = pad.width, h = pad.height, data = pad.getContext('2d').getImageData(0, 0, w, h).data;
      let x0 = w, y0 = h, x1 = 0, y1 = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const c = document.createElement('canvas'); const padPx = 8;
      c.width = x1 - x0 + padPx * 2; c.height = y1 - y0 + padPx * 2;
      c.getContext('2d').drawImage(pad, x0 - padPx, y0 - padPx, c.width, c.height, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    }
    m.querySelector('#adopt').onclick = async () => {
      if (mode === 'type') {
        if (!t.value.trim()) return toast(isSig ? 'Type your name' : 'Type your initials', true);
        adopted[kind] = await renderTyped(t.value.trim());
      } else {
        if (!drawn) return toast('Draw your signature first', true);
        adopted[kind] = trimmed();
      }
      if (isSig) adopted.method = mode;
      close(); done();
    };
    setTimeout(() => t.focus(), 50);
  } });
}

function finish() {
  const missing = required().filter((f) => !isDone(f));
  if (missing.length) return next();
  modal(`<h2>Sign ${esc(S.document_name)}?</h2>
    <p class="muted">By clicking <b>Sign agreement</b>, you confirm you have reviewed the document and agree to be legally bound by it with your electronic signature.</p>
    <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" data-close>Review again</button><button class="btn primary" id="ok">Sign agreement</button></div>`,
  { onMount: (m, close) => m.querySelector('#ok').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Signing…';
    try {
      await api(`${base}/submit`, { method: 'POST', body: { values, consent: true, signature_method: adopted.method, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      close(); doneScreen(true);
    } catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = 'Sign agreement'; }
  } });
}

function doneScreen(justSigned) {
  window.scrollTo(0, 0);
  shell(`<div class="card pad stack" style="text-align:center">
    <div style="width:56px;height:56px;border-radius:50%;background:var(--ok-soft);color:var(--ok);display:flex;align-items:center;justify-content:center;margin:0 auto;font-size:28px">✓</div>
    <h1>${justSigned ? 'Signed. Thank you!' : 'This agreement is signed'}</h1>
    <p class="muted" style="margin:0">${esc(S.document_name)} with ${esc(S.org_name)} is complete. ${justSigned ? 'A copy will be emailed to you if email is enabled — you can also download it now.' : ''}</p>
    <div><a class="btn primary lg" href="${base}/document.pdf?download=1">Download signed PDF</a></div>
    <p class="small muted" style="margin:0">The PDF includes a certificate of completion with the full audit trail. You can close this page.</p>
  </div>`);
}

boot();
