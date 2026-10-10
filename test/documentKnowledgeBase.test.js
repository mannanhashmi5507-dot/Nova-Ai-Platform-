const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { ingestDocument, semanticSearch, chatWithDocuments } = require('../src/documents/knowledgeBase');

function withMockedDb(mocks, fn) {
  const originals = {};
  for (const key of Object.keys(mocks)) { originals[key] = db[key]; db[key] = mocks[key]; }
  return Promise.resolve(fn()).finally(() => { for (const key of Object.keys(originals)) db[key] = originals[key]; });
}

const fakeEmbedFetch = async () => ({ ok: true });
const fakeEmbedSafeJson = () => {
  let call = 0;
  return async () => ({ data: [{ embedding: [1, call++ * 0.1, 0] }] }); // slightly different each call, deterministic
};

test('ingestDocument chunks, embeds each chunk, and saves them, then marks the document indexed', async () => {
  let savedChunks = null;
  let markedIndexed = false;
  await withMockedDb({
    saveDocumentChunks: async (docId, userId, chunks) => { savedChunks = chunks; return chunks.length; },
    markDocumentIndexed: async () => { markedIndexed = true; },
  }, async () => {
    const result = await ingestDocument(1, 42, 'This is a short test document.', 'sk-test', fakeEmbedFetch, fakeEmbedSafeJson());
    assert.equal(result.chunksIndexed, 1);
    assert.equal(savedChunks.length, 1);
    assert.ok(Array.isArray(savedChunks[0].embedding));
    assert.equal(markedIndexed, true);
  });
});

test('ingestDocument returns 0 chunks for empty text without calling the embeddings API', async () => {
  let saveCalled = false;
  await withMockedDb({ saveDocumentChunks: async () => { saveCalled = true; } }, async () => {
    const result = await ingestDocument(1, 42, '', 'sk-test', fakeEmbedFetch, fakeEmbedSafeJson());
    assert.equal(result.chunksIndexed, 0);
    assert.equal(saveCalled, false);
  });
});

test('semanticSearch returns a helpful note (not an error) when the user has no indexed chunks yet', async () => {
  await withMockedDb({ getAllUserChunks: async () => [] }, async () => {
    const result = await semanticSearch(42, 'what is this about', 'sk-test', fakeEmbedFetch, fakeEmbedSafeJson());
    assert.equal(result.results.length, 0);
    assert.match(result.note, /No indexed document chunks/);
  });
});

test('semanticSearch scopes to a single document when documentId is given', async () => {
  let calledWithDocId = null;
  await withMockedDb({
    getDocumentChunks: async (docId) => { calledWithDocId = docId; return [{ id: 1, text: 'chunk', embedding: [1, 0, 0] }]; },
    getAllUserChunks: async () => { throw new Error('should not be called when documentId is scoped'); },
  }, async () => {
    await semanticSearch(42, 'query', 'sk-test', fakeEmbedFetch, fakeEmbedSafeJson(), { documentId: 7 });
    assert.equal(calledWithDocId, 7);
  });
});

test('semanticSearch searches across all documents when no documentId is given', async () => {
  let allChunksCalled = false;
  await withMockedDb({
    getAllUserChunks: async () => { allChunksCalled = true; return [{ id: 1, text: 'chunk', embedding: [1, 0, 0] }]; },
  }, async () => {
    await semanticSearch(42, 'query', 'sk-test', fakeEmbedFetch, fakeEmbedSafeJson());
    assert.equal(allChunksCalled, true);
  });
});

test('chatWithDocuments returns a plain "no relevant content" answer instead of hallucinating when nothing is indexed', async () => {
  await withMockedDb({ getAllUserChunks: async () => [] }, async () => {
    const result = await chatWithDocuments(42, 'what does the contract say', async () => { throw new Error('AI must not be called with no context'); }, 'sk-test', fakeEmbedFetch, fakeEmbedSafeJson());
    // chatWithDocuments forwards semanticSearch's specific note when one
    // exists (here: no chunks indexed yet at all) rather than a generic
    // fallback string — that's the more helpful, correct behavior.
    assert.match(result.answer, /No indexed document chunks found/);
    assert.deepEqual(result.sources, []);
  });
});

test('chatWithDocuments retrieves relevant chunks, builds context, and returns sources with the answer', async () => {
  await withMockedDb({
    getAllUserChunks: async () => [
      { id: 1, documentId: 5, text: 'The contract term is 12 months.', embedding: [1, 0, 0], filename: 'contract.pdf' },
    ],
  }, async () => {
    let capturedMessages = null;
    const fakeGetAIReply = async (messages) => { capturedMessages = messages; return { reply: 'The term is 12 months [1].', provider: 'Test' }; };
    const result = await chatWithDocuments(42, 'what is the contract term', fakeGetAIReply, 'sk-test', fakeEmbedFetch, fakeEmbedSafeJson());

    assert.match(capturedMessages[0].content, /12 months/);
    assert.match(capturedMessages[0].content, /ONLY the provided document excerpts/);
    assert.equal(result.answer, 'The term is 12 months [1].');
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].filename, 'contract.pdf');
    assert.equal(typeof result.sources[0].similarity, 'number');
  });
});

test('chatWithDocuments respects documentId scoping, passing it through to semanticSearch', async () => {
  let scopedDocId = null;
  await withMockedDb({
    getDocumentChunks: async (docId) => { scopedDocId = docId; return [{ id: 1, documentId: docId, text: 'chunk', embedding: [1, 0, 0], filename: 'x.pdf' }]; },
  }, async () => {
    const fakeGetAIReply = async () => ({ reply: 'answer', provider: 'Test' });
    await chatWithDocuments(42, 'question', fakeGetAIReply, 'sk-test', fakeEmbedFetch, fakeEmbedSafeJson(), undefined, { documentId: 9 });
    assert.equal(scopedDocId, 9);
  });
});
