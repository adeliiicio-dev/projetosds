const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const jira = require('./jira-search');
const server = require('./server');

const FILTERS = { user: 'Ada', timeFrom: '18:00', timeTo: '19:00', days: ['2026-11-10'] };

function issue(key, extra) {
  return {
    key,
    fields: {
      summary: extra.summary || key,
      status: { name: extra.status || 'To Do' },
      assignee: { displayName: extra.assignee || 'Ada' },
      updated: extra.updated
    },
    changelog: {
      histories: extra.history === null ? [] : [{
        created: extra.at,
        author: { displayName: extra.author || 'Ada' },
        items: [{ field: 'status', fromString: extra.from, toString: extra.to }]
      }]
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
  assert.ok(jql.includes('assignee = "Ada \\"Silva\\""'));
  assert.ok(jql.includes('status changed BY "Ada \\"Silva\\""'));
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

  const rows = jira.buildRows([
    issue('LC-1', { from: 'Request', to: 'To Do', at: '2026-11-10T18:15:00.000-0300', updated: '2026-11-10T18:15:00.000-0300', summary: 'Um' }),
    issue('LC-2', { from: 'Request', to: 'Clarification', at: '2026-11-10T18:40:00.000-0300', updated: '2026-11-10T18:40:00.000-0300', summary: 'Dois' }),
    issue('LC-3', { from: 'Request', to: 'Done', at: '2026-11-10T18:20:00.000-0300', updated: '2026-11-10T18:20:00.000-0300', summary: 'Três' }),
    issue('LC-4', { from: 'Request', to: 'To Do', at: '2026-11-10T22:10:00.000-0300', updated: '2026-11-10T22:10:00.000-0300', summary: 'Fora' })
  ], FILTERS);
  assert.equal(rows.dropped, 1);
  assert.deepEqual(rows.rows.map(row => row.key), ['LC-1', 'LC-2', 'LC-3']);
  assert.deepEqual(jira.filterByTransition(rows.rows, 'todo').map(row => row.key), ['LC-1']);
  assert.deepEqual(jira.filterByTransition(rows.rows, 'clarification').map(row => row.key), ['LC-2']);
  assert.equal(jira.filterByTransition(rows.rows, 'all').length, 3);
  assert.match(rows.rows[0].moveText, /Request → To Do/);
  assert.match(rows.rows[0].moveText, /18:15/);
  assert.equal(rows.rows[0].payload.statusChanges[0].from, 'Request');
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
  assert.ok(calls.every(call => call.maxResults === 50 && call.expand === 'changelog'));
  assert.deepEqual(calls[0].fields, jira.JIRA_FIELDS);

  const once = [];
  const stopped = await jira.collectIssues(body => {
    once.push(body.startAt);
    return { total: 50, issues: Array.from({ length: 50 }, (_, i) => ({ key: `A-${i}`, fields: {} })) };
  }, 'x');
  assert.deepEqual(once, [0]);
  assert.equal(stopped.issues.length, 50);

  let tries = 0;
  const retried = await jira.collectIssues(body => {
    tries += 1;
    if (body.expand) {
      const err = new Error('Expand changelog is invalid');
      err.status = 400;
      throw err;
    }
    return { total: 1, issues: [{ key: 'LC-9', fields: {} }] };
  }, 'x');
  assert.equal(tries, 2);
  assert.equal(retried.changelog, false);
  assert.equal(retried.issues[0].key, 'LC-9');

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
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options.method, redirect: options.redirect, headers: options.headers, body: options.body });
    if (!String(url).endsWith('/rest/api/2/search') || options.method !== 'POST') {
      throw new Error(`caminho inesperado ${options.method} ${url}`);
    }
    const payload = JSON.parse(options.body);
    assert.equal(payload.maxResults, 50);
    assert.equal(payload.expand, 'changelog');
    assert.equal(options.body.includes(token), false);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        total: 1,
        issues: [issue('LC-7', {
          from: 'Request',
          to: 'To Do',
          at: '2026-11-10T18:05:00.000-0300',
          updated: '2026-11-10T18:05:00.000-0300',
          summary: 'Portal'
        })]
      })
    };
  };
  const { app, port } = await listen(server.createHandler({ fetchImpl }));
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
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, 'error');
    assert.equal(calls[0].headers.Authorization, `Bearer ${token}`);
    assert.equal(String(calls[0].url), 'http://jira.example/jira/rest/api/2/search');

    const deniedFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ errorMessages: [`bad ${token}`] })
    });
    const deniedApp = await listen(server.createHandler({ fetchImpl: deniedFetch }));
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
    assert.match(page.body, /Report v2/);
    const wrong = await requestOnce(port, 'PUT', '/api/jira/search', '{}');
    assert.equal(wrong.status, 405);
  } finally {
    await new Promise(resolve => app.close(resolve));
    ['JIRA_URL', 'BEARER_TOKEN'].forEach(key => {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    });
  }
}

function testSources() {
  const files = ['server.js', 'jira-search.js', 'jira-ui.js', 'index.html'];
  const src = files.map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
  assert.equal(/\/rest\/api\/2\/issue/.test(src), false);
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
  testSources();
  console.log('jira search tests ok');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
