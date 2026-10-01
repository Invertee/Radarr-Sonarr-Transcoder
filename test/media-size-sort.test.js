'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ConversionEstimates = require('../public/conversion-estimates');

const publicDir = path.join(__dirname, '..', 'public');
const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const asset = (prefix) => index.match(new RegExp(`src="/(${prefix}[^"?]+)`))[1];

for (const [name, render, collection, body, sizeColumn] of [
  ['Radarr movies', 'renderMovies', 'movies', 'moviesBody', 1],
  ['Sonarr episode files', 'renderSonarrFiles', 'sonarrFiles', 'episodesBody', 1],
  ['Sonarr series', 'renderSeries', 'series', 'seriesBody', 2]
]) {
  test(`${name} sort exact sizes across units and pages, independently of estimates`, () => {
    const context = vm.createContext({
      document: { addEventListener() {}, readyState: 'loading' },
      ConversionEstimates
    });
    vm.runInContext(fs.readFileSync(path.join(publicDir, asset('app.')), 'utf8'), context);
    // Include values that display identically after rounding, and the reported MB/GB boundary.
    const sizes = [0, 1022.9 * 1024 ** 2, 5 * 1024 ** 3, 5 * 1024 ** 3 + 1,
      ...Array.from({ length: 56 }, (_, i) => (i + 1) * 1024 ** 3)];
    context.items = sizes.map((sizeBytes, id) => ({
      id, title: `Media ${id}`, sizeBytes, hasFile: sizeBytes > 0, path: `/media/${id}.mkv`,
      durationSeconds: 3600, width: 1920, height: 1080, audioStreams: 1
    }));
    vm.runInContext(`
      state.${collection} = items;
      state.profiles = [{ key: 'test', qp: 24, maxWidth: 1920 }];
      for (const key of ['seriesSearch', 'episodeSearch', 'movieSearch']) elements[key] = { value: '' };
      elements.movieProfile = elements.episodeProfile = { value: 'test' };
      elements.episodeSummary = {};
      elements.${body} = {};
      ${render}();
      globalThis.html = elements.${body}.innerHTML;
    `, context);
    if (collection !== 'series') assert.match(context.html, /Rough output:/);
    const rows = [...context.html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => ({
      cells: [...match[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((cell) => ({
        dataset: { sortValue: cell[1].match(/data-sort-value="([^"]*)"/)?.[1] },
        textContent: cell[2].replace(/<[^>]*>/g, '')
      })),
      querySelector() { return null; },
      hidden: false
    }));
    assert.equal(rows.length, sizes.length);
    assert.deepEqual(rows.map((row) => Number(row.cells[sizeColumn].dataset.sortValue)), sizes);

    // Exercise the production sort/filter/pagination update with rendered cell values.
    const tableBody = { rows, appendChild(row) {
      this.rows.splice(this.rows.indexOf(row), 1);
      this.rows.push(row);
    } };
    const table = { tBodies: [tableBody] };
    const tableState = {
      updating: false, sortColumn: sizeColumn, sortDirection: -1, filters: [], pageSize: 50, page: 1,
      summary: {}, pageLabel: {}, firstButton: {}, previousButton: {}, nextButton: {}, lastButton: {}
    };
    context.table = table;
    context.tableState = tableState;
    vm.runInContext(fs.readFileSync(path.join(publicDir, asset('table-tools.')), 'utf8')
      .replace('const initialise =', 'globalThis.sortTable = () => { states.set(table, tableState); update(table); }; const initialise ='), context);
    const values = () => tableBody.rows.map((row) => Number(row.cells[sizeColumn].dataset.sortValue));
    const visible = () => tableBody.rows.filter((row) => !row.hidden)
      .map((row) => Number(row.cells[sizeColumn].dataset.sortValue));
    const descending = [...sizes].sort((a, b) => b - a);
    context.sortTable();
    assert.deepEqual(values(), descending);
    assert.deepEqual(visible(), descending.slice(0, 50));
    assert.equal(tableState.pageLabel.textContent, 'Page 1 of 2');
    tableState.page = 2;
    context.sortTable();
    assert.deepEqual(visible(), descending.slice(50));
    tableState.sortDirection = 1;
    tableState.page = 1;
    context.sortTable();
    assert.deepEqual(visible(), [...descending].reverse().slice(0, 50));
  });
}
