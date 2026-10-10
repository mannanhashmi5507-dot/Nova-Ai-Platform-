const test = require('node:test');
const assert = require('node:assert/strict');
const { renderInvoiceHTML, escapeHtml, formatCurrency } = require('../src/business/invoiceRender');
const { calculateInvoice } = require('../src/business/invoiceMath');

test('escapeHtml escapes all 5 dangerous characters', () => {
  assert.equal(escapeHtml('<script>alert("hi")</script>'), '&lt;script&gt;alert(&quot;hi&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml("it's & <tag>"), 'it&#39;s &amp; &lt;tag&gt;');
});

test('formatCurrency produces a real, correctly-formatted currency string', () => {
  assert.equal(formatCurrency(1234.5), '$1,234.50');
  assert.equal(formatCurrency(0), '$0.00');
});

test('renders a complete, well-formed invoice with all sections present', () => {
  const calculated = calculateInvoice([{ description: 'Web design', quantity: 1, unitPrice: 500 }], { taxRatePercent: 10 });
  const html = renderInvoiceHTML({
    invoiceNumber: 'INV-001', issueDate: '2026-07-30', dueDate: '2026-08-30',
    fromName: 'Nova Freelance', fromEmail: 'me@example.com',
    toName: 'Acme Corp', toEmail: 'billing@acme.com',
    calculated, currency: 'USD', notes: 'Thank you for your business!',
  });
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /INV-001/);
  assert.match(html, /Web design/);
  assert.match(html, /Nova Freelance/);
  assert.match(html, /Acme Corp/);
  assert.match(html, /Thank you for your business!/);
  assert.match(html, /\$550\.00/); // 500 + 10% tax
});

test('SECURITY: a malicious customer name cannot inject a script tag into the invoice HTML', () => {
  const calculated = calculateInvoice([{ description: 'x', quantity: 1, unitPrice: 10 }]);
  const html = renderInvoiceHTML({
    invoiceNumber: 'INV-002', issueDate: '2026-01-01',
    fromName: 'Me', toName: '<script>alert("xss")</script>', calculated,
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('SECURITY: a malicious line item description is escaped, not injected raw', () => {
  const calculated = calculateInvoice([{ description: '<img src=x onerror=alert(1)>', quantity: 1, unitPrice: 10 }]);
  const html = renderInvoiceHTML({ invoiceNumber: 'INV-003', issueDate: '2026-01-01', fromName: 'Me', toName: 'Cust', calculated });
  assert.doesNotMatch(html, /<img src=x onerror/);
});

test('discount and tax rows only appear in output when actually non-zero', () => {
  const noDiscountNoTax = calculateInvoice([{ description: 'x', quantity: 1, unitPrice: 10 }]);
  const html1 = renderInvoiceHTML({ invoiceNumber: 'A', issueDate: '2026-01-01', fromName: 'Me', toName: 'C', calculated: noDiscountNoTax });
  assert.doesNotMatch(html1, /Discount/);
  assert.doesNotMatch(html1, />Tax/);

  const withBoth = calculateInvoice([{ description: 'x', quantity: 1, unitPrice: 10 }], { taxRatePercent: 5, discountPercent: 5 });
  const html2 = renderInvoiceHTML({ invoiceNumber: 'B', issueDate: '2026-01-01', fromName: 'Me', toName: 'C', calculated: withBoth });
  assert.match(html2, /Discount/);
  assert.match(html2, />Tax/);
});

test('omits the notes section entirely when no notes are given (no empty div)', () => {
  const calculated = calculateInvoice([{ description: 'x', quantity: 1, unitPrice: 10 }]);
  const html = renderInvoiceHTML({ invoiceNumber: 'A', issueDate: '2026-01-01', fromName: 'Me', toName: 'C', calculated });
  assert.doesNotMatch(html, /class="notes"/);
});
