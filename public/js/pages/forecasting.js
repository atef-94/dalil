import { el, clear, table, toast, errorBanner, loadingState, selectInput } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

export async function renderForecasting(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h1', {}, t(locale, 'page_title_forecasting')),
      el('p', { class: 'page-subtitle' }, 'Deterministic projections built from real historical bookings/collections and the existing payment-plan engine — no external ML, no randomness.'),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const projectSelect = selectInput([{ value: '', label: 'All projects (portfolio-wide)' }]);
  const historicalMonths = el('input', { type: 'number', value: '6', min: '1', max: '60' });
  const trailingMonths = el('input', { type: 'number', value: '3', min: '1', max: '24' });
  const forecastMonths = el('input', { type: 'number', value: '6', min: '1', max: '24' });
  const generateBtn = el('button', { class: 'primary' }, 'Generate forecast');

  const historicalSlot = el('div');
  const forecastSlot = el('div');

  const compareMonth = el('input', { type: 'month' });
  const compareTrailing = el('input', { type: 'number', value: '3', min: '1', max: '24' });
  const compareBtn = el('button', {}, 'Compare actual vs forecast');
  const compareSlot = el('div');

  async function loadHistorical() {
    clear(historicalSlot);
    historicalSlot.appendChild(loadingState());
    try {
      const history = await api.get('/api/forecasting/historical', { projectId: projectSelect.value, months: historicalMonths.value });
      clear(historicalSlot);
      historicalSlot.appendChild(table(
        [
          { label: 'Month', key: 'month' },
          { label: 'Bookings', key: 'bookingsCount' },
          { label: 'Bookings value', render: (h) => Number(h.bookingsValue).toLocaleString() },
          { label: 'Scheduled collections', render: (h) => Number(h.scheduledCollections).toLocaleString() },
          { label: 'Actual collections', render: (h) => Number(h.actualCollections).toLocaleString() },
        ],
        history,
        { empty: 'No historical data yet for this range.' },
      ));
    } catch (err) {
      clear(historicalSlot);
      historicalSlot.appendChild(errorBanner(err.message));
    }
  }

  generateBtn.addEventListener('click', async () => {
    clear(errorSlot);
    await loadHistorical();
    clear(forecastSlot);
    forecastSlot.appendChild(loadingState());
    try {
      const forecast = await api.get('/api/forecasting/forecast', {
        projectId: projectSelect.value,
        trailingMonths: trailingMonths.value,
        forecastMonths: forecastMonths.value,
      });
      clear(forecastSlot);
      forecastSlot.appendChild(el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, forecast.method));
      forecastSlot.appendChild(el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(forecast.projectedNewBookingsPerMonth).toLocaleString()), el('div', { class: 'label' }, 'Projected new bookings / month')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, forecast.historicalCollectionRatePercent === null ? 'n/a' : `${forecast.historicalCollectionRatePercent}%`), el('div', { class: 'label' }, 'Historical collection rate')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(forecast.totalScheduledFutureCollections).toLocaleString()), el('div', { class: 'label' }, 'Total scheduled future collections')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(forecast.totalExpectedFutureCollections).toLocaleString()), el('div', { class: 'label' }, 'Expected future collections (rate-adjusted)')]),
      ]));
      forecastSlot.appendChild(table(
        [
          { label: 'Month', key: 'month' },
          { label: 'Projected new bookings', render: (s) => Number(s.projectedNewBookingsValue).toLocaleString() },
          { label: 'Scheduled collections (known)', render: (s) => Number(s.scheduledCollections).toLocaleString() },
          { label: 'Expected collections', render: (s) => Number(s.expectedCollections).toLocaleString() },
        ],
        forecast.series,
        { empty: 'No forecast periods.' },
      ));
    } catch (err) {
      clear(forecastSlot);
      forecastSlot.appendChild(errorBanner(err.message));
    }
  });

  compareBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!compareMonth.value) {
      errorSlot.appendChild(errorBanner('Choose a month to compare.'));
      return;
    }
    clear(compareSlot);
    compareSlot.appendChild(loadingState());
    try {
      const comparison = await api.get('/api/forecasting/compare', {
        projectId: projectSelect.value,
        month: compareMonth.value,
        trailingMonths: compareTrailing.value,
      });
      clear(compareSlot);
      compareSlot.appendChild(el('div', { class: 'stat-grid' }, [
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.forecastBookingsValue).toLocaleString()), el('div', { class: 'label' }, 'Forecast bookings')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.actualBookingsValue).toLocaleString()), el('div', { class: 'label' }, 'Actual bookings')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, comparison.bookingsVariancePercent === null ? 'n/a' : `${comparison.bookingsVariancePercent}%`), el('div', { class: 'label' }, 'Bookings variance')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.forecastCollections).toLocaleString()), el('div', { class: 'label' }, 'Forecast collections')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.actualCollections).toLocaleString()), el('div', { class: 'label' }, 'Actual collections')]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, comparison.collectionsVariancePercent === null ? 'n/a' : `${comparison.collectionsVariancePercent}%`), el('div', { class: 'label' }, 'Collections variance')]),
      ]));
    } catch (err) {
      clear(compareSlot);
      compareSlot.appendChild(errorBanner(err.message));
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Filters'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Project'), projectSelect]),
      el('div', {}, [el('label', {}, 'Historical months'), historicalMonths]),
      el('div', {}, [el('label', {}, 'Trailing months (forecast basis)'), trailingMonths]),
      el('div', {}, [el('label', {}, 'Forecast months'), forecastMonths]),
    ]),
    el('div', { class: 'form-actions' }, [generateBtn]),
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Historical sales & collections'),
    historicalSlot,
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Forecast'),
    forecastSlot,
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Actual vs forecast'),
    el('p', { class: 'page-subtitle' }, 'What the trailing-average method would have forecast for a given month, using only the months before it, compared against what actually happened.'),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Month'), compareMonth]),
      el('div', {}, [el('label', {}, 'Trailing months'), compareTrailing]),
    ]),
    el('div', { class: 'form-actions' }, [compareBtn]),
    compareSlot,
  ]));

  try {
    const projects = await api.get('/api/inventory/projects', { limit: 200 });
    projects.items.forEach((p) => projectSelect.appendChild(el('option', { value: p.id }, p.name)));
  } catch {
    // Project list is a convenience filter — leaving it as "all projects" is fine if this fails.
  }

  await loadHistorical();
}
