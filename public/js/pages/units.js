import {
  el, clear, table, toast, errorBanner, statusBadge, badge, paginationControls, loadingState, emptyState,
  searchInput, selectInput, contentModal, formModal, tabs, icon, scrollRow, iconToggleButton, popover, field,
} from '../ui.js';
import { t, formatNumber } from '../i18n.js';
import { api } from '../api.js';
import { can, getLocale } from '../state.js';
import { openImportWizard } from '../import-wizard.js';

export async function renderUnits(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, [el('h1', {}, t(locale, 'page_title_units'))]));

  const tabsSlot = el('div');
  const panelSlot = el('div');
  container.appendChild(tabsSlot);
  container.appendChild(panelSlot);

  async function renderPanel(key) {
    clear(panelSlot);
    if (key === 'manage') await renderManageTab(panelSlot, locale);
    else await renderCatalogTab(panelSlot, locale);
  }
  tabsSlot.appendChild(tabs([
    { key: 'catalog', label: t(locale, 'catalog_tab_browse') },
    { key: 'manage', label: t(locale, 'catalog_tab_manage') },
  ], 'catalog', (key) => renderPanel(key)));

  await renderPanel('catalog');
}

// ============================================================
// Catalog tab — the consumer-style browse experience: search,
// developer logos, new/offer banners, filter chips, project
// card grid (favorite/share/compare + map/units toggle).
// ============================================================
async function renderCatalogTab(root, locale) {
  clear(root);

  let q = '';
  let developerId = '';
  let sort = '';
  let minPriceFrom = '';
  let maxPriceTo = '';
  let bedrooms = '';
  let unitType = '';
  let favoritesOnly = false;
  let offset = 0;
  let developers = [];
  let unitTypeOptions = [];
  let compareIds = [];
  const compareCache = new Map();

  const errorSlot = el('div');
  root.appendChild(errorSlot);

  const searchBox = el('div', { class: 'catalog-search-bar' }, [
    icon('search'),
    searchInput(t(locale, 'catalog_search_placeholder'), (value) => { q = value; offset = 0; loadGrid(); }),
  ]);
  root.appendChild(searchBox);

  const devStripSlot = el('div');
  root.appendChild(devStripSlot);

  const bannerSectionSlot = el('div');
  root.appendChild(bannerSectionSlot);

  const toolbarSlot = el('div');
  root.appendChild(toolbarSlot);

  const gridSlot = el('div');
  root.appendChild(gridSlot);

  const paginationSlot = el('div');
  root.appendChild(paginationSlot);

  const compareTraySlot = el('div');
  root.appendChild(compareTraySlot);

  function developerNameOf(p) {
    return developers.find((d) => d.id === p.developerId)?.name;
  }

  async function loadDevelopers() {
    try {
      const page = await api.get('/api/inventory/developers', { limit: 100 });
      developers = page.items;
    } catch (err) {
      // Non-fatal — the grid itself still works without the logo strip.
    }
    renderDevStrip();
  }

  function logoCircle(d) {
    const circle = el('div', { class: 'logo-circle' }, d.name.slice(0, 2).toUpperCase());
    if (d.logoUrl) {
      const img = el('img', { src: d.logoUrl, alt: d.name, onerror: () => img.remove() });
      circle.insertBefore(img, circle.firstChild);
    }
    return circle;
  }

  function renderDevStrip() {
    clear(devStripSlot);
    if (!developers.length) return;
    const items = developers.map((d) => {
      const item = el('div', { class: `dev-logo-item${d.id === developerId ? ' active' : ''}`, role: 'button', tabindex: '0' }, [
        logoCircle(d),
        el('div', { class: 'logo-name' }, d.name),
      ]);
      item.addEventListener('click', () => {
        developerId = developerId === d.id ? '' : d.id;
        offset = 0;
        renderDevStrip();
        loadGrid();
      });
      return item;
    });
    devStripSlot.appendChild(scrollRow(items, { className: 'dev-logo-strip' }));
  }

  function buildBannerCard(p, kind) {
    const card = el('div', { class: `banner-card${kind === 'offer' ? ' offer' : ''}` }, [
      el('div', { class: 'banner-eyebrow' }, kind === 'offer' ? t(locale, 'catalog_offer_badge') : t(locale, 'catalog_new_badge')),
      el('div', { class: 'banner-title' }, p.name),
      el('div', { class: 'banner-cta' }, developerNameOf(p) || p.destination || '—'),
    ]);
    card.addEventListener('click', () => openProjectDetailModal(p, { locale, onSaved: loadGrid }));
    return card;
  }

  async function loadFeatured() {
    clear(bannerSectionSlot);
    try {
      const page = await api.get('/api/inventory/projects', { limit: 50 });
      const all = page.items;
      unitTypeOptions = [...new Set(all.flatMap((p) => p.typeOfUnits || []))].slice(0, 12);
      const newest = [...all].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 6);
      const offers = all.filter((p) => p.cashDiscountPercent).slice(0, 6);
      const banners = [...newest.map((p) => ({ p, kind: 'new' })), ...offers.map((p) => ({ p, kind: 'offer' }))];
      if (!banners.length) return;
      bannerSectionSlot.appendChild(el('div', { class: 'catalog-section-header' }, [el('h3', {}, t(locale, 'catalog_new_projects_title'))]));
      bannerSectionSlot.appendChild(scrollRow(banners.map(({ p, kind }) => buildBannerCard(p, kind))));
    } catch (err) {
      // Banners are decorative — a failure here shouldn't block the grid.
    }
  }

  function sortLabel(value) {
    if (value === 'newest') return t(locale, 'catalog_sort_newest');
    if (value === 'price_asc') return t(locale, 'catalog_sort_price_asc');
    if (value === 'price_desc') return t(locale, 'catalog_sort_price_desc');
    return t(locale, 'catalog_sort');
  }

  function popoverOptionButton(label, active, onClick) {
    const btn = el('button', { class: `filter-chip${active ? ' active' : ''}`, style: 'width:100%;justify-content:flex-start' }, label);
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderToolbar(total) {
    clear(toolbarSlot);
    const count = el('div', { class: 'catalog-count' }, [el('strong', {}, formatNumber(locale, total)), ` ${t(locale, 'catalog_results')}`]);

    const sortTrigger = el('button', { class: `filter-chip${sort ? ' active' : ''}` }, [icon('chevronDown'), sortLabel(sort)]);
    const sortPop = popover(sortTrigger, (close) => [
      popoverOptionButton(t(locale, 'catalog_sort_newest'), sort === 'newest', () => { sort = sort === 'newest' ? '' : 'newest'; offset = 0; close(); loadGrid(); }),
      popoverOptionButton(t(locale, 'catalog_sort_price_asc'), sort === 'price_asc', () => { sort = sort === 'price_asc' ? '' : 'price_asc'; offset = 0; close(); loadGrid(); }),
      popoverOptionButton(t(locale, 'catalog_sort_price_desc'), sort === 'price_desc', () => { sort = sort === 'price_desc' ? '' : 'price_desc'; offset = 0; close(); loadGrid(); }),
    ]);

    const priceTrigger = el('button', { class: `filter-chip${(minPriceFrom || maxPriceTo) ? ' active' : ''}` }, [icon('filter'), t(locale, 'catalog_filter_price')]);
    const pricePop = popover(priceTrigger, (close) => {
      const minInput = el('input', { type: 'number', value: minPriceFrom });
      const maxInput = el('input', { type: 'number', value: maxPriceTo });
      const applyBtn = el('button', { class: 'primary' }, t(locale, 'catalog_apply'));
      applyBtn.addEventListener('click', () => { minPriceFrom = minInput.value; maxPriceTo = maxInput.value; offset = 0; close(); loadGrid(); });
      return [field(t(locale, 'catalog_min_price'), minInput), field(t(locale, 'catalog_max_price'), maxInput), applyBtn];
    });

    const roomsTrigger = el('button', { class: `filter-chip${bedrooms ? ' active' : ''}` }, [icon('filter'), t(locale, 'catalog_filter_rooms')]);
    const roomsPop = popover(roomsTrigger, (close) => {
      const options = ['', '1', '2', '3', '4', '5'];
      return options.map((v) => popoverOptionButton(v === '' ? t(locale, 'catalog_any') : v, bedrooms === v, () => { bedrooms = v; offset = 0; close(); loadGrid(); }));
    });

    const typeTrigger = el('button', { class: `filter-chip${unitType ? ' active' : ''}` }, [icon('filter'), unitType || t(locale, 'catalog_filter_unit_types')]);
    const typePop = popover(typeTrigger, (close) => {
      const options = ['', ...unitTypeOptions];
      if (!options.length) return [el('div', { style: 'font-size:12px;color:var(--text-muted)' }, t(locale, 'common_nothing_here'))];
      return options.map((v) => popoverOptionButton(v === '' ? t(locale, 'catalog_any') : v, unitType === v, () => { unitType = v; offset = 0; close(); loadGrid(); }));
    });

    const favBtn = el('button', { class: `filter-chip${favoritesOnly ? ' active' : ''}` }, [icon(favoritesOnly ? 'heartFilled' : 'heart'), t(locale, 'catalog_filter_favorites_only')]);
    favBtn.addEventListener('click', () => { favoritesOnly = !favoritesOnly; offset = 0; loadGrid(); });

    toolbarSlot.appendChild(el('div', { class: 'catalog-toolbar' }, [
      count,
      el('div', { class: 'filter-chip-bar' }, [sortPop, pricePop, roomsPop, typePop, favBtn]),
    ]));
  }

  function shareText(p, dev) {
    const lines = [p.name];
    if (dev) lines.push(dev.name);
    if (p.destination) lines.push(p.destination);
    if (p.priceFrom || p.priceTo) lines.push(`${t(locale, 'catalog_price_from')} ${formatNumber(locale, p.priceFrom ?? p.priceTo)} ${p.currency || 'EGP'}`);
    return lines.join(' — ');
  }

  function toggleCompare(p, btn) {
    const idx = compareIds.indexOf(p.id);
    if (idx >= 0) {
      compareIds.splice(idx, 1);
    } else {
      if (compareIds.length >= 3) { toast(t(locale, 'catalog_compare_max'), 'error'); return; }
      compareIds.push(p.id);
      compareCache.set(p.id, p);
    }
    btn.classList.toggle('compare-active', compareIds.includes(p.id));
    renderCompareTray();
  }

  function renderCompareTray() {
    clear(compareTraySlot);
    if (!compareIds.length) return;
    const items = compareIds.map((id) => {
      const proj = compareCache.get(id);
      const removeBtn = el('button', { type: 'button' }, icon('close', 'sm'));
      const chip = el('div', { class: 'compare-tray-item' }, [proj?.name || id, removeBtn]);
      removeBtn.addEventListener('click', () => { compareIds = compareIds.filter((x) => x !== id); renderCompareTray(); });
      return chip;
    });
    const viewBtn = el('button', { class: 'primary' }, `${t(locale, 'catalog_compare_view')} (${compareIds.length})`);
    viewBtn.disabled = compareIds.length < 2;
    viewBtn.addEventListener('click', () => openCompareModal());
    compareTraySlot.appendChild(el('div', { class: 'compare-tray' }, [
      el('div', { class: 'compare-tray-items' }, items),
      viewBtn,
    ]));
  }

  async function openCompareModal() {
    const body = el('div', {}, loadingState());
    contentModal(t(locale, 'catalog_compare_title'), body, { wide: true });
    try {
      const details = await Promise.all(compareIds.map((id) => api.get(`/api/inventory/projects/${id}`)));
      clear(body);
      function rowFor(label, fn) {
        return el('tr', {}, [el('th', {}, label), ...details.map((d) => el('td', {}, fn(d)))]);
      }
      const tableEl = el('table', {}, [
        el('thead', {}, el('tr', {}, [el('th', {}, ''), ...details.map((d) => el('th', {}, d.project.name))])),
        el('tbody', {}, [
          rowFor('Developer', (d) => d.developer?.name || '—'),
          rowFor('Destination', (d) => d.project.destination || '—'),
          rowFor('Price', (d) => (d.project.priceFrom || d.project.priceTo) ? `${formatNumber(locale, d.project.priceFrom)} – ${formatNumber(locale, d.project.priceTo)}` : '—'),
          rowFor('BUA (sqm)', (d) => (d.project.buaFromSqm || d.project.buaToSqm) ? `${d.project.buaFromSqm ?? '—'} – ${d.project.buaToSqm ?? '—'}` : '—'),
          rowFor('Finishing', (d) => d.project.finishingType || '—'),
          rowFor('Cash discount', (d) => (d.project.cashDiscountPercent !== undefined ? `${d.project.cashDiscountPercent}%` : '—')),
        ]),
      ]);
      body.appendChild(el('div', { class: 'table-wrap' }, tableEl));
    } catch (err) {
      clear(body);
      body.appendChild(errorBanner(err.message));
    }
  }

  function buildProjectCard(p) {
    const dev = developers.find((d) => d.id === p.developerId);
    const coverUrl = p.coverImageUrl || (p.imageUrls && p.imageUrls[0]);
    const isNew = Date.now() - new Date(p.createdAt).getTime() < 1000 * 60 * 60 * 24 * 30;
    const hasOffer = !!p.cashDiscountPercent;

    const favBtn = iconToggleButton('heart', 'heartFilled', {
      active: !!p.isFavorite,
      ariaLabel: p.isFavorite ? t(locale, 'catalog_favorite_remove') : t(locale, 'catalog_favorite_add'),
      onClick: async () => {
        try {
          if (p.isFavorite) await api.delete(`/api/inventory/projects/${p.id}/favorite`);
          else await api.post(`/api/inventory/projects/${p.id}/favorite`, {});
          p.isFavorite = !p.isFavorite;
          clear(favBtn);
          favBtn.appendChild(icon(p.isFavorite ? 'heartFilled' : 'heart'));
          favBtn.classList.toggle('active', p.isFavorite);
          favBtn.setAttribute('aria-pressed', String(p.isFavorite));
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
        }
      },
    });

    const compareBtn = el('button', { class: `icon-btn${compareIds.includes(p.id) ? ' compare-active' : ''}`, type: 'button', 'aria-label': t(locale, 'catalog_compare') }, icon('compare'));
    compareBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleCompare(p, compareBtn); });

    const shareTrigger = el('button', { class: 'icon-btn', type: 'button', 'aria-label': t(locale, 'catalog_share') }, icon('share'));
    const sharePop = popover(shareTrigger, (close) => {
      const copyBtn = el('button', { style: 'width:100%;justify-content:flex-start' }, t(locale, 'catalog_share_copy_link'));
      copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(shareText(p, dev)); toast(t(locale, 'catalog_link_copied'), 'success'); } catch (err) { /* clipboard may be unavailable — non-fatal */ }
        close();
      });
      const waBtn = el('button', { style: 'width:100%;justify-content:flex-start' }, t(locale, 'catalog_share_whatsapp'));
      waBtn.addEventListener('click', () => {
        window.open(`https://wa.me/?text=${encodeURIComponent(shareText(p, dev))}`, '_blank', 'noopener');
        close();
      });
      return [copyBtn, waBtn];
    });

    const cover = el('div', {
      class: `project-card-cover${coverUrl ? ' has-image' : ''}`,
      style: coverUrl ? `background-image:url('${coverUrl.replace(/'/g, "%27")}')` : '',
    }, [
      el('div', { class: 'project-card-cover-top' }, [
        el('div', { class: 'project-card-badges' }, [
          isNew ? el('span', { class: 'project-card-badge' }, t(locale, 'catalog_new_badge')) : null,
          hasOffer ? el('span', { class: 'project-card-badge offer' }, `${t(locale, 'catalog_offer_badge')} ${p.cashDiscountPercent}%`) : null,
        ]),
        el('div', { class: 'project-card-actions' }, [favBtn, compareBtn, sharePop]),
      ]),
      el('div', { class: 'project-card-cover-bottom' }, [
        el('div', { class: 'project-name' }, p.name),
        dev ? el('div', { class: 'developer-name' }, dev.name) : null,
      ]),
    ]);
    cover.addEventListener('click', (e) => {
      if (e.target.closest('.popover-wrap') || e.target.closest('button')) return;
      openProjectDetailModal(p, { locale, onSaved: loadGrid });
    });

    const priceLine = (p.priceFrom || p.priceTo)
      ? el('div', { class: 'project-card-price' }, [`${t(locale, 'catalog_price_from')} ${formatNumber(locale, p.priceFrom ?? p.priceTo)}`, el('span', { class: 'unit' }, ` ${p.currency || 'EGP'}`)])
      : el('div', { class: 'project-card-price' }, '—');

    const body = el('div', { class: 'project-card-body' }, [
      p.destination ? el('div', { class: 'project-card-location' }, [icon('pin'), p.destination]) : null,
      priceLine,
    ]);

    const footerPanel = el('div');
    const unitsBtn = el('button', { type: 'button' }, [icon('grid'), t(locale, 'catalog_units_view')]);
    const mapBtn = el('button', { type: 'button' }, [icon('mapView'), t(locale, 'catalog_map_view')]);
    let openMode = null;
    async function setMode(mode) {
      if (openMode === mode) {
        openMode = null;
        clear(footerPanel);
        unitsBtn.classList.remove('active');
        mapBtn.classList.remove('active');
        return;
      }
      openMode = mode;
      unitsBtn.classList.toggle('active', mode === 'units');
      mapBtn.classList.toggle('active', mode === 'map');
      clear(footerPanel);
      if (mode === 'map') {
        // Linking out (rather than an <iframe> embed) avoids weakening the
        // app's CSP with a frame-src allowance for a third-party map host.
        if (p.locationLat !== undefined && p.locationLng !== undefined) {
          footerPanel.appendChild(el('div', { class: 'project-card-map-panel' }, el('a', {
            href: `https://www.google.com/maps?q=${p.locationLat},${p.locationLng}`, target: '_blank', rel: 'noopener',
          }, [icon('mapView'), ` ${t(locale, 'catalog_map_view')}`])));
        } else if (p.locationMapUrl) {
          footerPanel.appendChild(el('div', { style: 'padding:12px' }, el('a', { href: p.locationMapUrl, target: '_blank', rel: 'noopener' }, t(locale, 'catalog_map_view'))));
        } else {
          footerPanel.appendChild(el('div', { style: 'padding:12px;color:var(--text-muted);font-size:12px' }, t(locale, 'catalog_no_map')));
        }
      } else {
        footerPanel.appendChild(loadingState());
        try {
          const specs = await api.get(`/api/inventory/projects/${p.id}/unit-specs`);
          clear(footerPanel);
          if (!specs.length) {
            footerPanel.appendChild(el('div', { style: 'padding:12px;color:var(--text-muted);font-size:12px' }, t(locale, 'common_no_records')));
          } else {
            footerPanel.appendChild(table(
              [
                { label: 'Type', key: 'unitType' },
                { label: 'Beds', render: (s) => (s.bedrooms !== undefined && s.bedrooms !== null ? String(s.bedrooms) : '—') },
                { label: 'Price', render: (s) => ((s.priceFrom || s.priceTo) ? `${formatNumber(locale, s.priceFrom)} – ${formatNumber(locale, s.priceTo)}` : '—') },
              ],
              specs.slice(0, 5),
            ));
          }
        } catch (err) {
          clear(footerPanel);
          footerPanel.appendChild(errorBanner(err.message));
        }
      }
    }
    unitsBtn.addEventListener('click', () => setMode('units'));
    mapBtn.addEventListener('click', () => setMode('map'));

    return el('div', { class: 'project-card' }, [cover, body, el('div', { class: 'project-card-footer' }, [unitsBtn, mapBtn]), footerPanel]);
  }

  async function loadGrid() {
    clear(gridSlot);
    gridSlot.appendChild(loadingState());
    clear(paginationSlot);
    try {
      const page = await api.get('/api/inventory/projects', {
        limit: 24,
        offset,
        q,
        developerId: developerId || undefined,
        sort: sort || undefined,
        minPriceFrom: minPriceFrom || undefined,
        maxPriceTo: maxPriceTo || undefined,
        bedrooms: bedrooms || undefined,
        unitType: unitType || undefined,
        favorites: favoritesOnly ? 'true' : undefined,
      });
      renderToolbar(page.total);
      clear(gridSlot);
      if (!page.items.length) {
        gridSlot.appendChild(emptyState({ icon: 'units', title: t(locale, 'catalog_empty_title'), hint: t(locale, 'catalog_empty_hint') }));
      } else {
        gridSlot.appendChild(el('div', { class: 'project-card-grid' }, page.items.map((p) => buildProjectCard(p))));
      }
      paginationSlot.appendChild(paginationControls(page, (next) => { offset = next; loadGrid(); }));
    } catch (err) {
      clear(gridSlot);
      gridSlot.appendChild(errorBanner(err.message));
    }
  }

  await loadDevelopers();
  await loadFeatured();
  await loadGrid();
}

