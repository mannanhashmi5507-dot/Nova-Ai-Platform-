const express = require('express');
const multer = require('multer');
const db = require('../db');
const { extractText } = require('./textExtraction');
const { extractTextFromImage } = require('./ocr');
const { ingestDocument, semanticSearch, chatWithDocuments } = require('./knowledgeBase');
const { logger } = require('../logging/logger');

const router = express.Router();

// Memory storage — files are never written to disk. Extracted text is
// persisted (see documents.js schema); the raw upload buffer is
// discarded after extraction. 20MB cap: generous for real documents,
// bounded so one upload can't exhaust server memory.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.dbUser) return next();
  return res.status(401).json({ error: 'Sign in to upload and manage documents.' });
}
function notReadyIfNoDb(req, res, next) {
  if (!db.isEnabled()) return res.status(503).json({ error: 'Document storage isn\u2019t configured on this server yet.' });
  next();
}
router.use(requireAuth, notReadyIfNoDb);

// POST /api/documents/upload — real multipart file upload, real text
// extraction. Indexing (chunk + embed) happens automatically afterward
// if OPENAI_API_KEY is configured; otherwise the document is stored
// with its extracted text but marked unindexed (search/chat need the
// key; browsing the raw extracted text does not).
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required (multipart/form-data, field name "file")' });

    const { text, format, ...meta } = await extractText(req.file.buffer, req.file.originalname, req.file.mimetype);
    if (!text || !text.trim()) {
      return res.status(422).json({ error: 'No extractable text found in this file.' });
    }

    const document = await db.createDocument(req.dbUser.id, { filename: req.file.originalname, format, extractedText: text });

    let indexResult = { chunksIndexed: 0, indexed: false };
    const openAiKey = req.app.locals.env?.OPENAI_KEY;
    if (openAiKey) {
      try {
        const result = await ingestDocument(document.id, req.dbUser.id, text, openAiKey, req.app.locals.fetchWithTimeout, req.app.locals.safeJson);
        indexResult = { ...result, indexed: true };
      } catch (err) {
        logger.warn('documents.indexing_failed', { requestId: req.id, documentId: document.id, error: err.message });
        // Document still exists with its extracted text — search/chat
        // just won't work for it until indexing succeeds or is retried.
      }
    }

    res.json({ document, extraction: meta, ...indexResult });
  } catch (err) {
    logger.warn('documents.upload_failed', { requestId: req.id, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  const documents = await db.listDocuments(req.dbUser.id);
  res.json({ documents });
});

router.get('/:id', async (req, res) => {
  const document = await db.getDocument(parseInt(req.params.id, 10), req.dbUser.id);
  if (!document) return res.status(404).json({ error: 'Document not found' });
  res.json({ document });
});

router.delete('/:id', async (req, res) => {
  const deleted = await db.deleteDocument(parseInt(req.params.id, 10), req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Document not found' });
  res.json({ deleted: true });
});

// POST /api/documents/search — semantic search across all (or one) of
// the user's indexed documents.
router.post('/search', async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    const { query, documentId } = req.body;
    if (!query || !query.trim()) return res.status(400).json({ error: 'query is required' });
    const openAiKey = req.app.locals.env?.OPENAI_KEY;
    const result = await semanticSearch(req.dbUser.id, query, openAiKey, req.app.locals.fetchWithTimeout, req.app.locals.safeJson, { documentId });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/documents/chat — real RAG: retrieves relevant chunks, asks
// the AI to answer using only that retrieved context, returns sources.
router.post('/chat', async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    const { question, documentId } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'question is required' });
    const openAiKey = req.app.locals.env?.OPENAI_KEY;
    const result = await chatWithDocuments(
      req.dbUser.id, question, req.app.locals.getAIReply, openAiKey,
      req.app.locals.fetchWithTimeout, req.app.locals.safeJson, reqController.signal, { documentId }
    );
    res.json(result);
  } catch (err) {
    logger.warn('documents.chat_failed', { requestId: req.id, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

// POST /api/documents/ocr — extract text from an uploaded image.
router.post('/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'image is required (multipart/form-data, field name "image")' });
    const openAiKey = req.app.locals.env?.OPENAI_KEY;
    const result = await extractTextFromImage(req.file.buffer.toString('base64'), openAiKey, req.app.locals.fetchWithTimeout, req.app.locals.safeJson, req.file.mimetype);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = { router };
