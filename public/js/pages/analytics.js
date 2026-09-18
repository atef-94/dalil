import { el, clear, table, errorBanner, loadingState } from '../ui.js';
import { api } from '../api.js';

function statCard(value, label) {
  return el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label)]);
}

export async function renderAnalytics(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Analytics')));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const body = el('div');
  body.appendChild(loadingState());
  container.appendChild(body);

  try {
    const [funnel, pipeline, aging, occupancy, brokerPerf, scores, speedToContact, conversionRates, costPerLead, lostReasons] = await Promise.all([
      api.get('/api/analytics/sales-funnel'),
      api.get('/api/analytics/pipeline'),
      api.get('/api/analytics/collections-aging'),
      api.get('/api/analytics/inventory-occupancy'),
      api.get('/api/analytics/broker-performance'),
      api.get('/api/analytics/lead-scores'),
      api.get('/api/analytics/speed-to-first-contact'),
      api.get('/api/analytics/funnel-conversion-rates'),
      api.get('/api/analytics/cost-per-qualified-lead'),
      api.get('/api/analytics/lost-reasons'),
    ]);

    clear(body);

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Sales funnel'),
      el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, `${funnel.totalLeads} total leads, across this company's configured CRM pipeline.`),
      el('div', { class: 'stat-grid' }, funnel.stages.map((s) => statCard(s.count, s.stageName))),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Performance analytics'),
      el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, 'Computed from real recorded activity — no fabricated or estimated figures.'),
      el('div', { class: 'stat-grid' }, [
        statCard(
          speedToContact.averageHours !== null ? `${speedToContact.averageHours}h` : '—',
          `Avg. speed to first contact${speedToContact.sampleSize ? ` (n=${speedToContact.sampleSize})` : ''}`,
        ),
        statCard(`${conversionRates.overallWinRatePercent}%`, 'Overall win rate'),
        statCard(`${conversionRates.lostRatePercent}%`, 'Lost rate'),
        statCard(
          costPerLead.costPerQualifiedLead !== null ? Number(costPerLead.costPerQualifiedLead).toLocaleString() : '—',
          'Cost per qualified lead',
        ),
      ]),
      el('div', { class: 'stat-grid', style: 'margin-top:10px' },
        conversionRates.stageConversion.map((s) => statCard(`${s.conversionPercent}%`, `${s.fromStageName} → ${s.toStageName}`)),
      ),
      el('h4', { style: 'margin-bottom:6px' }, 'Lost reasons'),
      table(
        [
          { label: 'Reason', key: 'reason' },
          { label: 'Count', key: 'count' },
        ],
        lostReasons,
        { empty: 'No lost leads with a recorded reason yet.' },
      ),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Pipeline'),
      el('div', { class: 'stat-grid' }, [
        statCard(pipeline.openOpportunities, 'Open opportunities'),
        statCard(pipeline.reservedOpportunities, 'Reserved'),
        statCard(pipeline.wonOpportunities, 'Won'),
        statCard(pipeline.signedContracts, 'Signed contracts'),
        statCard(pipeline.cancelledContracts, 'Cancelled contracts'),
      ]),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Collections aging'),
      el('div', { class: 'stat-grid' }, [
        statCard(Number(aging.upcoming).toLocaleString(), 'Upcoming'),
        statCard(Number(aging.due).toLocaleString(), 'Due'),
        statCard(Number(aging.overdue).toLocaleString(), 'Overdue'),
        statCard(Number(aging.paid).toLocaleString(), 'Paid'),
      ]),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Inventory occupancy'),
      el('div', { class: 'stat-grid' }, [
        statCard(occupancy.available, 'Available'),
        statCard(occupancy.held, 'Held'),
        statCard(occupancy.reserved, 'Reserved'),
        statCard(occupancy.contracted, 'Contracted'),
        statCard(`${occupancy.occupancyRatePercent}%`, 'Occupancy rate'),
      ]),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Broker performance'),
      table(
        [
          { label: 'Broker company', render: (b) => b.brokerCompanyId.slice(0, 8) + '…' },
          { label: 'Pending', render: (b) => Number(b.pendingAmount).toLocaleString() },
          { label: 'Approved', render: (b) => Number(b.approvedAmount).toLocaleString() },
          { label: 'Paid', render: (b) => Number(b.paidAmount).toLocaleString() },
        ],
        brokerPerf,
        { empty: 'No broker commissions recorded yet.' },
      ),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, 'Lead priority (rule-based scoring)'),
      el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, 'A transparent 0–100 score from funnel stage, recency, and assignment — not a machine-learning model.'),
      table(
        [
          { label: 'Lead', render: (s) => s.leadId.slice(0, 8) + '…' },
          { label: 'Score', render: (s) => String(s.score) },
          { label: 'Why', render: (s) => s.factors.map((f) => `${f.label} (+${f.points})`).join(', ') || '—' },
        ],
        scores,
        { empty: 'No active leads to score yet.' },
      ),
    ]));
  } catch (err) {
    clear(body);
    body.appendChild(errorBanner(err.message));
  }
}
