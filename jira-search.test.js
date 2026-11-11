const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const jira = require('./jira-search');
const server = require('./server');
const EMPTY_METRICS = path.join(os.tmpdir(), `sds-metrics-empty-${process.pid}.json`);

const FILTERS = { user: 'Ada', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10'] };
const RANGE_18_22 = { timeFrom: '18:00', timeTo: '22:00' };
const RANGE_18_19 = { timeFrom: '18:00', timeTo: '19:00' };

function issue(key, extra) {
  const author = !Object.prototype.hasOwnProperty.call(extra, 'author')
    ? { displayName: 'Ada' }
    : (extra.author && typeof extra.author === 'object'
      ? extra.author
      : (extra.author ? { displayName: extra.author } : null));
  return {
    key,
    fields: {
      summary: extra.summary || key,
      status: { name: extra.status || 'To Do' },
      assignee: { displayName: extra.assignee || 'Ada' },
      updated: extra.updated,
      ...(extra.fieldsExtra || {})
    },
    changelog: {
      histories: extra.history === null ? [] : (extra.histories || [{
        created: extra.at,
        author,
        items: extra.items || [{ field: extra.field || 'status', fromString: extra.from, toString: extra.to }]
      }])
    }
  };
}

async function testJql() {
  const jql = jira.buildSearchJql({
    user: 'Ada "Silva"',
    timeFrom: '18:00',
    timeTo: '19:00',
    days: ['2026-11-11', '2026-11-10']
  });
  assert.equal(jql.includes('assignee ='), false);
  assert.ok(jql.includes('status changed BY "Ada \\"Silva\\"" DURING ('));
  assert.ok(jql.includes('2026/11/10 18:00'));
  assert.ok(jql.includes('2026/11/10 18:59'));
  assert.ok(jql.includes('2026/11/11 18:00'));
  assert.ok(jql.indexOf('2026/11/10') < jql.indexOf('2026/11/11'));
  assert.equal(jira.JIRA_FIELDS.join(','), 'summary,status,assignee,updated');
  assert.throws(() => jira.assertSearchInput({ user: 'Ada', timeFrom: '19:00', timeTo: '18:00', days: ['2026-11-10'] }), /depois do inicial/);
  assert.throws(() => jira.assertSearchInput({ user: 'Ada\nSilva', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10'] }), /inválido/);
}

async function testWindowsAndMoves() {
  const inside = jira.zonedParts('2026-11-10T21:30:00.000Z');
  assert.equal(inside.date, '2026-11-10');
  assert.equal(inside.minutes, 18 * 60 + 30);
  assert.equal(jira.instantInWindows('2026-11-10T22:00:00.000Z', [{ date: '2026-11-10', start: 18 * 60, end: 19 * 60 }]), false);
  assert.equal(jira.statusMoveKind('Request', 'To Do'), 'todo');
  assert.equal(jira.statusMoveKind('Request', 'To-Do'), 'todo');
  assert.equal(jira.statusMoveKind('Request', 'Clarificação'), 'clarification');
  assert.equal(jira.statusMoveKind('To Do', 'Request'), '');
  assert.equal(jira.statusMoveKind('Request [ 16705 ]', 'To do [ 10000 ]'), 'todo');
  assert.equal(jira.statusMoveKind('Original: Request [ 16705 ]\tNew: To do [ 10000 ]', ''), 'todo');
  assert.equal(jira.statusMoveKind('Original: Request [ 16705 ] New: Clarification [ 10001 ]', ''), 'clarification');

  const rows = jira.buildRows([
    issue('LC-1', { from: 'Request', to: 'To Do', at: '2026-11-10T18:15:00.000-0300', updated: '2026-11-10T18:15:00.000-0300', summary: 'Um' }),
    issue('LC-2', { from: 'Request', to: 'Clarification', at: '2026-11-10T18:40:00.000-0300', updated: '2026-11-10T18:40:00.000-0300', summary: 'Dois' }),
    issue('LC-3', { from: 'Request', to: 'Done', at: '2026-11-10T18:20:00.000-0300', updated: '2026-11-10T18:20:00.000-0300', summary: 'Três' }),
    issue('LC-4', { from: 'Request', to: 'To Do', at: '2026-11-10T22:10:00.000-0300', updated: '2026-11-10T22:10:00.000-0300', summary: 'Fora' }),
    issue('LC-5', { from: 'Request [ 16705 ]', to: 'To do [ 10000 ]', at: '2026-11-10T18:12:00.000-0300', updated: '2026-11-10T18:12:00.000-0300', author: 'Bruno', summary: 'De outro' }),
    issue('LC-6', { from: 'Original: Request [ 16705 ]\tNew: Clarification [ 10001 ]', to: '', at: '2026-11-10T18:30:00.000-0300', updated: '2026-11-10T18:30:00.000-0300', author: 'Ada Silva', summary: 'Texto cru' })
  ], FILTERS);
  assert.equal(rows.dropped, 3);
  assert.deepEqual(rows.rows.map(row => row.key), ['LC-1', 'LC-2', 'LC-6']);
  assert.deepEqual(jira.filterByTransition(rows.rows, 'todo').map(row => row.key), ['LC-1']);
  assert.deepEqual(jira.filterByTransition(rows.rows, 'clarification').map(row => row.key), ['LC-2', 'LC-6']);
  assert.equal(jira.filterByTransition(rows.rows, 'all').length, 3);
  const listed = jira.countMoves(rows.rows);
  assert.equal(listed.all, listed.todo + listed.clarification);
  assert.equal(listed.todo, 1);
  assert.equal(listed.clarification, 2);
  assert.match(rows.rows[0].moveText, /Request → To Do/);
  assert.match(rows.rows[0].moveText, /18:15/);
  assert.equal(rows.rows[0].moveText.includes('Ada'), false);
  assert.equal(rows.rows[0].payload.statusChanges[0].from, 'Request');
  const bracket = jira.buildRows([
    issue('LC-7', { from: 'Request [ 16705 ]', to: 'To do [ 10000 ]', at: '2026-11-10T18:18:00.000-0300', updated: '2026-11-10T18:18:00.000-0300', summary: 'Colchete' })
  ], FILTERS);
  assert.deepEqual(jira.filterByTransition(bracket.rows, 'todo').map(row => row.key), ['LC-7']);
  assert.equal(jira.filterByTransition(bracket.rows, 'clarification').length, 0);
  assert.match(bracket.rows[0].moveText, /Request → To do/);
  assert.equal(bracket.rows[0].moveText.includes('16705'), false);
  assert.equal(bracket.rows[0].payload.statusChanges[0].to, 'To do');

  const named = jira.buildRows([
    issue('LC-8', { from: 'Request [ 16705 ]', to: 'To do [ 10000 ]', at: '2026-11-10T18:10:00.000+0000', updated: '2026-11-10T18:10:00.000+0000', author: 'Adelino Souza', summary: 'Fuso' }),
    issue('LC-9', { from: 'Request', to: 'To Do', at: '2026-11-10T18:12:00.000-0300', updated: '2026-11-10T18:12:00.000-0300', author: 'Ade', summary: 'Curto' }),
    issue('LC-10', { from: 'Request', to: 'To Do', at: '2026-11-10T18:14:00.000-0300', updated: '2026-11-10T18:14:00.000-0300', author: null, summary: 'Sem autor' }),
    issue('LC-11', { field: 'summary', from: 'A', to: 'B', at: '2026-11-10T18:16:00.000-0300', updated: '2026-11-10T18:16:00.000-0300', summary: 'Não é status' })
  ], { user: 'Ade', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10'] });
  assert.deepEqual(named.rows.map(row => row.key), ['LC-8', 'LC-9']);
  assert.equal(named.rows[0].kinds.includes('todo'), true);
  assert.equal(named.rows[0].moveText.includes('16705'), false);
  assert.equal(named.rows[0].moveText.includes('Adelino'), false);
  assert.match(named.rows[0].moveText, /Request → To do/);

  const five = Array.from({ length: 5 }, (_, index) => issue(`LC-2${index}`, {
    from: 'Original: Request [ 16705 ]\tNew: To do [ 10000 ]',
    to: '',
    at: '2026-11-10T18:20:00.000Z',
    updated: '2026-11-10T18:20:00.000Z',
    author: 'Adelino Souza',
    summary: `Item ${index}`
  }));
  const kept = jira.buildRows(five, { user: 'Ade', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10'] });
  assert.equal(kept.dropped, 0);
  assert.equal(kept.rows.length, 5);
  const other = jira.buildRows(five, { user: 'Bruno', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10'] });
  assert.equal(other.rows.length, 0);
  assert.equal(other.dropped, 5);

  const mixed = jira.buildRows([
    issue('LC-12', {
      summary: 'Misto',
      updated: '2026-11-10T18:45:00.000-0300',
      histories: [
        {
          created: '2026-11-10T18:15:00.000-0300',
          author: { displayName: 'Adelino Souza' },
          items: [{ field: 'status', fromString: 'Request [ 16705 ]', toString: 'To do [ 10000 ]' }]
        },
        {
          created: '2026-11-10T18:45:00.000-0300',
          author: { displayName: 'Bruno Costa' },
          items: [{ field: 'status', fromString: 'To do', toString: 'Done' }]
        }
      ]
    })
  ], { user: 'Ade', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10'] });
  assert.deepEqual(mixed.rows.map(row => row.key), ['LC-12']);
  assert.match(mixed.rows[0].moveText, /Request → To do/);
  assert.match(mixed.rows[0].moveText, /18:15/);
  assert.equal(mixed.rows[0].moveText.includes('18:45'), false);
  assert.equal(mixed.rows[0].moveText.includes('Done'), false);
  assert.equal(mixed.rows[0].moveText.includes('Bruno'), false);
  assert.equal(mixed.rows[0].moveText.includes('Adelino'), false);
  assert.equal(mixed.rows[0].corrected, false);

  const day = '2026-11-10T';
  const corrected = jira.buildRows([
    issue('LC-40', {
      summary: 'Corrigido',
      updated: `${day}18:40:00.000-0300`,
      fieldsExtra: { COE_subsidiaries: 'Chile' },
      histories: [
        { created: `${day}18:40:00.000-0300`, author: { displayName: 'Ada' }, items: [{ field: 'status', fromString: 'Request', toString: 'To do' }] },
        { created: `${day}18:20:00.000-0300`, author: { displayName: 'Bruno Costa' }, items: [{ field: 'status', fromString: 'Clarification', toString: 'Request' }] },
        { created: `${day}18:05:00.000-0300`, author: { displayName: 'Ada' }, items: [{ field: 'status', fromString: 'Request', toString: 'Clarification' }] }
      ]
    }),
    issue('LC-41', {
      summary: 'Sem volta',
      updated: `${day}18:40:00.000-0300`,
      histories: [
        { created: `${day}18:05:00.000-0300`, author: { displayName: 'Ada' }, items: [{ field: 'status', fromString: 'Request', toString: 'Clarification' }] },
        { created: `${day}18:40:00.000-0300`, author: { displayName: 'Ada' }, items: [{ field: 'status', fromString: 'Request', toString: 'To do' }] }
      ]
    }),
    issue('LC-42', {
      summary: 'Volta fora da faixa',
      updated: `${day}18:40:00.000-0300`,
      histories: [
        { created: `${day}18:05:00.000-0300`, author: { displayName: 'Ada' }, items: [{ field: 'status', fromString: 'Request', toString: 'Clarification' }] },
        { created: `${day}17:20:00.000-0300`, author: { displayName: 'Bruno Costa' }, items: [{ field: 'status', fromString: 'Clarification', toString: 'Request' }] },
        { created: `${day}18:40:00.000-0300`, author: { displayName: 'Ada' }, items: [{ field: 'status', fromString: 'Request', toString: 'To do' }] }
      ]
    }),
    issue('LC-43', {
      summary: 'To do de outro',
      updated: `${day}18:40:00.000-0300`,
      histories: [
        { created: `${day}18:05:00.000-0300`, author: { displayName: 'Ada' }, items: [{ field: 'status', fromString: 'Request', toString: 'Clarification' }] },
        { created: `${day}18:20:00.000-0300`, author: { displayName: 'Bruno Costa' }, items: [{ field: 'status', fromString: 'Clarification', toString: 'Request' }] },
        { created: `${day}18:40:00.000-0300`, author: { displayName: 'Bruno Costa' }, items: [{ field: 'status', fromString: 'Request', toString: 'To do' }] }
      ]
    })
  ], { user: 'Ada', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10'] });
  const fixed = corrected.rows.find(row => row.key === 'LC-40');
  assert.equal(fixed.corrected, true);
  assert.equal(fixed.subsidiary, 'Chile');
  assert.equal(fixed.moveText.includes('Clarification → Request'), false);
  assert.equal(corrected.rows.find(row => row.key === 'LC-41').corrected, false);
  assert.equal(corrected.rows.find(row => row.key === 'LC-42').corrected, false);
  assert.equal(corrected.rows.find(row => row.key === 'LC-43').corrected, false);
  assert.equal(jira.countMoves([fixed]).todo, 1);
  assert.equal(jira.countMoves([fixed]).clarification, 1);
  const mixedMetrics = jira.metricsForRows(mixed.rows, 'Ade', 'all', RANGE_18_19);
  assert.equal(mixedMetrics.tickets, 1);
  assert.deepEqual(mixedMetrics.hours, [1]);
  assert.deepEqual(mixedMetrics.bands.map(band => band.label), ['18h–19h']);
  const foreign = jira.metricsForRows([{
    key: 'LC-12',
    payload: {
      statusChanges: [
        { from: 'Request', to: 'To do', at: '2026-11-10T18:15:00.000-0300', author: 'Adelino Souza' },
        { from: 'To do', to: 'Done', at: '2026-11-10T18:45:00.000-0300', author: 'Bruno Costa' }
      ]
    }
  }], 'Ade', 'all', RANGE_18_22);
  assert.equal(foreign.tickets, 1);
  assert.equal(foreign.hours[0], 1);

  const twice = {
    key: 'LC-30',
    payload: {
      statusChanges: [
        { from: 'Request', to: 'To do', at: '2026-11-10T18:15:00.000-0300' },
        { from: 'Request', to: 'To do', at: '2026-11-10T18:40:00.000-0300' }
      ]
    }
  };
  const metrics = jira.metricsForRows([
    twice,
    { key: 'LC-31', payload: { statusChanges: [{ from: 'Request', to: 'To do', at: '2026-11-10T21:05:00.000-0300' }] } },
    { key: 'LC-32', payload: { statusChanges: [{ from: 'Request', to: 'To do', at: '2026-11-11T18:10:00.000-0300' }] } },
    { key: 'LC-33', payload: { statusChanges: [{ from: 'Request', to: 'To do', at: '2026-11-10T22:00:00.000-0300' }] } },
    { key: 'LC-34', payload: { statusChanges: [{ from: 'Request', to: 'To do', at: '2026-11-10T15:20:00.000-0300' }] } }
  ], '', 'all', RANGE_18_22);
  assert.deepEqual(metrics.weekdays, [0, 3, 1, 0, 0, 0, 0]);
  assert.deepEqual(metrics.hours, [3, 0, 0, 1]);
  assert.equal(metrics.tickets, 4);
  assert.equal(metrics.weekdays.reduce((sum, count) => sum + count, 0), metrics.hours.reduce((sum, count) => sum + count, 0));

  const both = jira.buildRows([
    issue('LC-40', {
      summary: 'Dois tipos',
      updated: '2026-11-10T18:40:00.000-0300',
      histories: [
        {
          created: '2026-11-10T18:10:00.000-0300',
          author: { displayName: 'Adelino Souza' },
          items: [{ field: 'status', fromString: 'Request', toString: 'To do' }]
        },
        {
          created: '2026-11-10T18:40:00.000-0300',
          author: { displayName: 'Adelino Souza' },
          items: [{ field: 'status', fromString: 'Request', toString: 'Clarification' }]
        },
        {
          created: '2026-11-10T18:50:00.000-0300',
          author: { displayName: 'Bruno Souza', emailAddress: 'ade.costa@example.com' },
          items: [{ field: 'status', fromString: 'Request', toString: 'Done' }]
        }
      ]
    }),
    issue('LC-41', { from: 'Request', to: 'Done', at: '2026-11-10T18:20:00.000-0300', author: 'Adelino Souza', summary: 'Outro destino' })
  ], { user: 'Adelino Souza', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10'] });
  assert.deepEqual(both.rows.map(row => row.key), ['LC-40']);
  assert.equal(both.rows[0].moveText.includes('Done'), false);
  assert.equal(both.rows[0].moveText.includes('Bruno'), false);
  const moveCounts = jira.countMoves(both.rows);
  assert.equal(moveCounts.all, 2);
  assert.equal(moveCounts.todo, 1);
  assert.equal(moveCounts.clarification, 1);
  assert.equal(moveCounts.todo + moveCounts.clarification, moveCounts.all);
  const todoOnly = jira.metricsForRows(both.rows, 'Adelino Souza', 'todo', RANGE_18_19);
  const clarOnly = jira.metricsForRows(both.rows, 'Adelino Souza', 'clarification', RANGE_18_19);
  const bothMetrics = jira.metricsForRows(both.rows, 'Adelino Souza', 'all', RANGE_18_19);
  assert.equal(todoOnly.tickets, moveCounts.todo);
  assert.equal(clarOnly.tickets, moveCounts.clarification);
  assert.equal(bothMetrics.tickets, moveCounts.all);
  assert.equal(todoOnly.weekdays.reduce((sum, count) => sum + count, 0), todoOnly.hours.reduce((sum, count) => sum + count, 0));

  const utc = jira.buildRows([
    issue('LC-50', {
      from: 'Request',
      to: 'To do',
      at: '2026-11-10T18:10:00.000+0000',
      updated: '2026-11-10T18:10:00.000+0000',
      author: { displayName: 'A. Souza', name: 'adelino.souza', key: 'adelino.souza' },
      summary: 'UTC'
    })
  ], { user: 'Ade', timeFrom: '18:00', timeTo: '22:00', days: ['2026-11-10'] });
  assert.equal(utc.rows.length, 1);
  const utcMetrics = jira.metricsForRows(utc.rows, 'Ade', 'todo', RANGE_18_22);
  assert.equal(utcMetrics.tickets, 1);
  assert.equal(utcMetrics.hours[0], 1);
  assert.equal(utcMetrics.tickets, jira.countMoves(utc.rows).todo);
  assert.equal(utcMetrics.weekdays.reduce((sum, count) => sum + count, 0), utcMetrics.hours.reduce((sum, count) => sum + count, 0));

  const split = jira.metricsForRows([{
    key: 'LC-40',
    payload: {
      statusChanges: [
        { from: 'Request', to: 'To do', at: '2026-11-10T18:10:00.000-0300', author: 'Adelino Souza', kind: 'todo' },
        { from: 'Request', to: 'Clarification', at: '2026-11-10T21:10:00.000-0300', author: 'Adelino Souza', kind: 'clarification' },
        { from: 'Request', to: 'Done', at: '2026-11-10T22:00:00.000-0300', author: 'Adelino Souza', kind: '' }
      ]
    }
  }], 'Adelino Souza', 'all', RANGE_18_22);
  assert.deepEqual(split.hours, [1, 0, 0, 1]);
  assert.equal(split.weekdays.reduce((sum, count) => sum + count, 0), 2);
  assert.equal(split.hours.reduce((sum, count) => sum + count, 0), 2);

  const late = jira.metricsForRows([{
    payload: {
      statusChanges: [
        { from: 'Request', to: 'To do', at: '2026-11-10T22:10:00.000-0300', kind: 'todo', subsidiary: 'Brasil' },
        { from: 'Request', to: 'Clarification', at: '2026-11-10T21:10:00.000-0300', kind: 'clarification', subsidiary: 'Chile' }
      ]
    }
  }], '', 'all', { timeFrom: '21:00', timeTo: '23:00' });
  assert.deepEqual(late.bands.map(band => band.label), ['21h–22h', '22h–23h']);
  assert.deepEqual(late.hours, [1, 1]);
  assert.equal(late.tickets, 2);
  assert.equal(late.subsidiaries.find(rec => rec.name === 'Brasil').bands[1], 1);
  assert.equal(late.weekdays.reduce((sum, count) => sum + count, 0), late.hours.reduce((sum, count) => sum + count, 0));
  assert.deepEqual(jira.hourBands('18:30', '20:15').map(band => band.label), ['18h30–19h', '19h–20h', '20h–20h15']);
  assert.equal(jira.subsidiaryFieldId([
    { id: 'customfield_10001', name: 'Other' },
    { id: 'customfield_10234', name: 'COE_subsidiaries' }
  ]), 'customfield_10234');

  const owned = issue('LC-70', {
    from: 'Request',
    to: 'To do',
    at: '2026-11-10T18:20:00.000-0300',
    updated: '2026-11-10T18:20:00.000-0300',
    summary: 'Brasil'
  });
  owned.fields.customfield_10234 = { value: 'Brasil' };
  const withSub = jira.buildRows([owned], { ...FILTERS, subsidiaryField: 'customfield_10234' });
  assert.equal(withSub.rows[0].subsidiary, 'Brasil');
  assert.equal(withSub.rows[0].payload.statusChanges[0].subsidiary, 'Brasil');
  const subMetrics = jira.metricsForRows(withSub.rows, 'Ada', 'all', RANGE_18_19);
  assert.equal(subMetrics.subsidiaries[0].name, 'Brasil');
  assert.equal(subMetrics.subsidiaries[0].days[1], 1);
  assert.equal(subMetrics.subsidiaries[0].bands[0], 1);

  const later = jira.metricsForRows([{
    key: 'LC-80',
    payload: {
      statusChanges: [
        { from: 'Request', to: 'Clarification', at: '2026-11-10T18:10:00.000-0300', kind: 'clarification', subsidiary: 'Brasil' },
        { from: 'Request', to: 'To do', at: '2026-11-10T19:40:00.000-0300', kind: 'todo', subsidiary: 'Brasil' }
      ]
    }
  }], '', 'all', { timeFrom: '18:00', timeTo: '20:00' });
  assert.deepEqual(later.hours, [1, 1]);
  assert.equal(later.tickets, 2);
  assert.equal(later.subsidiaries[0].bands[0], 1);
  assert.equal(later.subsidiaries[0].bands[1], 1);
  assert.equal(later.weekdays.reduce((sum, count) => sum + count, 0), later.hours.reduce((sum, count) => sum + count, 0));
  const tied = jira.metricLeaders(later);
  assert.equal(tied.nightSubsidiary, 'Brasil');
  assert.equal(tied.busiestBand, '18h–19h, 19h–20h');

  const evening = jira.metricsForRows([{
    key: 'LC-81',
    payload: {
      statusChanges: [
        { from: 'Request', to: 'To do', at: '2026-11-10T17:10:00.000-0300', kind: 'todo', subsidiary: 'Chile' },
        { from: 'Request', to: 'Clarification', at: '2026-11-10T17:40:00.000-0300', kind: 'clarification', subsidiary: 'Chile' },
        { from: 'Request', to: 'To do', at: '2026-11-10T18:20:00.000-0300', kind: 'todo', subsidiary: 'Brasil' }
      ]
    }
  }], '', 'all', { timeFrom: '17:00', timeTo: '19:00' });
  const leaders = jira.metricLeaders(evening);
  assert.equal(evening.tickets, 3);
  assert.equal(leaders.nightSubsidiary, 'Brasil');
  assert.equal(leaders.busiestBand, '17h–18h');
  assert.equal(jira.metricLeaders({ bands: [], hours: [], subsidiaries: [] }).nightSubsidiary, 'Nenhum');
  assert.equal(jira.metricLeaders({ bands: [], hours: [], subsidiaries: [] }).busiestBand, 'Nenhum');
}

async function testPaging() {
  const pages = [
    { startAt: 0, issues: Array.from({ length: 50 }, (_, i) => ({ key: `LC-${i}`, fields: {} })) },
    { startAt: 50, issues: Array.from({ length: 50 }, (_, i) => ({ key: `LC-${i + 50}`, fields: {} })) },
    { startAt: 100, issues: Array.from({ length: 20 }, (_, i) => ({ key: `LC-${i + 100}`, fields: {} })) }
  ];
  const calls = [];
  const collected = await jira.collectIssues(body => {
    calls.push(body);
    const page = pages.find(item => item.startAt === body.startAt);
    return { total: 120, issues: page.issues };
  }, 'project = LC');
  assert.equal(collected.issues.length, 120);
  assert.equal(collected.total, 120);
  assert.equal(collected.truncated, false);
  assert.deepEqual(calls.map(call => call.startAt), [0, 50, 100]);
  assert.ok(calls.every(call => call.maxResults === 50 && call.expand === undefined));
  assert.deepEqual(calls[0].fields, jira.JIRA_FIELDS);

  const once = [];
  const stopped = await jira.collectIssues(body => {
    once.push(body.startAt);
    return { total: 50, issues: Array.from({ length: 50 }, (_, i) => ({ key: `A-${i}`, fields: {} })) };
  }, 'x');
  assert.deepEqual(once, [0]);
  assert.equal(stopped.issues.length, 50);

  let tries = 0;
  const plain = await jira.collectIssues(body => {
    tries += 1;
    assert.equal(body.expand, undefined);
    return { total: 1, issues: [{ key: 'LC-9', fields: {} }] };
  }, 'x');
  assert.equal(tries, 1);
  assert.equal(plain.changelog, false);
  assert.equal(plain.issues[0].key, 'LC-9');

  let loops = 0;
  const dupes = await jira.collectIssues(() => {
    loops += 1;
    if (loops > 5) throw new Error('paginação repetiu a mesma página');
    return { total: 200, issues: Array.from({ length: 50 }, () => ({ key: 'LC-1', fields: {} })) };
  }, 'x');
  assert.equal(dupes.issues.length, 1);
  assert.equal(loops, 2);
}

function requestOnce(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: body ? { 'Content-Type': 'application/json' } : {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function listen(handler) {
  return new Promise(resolve => {
    const app = http.createServer(handler);
    app.listen(0, '127.0.0.1', () => resolve({ app, port: app.address().port }));
  });
}

async function testHttp() {
  const saved = {
    JIRA_URL: process.env.JIRA_URL,
    BEARER_TOKEN: process.env.BEARER_TOKEN
  };
  const calls = [];
  const token = 'local-test-token';
  process.env.JIRA_URL = 'http://jira.example/jira';
  delete process.env.JIRA_USER;
  delete process.env.JIRA_API_TOKEN;
  process.env.BEARER_TOKEN = token;
  const sample = issue('LC-7', {
    from: 'Request',
    to: 'To Do',
    at: '2026-11-10T18:05:00.000-0300',
    updated: '2026-11-10T18:05:00.000-0300',
    summary: 'Portal'
  });
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method, redirect: options.redirect, headers: options.headers, body: options.body });
    const href = String(url);
    if (href.endsWith('/rest/api/2/field')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          { id: 'customfield_10001', name: 'Other' },
          { id: 'customfield_10234', name: 'COE_subsidiaries' }
        ])
      };
    }
    if (href.includes('/changelog')) {
      return { ok: false, status: 404, text: async () => 'HTTP 404 Not Found' };
    }
    if (options.method === 'GET' && /\/rest\/api\/2\/issue\/LC-7\?expand=changelog$/.test(href)) {
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, undefined);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ key: 'LC-7', changelog: { histories: sample.changelog.histories } })
      };
    }
    if (!href.endsWith('/rest/api/2/search') || options.method !== 'POST') {
      throw new Error(`caminho inesperado ${options.method} ${url}`);
    }
    const payload = JSON.parse(options.body);
    assert.equal(payload.maxResults, 50);
    assert.equal(payload.expand, undefined);
    assert.equal(options.body.includes(token), false);
    const bare = { ...sample };
    delete bare.changelog;
    bare.fields = { ...bare.fields, customfield_10234: { value: 'Brasil' } };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ total: 1, issues: [bare] })
    };
  };
  const { app, port } = await listen(server.createHandler({ fetchImpl, metricsPath: EMPTY_METRICS }));
  try {
    const missing = await requestOnce(port, 'POST', '/api/jira/search', JSON.stringify({ user: '', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10'] }));
    assert.equal(missing.status, 400);
    assert.match(missing.body, /usuário/);
    assert.equal(missing.body.includes(token), false);

    const ok = await requestOnce(port, 'POST', '/api/jira/search', JSON.stringify(FILTERS));
    assert.equal(ok.status, 200);
    const data = JSON.parse(ok.body);
    assert.equal(data.issues[0].key, 'LC-7');
    assert.equal(data.issues[0].summary, 'Portal');
    assert.equal(data.issues[0].status, 'To Do');
    assert.equal(data.issues[0].assignee, 'Ada');
    assert.match(data.issues[0].moveText, /Request → To Do/);
    assert.equal(data.issues[0].url, 'http://jira.example/jira/browse/LC-7');
    assert.equal(ok.body.includes(token), false);
    assert.equal(data.total, 1);
    assert.equal(data.fetched, 1);
    assert.equal(data.matched, 1);
    assert.equal(data.subsidiaryField, 'customfield_10234');
    assert.equal(data.issues[0].subsidiary, 'Brasil');
    assert.equal(calls.length, 3);
    assert.equal(calls[0].method, 'GET');
    assert.equal(String(calls[0].url), 'http://jira.example/jira/rest/api/2/field');
    assert.equal(calls[1].redirect, 'error');
    assert.equal(calls[1].headers.Authorization, `Bearer ${token}`);
    assert.equal(String(calls[1].url), 'http://jira.example/jira/rest/api/2/search');
    assert.ok(JSON.parse(calls[1].body).fields.includes('customfield_10234'));
    assert.equal(calls[2].method, 'GET');
    assert.match(String(calls[2].url), /\/rest\/api\/2\/issue\/LC-7\?expand=changelog$/);
    assert.equal(String(calls[1].url).includes('/changelog'), false);

    const deniedFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ errorMessages: [`bad ${token}`] })
    });
    const deniedApp = await listen(server.createHandler({ fetchImpl: deniedFetch, metricsPath: EMPTY_METRICS }));
    try {
      const denied = await requestOnce(deniedApp.port, 'POST', '/api/jira/search', JSON.stringify(FILTERS));
      assert.equal(denied.status, 401);
      assert.match(denied.body, /recusou o acesso/);
      assert.equal(denied.body.includes(token), false);
    } finally {
      await new Promise(resolve => deniedApp.app.close(resolve));
    }

    delete process.env.BEARER_TOKEN;
    const unconfigured = await requestOnce(port, 'POST', '/api/jira/search', JSON.stringify(FILTERS));
    assert.equal(unconfigured.status, 503);
    assert.match(unconfigured.body, /JIRA_URL/);
    assert.match(unconfigured.body, /BEARER_TOKEN/);
    assert.equal(/JIRA_USER|JIRA_API_TOKEN/.test(unconfigured.body), false);

    const hidden = await requestOnce(port, 'GET', '/.env');
    assert.equal(hidden.status, 404);
    const page = await requestOnce(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.body, /Relatório semanal/);
    assert.match(page.body, /id="rpDays"/);
    assert.match(page.body, /Anotações/);
    assert.equal(page.body.includes('id="rpPasteCard"'), false);
    assert.equal(page.body.includes('id="rpReport"'), false);
    assert.equal(page.body.includes('Tickets triados por faixa'), false);
    assert.equal(page.body.includes('COE_subsidiaries por dia'), false);
    assert.match(page.body, /value="Chile"/);
    assert.match(page.body, /value="Peru"/);
    assert.match(page.body, /value="Colombia"/);
    assert.match(page.body, /value="Mexico"/);
    assert.equal(/data-rp-guide|Report v2/.test(page.body), false);
    const wrong = await requestOnce(port, 'PUT', '/api/jira/search', '{}');
    assert.equal(wrong.status, 405);

    const mismatch = Array.from({ length: 5 }, (_, index) => {
      const row = issue(`LC-4${index}`, {
        from: 'Request',
        to: 'To Do',
        at: '2026-11-10T22:10:00.000-0300',
        updated: '2026-11-10T22:10:00.000-0300',
        author: 'Bruno',
        summary: `Fora ${index}`
      });
      const bare = { ...row };
      delete bare.changelog;
      bare.history = row.changelog.histories;
      return bare;
    });
    const mismatchFetch = async (url, options) => {
      const href = String(url);
      if (href.endsWith('/rest/api/2/field')) {
        return { ok: true, status: 200, text: async () => '[]' };
      }
      if (href.includes('/changelog')) {
        return { ok: false, status: 404, text: async () => 'HTTP 404 Not Found' };
      }
      if (options.method === 'GET') {
        const key = href.match(/\/issue\/(LC-4\d)\?expand=changelog$/);
        const found = mismatch.find(row => row.key === (key && key[1]));
        return { ok: true, status: 200, text: async () => JSON.stringify({ changelog: { histories: found.history } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ total: 5, issues: mismatch }) };
    };
    process.env.BEARER_TOKEN = token;
    const mismatchApp = await listen(server.createHandler({ fetchImpl: mismatchFetch, metricsPath: EMPTY_METRICS }));
    try {
      const empty = await requestOnce(mismatchApp.port, 'POST', '/api/jira/search', JSON.stringify(FILTERS));
      assert.equal(empty.status, 200);
      const emptyData = JSON.parse(empty.body);
      assert.equal(emptyData.total, 0);
      assert.equal(emptyData.fetched, 0);
      assert.equal(emptyData.matched, 0);
      assert.equal(emptyData.issues.length, 0);
      assert.equal(/"fetched"\s*:\s*5|foram alterados|devolveu/.test(empty.body), false);
    } finally {
      await new Promise(resolve => mismatchApp.app.close(resolve));
    }

    const badFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: `The number of change history items requested exceeds the limit ${token}` })
    });
    const badApp = await listen(server.createHandler({ fetchImpl: badFetch, metricsPath: EMPTY_METRICS }));
    try {
      const bad = await requestOnce(badApp.port, 'POST', '/api/jira/search', JSON.stringify(FILTERS));
      assert.equal(bad.status, 400);
      assert.match(bad.body, /change history items/);
      assert.equal(/O Jira respondeu 400/.test(bad.body), false);
      assert.equal(bad.body.includes(token), false);
    } finally {
      await new Promise(resolve => badApp.app.close(resolve));
    }

    const rawFetch = async () => ({
      ok: false,
      status: 400,
      text: async () => 'not-json: error in the JQL query'
    });
    const rawApp = await listen(server.createHandler({ fetchImpl: rawFetch, metricsPath: EMPTY_METRICS }));
    try {
      const raw = await requestOnce(rawApp.port, 'POST', '/api/jira/search', JSON.stringify(FILTERS));
      assert.equal(raw.status, 400);
      assert.match(raw.body, /error in the JQL query/);
    } finally {
      await new Promise(resolve => rawApp.app.close(resolve));
    }
  } finally {
    await new Promise(resolve => app.close(resolve));
    ['JIRA_URL', 'BEARER_TOKEN'].forEach(key => {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
}

async function testSavedDays() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sds-metrics-'));
  const metricsPath = path.join(dir, 'report-v2-metrics.json');
  const savedEnv = { JIRA_URL: process.env.JIRA_URL, BEARER_TOKEN: process.env.BEARER_TOKEN };
  const token = 'local-test-token';
  process.env.JIRA_URL = 'http://jira.example/jira';
  process.env.BEARER_TOKEN = token;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ method: options.method, body: options.body || '' });
    return { ok: true, status: 200, text: async () => JSON.stringify({ total: 0, issues: [] }) };
  };
  const counts = {
    all: { weekdays: [0, 5, 0, 0, 0, 0, 0], hours: [5, 0, 0, 0], tickets: 5 },
    todo: { weekdays: [0, 4, 0, 0, 0, 0, 0], hours: [4, 0, 0, 0], tickets: 4 },
    clarification: { weekdays: [0, 1, 0, 0, 0, 0, 0], hours: [1, 0, 0, 0], tickets: 1 }
  };
  const { app, port } = await listen(server.createHandler({ fetchImpl, metricsPath }));
  try {
    const save = await requestOnce(port, 'POST', '/api/jira/metrics', JSON.stringify({
      date: '2026-11-10', user: 'Ada', counts, bearer: token
    }));
    assert.equal(save.status, 200);
    const file = fs.readFileSync(metricsPath, 'utf8');
    assert.equal(file.includes(token), false);
    assert.equal(file.includes('bearer'), false);
    const listed = JSON.parse((await requestOnce(port, 'GET', '/api/jira/metrics')).body);
    assert.equal(listed.days.length, 1);
    assert.equal(listed.days[0].date, '2026-11-10');
    assert.equal(listed.days[0].counts.all.tickets, 5);
    assert.equal(listed.days[0].user, 'Ada');

    const mixed = JSON.parse((await requestOnce(port, 'POST', '/api/jira/search', JSON.stringify({
      user: 'Ada', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10', '2026-11-11']
    }))).body);
    assert.deepEqual(mixed.queried, ['2026-11-11']);
    assert.equal(mixed.saved[0].date, '2026-11-10');
    const firstPosts = calls.filter(call => call.method === 'POST');
    assert.equal(firstPosts.length, 1);
    assert.equal(JSON.parse(firstPosts[0].body).jql.includes('2026/11/10'), false);
    assert.equal(JSON.parse(firstPosts[0].body).jql.includes('2026/11/11'), true);

    const again = JSON.parse((await requestOnce(port, 'POST', '/api/jira/search', JSON.stringify({
      user: 'ada', timeFrom: '18:00', timeTo: '22:00', days: ['2026-11-10']
    }))).body);
    assert.deepEqual(again.queried, []);
    assert.equal(again.issues.length, 0);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);

    const other = JSON.parse((await requestOnce(port, 'POST', '/api/jira/search', JSON.stringify({
      user: 'Bruno', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10']
    }))).body);
    assert.deepEqual(other.queried, ['2026-11-10']);
    const posts = calls.filter(call => call.method === 'POST');
    assert.equal(posts.length, 2);
    assert.equal(JSON.parse(posts[1].body).jql.includes('2026/11/10'), true);

    const bad = await requestOnce(port, 'POST', '/api/jira/metrics', JSON.stringify({ date: 'ontem', user: 'Ada', counts }));
    assert.equal(bad.status, 400);

    const missingDay = await requestOnce(port, 'POST', '/api/jira/notes', JSON.stringify({
      title: 'Plantão', description: 'Fila da noite', subsidiaries: ['Chile']
    }));
    assert.equal(missingDay.status, 400);
    const note = await requestOnce(port, 'POST', '/api/jira/notes', JSON.stringify({
      date: '2026-11-10',
      title: 'Plantão',
      description: 'Fila da noite',
      subsidiaries: ['Mexico', 'Chile'],
      bearer: token
    }));
    assert.equal(note.status, 200);
    assert.equal(note.body.includes(token), false);
    assert.equal(JSON.parse(note.body).note.date, '2026-11-10');
    assert.deepEqual(JSON.parse(note.body).note.subsidiaries, ['Chile', 'Mexico']);
    const afterNote = JSON.parse((await requestOnce(port, 'GET', '/api/jira/metrics')).body);
    assert.equal(afterNote.notes.length, 1);
    assert.equal(afterNote.notes[0].title, 'Plantão');
    assert.equal(afterNote.notes[0].date, '2026-11-10');
    assert.equal(afterNote.days.length, 1);
    assert.equal(afterNote.days.some(day => day.date === '2026-11-10'), true);
    const dayAgain = await requestOnce(port, 'POST', '/api/jira/metrics', JSON.stringify({
      date: '2026-11-12', user: 'Ada', counts
    }));
    assert.equal(dayAgain.status, 200);
    const both = JSON.parse((await requestOnce(port, 'GET', '/api/jira/metrics')).body);
    assert.equal(both.days.length, 2);
    assert.equal(both.notes.length, 1);
    assert.equal(both.notes[0].description, 'Fila da noite');
    assert.equal(both.notes[0].date, '2026-11-10');
    assert.equal(both.days.some(day => day.date === '2026-11-10'), true);
    const disk = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
    assert.equal(disk.notes.length, 1);
    assert.equal(disk.days.length, 2);
    assert.equal(disk.notes[0].title, 'Plantão');
    assert.equal(disk.notes[0].date, '2026-11-10');
    const rejected = await requestOnce(port, 'POST', '/api/jira/notes', JSON.stringify({
      title: 'Segredo', description: token, subsidiaries: ['Peru']
    }));
    assert.equal(rejected.status, 400);
    const unknown = await requestOnce(port, 'POST', '/api/jira/notes', JSON.stringify({
      title: 'Outro', description: 'Brasil não entra', subsidiaries: ['Brasil']
    }));
    assert.equal(unknown.status, 400);
    const stored = fs.readFileSync(metricsPath, 'utf8');
    assert.equal(stored.includes(token), false);
    assert.equal(stored.includes('Brasil'), false);
    assert.equal(JSON.parse(stored).notes.length, 1);

    const hidden = await requestOnce(port, 'GET', '/data/report-v2-metrics.json');
    assert.equal(hidden.status, 404);
  } finally {
    await new Promise(resolve => app.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    ['JIRA_URL', 'BEARER_TOKEN'].forEach(key => {
      if (savedEnv[key] == null) delete process.env[key];
      else process.env[key] = savedEnv[key];
    });
  }
}

