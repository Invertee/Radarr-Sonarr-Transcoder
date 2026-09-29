'use strict';

(() => {
  const states = new WeakMap();
  const pageSizes = [25, 50, 100, 0];
  const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const rowsFor = (table) => Array.from(table.tBodies[0]?.rows || []).filter((row) => !row.querySelector('.empty-cell'));

  function typedValue(cell) {
    const raw = (cell?.dataset.sortValue || cell?.textContent || '').trim();
    const duration = raw.match(/^(\d+):(\d{2}):(\d{2})$/);
    if (duration) {
      return { type: 'number', value: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) };
    }

    const size = raw.match(/^(-?[\d,.]+)\s*(b|kb|mb|gb|tb)$/i);
    if (size) {
      const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
      return { type: 'number', value: Number(size[1].replaceAll(',', '')) * units[size[2].toLowerCase()] };
    }

    const numeric = Number(raw.replaceAll(',', '').replace(/[%#]/g, ''));
    if (raw && Number.isFinite(numeric)) {
      return { type: 'number', value: numeric };
    }

    const date = Date.parse(raw);
    if (raw && Number.isFinite(date) && /[-/:]|\b(?:am|pm)\b/i.test(raw)) {
      return { type: 'number', value: date };
    }
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
    if (!state || state.updating) {
      return;
    }
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
      const totalPages = state.pageSize ? Math.max(1, Math.ceil(matching.length / state.pageSize)) : 1;
      state.page = Math.min(Math.max(state.page, 1), totalPages);

      const firstIndex = state.pageSize ? (state.page - 1) * state.pageSize : 0;
      const lastIndex = state.pageSize ? Math.min(firstIndex + state.pageSize, matching.length) : matching.length;
      rows.forEach((row) => { row.hidden = true; });
      matching.slice(firstIndex, lastIndex).forEach((row) => { row.hidden = false; });

      if (matching.length === 0) {
        state.summary.textContent = rows.length ? `0 matching (${rows.length} total)` : '0 rows';
      } else {
        state.summary.textContent = matching.length === rows.length
          ? `${firstIndex + 1}-${lastIndex} of ${rows.length} rows`
          : `${firstIndex + 1}-${lastIndex} of ${matching.length} matching (${rows.length} total)`;
      }

      state.pageLabel.textContent = `Page ${state.page} of ${totalPages}`;
      state.firstButton.disabled = state.page <= 1;
      state.previousButton.disabled = state.page <= 1;
      state.nextButton.disabled = state.page >= totalPages;
      state.lastButton.disabled = state.page >= totalPages;
    } finally {
      state.updating = false;
    }
  }

  function schedule(table) {
    const state = states.get(table);
    if (!state || state.queued) {
      return;
    }
    state.queued = true;
    requestAnimationFrame(() => {
      state.queued = false;
      update(table);
    });
  }

  function changePage(table, page) {
    const state = states.get(table);
    if (!state) {
      return;
    }
    state.page = page;
    update(table);
    state.scroll.scrollTop = 0;
  }

  function enhance(table) {
    if (states.has(table) || !table.tHead || !table.tBodies[0]) {
      return;
    }
    const headerRow = table.tHead.rows[0];
    const headers = Array.from(headerRow?.cells || []);
    const wrap = table.closest('.table-wrap');
    if (!headers.length || !wrap) {
      return;
    }

    table.classList.add('enhanced-table');
    const tools = document.createElement('div');
    tools.className = 'table-tools';
    tools.innerHTML = `
      <span class="table-tools__summary" aria-live="polite">0 rows</span>
      <div class="table-tools__controls">
        <nav class="table-pagination" aria-label="Table pages">
          <button type="button" data-page-action="first" aria-label="First page">«</button>
          <button type="button" data-page-action="previous" aria-label="Previous page">‹</button>
          <span class="table-pagination__label" aria-live="polite">Page 1 of 1</span>
          <button type="button" data-page-action="next" aria-label="Next page">›</button>
          <button type="button" data-page-action="last" aria-label="Last page">»</button>
        </nav>
        <label class="table-tools__page-size">Rows per page<select aria-label="Rows per page">${pageSizes.map((size) => `<option value="${size}" ${size === 50 ? 'selected' : ''}>${size || 'All'}</option>`).join('')}</select></label>
      </div>
    `;
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
      if (isAction) {
        return null;
      }
      const input = document.createElement('input');
      input.className = 'table-column-filter';
      input.type = 'search';
      input.placeholder = `Filter ${header.textContent.trim() || `column ${index + 1}`}`;
      input.setAttribute('aria-label', input.placeholder);
      cell.appendChild(input);
      return input;
    });

    const state = {
      filters: headers.map(() => ''),
      pageSize: 50,
      page: 1,
      sortColumn: null,
      sortDirection: 1,
      summary: tools.querySelector('.table-tools__summary'),
      pageLabel: tools.querySelector('.table-pagination__label'),
      firstButton: tools.querySelector('[data-page-action="first"]'),
      previousButton: tools.querySelector('[data-page-action="previous"]'),
      nextButton: tools.querySelector('[data-page-action="next"]'),
      lastButton: tools.querySelector('[data-page-action="last"]'),
      scroll,
      updating: false,
      queued: false
    };
    states.set(table, state);

    headers.forEach((header, index) => {
      if (header.dataset.sortable !== 'true') {
        return;
      }
      header.tabIndex = 0;
      header.setAttribute('role', 'button');
      const sort = () => {
        state.sortDirection = state.sortColumn === index ? state.sortDirection * -1 : 1;
        state.sortColumn = index;
        state.page = 1;
        headers.forEach((item, itemIndex) => item.setAttribute(
          'aria-sort',
          itemIndex === index ? (state.sortDirection === 1 ? 'ascending' : 'descending') : 'none'
        ));
        update(table);
        scroll.scrollTop = 0;
      };
      header.addEventListener('click', sort);
      header.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          sort();
        }
      });
    });

    inputs.forEach((input, index) => input?.addEventListener('input', () => {
      state.filters[index] = text(input.value);
      state.page = 1;
      update(table);
      scroll.scrollTop = 0;
    }));

    tools.querySelector('.table-tools__page-size select').addEventListener('change', (event) => {
      state.pageSize = Number(event.target.value);
      state.page = 1;
      update(table);
      scroll.scrollTop = 0;
    });

    state.firstButton.addEventListener('click', () => changePage(table, 1));
    state.previousButton.addEventListener('click', () => changePage(table, state.page - 1));
    state.nextButton.addEventListener('click', () => changePage(table, state.page + 1));
    state.lastButton.addEventListener('click', () => {
      const matchingCount = rowsFor(table).filter((row) => state.filters.every((filter, index) =>
        !filter || text(row.cells[index]?.textContent).includes(filter))).length;
      const lastPage = state.pageSize ? Math.max(1, Math.ceil(matchingCount / state.pageSize)) : 1;
      changePage(table, lastPage);
    });

    new MutationObserver(() => schedule(table)).observe(table.tBodies[0], {
      childList: true,
      subtree: true,
      characterData: true
    });
    update(table);
  }

  const initialise = () => document.querySelectorAll('.table-wrap table').forEach(enhance);
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', initialise, { once: true })
    : initialise();
})();
