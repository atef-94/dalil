import ExcelJS from 'exceljs';
import type { Quotation, Unit } from '../../domain/types.js';
import type { QuotationCalculation } from './quotation.service.js';

/**
 * Both exports render the exact same QuotationCalculation the live UI
 * preview and the persisted Quotation agree on (see quotation.service.ts) —
 * there is no separate formatting/rounding path for "what the customer
 * downloads" vs. "what the sales agent saw on screen".
 */

export async function buildQuotationWorkbook(quotation: Quotation, calc: QuotationCalculation): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ACTIVE';
  workbook.created = new Date();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 28 }, { width: 34 }];
  const summaryRows: [string, string | number][] = [
    ['Reference Number', quotation.referenceNumber],
    ['Version', quotation.version],
    ['Status', quotation.status],
    ['Unit Code', calc.unit.code],
    ['Unit Type', calc.unit.unitType],
    ['Area (sqm)', calc.unit.areaSqm],
    ['Total Price', calc.totalPrice],
    ['Discount %', calc.discountPercent],
    ['Escalation % / Year', calc.escalationPercentPerYear],
    ['Net Value', calc.netValue],
    ['Down Payment', calc.downPayment],
    ['Generated At', quotation.createdAt],
  ];
  summary.addRow(['Field', 'Value']).font = { bold: true };
  for (const [label, value] of summaryRows) summary.addRow([label, value]);

  const schedule = workbook.addWorksheet('Payment Schedule');
  schedule.columns = [
    { header: '#', key: 'seq', width: 6 },
    { header: 'Label', key: 'label', width: 24 },
    { header: 'Due Date', key: 'dueDate', width: 16 },
    { header: 'Amount', key: 'amount', width: 16 },
  ];
  schedule.getRow(1).font = { bold: true };
  calc.schedule.forEach((line, index) => {
    schedule.addRow({ seq: index + 1, label: line.label, dueDate: line.dueDate, amount: line.amount });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * A print-optimized HTML view of a quotation — the browser's own "Print >
 * Save as PDF" produces the actual PDF file, so this never claims a
 * server-rendered PDF that doesn't exist. Every real browser supports it,
 * and it needs no new production dependency (a headless-Chromium rendering
 * pipeline stays a documented, not-yet-built option — see README).
 */
export function buildQuotationPrintHtml(quotation: Quotation, calc: QuotationCalculation, unit: Unit): string {
  const rows = calc.schedule
    .map(
      (line, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(line.label)}</td><td>${escapeHtml(line.dueDate)}</td><td class="num">${line.amount.toLocaleString()}</td></tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quotation ${escapeHtml(quotation.referenceNumber)}</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; color: #1a1a1a; margin: 40px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .meta { color: #555; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; font-size: 13px; }
  th { background: #f4f4f5; }
  td.num, th.num { text-align: right; }
  .summary { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; margin-top: 16px; font-size: 14px; }
  .summary div span { color: #666; }
  @media print { body { margin: 12mm; } }
</style>
</head>
<body>
  <h1>Quotation ${escapeHtml(quotation.referenceNumber)} <small>(v${quotation.version})</small></h1>
  <div class="meta">${escapeHtml(unit.code)} — ${escapeHtml(unit.unitType)}, ${escapeHtml(unit.areaSqm)} m² &nbsp;|&nbsp; Generated ${escapeHtml(new Date(quotation.createdAt).toLocaleDateString())}</div>
  <div class="summary">
    <div><span>Total Price:</span> ${calc.totalPrice.toLocaleString()}</div>
    <div><span>Discount:</span> ${calc.discountPercent}%</div>
    <div><span>Net Value:</span> ${calc.netValue.toLocaleString()}</div>
    <div><span>Escalation / Year:</span> ${calc.escalationPercentPerYear}%</div>
    <div><span>Down Payment:</span> ${calc.downPayment.toLocaleString()}</div>
    <div><span>Status:</span> ${escapeHtml(quotation.status)}</div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Label</th><th>Due Date</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}
