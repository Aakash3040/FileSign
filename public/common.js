// Shared browser helpers.
export async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { ...(opts.headers || {}) }, credentials: 'same-origin' };
  if (opts.body instanceof Blob || opts.body instanceof ArrayBuffer) { init.body = opts.body; }
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
  const res = await fetch(path, init);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && !opts.allow401 && location.pathname.startsWith('/app')) { location.href = '/login'; throw new Error('Not signed in'); }
  if (!res.ok) { const e = new Error(data?.error || `Request failed (${res.status})`); e.data = data; e.status = res.status; throw e; }
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
export function toast(msg, bad = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), bad ? 6000 : 3200);
}

export function modal(html, { onMount } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => back.remove();
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', function k(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', k); } });
  document.body.appendChild(back);
  back.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  onMount?.(back.querySelector('.modal'), close);
  return close;
}

export const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
export const STATUS_LABEL = { sent: 'Awaiting signature', viewed: 'Opened', completed: 'Signed', declined: 'Declined', voided: 'Voided', expired: 'Expired' };
export const badge = (s) => `<span class="badge ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;

export const LOGO = `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#2851c7"/><path d="M9 21.5c2.2-.2 3.6-2.6 4.6-5.2.8-2.1 1.7-5.6 3.7-5.6 1.7 0 1.3 2.5.4 4.9-.8 2.2-.4 4.4 1.6 4.4 1.5 0 2.6-1.2 3.7-2.5" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round"/><path d="M9 24.5h14" stroke="#9db4f5" stroke-width="1.6" stroke-linecap="round"/></svg>`;

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  catch { prompt('Copy this link:', text); }
}
