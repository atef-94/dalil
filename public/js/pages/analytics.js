import { el, clear, table, errorBanner, loadingState } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

function statCard(value, label) {
  return el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label)]);
}

export async function renderAnalytics(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_analytics'))));
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
      el('h3', { style: 'margin-top:0' }, t(locale, 'analytics_funnel_title')),
      el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, `${funnel.totalLeads} ${t(locale, 'analytics_funnel_subtitle_suffix')}`),
      el('div', { class: 'stat-grid' }, funnel.stages.map((s) => statCard(s.count, s.stageName))),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'analytics_performance_title')),
      el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, t(locale, 'analytics_performance_subtitle')),
      el('div', { class: 'stat-grid' }, [
        statCard(
          speedToContact.averageHours !== null ? `${speedToContact.averageHours}h` : '—',
          `${t(locale, 'crm_avg_speed')}${speedToContact.sampleSize ? ` (n=${speedToContact.sampleSize})` : ''}`,
        ),
        statCard(`${conversionRates.overallWinRatePercent}%`, t(locale, 'crm_overall_win_rate')),
        statCard(`${conversionRates.lostRatePercent}%`, t(locale, 'crm_lost_rate')),
        statCard(
          costPerLead.costPerQualifiedLead !== null ? Number(costPerLead.costPerQualifiedLead).toLocaleString() : '—',
          t(locale, 'crm_cost_per_qualified_lead'),
        ),
      ]),
      el('div', { class: 'stat-grid', style: 'margin-top:10px' },
        conversionRates.stageConversion.map((s) => statCard(`${s.conversionPercent}%`, `${s.fromStageName} → ${s.toStageName}`)),
      ),
      el('h4', { style: 'margin-bottom:6px' }, t(locale, 'analytics_lost_reasons_title')),
      table(
        [
          { label: t(locale, 'fin_reason_field'), key: 'reason' },
          { label: t(locale, 'analytics_count'), key: 'count' },
        ],
        lostReasons,
        { empty: t(locale, 'analytics_lost_reasons_empty') },
      ),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'analytics_pipeline_title')),
      el('div', { class: 'stat-grid' }, [
        statCard(pipeline.openOpportunities, t(locale, 'analytics_open_offers')),
        statCard(pipeline.reservedOpportunities, t(locale, 'units_manage_status_reserved')),
        statCard(pipeline.wonOpportunities, t(locale, 'analytics_won')),
        statCard(pipeline.signedContracts, t(locale, 'analytics_signed_contracts')),
        statCard(pipeline.cancelledContracts, t(locale, 'analytics_cancelled_contracts')),
      ]),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'analytics_collections_aging_title')),
      el('div', { class: 'stat-grid' }, [
        statCard(Number(aging.upcoming).toLocaleString(), t(locale, 'analytics_upcoming')),
        statCard(Number(aging.due).toLocaleString(), t(locale, 'crm_task_col_due')),
        statCard(Number(aging.overdue).toLocaleString(), t(locale, 'analytics_overdue')),
        statCard(Number(aging.paid).toLocaleString(), t(locale, 'contracts_col_paid')),
      ]),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'analytics_inventory_occupancy_title')),
      el('div', { class: 'stat-grid' }, [
        statCard(occupancy.available, t(locale, 'units_manage_status_available')),
        statCard(occupancy.held, t(locale, 'units_manage_status_held')),
        statCard(occupancy.reserved, t(locale, 'units_manage_status_reserved')),
        statCard(occupancy.contracted, t(locale, 'units_manage_status_contracted')),
        statCard(`${occupancy.occupancyRatePercent}%`, t(locale, 'analytics_occupancy_rate')),
      ]),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'analytics_broker_performance_title')),
      table(
        [
          { label: t(locale, 'brokers_broker_company_field'), render: (b) => b.brokerCompanyId.slice(0, 8) + '…' },
          { label: t(locale, 'analytics_pending'), render: (b) => Number(b.pendingAmount).toLocaleString() },
          { label: t(locale, 'analytics_approved'), render: (b) => Number(b.approvedAmount).toLocaleString() },
          { label: t(locale, 'contracts_col_paid'), render: (b) => Number(b.paidAmount).toLocaleString() },
        ],
        brokerPerf,
        { empty: t(locale, 'analytics_broker_perf_empty') },
      ),
    ]));

    body.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'analytics_lead_priority_title')),
      el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, t(locale, 'analytics_lead_priority_subtitle')),
      table(
        [
          { label: t(locale, 'ai_panel_lead_word'), render: (s) => s.leadId.slice(0, 8) + '…' },
          { label: t(locale, 'analytics_score'), render: (s) => String(s.score) },
          { label: t(locale, 'analytics_why'), render: (s) => s.factors.map((f) => `${f.label} (+${f.points})`).join(', ') || '—' },
        ],
        scores,
        { empty: t(locale, 'analytics_lead_priority_empty') },
      ),
    ]));
  } catch (err) {
    clear(body);
    body.appendChild(errorBanner(err.message));
  }
}
