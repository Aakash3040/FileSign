// Renders a PDF into page containers with an overlay layer for fields.
import * as pdfjsLib from '/vendor/pdfjs/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';

export async function renderPdf(container, url, { maxWidth = 860 } = {}) {
  container.innerHTML = '<div class="muted" style="padding:40px;text-align:center">Loading document…</div>';
  const doc = await pdfjsLib.getDocument({ url, isEvalSupported: false }).promise;
  container.innerHTML = '';
  const avail = Math.min(maxWidth, container.clientWidth - 8 || maxWidth);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = avail / base.width;
    const vp = page.getViewport({ scale });
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page';
    wrap.style.width = `${vp.width}px`; wrap.style.height = `${vp.height}px`;
    wrap.dataset.page = String(i - 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${vp.width}px`; canvas.style.height = `${vp.height}px`;
    const layer = document.createElement('div');
    layer.className = 'layer';
    wrap.append(canvas, layer);
    container.appendChild(wrap);
    pages.push({ el: wrap, layer, scale, w: base.width, h: base.height });
    // render progressively; don't block the next page
    page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale: scale * dpr }) }).promise.catch(() => {});
  }
  return pages;
}
