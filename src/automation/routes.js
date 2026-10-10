const express = require('express');
const db = require('../db');
const { WORKFLOWS } = require('./workflows');
const { executeWorkflow } = require('./orchestrator');
const jobQueue = require('./jobQueue');
const { logger } = require('../logging/logger');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.dbUser) return next();
  return res.status(401).json({ error: 'Sign in to use Automation.' });
}
function notReadyIfNoDb(req, res, next) {
  if (!db.isEnabled()) return res.status(503).json({ error: 'This feature isn\u2019t configured on this server yet.' });
  next();
}
router.use(requireAuth, notReadyIfNoDb);

// GET /api/automation/workflows — list workflows, honestly marking the
// one that isn't actually available.
router.get('/workflows', (req, res) => {
  const workflows = Object.entries(WORKFLOWS).map(([type, w]) => ({ type, name: w.name, available: w.available !== false }));
  res.json({ workflows });
});

// POST /api/automation/workflows/:type/run — execute synchronously, wait
// for the result. Good for a quick "try it now" from the UI.
router.post('/workflows/:type/run', async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    const result = await executeWorkflow(req.params.type, req.body, req.dbUser.id, {
      getAIReply: req.app.locals.getAIReply,
      signal: reqController.signal,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/automation/workflows/:type/queue — enqueue as a background
// job instead of blocking the request; returns immediately with a job id.
router.post('/workflows/:type/queue', async (req, res) => {
  try {
    const workflow = WORKFLOWS[req.params.type];
    if (!workflow) return res.status(404).json({ error: `Unknown workflow: ${req.params.type}` });
    if (workflow.available === false) return res.status(501).json({ error: workflow.name + ' is not available \u2014 see /api/automation/workflows for details' });

    const job = await db.enqueueJob({ userId: req.dbUser.id, type: `workflow:${req.params.type}`, payload: { ...req.body, userId: req.dbUser.id } });
    res.json({ queued: true, job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/jobs', async (req, res) => {
  res.json({ jobs: await db.listJobs(req.dbUser.id, { status: req.query.status }) });
});

router.get('/workflow-runs', async (req, res) => {
  res.json({ runs: await db.listWorkflowRuns(req.dbUser.id) });
});

router.get('/workflow-runs/:id', async (req, res) => {
  const run = await db.getWorkflowRun(parseInt(req.params.id, 10), req.dbUser.id);
  if (!run) return res.status(404).json({ error: 'Workflow run not found' });
  res.json({ run });
});

module.exports = { router };
