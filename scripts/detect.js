// Usage: node scripts/detect.js <file.pdf|.docx> [orgName]  — prints detected fields.
const fs = require('fs');
const { normalizeToPdf, analyzePdf } = require('../src/pdf');
(async () => {
  const file = process.argv[2];
  const pdf = await normalizeToPdf(fs.readFileSync(file), file);
  const r = await analyzePdf(pdf, { orgName: process.argv[3] });
  console.log(`${file}: ${r.pages.length} pages, clientSig=${r.hasClientSig}, notes=${JSON.stringify(r.notes)}`);
  for (const f of r.fields) console.log(`  p${f.page + 1} ${f.role.padEnd(6)} ${f.type.padEnd(9)} ${f.label.padEnd(16)} x=${f.x.toFixed(0)} y=${f.y.toFixed(0)} w=${f.w.toFixed(0)} h=${f.h.toFixed(0)} src=${f.source || ''}  <- ${f.detectedFrom}`);
})().catch((e) => { console.error(e); process.exit(1); });
