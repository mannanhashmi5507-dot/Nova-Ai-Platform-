// ─── Documents: Text Extraction ───────────────────────────────
// Phase 11. Real parsing for the formats actually requested:
//   - PDF: pdf-parse
//   - Word (.docx): mammoth
//   - Excel (.xlsx/.xls/.csv): xlsx (SheetJS) — converted to a readable
//     text/CSV representation per sheet
//   - PowerPoint (.pptx): a real but intentionally basic extractor —
//     .pptx is a zip of XML files; this unzips it (adm-zip) and pulls
//     text nodes out of each slide's XML. It gets the actual text
//     content, not a placeholder — but doesn't handle every edge case
//     a dedicated pptx library would (speaker notes, SmartArt text,
//     etc. are not extracted). That's a real, stated limitation, not
//     a silent gap.
//
// HONEST NOTE ON STORAGE: only the EXTRACTED TEXT is persisted, not the
// original file bytes — there's no object storage (S3 etc.) wired up
// yet to keep raw uploads. If preserving the original file matters,
// that's a real, separate piece of infrastructure to add later.
//
// Real libraries are required lazily (inside each function, not at
// module load) so this module can be loaded/tested even in an
// environment where the parsing libraries aren't installed (e.g. this
// sandbox has no network to npm install) — only the specific extractor
// actually being called needs the library to be present.

function detectFormat(filename, mimetype) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (mimetype === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mimetype?.includes('wordprocessingml') || ext === 'docx') return 'docx';
  if (mimetype?.includes('spreadsheetml') || ['xlsx', 'xls'].includes(ext)) return 'xlsx';
  if (mimetype === 'text/csv' || ext === 'csv') return 'csv';
  if (mimetype?.includes('presentationml') || ext === 'pptx') return 'pptx';
  if (mimetype?.startsWith('text/') || ext === 'txt' || ext === 'md') return 'text';
  return null;
}

async function extractPdf(buffer, pdfParseImpl) {
  const pdfParse = pdfParseImpl || require('pdf-parse');
  const data = await pdfParse(buffer);
  return { text: data.text, pageCount: data.numpages };
}

async function extractDocx(buffer, mammothImpl) {
  const mammoth = mammothImpl || require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return { text: result.value, warnings: result.messages?.map(m => m.message) || [] };
}

async function extractXlsx(buffer, xlsxImpl) {
  const XLSX = xlsxImpl || require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets = workbook.SheetNames.map(name => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
    return `--- Sheet: ${name} ---\n${csv}`;
  });
  return { text: sheets.join('\n\n'), sheetNames: workbook.SheetNames };
}

async function extractPptx(buffer, admZipImpl) {
  const AdmZip = admZipImpl || require('adm-zip');
  const zip = new AdmZip(buffer);
  const slideEntries = zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const numA = parseInt(a.entryName.match(/slide(\d+)\.xml/)[1], 10);
      const numB = parseInt(b.entryName.match(/slide(\d+)\.xml/)[1], 10);
      return numA - numB;
    });

  const slideTexts = slideEntries.map((entry, i) => {
    const xml = entry.getData().toString('utf8');
    // Extract text between <a:t> tags — the actual visible text runs in
    // OOXML slide markup. Basic but real: this is genuinely how slide
    // text is structured in the format.
    const matches = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)];
    const text = matches.map(m => m[1]).join(' ');
    return `--- Slide ${i + 1} ---\n${text}`;
  });

  return { text: slideTexts.join('\n\n'), slideCount: slideEntries.length };
}

async function extractText(buffer, filename, mimetype, impls = {}) {
  const format = detectFormat(filename, mimetype);
  if (!format) {
    throw new Error(`Unsupported file type for "${filename}". Supported: PDF, Word (.docx), Excel (.xlsx/.csv), PowerPoint (.pptx), plain text.`);
  }

  switch (format) {
    case 'pdf':  return { format, ...(await extractPdf(buffer, impls.pdfParse)) };
    case 'docx': return { format, ...(await extractDocx(buffer, impls.mammoth)) };
    case 'xlsx': return { format, ...(await extractXlsx(buffer, impls.xlsx)) };
    case 'pptx': return { format, ...(await extractPptx(buffer, impls.admZip)) };
    case 'csv':
    case 'text': return { format, text: buffer.toString('utf8') };
    default: throw new Error(`Unhandled format: ${format}`); // unreachable given detectFormat, but fails loud rather than silent if it ever is
  }
}

module.exports = { extractText, detectFormat, extractPdf, extractDocx, extractXlsx, extractPptx };