/** Shared read/edit detail modal for a Project — facilities, phases,
 * launches, catalog unit specs, sales phone numbers, and an edit form.
 * Used by both the Catalog tab (card click) and the Manage tab ("Details"
 * button) so this logic lives in exactly one place. */
async function openProjectDetailModal(project, { locale, onSaved } = {}) {
  locale = locale || getLocale();
  const body = el('div', {}, loadingState());
  contentModal(project.name, body, { wide: true });

  async function refresh() {
    clear(body);
    body.appendChild(loadingState());
    let details;
    try {
      details = await api.get(`/api/inventory/projects/${project.id}`);
    } catch (err) {
      clear(body);
      body.appendChild(errorBanner(err.message));
      return;
    }
    let unitSpecs = [];
    try {
      unitSpecs = await api.get(`/api/inventory/projects/${project.id}/unit-specs`);
    } catch (err) {
      // view:project may be absent for this role — the rest of the panel
      // still renders fine without it.
    }

    clear(body);
    const { project: p, developer, phases, launches, facilities, engineeringConsultant, projectManagement, salesPhoneNumbers } = details;

    const editBtn = el('button', {}, t(locale, 'units_project_edit_details_btn'));
    editBtn.addEventListener('click', async () => {
      const values = await formModal({
        title: t(locale, 'units_project_edit_title'),
        fields: [
          { key: 'destination', label: t(locale, 'units_project_field_destination'), value: p.destination || '' },
          { key: 'address', label: t(locale, 'units_project_field_address'), value: p.address || '' },
          { key: 'coverImageUrl', label: t(locale, 'units_project_field_cover_image'), value: p.coverImageUrl || '' },
          { key: 'locationMapUrl', label: t(locale, 'units_project_field_location_map'), value: p.locationMapUrl || '' },
          { key: 'finishingType', label: t(locale, 'units_project_field_finishing_type'), value: p.finishingType || '' },
          { key: 'projectAreaSqm', label: t(locale, 'units_project_field_area'), type: 'number', value: p.projectAreaSqm ?? '' },
          { key: 'priceFrom', label: t(locale, 'units_project_field_price_from'), type: 'number', value: p.priceFrom ?? '' },
          { key: 'priceTo', label: t(locale, 'units_project_field_price_to'), type: 'number', value: p.priceTo ?? '' },
          { key: 'cashDiscountPercent', label: t(locale, 'units_project_field_cash_discount'), type: 'number', value: p.cashDiscountPercent ?? '' },
          { key: 'maintenanceFeePercent', label: t(locale, 'units_project_field_maintenance_fee'), type: 'number', value: p.maintenanceFeePercent ?? '' },
          { key: 'ministerialDecisionNumber', label: t(locale, 'units_project_field_ministerial_decision'), value: p.ministerialDecisionNumber || '' },
        ],
      });
      if (!values) return;
      try {
        await api.patch(`/api/inventory/projects/${project.id}`, {
          destination: values.destination || undefined,
          address: values.address || undefined,
          coverImageUrl: values.coverImageUrl || undefined,
          locationMapUrl: values.locationMapUrl || undefined,
          finishingType: values.finishingType || undefined,
          projectAreaSqm: values.projectAreaSqm ? Number(values.projectAreaSqm) : undefined,
          priceFrom: values.priceFrom ? Number(values.priceFrom) : undefined,
          priceTo: values.priceTo ? Number(values.priceTo) : undefined,
          cashDiscountPercent: values.cashDiscountPercent ? Number(values.cashDiscountPercent) : undefined,
          maintenanceFeePercent: values.maintenanceFeePercent ? Number(values.maintenanceFeePercent) : undefined,
          ministerialDecisionNumber: values.ministerialDecisionNumber || undefined,
        });
        toast(t(locale, 'units_project_saved_toast'), 'success');
        await refresh();
        await onSaved?.();
      } catch (err) {
        body.prepend(errorBanner(err.message));
      }
    });

    const summary = el('div', { class: 'card', style: 'margin-bottom:12px' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [
        el('div', {}, [
          p.destination ? badge(p.destination, 'blue') : null,
          developer ? el('span', { style: 'margin-left:8px' }, `${t(locale, 'units_project_developer_label')} ${developer.name}`) : null,
        ]),
        editBtn,
      ]),
      el('div', { style: 'margin-top:8px;font-size:13px;color:var(--text-muted)' }, [
        p.address ? el('div', {}, `${t(locale, 'units_project_address_label')} ${p.address}`) : null,
        p.locationMapUrl ? el('div', {}, [el('a', { href: p.locationMapUrl, target: '_blank', rel: 'noopener' }, t(locale, 'units_project_view_on_map'))]) : null,
        p.finishingType ? el('div', {}, `${t(locale, 'units_project_finishing_label')} ${p.finishingType}`) : null,
        p.projectAreaSqm ? el('div', {}, `${t(locale, 'units_project_area_label')} ${p.projectAreaSqm} sqm`) : null,
        (p.priceFrom || p.priceTo) ? el('div', {}, `${t(locale, 'units_project_price_range_label')} ${p.priceFrom ? Number(p.priceFrom).toLocaleString() : '—'} – ${p.priceTo ? Number(p.priceTo).toLocaleString() : '—'} ${p.currency || 'EGP'}`) : null,
        p.cashDiscountPercent !== undefined ? el('div', {}, `${t(locale, 'units_project_cash_discount_label')} ${p.cashDiscountPercent}%`) : null,
        p.maintenanceFeePercent !== undefined ? el('div', {}, `${t(locale, 'units_project_maintenance_label')} ${p.maintenanceFeePercent}%`) : null,
        p.ministerialDecisionNumber ? el('div', {}, `${t(locale, 'units_project_ministerial_decision_label')} ${p.ministerialDecisionNumber}`) : null,
        engineeringConsultant ? el('div', {}, `${t(locale, 'units_project_consultant_label')} ${engineeringConsultant.name}`) : null,
        projectManagement ? el('div', {}, `${t(locale, 'units_project_management_label')} ${projectManagement.name}`) : null,
      ]),
    ]);
    body.appendChild(summary);

    // Facilities
    const addFacilityBtn = el('button', {}, t(locale, 'units_project_add_facility_btn'));
    addFacilityBtn.addEventListener('click', async () => {
      const values = await formModal({ title: t(locale, 'units_project_add_facility_title'), fields: [{ key: 'name', label: t(locale, 'units_project_facility_name_field'), placeholder: t(locale, 'units_project_facility_name_placeholder') }] });
      if (!values?.name?.trim()) return;
      try {
        const f = await api.post('/api/inventory/facilities', { name: values.name.trim() });
        await api.patch(`/api/inventory/projects/${project.id}`, { facilityIds: [...(p.facilityIds || []), f.id] });
        toast(t(locale, 'units_project_facility_added_toast'), 'success');
        await refresh();
      } catch (err) {
        body.prepend(errorBanner(err.message));
      }
    });
    body.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [el('h4', { style: 'margin:0' }, t(locale, 'units_project_facilities_title')), addFacilityBtn]),
      el('div', { style: 'margin-top:8px' }, facilities.length ? facilities.map((f) => badge(f.name)) : [el('span', { class: 'muted' }, t(locale, 'units_project_none_yet'))]),
    ]));

    // Phases
    const addPhaseBtn = el('button', {}, t(locale, 'units_project_add_phase_btn'));
    addPhaseBtn.addEventListener('click', async () => {
      const values = await formModal({ title: t(locale, 'units_project_add_phase_title'), fields: [{ key: 'name', label: t(locale, 'units_project_phase_name_field'), placeholder: t(locale, 'units_project_phase_name_placeholder') }] });
      if (!values?.name?.trim()) return;
      try {
        await api.post(`/api/inventory/projects/${project.id}/phases`, { name: values.name.trim(), order: phases.length });
        toast(t(locale, 'units_project_phase_added_toast'), 'success');
        await refresh();
      } catch (err) {
        body.prepend(errorBanner(err.message));
      }
    });
    body.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [el('h4', { style: 'margin:0' }, t(locale, 'units_project_phases_title')), addPhaseBtn]),
      table([{ label: t(locale, 'units_col_name'), key: 'name' }, { label: t(locale, 'units_col_order'), render: (ph) => String(ph.order) }], phases, { empty: t(locale, 'units_project_no_phases') }),
    ]));

    // Launches
    const addLaunchBtn = el('button', {}, t(locale, 'units_project_add_launch_btn'));
    addLaunchBtn.addEventListener('click', async () => {
      const values = await formModal({
        title: t(locale, 'units_project_add_launch_title'),
        fields: [
          { key: 'name', label: t(locale, 'units_project_launch_name_field'), placeholder: t(locale, 'units_project_launch_name_placeholder') },
          { key: 'launchDate', label: t(locale, 'units_project_launch_date_field'), type: 'date' },
          { key: 'notes', label: t(locale, 'units_project_notes_field'), type: 'textarea' },
        ],
      });
      if (!values?.name?.trim()) return;
      try {
        await api.post(`/api/inventory/projects/${project.id}/launches`, { name: values.name.trim(), launchDate: values.launchDate || undefined, notes: values.notes || undefined });
        toast(t(locale, 'units_project_launch_added_toast'), 'success');
        await refresh();
      } catch (err) {
        body.prepend(errorBanner(err.message));
      }
    });
    body.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [el('h4', { style: 'margin:0' }, t(locale, 'units_project_launches_title')), addLaunchBtn]),
      table([{ label: t(locale, 'units_col_name'), key: 'name' }, { label: t(locale, 'units_col_date'), render: (l) => l.launchDate || '—' }], launches, { empty: t(locale, 'units_project_no_launches') }),
    ]));

    // Unit Specs (Catalog) — the project's marketed product ranges (Unit
    // Type + Bedrooms -> BUA/price ranges), populated by a Project
    // Catalog import or added manually; distinct from real, physically
    // coded Units below.
    body.appendChild(el('div', { class: 'card', style: 'margin-bottom:12px' }, [
      el('h4', { style: 'margin:0 0 8px' }, t(locale, 'units_project_unit_specs_title')),
      table(
        [
          { label: t(locale, 'units_col_unit_type'), key: 'unitType' },
          { label: t(locale, 'units_col_bedrooms'), render: (s) => (s.bedrooms !== undefined && s.bedrooms !== null ? String(s.bedrooms) : '—') },
          { label: t(locale, 'units_col_bua'), render: (s) => (s.buaFromSqm || s.buaToSqm ? `${s.buaFromSqm ?? '—'} – ${s.buaToSqm ?? '—'}` : '—') },
          { label: t(locale, 'units_col_price'), render: (s) => (s.priceFrom || s.priceTo ? `${s.priceFrom ? Number(s.priceFrom).toLocaleString() : '—'} – ${s.priceTo ? Number(s.priceTo).toLocaleString() : '—'}` : '—') },
          { label: t(locale, 'units_col_finishing'), render: (s) => s.finishingType || '—' },
        ],
        unitSpecs,
        { empty: t(locale, 'units_project_no_unit_specs') },
      ),
    ]));

    // Sales phone numbers
    const addPhoneBtn = el('button', {}, t(locale, 'units_project_add_phone_btn'));
    addPhoneBtn.addEventListener('click', async () => {
      const values = await formModal({ title: t(locale, 'units_project_add_phone_title'), fields: [{ key: 'phoneNumber', label: t(locale, 'units_project_phone_field'), placeholder: t(locale, 'units_project_phone_placeholder') }] });
      if (!values?.phoneNumber?.trim()) return;
      try {
        await api.post(`/api/inventory/projects/${project.id}/sales-phone-numbers`, { phoneNumber: values.phoneNumber.trim() });
        toast(t(locale, 'units_project_phone_added_toast'), 'success');
        await refresh();
      } catch (err) {
        body.prepend(errorBanner(err.message));
      }
    });
    body.appendChild(el('div', { class: 'card' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [el('h4', { style: 'margin:0' }, t(locale, 'units_project_phones_title')), addPhoneBtn]),
      el('div', { style: 'margin-top:8px' }, salesPhoneNumbers.length ? salesPhoneNumbers.map((s) => badge(s.phoneNumber)) : [el('span', { class: 'muted' }, t(locale, 'units_project_none_yet'))]),
    ]));
  }

  await refresh();
}

