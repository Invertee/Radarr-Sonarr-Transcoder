'use strict';

(() => {
  const states = new WeakMap();
  const pageSizes = [25, 50, 100, 0];
  const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const rowsFor = (table) => Array.from(table.tBodies[0]?.rows || []).filter((row) => !row.querySelector('.empty-cell'));

  function typedValue(cell) {
    const raw = (cell?.dataset.sortValue || cell?.textContent || '').trim();
    const duration = raw.match(/^(\d+):(\d{2}):(\d{2})$/);
    if (duration) return { type: 'number', value: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) };

    const size = raw.match(/^(-?[\d,.]+)\s*(b|kb|mb|gb|tb)$/i);
    if (size) {
      const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
      return { type: 'number', value: Number(size[1].replaceAll(',', '')) * units[size[2].toLowerCase()] };
    }

    const numeric = Number(raw.replaceAll(',', '').replace(/[%#]/g, ''));
    if (raw && Number.isFinite(numeric)) return { type: 'number', value: numeric };

    const date = Date.parse(raw);
    if (raw && Number.isFinite(date) && /[-/:]|\b(?:am|pm)\b/i.test(raw)) return { type: 'number', value: date };
    return { type: 'text', value: text(raw) };
  }

  function compare(left, right, column, direction) {
    const a = typedValue(left.cells[column]);
    const b = typedValue(right.cells[column]);
    const result = a.type === 'number' && b.type === 'number'
      ? a.value - b.value
      : String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: 'base' });
    return result * direction;
  }

  function actionColumn(header, index, total) {
    const label = text(header.textContent);
    return header.classList.contains('actions-column') || label === 'actions' || (!label && index === total - 1);
  }

  function update(table) {
    const state = states.get(table);
    if (!state || state.updating) return;
    state.updating = true;
    try {
      const body = table.tBodies[0];
      let rows = rowsFor(table);

      if (state.sortColumn !== null) {
        const sorted = rows
          .map((row, index) => ({ row, index }))
          .sort((a, b) => compare(a.row, b.row, state.sortColumn, state.sortDirection) || a.index - b.index)
          .map((entry) => entry.row);
        if (sorted.some((row, index) => rows[index] !== row)) {
          sorted.forEach((row) => body.appendChild(row));
        }
        rows = sorted;
      }

      const matching = rows.filter((row) => state.filters.every((filter, index) =>
        !filter || text(row.cells[index]?.textContent).includes(filter)));
      rows.forEach((row) => { row.hidden = true; });
      matching.slice(0, state.pageSize || matching.length).forEach((row) => { row.hidden = false; });

      const visible = state.pageSize ? Math.min(matching.length, state.pageSize) : matching.length;
      state.summary.textContent = matching.length === rows.length
        ? `${visible} of ${rows.length} row${rows.length === 1 ? '' : 's'}`
        : `${visible} of ${matching.length} matching (${rows.length} total)`;
    } finally {
      state.updating = false;
    }
  }

  function schedule(table) {
    const state = states.get(table);
    if (!state || state.queued) return;
    state.queued = true;
    requestAnimationFrame(() => {
      state.queued = false;
      update(table);
    });
  }

  function enhance(table) {
    if (states.has(table) || !table.tHead || !table.tBodies[0]) return;
    const headerRow = table.tHead.rows[0];
    const headers = Array.from(headerRow?.cells || []);
    const wrap = table.closest('.table-wrap');
    if (!headers.length || !wrap) return;

    table.classList.add('enhanced-table');
    const tools = document.createElement('div');
    tools.className = 'table-tools';
    tools.innerHTML = `<span class="table-tools__summary" aria-live="polite">0 rows</span><label class="table-tools__page-size">Rows shown<select aria-label="Rows shown">${pageSizes.map((size) => `<option value="${size}" ${size === 50 ? 'selected' : ''}>${size || 'All'}</option>`).join('')}</select></label>`;
    const scroll = document.createElement('div');
    scroll.className = 'data-table-scroll';
    table.before(scroll);
    scroll.appendChild(table);
    wrap.prepend(tools);

    const filterRow = table.tHead.insertRow(1);
    filterRow.className = 'table-filter-row';
    const inputs = headers.map((header, index) => {
      const cell = document.createElement('th');
      const isAction = actionColumn(header, index, headers.length);
      header.dataset.sortable = String(!isAction);
      header.setAttribute('aria-sort', 'none');
      filterRow.appendChild(cell);
      if (isAction) return null;
      const input = document.createElement('input');
      input.className = 'table-column-filter';
      input.type = 'search';
      input.placeholder = `Filter ${header.textContent.trim() || `column ${index + 1}`}`;
      input.setAttribute('aria-label', input.placeholder);
      cell.appendChild(input);
      return input;
    });

    const state = {
      filters: headers.map(() => ''), pageSize: 50, sortColumn: null, sortDirection: 1,
      summary: tools.querySelector('.table-tools__summary'), updating: false, queued: false
    };
    states.set(table, state);

    headers.forEach((header, index) => {
      if (header.dataset.sortable !== 'true') return;
      header.tabIndex = 0;
      header.setAttribute('role', 'button');
      const sort = () => {
        state.sortDirection = state.sortColumn === index ? state.sortDirection * -1 : 1;
        state.sortColumn = index;
        headers.forEach((item, itemIndex) => item.setAttribute('aria-sort', itemIndex === index ? (state.sortDirection === 1 ? 'ascending' : 'descending') : 'none'));
        update(table);
      };
      header.addEventListener('click', sort);
      header.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sort(); }
      });
    });

    inputs.forEach((input, index) => input?.addEventListener('input', () => {
      state.filters[index] = text(input.value);
      update(table);
    }));
    tools.querySelector('select').addEventListener('change', (event) => {
      state.pageSize = Number(event.target.value);
      update(table);
    });

    new MutationObserver(() => schedule(table)).observe(table.tBodies[0], { childList: true, subtree: true, characterData: true });
    update(table);
  }

  const initialise = () => document.querySelectorAll('.table-wrap table').forEach(enhance);
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', initialise, { once: true })
    : initialise();
})();
