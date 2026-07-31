'use strict';

(() => {
  const PAGE_SIZES = [25, 50, 100, 0];
  const tableStates = new WeakMap();

  function normalise(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function parseDuration(value) {
    const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})$/);
    if (!match) {
      return null;
    }
    return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
  }

  function parseSize(value) {
    const match = String(value).trim().match(/^(-?[\d,.]+)\s*(b|kb|mb|gb|tb)$/i);
    if (!match) {
      return null;
    }
    const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
    return Number(match[1].replaceAll(',', '')) * units[match[2].toLowerCase()];
  }

  function sortableValue(cell) {
    const raw = cell?.dataset.sortValue || cell?.textContent || '';
    const text = raw.trim();
    const duration = parseDuration(text);
    if (duration !== null) {
      return { type: 'number', value: duration };
    }
    const size = parseSize(text);
    if (size !== null) {
      return { type: 'number', value: size };
    }
    const numeric = Number(text.replaceAll(',', '').replace(/[%#]/g, ''));
    if (text && Number.isFinite(numeric)) {
      return { type: 'number', value: numeric };
    }
    const date = Date.parse(text);
    if (text && Number.isFinite(date) && /[-/:]|\b(?:am|pm)\b/i.test(text)) {
      return { type: 'number', value: date };
    }
    return { type: 'text', value: normalise(text) };
  }

  function compareRows(left, right, column, direction) {
    const a = sortableValue(left.cells[column]);
    const b = sortableValue(right.cells[column]);
    let result;
    if (a.type === 'number' && b.type === 'number') {
      result = a.value - b.value;
    } else {
      result = String(a.value).localeCompare(String(b.value), undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    }
    return result * direction;
  }

  function isActionColumn(header, index, total) {
    const label = normalise(header.textContent);
    return header.classList.contains('actions-column') || label === 'actions' || (!label && index === total - 1);
  }

  function getDataRows(table) {
    return Array.from(table.tBodies[0]?.rows || []).filter((row) => !row.querySelector('.empty-cell'));
  }

  function updateTable(table) {
    const state = tableStates.get(table);
    if (!state || state.updating) {
      return;
    }
    state.updating = true;

    try {
      const body = table.tBodies[0];
      if (!body) {
        return;
      }

      let rows = getDataRows(table);
      if (state.sortColumn !== null) {
        rows = rows
          .map((row, index) => ({ row, index }))
          .sort((left, right) => compareRows(left.row, right.row, state.sortColumn, state.sortDirection) || left.index - right.index)
          .map((entry) => entry.row);
        rows.forEach((row) => body.appendChild(row));
      }

      const matchingRows = rows.filter((row) => state.filters.every((filter, index) => {
        if (!filter) {
          return true;
        }
        return normalise(row.cells[index]?.textContent).includes(filter);
      }));

      const pageSize = state.pageSize;
      rows.forEach((row) => { row.hidden = true; });
      matchingRows.slice(0, pageSize || matchingRows.length).forEach((row) => { row.hidden = false; });

      const visible = pageSize ? Math.min(matchingRows.length, pageSize) : matchingRows.length;
      state.summary.textContent = matchingRows.length === rows.length
        ? `${visible} of ${rows.length} row${rows.length === 1 ? '' : 's'}`
        : `${visible} of ${matchingRows.length} matching (${rows.length} total)`;
    } finally {
      state.updating = false;
    }
  }

  function scheduleUpdate(table) {
    const state = tableStates.get(table);
    if (!state || state.updateQueued) {
      return;
    }
    state.updateQueued = true;
    window.requestAnimationFrame(() => {
      state.updateQueued = false;
      updateTable(table);
    });
  }

  function enhanceTable(table, tableIndex) {
    if (tableStates.has(table) || !table.tHead || !table.tBodies[0]) {
      return;
    }

    const headerRow = table.tHead.rows[0];
    if (!headerRow) {
      return;
    }

    const headers = Array.from(headerRow.cells);
    const wrap = table.closest('.table-wrap');
    if (!wrap) {
      return;
    }

    table.classList.add('enhanced-table');
    table.dataset.tableIndex = String(tableIndex);

    const tools = document.createElement('div');
    tools.className = 'table-tools';
    tools.innerHTML = `
      <span class="table-tools__summary" aria-live="polite">0 rows</span>
      <label class="table-tools__page-size">
        Rows shown
        <select aria-label="Rows shown">
          ${PAGE_SIZES.map((size) => `<option value="${size}" ${size === 50 ? 'selected' : ''}>${size || 'All'}</option>`).join('')}
        </select>
      </label>
    `;

    const scroll = document.createElement('div');
    scroll.className = 'data-table-scroll';
    table.before(scroll);
    scroll.appendChild(table);
    wrap.prepend(tools);

    const filterRow = table.tHead.insertRow(1);
    filterRow.className = 'table-filter-row';
    const filters = headers.map((header, index) => {
      const filterCell = document.createElement('th');
      const actionColumn = isActionColumn(header, index, headers.length);
      header.dataset.sortable = actionColumn ? 'false' : 'true';
      header.setAttribute('aria-sort', 'none');

      if (actionColumn) {
        filterCell.setAttribute('aria-hidden', 'true');
        filterRow.appendChild(filterCell);
        return null;
      }

      const input = document.createElement('input');
      input.className = 'table-column-filter';
      input.type = 'search';
      input.placeholder = `Filter ${header.textContent.trim() || `column ${index + 1}`}`;
      input.setAttribute('aria-label', input.placeholder);
      filterCell.appendChild(input);
      filterRow.appendChild(filterCell);
      return input;
    });

    const state = {
      filters: headers.map(() => ''),
      pageSize: 50,
      sortColumn: null,
      sortDirection: 1,
      summary: tools.querySelector('.table-tools__summary'),
      updating: false,
      updateQueued: false
    };
    tableStates.set(table, state);

    headers.forEach((header, index) => {
      if (header.dataset.sortable !== 'true') {
        return;
      }
      header.tabIndex = 0;
      header.setAttribute('role', 'button');
      const sort = () => {
        if (state.sortColumn === index) {
          state.sortDirection *= -1;
        } else {
          state.sortColumn = index;
          state.sortDirection = 1;
        }
        headers.forEach((item, headerIndex) => {
          item.setAttribute('aria-sort', headerIndex === state.sortColumn
            ? (state.sortDirection === 1 ? 'ascending' : 'descending')
            : 'none');
        });
        updateTable(table);
      };
      header.addEventListener('click', sort);
      header.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          sort();
        }
      });
    });

    filters.forEach((input, index) => {
      input?.addEventListener('input', () => {
        state.filters[index] = normalise(input.value);
        updateTable(table);
      });
    });

    tools.querySelector('select').addEventListener('change', (event) => {
      state.pageSize = Number(event.target.value);
      updateTable(table);
    });

    const observer = new MutationObserver(() => scheduleUpdate(table));
    observer.observe(table.tBodies[0], { childList: true, subtree: true, characterData: true });
    updateTable(table);
  }

  function initialise() {
    document.querySelectorAll('.table-wrap table').forEach((table, index) => enhanceTable(table, index));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialise, { once: true });
  } else {
    initialise();
  }
})();
