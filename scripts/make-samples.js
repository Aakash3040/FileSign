// Generates fictional test agreements in different layouts (test data only).
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'samples');
fs.mkdirSync(out, { recursive: true });

const LOREM = 'The Client engages the Company to provide the services described in this Agreement. Fees are payable within thirty (30) days of invoice. Either party may terminate this Agreement on fourteen (14) days written notice. The Company will keep Client information confidential except where disclosure is required by law.';

async function make(name, build) {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const b = await doc.embedFont(StandardFonts.HelveticaBold);
  await build(doc, f, b);
  fs.writeFileSync(path.join(out, name), await doc.save());
  console.log('wrote', name);
}

function para(page, f, text, x, y, size = 10.5, maxW = 470) {
  const words = text.split(' ');
  let line = '';
  for (const w of words) {
    if (f.widthOfTextAtSize(line + w + ' ', size) > maxW) { page.drawText(line, { x, y, size, font: f }); y -= size * 1.5; line = ''; }
    line += w + ' ';
  }
  page.drawText(line, { x, y, size, font: f });
  return y - size * 2;
}

(async () => {
  // 1) Two-column signature block with placeholders on page 1.
  await make('two-party-agreement.pdf', async (doc, f, b) => {
    let p = doc.addPage([612, 792]);
    p.drawText('CLIENT SERVICES AGREEMENT', { x: 72, y: 720, size: 16, font: b });
    p.drawText('File number: [File Number]', { x: 72, y: 690, size: 10.5, font: f });
    p.drawText('This agreement is made between Northwind Advisory LLC and [Client Name].', { x: 72, y: 672, size: 10.5, font: f });
    let y = 640;
    for (let i = 1; i <= 6; i++) { p.drawText(`${i}. Terms`, { x: 72, y, size: 11, font: b }); y = para(p, f, LOREM, 72, y - 16); if (y < 120) break; }
    p.drawText('Client initials: ________', { x: 430, y: 60, size: 9, font: f });
    p = doc.addPage([612, 792]);
    y = para(p, f, LOREM, 72, 720);
    p.drawText('[ ] I agree to receive notices by email.', { x: 72, y: y - 10, size: 10.5, font: f });
    p.drawText('IN WITNESS WHEREOF the parties have signed this agreement.', { x: 72, y: y - 40, size: 10.5, font: f });
    const top = y - 90;
    p.drawText('CLIENT', { x: 72, y: top, size: 11, font: b });
    p.drawText('NORTHWIND ADVISORY LLC', { x: 330, y: top, size: 11, font: b });
    const rows = ['Signature', 'Name', 'Date'];
    rows.forEach((r, i) => {
      const yy = top - 40 - i * 40;
      p.drawText(`${r}: ______________________`, { x: 72, y: yy, size: 10.5, font: f });
      p.drawText(`${r}: ______________________`, { x: 330, y: yy, size: 10.5, font: f });
    });
  });

  // 2) No signature block at all (FileSign should append a signature page).
  await make('no-signature-block.pdf', async (doc, f, b) => {
    const p = doc.addPage([612, 792]);
    p.drawText('Engagement Terms', { x: 72, y: 720, size: 16, font: b });
    let y = 690;
    for (let i = 0; i < 4; i++) y = para(p, f, LOREM, 72, y);
  });

  // 3) Underlines with captions beneath ("signature line" style), A4 size.
  await make('caption-style.pdf', async (doc, f, b) => {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText('Retainer Agreement', { x: 60, y: 780, size: 16, font: b });
    let y = para(p, f, LOREM, 60, 750);
    y = para(p, f, LOREM, 60, y);
    p.drawText('_____________________________', { x: 60, y: y - 40, size: 10.5, font: f });
    p.drawText('Client Signature', { x: 60, y: y - 54, size: 9, font: f });
    p.drawText('______________', { x: 320, y: y - 40, size: 10.5, font: f });
    p.drawText('Date', { x: 320, y: y - 54, size: 9, font: f });
    p.drawText('Email: ', { x: 60, y: y - 90, size: 10.5, font: f });
  });
})();
