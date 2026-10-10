const express = require('express');
const db = require('../db');
const planners = require('./planners');
const { getLearningContent, VALID_TOPICS } = require('./learningContent');
const { withDisclaimer } = require('./disclaimers');
const { logger } = require('../logging/logger');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.dbUser) return next();
  return res.status(401).json({ error: 'Sign in to use net worth tracking and financial goals.' });
}
function notReadyIfNoDb(req, res, next) {
  if (!db.isEnabled()) return res.status(503).json({ error: 'This feature isn\u2019t configured on this server yet.' });
  next();
}

// ── Planners: pure math, stateless, no auth required ──────────
// Every response carries the disclaimer as a real field, not just prompt text.

router.post('/planners/spending', (req, res) => {
  try {
    const result = planners.spendingPlan50_30_20(req.body.monthlyIncome);
    res.json(withDisclaimer(result));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/planners/investment-projection', (req, res) => {
  try {
    const result = planners.investmentProjection(req.body);
    res.json(withDisclaimer(result));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/planners/required-savings', (req, res) => {
  try {
    const result = planners.requiredMonthlySavings(req.body);
    res.json(withDisclaimer(result));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Learning: fixed topic enum only, no free text ──────────────

router.get('/learn/topics', (req, res) => {
  res.json({ topics: VALID_TOPICS });
});

router.post('/learn/:topic', async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    const result = await getLearningContent(req.params.topic, req.app.locals.getAIReply, reqController.signal);
    res.json(withDisclaimer(result));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Net worth & goals: real bookkeeping, requires auth + DB ────

router.use('/net-worth', requireAuth, notReadyIfNoDb);
router.use('/goals', requireAuth, notReadyIfNoDb);

router.get('/net-worth', async (req, res) => {
  const [assets, liabilities] = await Promise.all([db.listAssets(req.dbUser.id), db.listLiabilities(req.dbUser.id)]);
  const calc = planners.calculateNetWorth(assets, liabilities);
  res.json(withDisclaimer({ assets, liabilities, ...calc }));
});

router.post('/net-worth/assets', async (req, res) => {
  const { name, category, value } = req.body;
  if (!name || typeof value !== 'number') return res.status(400).json({ error: 'name and numeric value are required' });
  const asset = await db.addAsset(req.dbUser.id, { name, category, value });
  res.json({ asset });
});

router.delete('/net-worth/assets/:id', async (req, res) => {
  const deleted = await db.deleteAsset(parseInt(req.params.id, 10), req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Asset not found' });
  res.json({ deleted: true });
});

router.post('/net-worth/liabilities', async (req, res) => {
  const { name, category, value } = req.body;
  if (!name || typeof value !== 'number') return res.status(400).json({ error: 'name and numeric value are required' });
  const liability = await db.addLiability(req.dbUser.id, { name, category, value });
  res.json({ liability });
});

router.delete('/net-worth/liabilities/:id', async (req, res) => {
  const deleted = await db.deleteLiability(parseInt(req.params.id, 10), req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Liability not found' });
  res.json({ deleted: true });
});

router.get('/goals', async (req, res) => {
  const goals = await db.listFinancialGoals(req.dbUser.id);
  res.json({ goals });
});

router.post('/goals', async (req, res) => {
  const { name, targetAmount, currentAmount, targetDate } = req.body;
  if (!name || typeof targetAmount !== 'number') return res.status(400).json({ error: 'name and numeric targetAmount are required' });
  const goal = await db.createFinancialGoal(req.dbUser.id, { name, targetAmount, currentAmount, targetDate });
  res.json({ goal });
});

router.patch('/goals/:id', async (req, res) => {
  const goal = await db.updateFinancialGoal(parseInt(req.params.id, 10), req.dbUser.id, req.body);
  if (!goal) return res.status(404).json({ error: 'Goal not found' });
  res.json({ goal });
});

router.delete('/goals/:id', async (req, res) => {
  const deleted = await db.deleteFinancialGoal(parseInt(req.params.id, 10), req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Goal not found' });
  res.json({ deleted: true });
});

module.exports = { router };