function testSources() {
  const files = ['server.js', 'jira-search.js', 'jira-ui.js', 'index.html'];
  const src = files.map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
  assert.match(src, /\/rest\/api\/2\/issue\//);
  assert.match(src, /searchParams\.set\('expand', 'changelog'\)/);
  assert.equal(/\/rest\/api\/2\/issue\/[^'"`\s]*\/changelog/.test(src), false);
  const ui = fs.readFileSync(path.join(__dirname, 'jira-ui.js'), 'utf8');
  assert.equal(ui.includes('rpBars'), false);
  assert.equal(ui.includes('rpMatrixChart'), false);
  assert.match(ui, /Todas Subs/);
  assert.match(ui, /\['Chile', 'Peru', 'Colombia', 'Mexico'\]/);
  assert.equal(ui.includes('Salvar este dia'), false);
  assert.equal(ui.includes('Quantidade de tickets por dia no horário'), false);
  assert.equal(ui.includes('Quantidade de tickets por Subs em cada faixa de horário'), false);
  assert.equal(/<svg class="rp-chart"/.test(ui), false);
  assert.equal(src.includes('foram alterados'), false);
  assert.equal(src.includes('O Jira devolveu'), false);
  assert.equal(/\btransitions\b/.test(src), false);
  assert.equal(/\/rest\/api\/2\/comment/.test(src), false);
  assert.equal(/method:\s*'PUT'/.test(src), false);
  assert.equal(/method:\s*'DELETE'/.test(src), false);
  const example = fs.readFileSync(path.join(__dirname, '.env.example'), 'utf8');
  assert.match(example, /^JIRA_URL=$/m);
  assert.match(example, /^BEARER_TOKEN=$/m);
  assert.equal(/JIRA_USER|JIRA_API_TOKEN|Basic /.test(example + '\n' + src), false);
  const local = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  assert.equal(local.includes('local-test-token'), false);
  assert.match(local, /^BEARER_TOKEN=$/m);
  assert.equal(/JIRA_USER|JIRA_API_TOKEN/.test(local), false);
}

async function main() {
  await testJql();
  await testWindowsAndMoves();
  await testPaging();
  await testHttp();
  await testSavedDays();
  testSources();
  console.log('jira search tests ok');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
