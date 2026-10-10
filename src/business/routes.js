const express = require('express');
const db = require('../db');
const { calculateInvoice } = require('./invoiceMath');
const { renderInvoiceHTML } = require('./invoiceRender');
const { logger } = require('../logging/logger');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.dbUser) return next();
  return res.status(401).json({ error: 'Sign in to use the Business Hub.' });
}
function notReadyIfNoDb(req, res, next) {
  if (!db.isEnabled()) return res.status(503).json({ error: 'This feature isn\u2019t configured on this server yet.' });
  next();
}
router.use(requireAuth, notReadyIfNoDb);

// ── CRM ──────────────────────────────────────────────────────

router.get('/customers', async (req, res) => {
  const customers = await db.listCustomers(req.dbUser.id, { stage: req.query.stage });
  res.json({ customers });
});

router.post('/customers', async (req, res) => {
  const { name, email, company, phone, stage, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const customer = await db.createCustomer(req.dbUser.id, { name, email, company, phone, stage, notes });
  res.json({ customer });
});

router.get('/customers/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const customer = await db.getCustomer(id, req.dbUser.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json({ customer });
});

router.patch('/customers/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const customer = await db.updateCustomer(id, req.dbUser.id, req.body);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  res.json({ customer });
});

router.delete('/customers/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deleted = await db.deleteCustomer(id, req.dbUser.id);
  if (!deleted) return res.status(404).json({ error: 'Customer not found' });
  res.json({ deleted: true });
});

// ── Invoices ──────────────────────────────────────────────────

router.post('/invoices', async (req, res) => {
  try {
    const { customerId, invoiceNumber, lineItems, taxRatePercent, discountPercent, currency, issueDate, dueDate, notes } = req.body;
    if (!invoiceNumber || !invoiceNumber.trim()) return res.status(400).json({ error: 'invoiceNumber is required' });
    if (!issueDate || isNaN(Date.parse(issueDate))) return res.status(400).json({ error: 'issueDate must be a valid date' });

    const calculated = calculateInvoice(lineItems, { taxRatePercent, discountPercent });
    const invoice = await db.createInvoice(req.dbUser.id, {
      customerId, invoiceNumber, lineItems: calculated.lineItems, subtotal: calculated.subtotal,
      discountPercent: calculated.discountPercent, taxRatePercent: calculated.taxRatePercent,
      total: calculated.total, currency, issueDate, dueDate, notes,
    });
    if (!invoice) return res.status(409).json({ error: `Invoice number "${invoiceNumber}" already exists` });
    res.json({ invoice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/invoices', async (req, res) => {
  const invoices = await db.listInvoices(req.dbUser.id, { status: req.query.status });
  res.json({ invoices });
});

router.get('/invoices/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const invoice = await db.getInvoice(id, req.dbUser.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  res.json({ invoice });
});

router.get('/invoices/:id/html', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const invoice = await db.getInvoice(id, req.dbUser.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  let customer = null;
  if (invoice.customer_id) customer = await db.getCustomer(invoice.customer_id, req.dbUser.id);

  const html = renderInvoiceHTML({
    invoiceNumber: invoice.invoice_number,
    issueDate: invoice.issue_date,
    dueDate: invoice.due_date,
    fromName: req.dbUser.display_name || req.dbUser.email,
    fromEmail: req.dbUser.email,
    toName: customer?.name || 'Customer',
    toEmail: customer?.email,
    calculated: {
      lineItems: invoice.line_items,
      subtotal: Number(invoice.subtotal),
      discountPercent: Number(invoice.discount_percent),
      discountAmount: Number(invoice.subtotal) * Number(invoice.discount_percent) / 100,
      taxRatePercent: Number(invoice.tax_rate_percent),
      taxAmount: Number(invoice.total) - (Number(invoice.subtotal) - Number(invoice.subtotal) * Number(invoice.discount_percent) / 100),
      total: Number(invoice.total),
    },
    currency: invoice.currency,
    notes: invoice.notes,
  });
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

router.patch('/invoices/:id/status', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body;
  if (!['draft', 'sent', 'paid', 'overdue', 'canceled'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  const invoice = await db.updateInvoiceStatus(id, req.dbUser.id, status);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  res.json({ invoice });
});

// ── Analytics ─────────────────────────────────────────────────

router.get('/analytics', async (req, res) => {
  const analytics = await db.getBusinessAnalytics(req.dbUser.id);
  res.json(analytics);
});

module.exports = { router };
