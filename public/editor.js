// Drag-and-drop field editor for an agreement template.
import { api, esc, toast } from '/common.js';
import { renderPdf } from '/pdfview.js';

const TYPES = {
  signature: { label: 'Signature', w: 170, h: 32 },
  initials: { label: 'Initials', w: 60, h: 26 },
  name: { label: 'Full name', w: 170, h: 16 },
  date: { label: 'Date signed', w: 110, h: 16 },
  email: { label: 'Email', w: 180, h: 16 },
  text: { label: 'Text', w: 150, h: 16 },
  checkbox: { label: 'Checkbox', w: 14, h: 14 },
};
const SOURCES = {
  client_name: "Client's name", client_email: "Client's email", file_ref: 'File / case number', today: "Today's date",
  sender_name: 'Your name (sender)', sender_email: 'Your email (sender)', sender_signature: 'Your signature (typed, when sending)',
  custom: 'Ask me when opening a file',
};

export async function mountEditor(view, tpl, { isNew, onSaved }) {
  let fields = tpl.fields.map((f) => ({ ...f }));
  let sel = null, placing = null, dirty = false, pages = [];
  const nextId = () => { let n = fields.length + 1; while (fields.some((f) => f.id === `f${n}`)) n++; return `f${n}`; };
  const client = () => fields.filter((f) => f.role === 'client');

  const notes = tpl.detection?.notes || [];
  view.innerHTML = `
    <div class="pagehead"><div><a href="#/templates" class="small">← Agreements</a><h1>Set up fields</h1></div><div class="spacer"></div>
      <button class="btn" id="save">Save</button><button class="btn primary" id="savego">Save &amp; open a file →</button></div>
    ${isNew ? `<div class="notice ok" style="margin-bottom:12px"><b>We read your agreement and placed ${fields.length} field${fields.length === 1 ? '' : 's'}.</b>
      Blue fields are completed by the client when they sign. Purple fields are filled in automatically when you open a file. Check them, drag to adjust, then save.</div>` : ''}
    ${notes.map((n) => `<div class="notice warn" style="margin-bottom:12px">${esc(n)}</div>`).join('')}
    <div class="editor-wrap editor">
      <div class="editor-canvas" id="canvas"><div class="pdf-pages" id="pages"></div></div>
      <aside class="editor-side stack">
        <div class="card pad stack">
          <label class="field"><span>Agreement name</span><input id="name" value="${esc(tpl.name)}"></label>
          <label class="row" style="gap:8px"><input type="checkbox" id="isdef" ${tpl.is_default ? 'checked' : ''}> <span>Default agreement for new files</span></label>
        </div>
        <div class="card pad">
          <h3>Add a field</h3>
          <div class="palette">${Object.entries(TYPES).map(([k, v]) => `<button class="btn sm" data-add="${k}">+ ${v.label}</button>`).join('')}</div>
          <div class="hint" id="placehint">Pick a field, then click on the document to place it.</div>
          <div class="row" style="margin-top:10px;gap:14px"><span class="legend"><i></i>Client completes</span><span class="legend"><i class="s"></i>Auto-filled by you</span></div>
        </div>
        <div class="card pad" id="props"></div>
        <div class="card pad"><h3>All fields <span class="muted small" id="count"></span></h3><ul class="fieldlist" id="flist"></ul></div>
      </aside>
    </div>`;

  const $ = (s) => view.querySelector(s);
  const markDirty = () => { dirty = true; };
  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  $('#name').oninput = markDirty; $('#isdef').onchange = markDirty;

  pages = await renderPdf($('#pages'), `/api/templates/${tpl.id}/pdf`, { maxWidth: 820 });

  function draw() {
    pages.forEach((p) => { p.layer.innerHTML = ''; });
    for (const f of fields) {
      const p = pages[f.page];
      if (!p) continue;
      const el = document.createElement('div');
      el.className = `fbox ${f.role}${sel === f.id ? ' sel' : ''}${f.whiteout ? ' wo' : ''}`;
      Object.assign(el.style, { left: `${f.x * p.scale}px`, top: `${f.y * p.scale}px`, width: `${f.w * p.scale}px`, height: `${f.h * p.scale}px` });
      el.textContent = f.type === 'checkbox' ? '' : (f.role === 'sender' ? (SOURCES[f.source] && f.source !== 'custom' ? SOURCES[f.source].replace(/ \(.*\)/, '') : f.label) : f.label) + (f.required && f.role === 'client' ? ' *' : '');
      el.title = `${f.label} — ${f.role === 'client' ? 'client completes' : 'auto-filled'}`;
      el.dataset.id = f.id;
      const rs = document.createElement('div'); rs.className = 'rs'; el.appendChild(rs);
      el.addEventListener('pointerdown', (e) => startDrag(e, f, p, e.target === rs));
      p.layer.appendChild(el);
    }
    drawList(); drawProps();
  }

  function drawList() {
    const c = client();
    $('#count').textContent = `${c.length} client · ${fields.length - c.length} auto`;
    $('#flist').innerHTML = fields.map((f) => `<li data-id="${esc(f.id)}" class="${sel === f.id ? 'on' : ''}"><span class="dot ${f.role === 'sender' ? 's' : ''}"></span>
      <span style="flex:1">${esc(f.label)}</span><span class="muted small">p${f.page + 1}</span></li>`).join('') || '<li class="muted">No fields yet</li>';
    $('#flist').querySelectorAll('li[data-id]').forEach((li) => li.onclick = () => {
      sel = li.dataset.id; draw();
      view.querySelector(`.fbox[data-id="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  function drawProps() {
    const f = fields.find((x) => x.id === sel);
    const box = $('#props');
    if (!f) {
      const hasSig = client().some((x) => x.type === 'signature');
      box.innerHTML = `<h3>Field settings</h3><p class="muted small" style="margin:0">Select a field on the document to change it. Press <b>Delete</b> to remove the selected field.</p>
        ${hasSig ? '' : '<div class="notice bad small" style="margin-top:10px">Add at least one client <b>Signature</b> field before sending.</div>'}`;
      return;
    }
    box.innerHTML = `<h3>Field settings</h3><div class="stack">
      <label class="field"><span>Label</span><input id="p-label" value="${esc(f.label)}"></label>
      <label class="field"><span>Type</span><select id="p-type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === f.type ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      <label class="field"><span>Who completes it</span><select id="p-role">
        <option value="client" ${f.role === 'client' ? 'selected' : ''}>The client, when signing</option>
        <option value="sender" ${f.role === 'sender' ? 'selected' : ''}>Filled automatically when I open a file</option></select></label>
      ${f.role === 'sender' ? `<label class="field"><span>Fill with</span><select id="p-src">${Object.entries(SOURCES).map(([k, v]) => `<option value="${k}" ${k === f.source ? 'selected' : ''}>${v}</option>`).join('')}</select></label>` : ''}
      ${f.role === 'client' && f.type === 'date' ? '<div class="hint" style="margin-top:-6px">Filled with the date the client signs. They can\'t change it.</div>' : ''}
      <label class="row" style="gap:8px"><input type="checkbox" id="p-req" ${f.required ? 'checked' : ''}> <span>Required</span></label>
      <label class="row" style="gap:8px"><input type="checkbox" id="p-wo" ${f.whiteout ? 'checked' : ''}> <span>Cover the text underneath</span></label>
      <div class="hint" style="margin-top:-8px">Use for placeholders like [Client Name] so they're replaced, not overlapped.</div>
      ${f.detectedFrom ? `<div class="small muted">Detected from: <span class="mono">${esc(f.detectedFrom)}</span></div>` : ''}
      <div class="row"><button class="btn sm" id="p-dup">Duplicate</button><button class="btn sm danger" id="p-del">Delete field</button></div></div>`;
    const upd = (k, v) => { f[k] = v; markDirty(); draw(); };
    $('#p-label').oninput = (e) => { f.label = e.target.value; markDirty(); const el = view.querySelector(`.fbox[data-id="${CSS.escape(f.id)}"]`); if (el?.firstChild?.nodeType === 3) el.firstChild.textContent = f.label; drawList(); };
    $('#p-type').onchange = (e) => {
      const t = e.target.value; f.type = t;
      if (Object.values(TYPES).some((v) => v.label === f.label) || !f.label) f.label = TYPES[t].label;
      if (t === 'checkbox') { f.w = f.h = 14; }
      if (t === 'signature' && f.h < 24) f.h = 30;
      if (f.role === 'sender' && t === 'date') f.source = 'today';
      markDirty(); draw();
    };
    $('#p-role').onchange = (e) => {
      f.role = e.target.value;
      if (f.role === 'sender') f.source = { signature: 'sender_signature', initials: 'sender_signature', name: 'sender_name', date: 'today', email: 'sender_email' }[f.type] || 'custom';
      else f.source = null;
      markDirty(); draw();
    };
    $('#p-src') && ($('#p-src').onchange = (e) => upd('source', e.target.value));
    $('#p-req').onchange = (e) => upd('required', e.target.checked);
    $('#p-wo').onchange = (e) => upd('whiteout', e.target.checked);
    $('#p-del').onclick = () => removeSel();
    $('#p-dup').onclick = () => { const n = { ...f, id: nextId(), y: Math.min(f.y + f.h + 6, pages[f.page].h - f.h), detectedFrom: null }; fields.push(n); sel = n.id; markDirty(); draw(); };
  }

  function removeSel() { if (!sel) return; fields = fields.filter((x) => x.id !== sel); sel = null; markDirty(); draw(); }

  function startDrag(e, f, p, resize) {
    if (placing) return;
    e.preventDefault(); e.stopPropagation();
    if (sel !== f.id) { sel = f.id; draw(); }
    const el = view.querySelector(`.fbox[data-id="${CSS.escape(f.id)}"]`);
    const sx = e.clientX, sy = e.clientY, o = { x: f.x, y: f.y, w: f.w, h: f.h };
    let moved = false;
    const move = (ev) => {
      const dx = (ev.clientX - sx) / p.scale, dy = (ev.clientY - sy) / p.scale;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true;
      if (resize) { f.w = Math.max(10, Math.min(p.w - f.x, o.w + dx)); f.h = Math.max(8, Math.min(p.h - f.y, o.h + dy)); }
      else { f.x = Math.max(0, Math.min(p.w - f.w, o.x + dx)); f.y = Math.max(0, Math.min(p.h - f.h, o.y + dy)); }
      Object.assign(el.style, { left: `${f.x * p.scale}px`, top: `${f.y * p.scale}px`, width: `${f.w * p.scale}px`, height: `${f.h * p.scale}px` });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (moved) markDirty(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  view.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => {
    placing = b.dataset.add;
    $('#canvas').classList.add('placing');
    $('#placehint').innerHTML = `<b>Click on the document</b> to place the ${TYPES[placing].label.toLowerCase()} field. <a href="#" id="cancelplace">Cancel</a>`;
    $('#cancelplace').onclick = (e) => { e.preventDefault(); stopPlacing(); };
  });
  const stopPlacing = () => { placing = null; $('#canvas').classList.remove('placing'); $('#placehint').textContent = 'Pick a field, then click on the document to place it.'; };
  pages.forEach((p, i) => p.el.addEventListener('pointerdown', (e) => {
    if (!placing) { if (e.target === p.layer || e.target.tagName === 'CANVAS') { sel = null; draw(); } return; }
    const r = p.el.getBoundingClientRect();
    const d = TYPES[placing];
    const x = (e.clientX - r.left) / p.scale - d.w / 2, y = (e.clientY - r.top) / p.scale - d.h / 2;
    const f = { id: nextId(), type: placing, role: 'client', label: d.label, required: placing !== 'text' && placing !== 'checkbox', page: i,
      x: Math.max(0, Math.min(p.w - d.w, x)), y: Math.max(0, Math.min(p.h - d.h, y)), w: d.w, h: d.h, source: null, whiteout: false };
    fields.push(f); sel = f.id; markDirty(); stopPlacing(); draw();
  }));

  const onKey = (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); removeSel(); }
    if (e.key === 'Escape') { stopPlacing(); sel = null; draw(); }
    const f = fields.find((x) => x.id === sel);
    if (f && e.key.startsWith('Arrow')) {
      e.preventDefault(); const s = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') f.x -= s; if (e.key === 'ArrowRight') f.x += s; if (e.key === 'ArrowUp') f.y -= s; if (e.key === 'ArrowDown') f.y += s;
      markDirty(); draw();
    }
  };
  document.addEventListener('keydown', onKey);

  async function save(next) {
    if (!client().some((f) => f.type === 'signature')) {
      if (!confirm('This agreement has no client signature field. Save anyway?')) return;
    }
    try {
      const saved = await api(`/api/templates/${tpl.id}`, { method: 'PUT', body: { name: $('#name').value, is_default: $('#isdef').checked, fields } });
      dirty = false; toast('Agreement saved');
      fields = saved.fields.map((f) => ({ ...f }));
      draw();
      onSaved?.(saved, next);
    } catch (e) { toast(e.message, true); }
  }
  $('#save').onclick = () => save(false);
  $('#savego').onclick = () => save(true);

  draw();
  return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', beforeUnload); };
}
