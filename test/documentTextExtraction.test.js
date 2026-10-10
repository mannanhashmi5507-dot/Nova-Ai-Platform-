const test = require('node:test');
const assert = require('node:assert/strict');
const { extractText, detectFormat, extractPdf, extractDocx, extractXlsx, extractPptx } = require('../src/documents/textExtraction');

test('detectFormat identifies PDF by mimetype', () => {
  assert.equal(detectFormat('report.pdf', 'application/pdf'), 'pdf');
});
test('detectFormat identifies PDF by extension when mimetype is generic', () => {
  assert.equal(detectFormat('report.pdf', 'application/octet-stream'), 'pdf');
});
test('detectFormat identifies docx', () => {
  assert.equal(detectFormat('doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
});
test('detectFormat identifies xlsx and csv', () => {
  assert.equal(detectFormat('sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx');
  assert.equal(detectFormat('data.csv', 'text/csv'), 'csv');
});
test('detectFormat identifies pptx', () => {
  assert.equal(detectFormat('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'), 'pptx');
});
test('detectFormat identifies plain text/markdown', () => {
  assert.equal(detectFormat('notes.txt', 'text/plain'), 'text');
  assert.equal(detectFormat('readme.md', 'text/markdown'), 'text');
});
test('detectFormat returns null for a genuinely unsupported type', () => {
  assert.equal(detectFormat('video.mp4', 'video/mp4'), null);
});

test('extractText throws a clear error for an unsupported file type', async () => {
  await assert.rejects(
    () => extractText(Buffer.from('x'), 'video.mp4', 'video/mp4'),
    /Unsupported file type/
  );
});

test('extractText dispatches plain text files without needing any external library', async () => {
  const result = await extractText(Buffer.from('Hello, this is plain text.'), 'notes.txt', 'text/plain');
  assert.equal(result.format, 'text');
  assert.equal(result.text, 'Hello, this is plain text.');
});

test('extractPdf uses the injected parser and returns real extracted text + page count', async () => {
  const fakePdfParse = async (buffer) => ({ text: 'Extracted PDF content', numpages: 3 });
  const result = await extractPdf(Buffer.from('fake pdf bytes'), fakePdfParse);
  assert.equal(result.text, 'Extracted PDF content');
  assert.equal(result.pageCount, 3);
});

test('extractDocx uses the injected parser and returns text + any conversion warnings', async () => {
  const fakeMammoth = { extractRawText: async () => ({ value: 'Word document text', messages: [{ message: 'minor formatting note' }] }) };
  const result = await extractDocx(Buffer.from('fake docx bytes'), fakeMammoth);
  assert.equal(result.text, 'Word document text');
  assert.deepEqual(result.warnings, ['minor formatting note']);
});

test('extractXlsx converts each sheet to labeled CSV text', async () => {
  const fakeXLSX = {
    read: () => ({ SheetNames: ['Sheet1', 'Sheet2'], Sheets: { Sheet1: {}, Sheet2: {} } }),
    utils: { sheet_to_csv: (sheet) => 'a,b,c\n1,2,3' },
  };
  const result = await extractXlsx(Buffer.from('fake xlsx bytes'), fakeXLSX);
  assert.match(result.text, /--- Sheet: Sheet1 ---/);
  assert.match(result.text, /--- Sheet: Sheet2 ---/);
  assert.deepEqual(result.sheetNames, ['Sheet1', 'Sheet2']);
});

test('extractPptx pulls real text runs out of slide XML and orders slides correctly', async () => {
  const slide1Xml = '<p:sld><a:t>First slide title</a:t><a:t> more text</a:t></p:sld>';
  const slide2Xml = '<p:sld><a:t>Second slide content</a:t></p:sld>';
  const fakeEntries = [
    { entryName: 'ppt/slides/slide2.xml', getData: () => Buffer.from(slide2Xml) },
    { entryName: 'ppt/slides/slide1.xml', getData: () => Buffer.from(slide1Xml) },
    { entryName: 'ppt/slides/_rels/slide1.xml.rels', getData: () => Buffer.from('') }, // should be filtered out
  ];
  class FakeAdmZip {
    getEntries() { return fakeEntries; }
  }
  const result = await extractPptx(Buffer.from('fake pptx bytes'), FakeAdmZip);
  assert.equal(result.slideCount, 2);
  // Must be in slide ORDER (1 then 2), not file-listing order
  assert.match(result.text, /Slide 1[\s\S]*First slide title[\s\S]*Slide 2[\s\S]*Second slide content/);
});

test('extractPptx handles a deck with no text gracefully (empty slides), not a crash', async () => {
  class FakeAdmZip {
    getEntries() { return [{ entryName: 'ppt/slides/slide1.xml', getData: () => Buffer.from('<p:sld></p:sld>') }]; }
  }
  const result = await extractPptx(Buffer.from('x'), FakeAdmZip);
  assert.equal(result.slideCount, 1);
});
