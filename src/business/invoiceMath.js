// ─── Business Hub: Invoice Calculations ──────────────────────
// Phase 9. Pure math, no AI involved — invoice totals need to be exactly
// right, not "approximately right based on an LLM's arithmetic," so
// this is deterministic code, tested against exact expected values.
//
// Money is handled in integer CENTS internally to avoid floating-point
// rounding errors (0.1 + 0.2 !== 0.3 in JS) — a classic real bug in
// invoice/billing code. Amounts in/out of these functions are decimal
// (e.g. 19.99), converted to/from cents only inside this module.

function toCents(amount) {
  return Math.round(amount * 100);
}
function fromCents(cents) {
  return Math.round(cents) / 100;
}

function validateLineItem(item, index) {
  if (!item.description || typeof item.description !== 'string') {
    throw new Error(`Line item ${index + 1}: description is required`);
  }
  if (typeof item.quantity !== 'number' || item.quantity <= 0) {
    throw new Error(`Line item ${index + 1}: quantity must be a positive number`);
  }
  if (typeof item.unitPrice !== 'number' || item.unitPrice < 0) {
    throw new Error(`Line item ${index + 1}: unitPrice must be a non-negative number`);
  }
}

function calculateInvoice(lineItems, { taxRatePercent = 0, discountPercent = 0 } = {}) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('At least one line item is required');
  }
  lineItems.forEach(validateLineItem);
  if (taxRatePercent < 0 || taxRatePercent > 100) throw new Error('taxRatePercent must be between 0 and 100');
  if (discountPercent < 0 || discountPercent > 100) throw new Error('discountPercent must be between 0 and 100');

  const itemsWithTotals = lineItems.map(item => {
    const lineTotalCents = toCents(item.unitPrice) * item.quantity;
    return { ...item, lineTotal: fromCents(lineTotalCents), _lineTotalCents: lineTotalCents };
  });

  const subtotalCents = itemsWithTotals.reduce((sum, item) => sum + item._lineTotalCents, 0);
  const discountCents = Math.round(subtotalCents * (discountPercent / 100));
  const afterDiscountCents = subtotalCents - discountCents;
  const taxCents = Math.round(afterDiscountCents * (taxRatePercent / 100));
  const totalCents = afterDiscountCents + taxCents;

  return {
    lineItems: itemsWithTotals.map(({ _lineTotalCents, ...item }) => item),
    subtotal: fromCents(subtotalCents),
    discountPercent,
    discountAmount: fromCents(discountCents),
    taxRatePercent,
    taxAmount: fromCents(taxCents),
    total: fromCents(totalCents),
  };
}

module.exports = { calculateInvoice, toCents, fromCents };
