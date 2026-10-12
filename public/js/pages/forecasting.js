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
      el('p', { class: 'page-subtitle' }, t(locale, 'forecast_page_subtitle')),
    ]),
  ]));
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  const projectSelect = selectInput([{ value: '', label: t(locale, 'forecast_all_projects_option') }]);
  const historicalMonths = el('input', { type: 'number', value: '6', min: '1', max: '60' });
  const trailingMonths = el('input', { type: 'number', value: '3', min: '1', max: '24' });
  const forecastMonths = el('input', { type: 'number', value: '6', min: '1', max: '24' });
  const generateBtn = el('button', { class: 'primary' }, t(locale, 'forecast_generate_btn'));

  const historicalSlot = el('div');
  const forecastSlot = el('div');

  const compareMonth = el('input', { type: 'month' });
  const compareTrailing = el('input', { type: 'number', value: '3', min: '1', max: '24' });
  const compareBtn = el('button', {}, t(locale, 'forecast_compare_btn'));
  const compareSlot = el('div');

  async function loadHistorical() {
    clear(historicalSlot);
    historicalSlot.appendChild(loadingState());
    try {
      const history = await api.get('/api/forecasting/historical', { projectId: projectSelect.value, months: historicalMonths.value });
      clear(historicalSlot);
      historicalSlot.appendChild(table(
        [
          { label: t(locale, 'fin_col_month'), key: 'month' },
          { label: t(locale, 'forecast_col_bookings'), key: 'bookingsCount' },
          { label: t(locale, 'forecast_col_bookings_value'), render: (h) => Number(h.bookingsValue).toLocaleString() },
          { label: t(locale, 'forecast_col_scheduled_collections'), render: (h) => Number(h.scheduledCollections).toLocaleString() },
          { label: t(locale, 'forecast_col_actual_collections'), render: (h) => Number(h.actualCollections).toLocaleString() },
        ],
        history,
        { empty: t(locale, 'forecast_historical_empty') },
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
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(forecast.projectedNewBookingsPerMonth).toLocaleString()), el('div', { class: 'label' }, t(locale, 'forecast_stat_new_bookings'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, forecast.historicalCollectionRatePercent === null ? t(locale, 'fin_na') : `${forecast.historicalCollectionRatePercent}%`), el('div', { class: 'label' }, t(locale, 'forecast_stat_collection_rate'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(forecast.totalScheduledFutureCollections).toLocaleString()), el('div', { class: 'label' }, t(locale, 'forecast_stat_total_scheduled_future'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(forecast.totalExpectedFutureCollections).toLocaleString()), el('div', { class: 'label' }, t(locale, 'forecast_stat_expected_future'))]),
      ]));
      forecastSlot.appendChild(table(
        [
          { label: t(locale, 'fin_col_month'), key: 'month' },
          { label: t(locale, 'forecast_col_projected_new_bookings'), render: (s) => Number(s.projectedNewBookingsValue).toLocaleString() },
          { label: t(locale, 'forecast_col_scheduled_collections_known'), render: (s) => Number(s.scheduledCollections).toLocaleString() },
          { label: t(locale, 'forecast_col_expected_collections'), render: (s) => Number(s.expectedCollections).toLocaleString() },
        ],
        forecast.series,
        { empty: t(locale, 'forecast_series_empty') },
      ));
    } catch (err) {
      clear(forecastSlot);
      forecastSlot.appendChild(errorBanner(err.message));
    }
  });

  compareBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!compareMonth.value) {
      errorSlot.appendChild(errorBanner(t(locale, 'forecast_err_choose_month')));
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
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.forecastBookingsValue).toLocaleString()), el('div', { class: 'label' }, t(locale, 'forecast_stat_forecast_bookings'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.actualBookingsValue).toLocaleString()), el('div', { class: 'label' }, t(locale, 'forecast_stat_actual_bookings'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, comparison.bookingsVariancePercent === null ? t(locale, 'fin_na') : `${comparison.bookingsVariancePercent}%`), el('div', { class: 'label' }, t(locale, 'forecast_stat_bookings_variance'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.forecastCollections).toLocaleString()), el('div', { class: 'label' }, t(locale, 'forecast_stat_forecast_collections'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, Number(comparison.actualCollections).toLocaleString()), el('div', { class: 'label' }, t(locale, 'forecast_col_actual_collections'))]),
        el('div', { class: 'stat-card' }, [el('div', { class: 'value' }, comparison.collectionsVariancePercent === null ? t(locale, 'fin_na') : `${comparison.collectionsVariancePercent}%`), el('div', { class: 'label' }, t(locale, 'forecast_stat_collections_variance'))]),
      ]));
    } catch (err) {
      clear(compareSlot);
      compareSlot.appendChild(errorBanner(err.message));
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'forecast_filters_heading')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'units_manage_project_field')), projectSelect]),
      el('div', {}, [el('label', {}, t(locale, 'forecast_historical_months_field')), historicalMonths]),
      el('div', {}, [el('label', {}, t(locale, 'forecast_trailing_months_field')), trailingMonths]),
      el('div', {}, [el('label', {}, t(locale, 'forecast_forecast_months_field')), forecastMonths]),
    ]),
    el('div', { class: 'form-actions' }, [generateBtn]),
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'forecast_historical_heading')),
    historicalSlot,
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'forecast_heading')),
    forecastSlot,
  ]));

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'forecast_actual_vs_forecast_heading')),
    el('p', { class: 'page-subtitle' }, t(locale, 'forecast_actual_vs_forecast_subtitle')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'fin_col_month')), compareMonth]),
      el('div', {}, [el('label', {}, t(locale, 'forecast_trailing_months_only_field')), compareTrailing]),
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
