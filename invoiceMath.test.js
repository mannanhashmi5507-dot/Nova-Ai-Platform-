const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateInvoice, toCents, fromCents } = require('../src/business/invoiceMath');

test('toCents/fromCents round-trip correctly', () => {
  assert.equal(toCents(19.99), 1999);
  assert.equal(fromCents(1999), 19.99);
});

test('calculates a simple single-item invoice with no tax/discount', () => {
  const result = calculateInvoice([{ description: 'Consulting', quantity: 2, unitPrice: 50 }]);
  assert.equal(result.subtotal, 100);
  assert.equal(result.total, 100);
  assert.equal(result.taxAmount, 0);
  assert.equal(result.discountAmount, 0);
});

test('calculates multiple line items correctly', () => {
  const result = calculateInvoice([
    { description: 'Item A', quantity: 3, unitPrice: 10 },
    { description: 'Item B', quantity: 1, unitPrice: 25.50 },
  ]);
  assert.equal(result.subtotal, 55.50);
  assert.equal(result.lineItems[0].lineTotal, 30);
  assert.equal(result.lineItems[1].lineTotal, 25.50);
});

test('applies tax correctly', () => {
  const result = calculateInvoice([{ description: 'x', quantity: 1, unitPrice: 100 }], { taxRatePercent: 8.5 });
  assert.equal(result.taxAmount, 8.5);
  assert.equal(result.total, 108.5);
});

test('applies discount correctly, calculated before tax', () => {
  const result = calculateInvoice([{ description: 'x', quantity: 1, unitPrice: 100 }], { discountPercent: 10, taxRatePercent: 10 });
  // 100 - 10% discount = 90, then +10% tax on 90 = 99
  assert.equal(result.discountAmount, 10);
  assert.equal(result.taxAmount, 9);
  assert.equal(result.total, 99);
});

test('THE CLASSIC FLOATING POINT TRAP: 0.1 + 0.2 style errors must not appear in invoice totals', () => {
  // This exact pattern (three items at prices that sum with floating-point
  // drift in naive JS math) is the textbook case that breaks invoice code.
  const result = calculateInvoice([
    { description: 'a', quantity: 1, unitPrice: 0.10 },
    { description: 'b', quantity: 1, unitPrice: 0.20 },
  ]);
  assert.equal(result.subtotal, 0.30, 'must be exactly 0.30, not 0.30000000000000004');
});

test('handles many line items with awkward cent values without drift', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ description: `item ${i}`, quantity: 3, unitPrice: 3.33 }));
  const result = calculateInvoice(items);
  // 7 * 3 * 3.33 = 69.93 exactly
  assert.equal(result.subtotal, 69.93);
});

test('rejects an empty line item array', () => {
  assert.throws(() => calculateInvoice([]), /at least one line item/i);
});

test('rejects a line item missing description', () => {
  assert.throws(() => calculateInvoice([{ quantity: 1, unitPrice: 10 }]), /description is required/);
});

test('rejects a line item with zero or negative quantity', () => {
  assert.throws(() => calculateInvoice([{ description: 'x', quantity: 0, unitPrice: 10 }]), /quantity must be a positive/);
  assert.throws(() => calculateInvoice([{ description: 'x', quantity: -2, unitPrice: 10 }]), /quantity must be a positive/);
});

test('rejects a negative unit price', () => {
  assert.throws(() => calculateInvoice([{ description: 'x', quantity: 1, unitPrice: -5 }]), /unitPrice must be a non-negative/);
});

test('rejects an out-of-range tax or discount percent', () => {
  const item = [{ description: 'x', quantity: 1, unitPrice: 10 }];
  assert.throws(() => calculateInvoice(item, { taxRatePercent: 150 }), /taxRatePercent/);
  assert.throws(() => calculateInvoice(item, { discountPercent: -5 }), /discountPercent/);
});

test('error message identifies WHICH line item is invalid, by position', () => {
  assert.throws(
    () => calculateInvoice([{ description: 'ok', quantity: 1, unitPrice: 10 }, { description: '', quantity: 1, unitPrice: 5 }]),
    /Line item 2/
  );
});
