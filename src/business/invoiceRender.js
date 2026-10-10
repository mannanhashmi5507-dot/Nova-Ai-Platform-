// ─── Business Hub: Invoice HTML Rendering ────────────────────
// Phase 9. Renders a real, clean, printable HTML invoice — the user's
// browser can print-to-PDF this directly (Ctrl/Cmd+P → Save as PDF),
// which produces a genuinely correct PDF without this app needing to
// add and maintain a binary PDF-generation dependency. That's a
// deliberate scope choice: HTML output is fully testable (string
// content, easy to verify correctness) where a PDF binary's byte
// output isn't meaningfully testable without visually inspecting it.

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

function renderInvoiceHTML({ invoiceNumber, issueDate, dueDate, fromName, fromEmail, toName, toEmail, calculated, currency = 'USD', notes }) {
  const rows = calculated.lineItems.map(item => `
    <tr>
      <td>${escapeHtml(item.description)}</td>
      <td style="text-align:right">${item.quantity}</td>
      <td style="text-align:right">${formatCurrency(item.unitPrice, currency)}</td>
      <td style="text-align:right">${formatCurrency(item.lineTotal, currency)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Invoice ${escapeHtml(invoiceNumber)}</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; max-width: 700px; margin: 40px auto; color: #1a1a1a; }
  .header { display: flex; justify-content: space-between; margin-bottom: 40px; }
  h1 { font-size: 24px; margin: 0 0 4px 0; }
  .meta { color: #666; font-size: 14px; }
  .parties { display: flex; justify-content: space-between; margin-bottom: 30px; }
  .party h3 { font-size: 12px; text-transform: uppercase; color: #888; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { text-align: left; border-bottom: 2px solid #333; padding: 8px 4px; font-size: 12px; text-transform: uppercase; color: #666; }
  th:not(:first-child) { text-align: right; }
  td { padding: 10px 4px; border-bottom: 1px solid #eee; }
  .totals { margin-left: auto; width: 260px; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 0; }
  .totals .total { font-weight: bold; font-size: 18px; border-top: 2px solid #333; padding-top: 8px; margin-top: 4px; }
  .notes { margin-top: 30px; font-size: 14px; color: #555; white-space: pre-wrap; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
  <div class="header">
    <div><h1>Invoice</h1><div class="meta">#${escapeHtml(invoiceNumber)}</div></div>
    <div class="meta">
      <div>Issued: ${escapeHtml(issueDate)}</div>
      ${dueDate ? `<div>Due: ${escapeHtml(dueDate)}</div>` : ''}
    </div>
  </div>
  <div class="parties">
    <div class="party"><h3>From</h3><div>${escapeHtml(fromName)}</div><div class="meta">${escapeHtml(fromEmail || '')}</div></div>
    <div class="party"><h3>Bill To</h3><div>${escapeHtml(toName)}</div><div class="meta">${escapeHtml(toEmail || '')}</div></div>
  </div>
  <table>
    <thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div><span>Subtotal</span><span>${formatCurrency(calculated.subtotal, currency)}</span></div>
    ${calculated.discountPercent > 0 ? `<div><span>Discount (${calculated.discountPercent}%)</span><span>-${formatCurrency(calculated.discountAmount, currency)}</span></div>` : ''}
    ${calculated.taxRatePercent > 0 ? `<div><span>Tax (${calculated.taxRatePercent}%)</span><span>${formatCurrency(calculated.taxAmount, currency)}</span></div>` : ''}
    <div class="total"><span>Total</span><span>${formatCurrency(calculated.total, currency)}</span></div>
  </div>
  ${notes ? `<div class="notes">${escapeHtml(notes)}</div>` : ''}
</body>
</html>`;
}

module.exports = { renderInvoiceHTML, escapeHtml, formatCurrency };