// ============================================================
// Manage tab — the existing admin CRUD surface (developers,
// projects, units, import), unchanged from before the catalog
// browser existed.
// ============================================================
async function renderManageTab(container, locale) {
  let offset = 0;
  let q = '';
  let filters = {};
  let projects = [];
  let developers = [];
  const headerActions = el('div');
  container.appendChild(el('div', { style: 'display:flex;justify-content:flex-end;margin-bottom:8px' }, headerActions));
  if (can('unit', 'create')) {
    const importBtn = el('button', {}, t(locale, 'units_manage_import_btn'));
    importBtn.addEventListener('click', () => {
      openImportWizard({
        title: t(locale, 'units_manage_import_btn'),
        uploadPath: '/api/inventory/units/import/upload',
        onImported: () => { load(); loadImportHistory(); },
        uploadOptions: [
          { key: 'fillDownBlankCells', label: 'My file has merged cells — repeat the value above into blank cells (e.g. a Project/Developer name shown once above a block of unit rows)', default: false },
          { key: 'sheetNameAsProject', label: 'Each sheet (tab) in this file is a different project — use the sheet name as the Project (e.g. a sheet named "Stayn" → Project "Stayn")', default: false },
        ],
        mappingOptions: [
          {
            key: 'mode',
            type: 'select',
            label: 'What does this file contain?',
            options: [
              { value: 'availability', label: 'Live Availability — real, individually-coded units (Code / Floor / Price / Status)' },
              { value: 'catalog', label: 'Project Catalog — a market/product range, no unit codes (Developer / Project / Phase / BUA From-To / Price From-To)' },
            ],
            default: 'availability',
          },
          {
            key: 'rangeStrategy',
            type: 'select',
            label: "If a row has a range (e.g. Price From/To or BUA From/To) instead of one value, use:",
            options: [
              { value: 'avg', label: 'Average of From & To' },
              { value: 'from', label: 'The "From" value' },
              { value: 'to', label: 'The "To" value' },
            ],
            default: 'avg',
          },
          { key: 'autoGenerateUnitCode', type: 'checkbox', label: "Auto-generate a unit code for rows that don't have one", default: true },
          { key: 'autoCreateMissingProjects', type: 'checkbox', label: "Automatically create any project named in the file that doesn't exist yet", default: true },
        ],
      });
    });
    headerActions.appendChild(importBtn);
  }
  const errorSlot = el('div');
  container.appendChild(errorSlot);

  // ---- Developers ----
  const developersListSlot = el('div');
  const newDeveloperNameInput = el('input', { type: 'text', placeholder: t(locale, 'units_manage_developer_name_placeholder') });
  const addDeveloperBtn = el('button', {}, t(locale, 'units_manage_add_developer_btn'));
  addDeveloperBtn.addEventListener('click', async () => {
    if (!newDeveloperNameInput.value.trim()) return;
    addDeveloperBtn.disabled = true;
    try {
      await api.post('/api/inventory/developers', { name: newDeveloperNameInput.value.trim() });
      newDeveloperNameInput.value = '';
      toast(t(locale, 'units_manage_developer_added_toast'), 'success');
      await loadDevelopers();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      addDeveloperBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'units_manage_developers_title')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'units_manage_developer_name_field')), newDeveloperNameInput]),
      el('div', { style: 'align-self:flex-end' }, addDeveloperBtn),
    ]),
    developersListSlot,
  ]));

  async function loadDevelopers() {
    clear(developersListSlot);
    try {
      const page = await api.get('/api/inventory/developers', { limit: 50 });
      developers = page.items;
      developersListSlot.appendChild(table(
        [
          { label: t(locale, 'units_col_name'), key: 'name' },
          { label: '', render: (d) => {
            const btn = el('button', {}, t(locale, 'units_manage_portfolio_btn'));
            btn.addEventListener('click', () => viewDeveloperPortfolio(d));
            return btn;
          } },
        ],
        developers,
        { empty: t(locale, 'units_manage_no_developers') },
      ));
    } catch (err) {
      developersListSlot.appendChild(errorBanner(err.message));
    }
  }

  async function viewDeveloperPortfolio(developer) {
    const body = el('div', {}, loadingState());
    contentModal(`${developer.name} — ${t(locale, 'units_manage_portfolio_title')}`, body);
    try {
      const result = await api.get(`/api/inventory/developers/${developer.id}/portfolio`);
      clear(body);
      body.appendChild(table(
        [{ label: t(locale, 'units_col_project'), key: 'name' }, { label: t(locale, 'units_col_destination'), render: (p) => p.destination || '—' }],
        result.projects,
        { empty: t(locale, 'units_manage_no_projects_for_developer') },
      ));
    } catch (err) {
      clear(body);
      body.appendChild(errorBanner(err.message));
    }
  }

  // ---- Projects ----
  const newProjectNameInput = el('input', { type: 'text', placeholder: t(locale, 'units_manage_project_name_placeholder') });
  const newProjectLocationInput = el('input', { type: 'text', placeholder: t(locale, 'units_manage_location_placeholder') });
  const newProjectDestinationInput = el('input', { type: 'text', placeholder: t(locale, 'units_manage_destination_placeholder') });
  const newProjectDeveloperSelect = selectInput([{ value: '', label: t(locale, 'units_manage_none_option') }]);
  const addProjectBtn = el('button', {}, t(locale, 'units_manage_add_project_btn'));
  addProjectBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!newProjectNameInput.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'units_manage_enter_project_name_error')));
      return;
    }
    addProjectBtn.disabled = true;
    try {
      await api.post('/api/inventory/projects', {
        name: newProjectNameInput.value.trim(),
        location: newProjectLocationInput.value.trim() || undefined,
        destination: newProjectDestinationInput.value.trim() || undefined,
        developerId: newProjectDeveloperSelect.value || undefined,
      });
      newProjectNameInput.value = '';
      newProjectLocationInput.value = '';
      newProjectDestinationInput.value = '';
      newProjectDeveloperSelect.value = '';
      toast(t(locale, 'units_manage_project_created_toast'), 'success');
      await loadProjects();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      addProjectBtn.disabled = false;
    }
  });

  const projectsListSlot = el('div');
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'units_manage_projects_title')),
    el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'units_manage_project_name_field')), newProjectNameInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_location_field')), newProjectLocationInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_destination_field')), newProjectDestinationInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_developer_field')), newProjectDeveloperSelect]),
      el('div', { style: 'align-self:flex-end' }, addProjectBtn),
    ]),
    projectsListSlot,
  ]));

  function developerName(id) {
    return developers.find((d) => d.id === id)?.name || '—';
  }

  async function loadProjects() {
    clear(projectsListSlot);
    try {
      const page = await api.get('/api/inventory/projects', { limit: 200 });
      projects = page.items;
      newProjectDeveloperSelect.innerHTML = '';
      newProjectDeveloperSelect.appendChild(el('option', { value: '' }, t(locale, 'units_manage_none_option')));
      developers.forEach((d) => newProjectDeveloperSelect.appendChild(el('option', { value: d.id }, d.name)));
      projectSelect.innerHTML = '';
      projects.forEach((p) => projectSelect.appendChild(el('option', { value: p.id }, p.name)));
      filterDestinationSelect.innerHTML = '';
      filterDestinationSelect.appendChild(el('option', { value: '' }, t(locale, 'units_manage_any_destination_option')));
      [...new Set(projects.map((p) => p.destination).filter(Boolean))].forEach((d) => filterDestinationSelect.appendChild(el('option', { value: d }, d)));

      projectsListSlot.appendChild(table(
        [
          { label: t(locale, 'units_col_name'), key: 'name' },
          { label: t(locale, 'units_col_destination'), render: (p) => p.destination || '—' },
          { label: t(locale, 'units_col_developer'), render: (p) => developerName(p.developerId) },
          { label: '', render: (p) => {
            const btn = el('button', {}, t(locale, 'units_manage_details_btn'));
            btn.addEventListener('click', () => openProjectDetailModal(p, { locale, onSaved: loadProjects }));
            return btn;
          } },
        ],
        page.items,
        { empty: t(locale, 'units_manage_no_projects') },
      ));
    } catch (err) {
      projectsListSlot.appendChild(errorBanner(err.message));
    }
  }

  // ---- Add a unit ----
  const projectSelect = selectInput([]);
  const codeInput = el('input', { type: 'text', placeholder: t(locale, 'units_manage_unit_code_placeholder') });
  const typeInput = el('input', { type: 'text', placeholder: t(locale, 'units_manage_type_placeholder') });
  const areaInput = el('input', { type: 'number', placeholder: t(locale, 'units_manage_area_placeholder') });
  const priceInput = el('input', { type: 'number', placeholder: t(locale, 'units_manage_list_price_placeholder') });
  const bedroomsInput = el('input', { type: 'number', min: '0', placeholder: t(locale, 'units_manage_bedrooms_placeholder') });
  const floorInput = el('input', { type: 'text', placeholder: t(locale, 'units_manage_floor_placeholder') });
  const designTypeInput = el('input', { type: 'text', placeholder: t(locale, 'units_manage_design_type_placeholder') });
  const viewInput = el('input', { type: 'text', placeholder: t(locale, 'units_manage_view_placeholder') });
  const buildingInput = el('input', { type: 'text', placeholder: t(locale, 'units_manage_building_placeholder') });
  const gardenAreaInput = el('input', { type: 'number', min: '0', placeholder: t(locale, 'units_manage_garden_area_placeholder') });
  const finishingInput = el('input', { type: 'text', placeholder: t(locale, 'units_manage_finishing_placeholder') });
  const createBtn = el('button', { class: 'primary' }, t(locale, 'units_manage_add_unit_btn'));

  createBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!projectSelect.value || !codeInput.value.trim() || !typeInput.value.trim() || !(Number(areaInput.value) > 0) || !(Number(priceInput.value) > 0)) {
      errorSlot.appendChild(errorBanner(t(locale, 'units_manage_add_unit_error')));
      return;
    }
    createBtn.disabled = true;
    try {
      await api.post('/api/inventory/units', {
        projectId: projectSelect.value,
        code: codeInput.value.trim(),
        unitType: typeInput.value.trim(),
        areaSqm: Number(areaInput.value),
        listPrice: Number(priceInput.value),
        bedrooms: bedroomsInput.value ? Number(bedroomsInput.value) : undefined,
        floorLabel: floorInput.value.trim() || undefined,
        designType: designTypeInput.value.trim() || undefined,
        view: viewInput.value.trim() ? viewInput.value.split(',').map((v) => v.trim()).filter(Boolean) : undefined,
        buildingLabel: buildingInput.value.trim() || undefined,
        gardenAreaSqm: gardenAreaInput.value ? Number(gardenAreaInput.value) : undefined,
        finishingType: finishingInput.value.trim() || undefined,
      });
      [codeInput, typeInput, areaInput, priceInput, bedroomsInput, floorInput, designTypeInput, viewInput, buildingInput, gardenAreaInput, finishingInput].forEach((i) => (i.value = ''));
      toast(t(locale, 'units_manage_unit_added_toast'), 'success');
      await load();
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createBtn.disabled = false;
    }
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'units_manage_add_unit_title')),
    el('div', { class: 'form-row', style: 'flex-wrap:wrap' }, [
      el('div', {}, [el('label', {}, t(locale, 'units_manage_project_field')), projectSelect]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_unit_code_field')), codeInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_type_field')), typeInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_area_field')), areaInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_list_price_field')), priceInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_bedrooms_field')), bedroomsInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_floor_field')), floorInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_design_type_field')), designTypeInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_view_field')), viewInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_building_field')), buildingInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_garden_area_field')), gardenAreaInput]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_finishing_field')), finishingInput]),
    ]),
    el('div', { class: 'form-actions' }, [createBtn]),
  ]));

  // ---- Search + advanced filters ----
  const search = searchInput(t(locale, 'units_manage_search_placeholder'), (value) => { q = value; offset = 0; load(); });
  const filterMinPrice = el('input', { type: 'number', placeholder: t(locale, 'units_manage_min_price_field') });
  const filterMaxPrice = el('input', { type: 'number', placeholder: t(locale, 'units_manage_max_price_field') });
  const filterMinArea = el('input', { type: 'number', placeholder: t(locale, 'units_manage_min_area_field') });
  const filterMaxArea = el('input', { type: 'number', placeholder: t(locale, 'units_manage_max_area_field') });
  const filterBedrooms = el('input', { type: 'number', min: '0', placeholder: t(locale, 'units_manage_bedrooms_field') });
  const filterFinishing = el('input', { type: 'text', placeholder: t(locale, 'units_manage_finishing_field') });
  const filterDestinationSelect = selectInput([{ value: '', label: t(locale, 'units_manage_any_destination_option') }]);
  const filterStatusSelect = selectInput([
    { value: 'any', label: t(locale, 'units_manage_status_any') },
    { value: 'available', label: t(locale, 'units_manage_status_available') },
    { value: 'held', label: t(locale, 'units_manage_status_held') },
    { value: 'reserved', label: t(locale, 'units_manage_status_reserved') },
    { value: 'contracted', label: t(locale, 'units_manage_status_contracted') },
  ]);
  const applyFiltersBtn = el('button', { class: 'primary' }, t(locale, 'units_manage_apply_filters_btn'));
  const clearFiltersBtn = el('button', {}, t(locale, 'units_manage_clear_filters_btn'));
  applyFiltersBtn.addEventListener('click', () => {
    filters = {
      minPrice: filterMinPrice.value || undefined,
      maxPrice: filterMaxPrice.value || undefined,
      minAreaSqm: filterMinArea.value || undefined,
      maxAreaSqm: filterMaxArea.value || undefined,
      bedrooms: filterBedrooms.value || undefined,
      finishingType: filterFinishing.value || undefined,
      destination: filterDestinationSelect.value || undefined,
      status: filterStatusSelect.value,
    };
    offset = 0;
    load();
  });
  clearFiltersBtn.addEventListener('click', () => {
    [filterMinPrice, filterMaxPrice, filterMinArea, filterMaxArea, filterBedrooms, filterFinishing].forEach((i) => (i.value = ''));
    filterDestinationSelect.value = '';
    filterStatusSelect.value = 'any';
    filters = {};
    offset = 0;
    load();
  });

  container.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'form-row', style: 'max-width:320px' }, [search]),
    el('h4', { style: 'margin:12px 0 6px' }, t(locale, 'units_manage_advanced_filters')),
    el('div', { class: 'form-row', style: 'flex-wrap:wrap' }, [
      el('div', {}, [el('label', {}, t(locale, 'units_manage_min_price_field')), filterMinPrice]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_max_price_field')), filterMaxPrice]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_min_area_field')), filterMinArea]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_max_area_field')), filterMaxArea]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_bedrooms_field')), filterBedrooms]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_finishing_field')), filterFinishing]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_destination_field')), filterDestinationSelect]),
      el('div', {}, [el('label', {}, t(locale, 'units_manage_status_field')), filterStatusSelect]),
      el('div', { style: 'align-self:flex-end;display:flex;gap:6px' }, [applyFiltersBtn, clearFiltersBtn]),
    ]),
  ]));

  const listSlot = el('div');
  container.appendChild(listSlot);

  const importHistorySlot = el('div');
  if (can('unit', 'view')) {
    container.appendChild(el('div', { class: 'card' }, [
      el('h3', { style: 'margin-top:0' }, t(locale, 'units_manage_import_history_title')),
      el('p', { style: 'color:var(--text-muted);font-size:12.5px' }, t(locale, 'units_manage_import_history_hint')),
      importHistorySlot,
    ]));
  }

  async function loadImportHistory() {
    if (!can('unit', 'view')) return;
    clear(importHistorySlot);
    try {
      const sessions = await api.get('/api/imports/history', { targetType: 'inventory_unit' });
      importHistorySlot.appendChild(table(
        [
          { label: t(locale, 'units_col_file'), key: 'fileName' },
          { label: t(locale, 'units_col_type'), render: (s) => s.fileType.toUpperCase() },
          { label: t(locale, 'units_col_rows'), render: (s) => String(s.rawRows.length) },
          { label: t(locale, 'units_col_status'), render: (s) => statusBadge(s.status) },
          { label: t(locale, 'units_col_uploaded'), render: (s) => new Date(s.createdAt).toLocaleString() },
        ],
        sessions,
        { empty: t(locale, 'units_manage_no_imports') },
      ));
    } catch (err) {
      importHistorySlot.appendChild(errorBanner(err.message));
    }
  }

  async function hold(unit, btn) {
    try {
      await api.post(`/api/inventory/units/${unit.id}/hold`, {});
      toast(t(locale, 'units_manage_hold_toast'), 'success');
      await load();
    } catch (err) {
      btn.disabled = false;
      errorSlot.appendChild(errorBanner(err.message));
    }
  }

  function projectName(id) {
    return projects.find((p) => p.id === id)?.name || id;
  }

  async function load() {
    await loadDevelopers();
    await loadProjects();
    clear(listSlot);
    listSlot.appendChild(loadingState());
    try {
      const page = await api.get('/api/inventory/units', { limit: 20, offset, q, ...filters });
      clear(listSlot);
      listSlot.append(table(
        [
          { label: t(locale, 'units_col_code'), key: 'code' },
          { label: t(locale, 'units_col_project'), render: (u) => projectName(u.projectId) },
          { label: t(locale, 'units_col_type'), key: 'unitType' },
          { label: t(locale, 'units_col_beds'), render: (u) => (u.bedrooms !== undefined ? String(u.bedrooms) : '—') },
          { label: t(locale, 'units_col_area'), render: (u) => `${u.areaSqm} m²` },
          { label: t(locale, 'units_col_price'), render: (u) => Number(u.listPrice).toLocaleString() },
          { label: t(locale, 'units_col_finishing'), render: (u) => u.finishingType || '—' },
          { label: t(locale, 'units_col_status'), render: (u) => statusBadge(u.status) },
          { label: '', render: (u) => {
            if (u.status !== 'available') return '';
            const btn = el('button', {}, t(locale, 'units_manage_hold_btn'));
            btn.addEventListener('click', () => {
              btn.disabled = true;
              hold(u, btn);
            });
            return btn;
          } },
        ],
        page.items,
        { empty: t(locale, 'units_manage_no_units') },
      ), paginationControls(page, (next) => { offset = next; load(); }));
    } catch (err) {
      listSlot.appendChild(errorBanner(err.message));
    }
  }

  await load();
  await loadImportHistory();
}
