/* ===== Servidor local: arquivos da ferramenta e consulta read-only no Jira ===== */

const fs = require('fs');
const http = require('http');
const path = require('path');
const jira = require('./jira-search');

const ROOT = __dirname;
const JIRA_TIMEOUT_MS = 20000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  text.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq < 1) return;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  });
}

function publicMessage(err, token) {
  if (err && (err.status === 401 || err.status === 403)) {
    return 'O Jira recusou o acesso. Confira BEARER_TOKEN no .env.';
  }
  let message = String(err && err.message || 'Falha ao consultar o Jira.');
  if (token && token.length >= 4 && message.includes(token)) message = message.split(token).join('…');
  return message.slice(0, 800);
}

function jiraConfig() {
  const baseUrl = String(process.env.JIRA_URL || '').trim();
  const token = String(process.env.BEARER_TOKEN || '').trim();
  if (!baseUrl || !token) {
    const err = new Error('Jira não configurado. Preencha JIRA_URL e BEARER_TOKEN no arquivo .env.');
    err.status = 503;
    throw err;
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    const err = new Error('JIRA_URL inválida no .env.');
    err.status = 503;
    throw err;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const err = new Error('JIRA_URL precisa começar com http:// ou https://.');
    err.status = 503;
    throw err;
  }
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return { baseUrl: parsed.toString(), token };
}

function searchUrl(baseUrl) {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/rest\/api\/\d+\/search$/i, '');
  url.pathname = `${prefix}/rest/api/2/search`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url;
}

function browseUrl(baseUrl, key) {
  if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(key || '')) return '';
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/rest\/api\/\d+\/search$/i, '');
  url.pathname = `${prefix}/browse/${encodeURIComponent(key)}`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.toString();
}

function jiraError(data, status, rawText, token) {
  const parts = [];
  if (data && Array.isArray(data.errorMessages)) parts.push(...data.errorMessages.map(String));
  if (data && data.errorMessage) parts.push(String(data.errorMessage));
  if (data && typeof data.message === 'string') parts.push(data.message);
  if (data && data.errors && typeof data.errors === 'object') {
    Object.entries(data.errors).forEach(([key, value]) => {
      parts.push(value && typeof value === 'object' ? `${key}: ${JSON.stringify(value)}` : `${key}: ${value}`);
    });
  }
  let message = parts.map(part => String(part || '').trim()).filter(Boolean).join(' ');
  if (!message) message = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!message) message = `O Jira respondeu ${status}.`;
  if (token && token.length >= 4) message = message.split(token).join('…');
  const err = new Error(message.slice(0, 800));
  err.status = status;
  return err;
}

function fieldsUrl(baseUrl) {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/rest\/api\/\d+\/search$/i, '');
  url.pathname = `${prefix}/rest/api/2/field`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url;
}

function issueChangelogUrl(baseUrl, key) {
  if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(key || '')) {
    const err = new Error('Chave de ticket inválida.');
    err.status = 400;
    throw err;
  }
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/rest\/api\/\d+\/search$/i, '');
  url.pathname = `${prefix}/rest/api/2/issue/${encodeURIComponent(key)}`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  url.searchParams.set('expand', 'changelog');
  return url;
}

async function jiraCall(config, url, method, body, fetchImpl) {
  const fieldList = method === 'GET' && url.pathname.endsWith('/rest/api/2/field') && !url.search;
  const changelog = method === 'GET' && /\/rest\/api\/2\/issue\/[^/]+$/.test(url.pathname) && url.searchParams.get('expand') === 'changelog';
  const allowed = method === 'POST'
    ? url.pathname.endsWith('/rest/api/2/search')
    : fieldList || changelog;
  if (!allowed) {
    const err = new Error('Consulta Jira bloqueada.');
    err.status = 500;
    throw err;
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(JIRA_TIMEOUT_MS)
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      const timeout = new Error('O Jira demorou demais para responder.');
      timeout.status = 504;
      throw timeout;
    }
    const down = new Error('Não foi possível alcançar o Jira.');
    down.status = 502;
    throw down;
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!response.ok) throw jiraError(data, response.status, text, config.token);
  return data || {};
}

async function jiraPost(config, body, fetchImpl) {
  return jiraCall(config, searchUrl(config.baseUrl), 'POST', body, fetchImpl);
}

async function loadFieldCatalog(config, fetchImpl) {
  try {
    return await jiraCall(config, fieldsUrl(config.baseUrl), 'GET', null, fetchImpl);
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) throw err;
    return [];
  }
}

async function loadChangelog(config, key, fetchImpl) {
  if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(key || '')) return [];
  const page = await jiraCall(config, issueChangelogUrl(config.baseUrl, key), 'GET', null, fetchImpl);
  const changelog = page && page.changelog;
  if (changelog && Array.isArray(changelog.histories)) return changelog.histories;
  if (changelog && Array.isArray(changelog.values)) return changelog.values;
  if (Array.isArray(page.histories)) return page.histories;
  if (Array.isArray(page.values)) return page.values;
  return [];
}

const METRICS_FILE = path.join(ROOT, 'data', 'report-v2-metrics.json');

function foldName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function metricsPath(filePath) {
  return filePath || METRICS_FILE;
}

function wholeCount(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100000) return null;
  return value;
}

function countList(value, size) {
  if (!Array.isArray(value) || (size != null && value.length !== size)) return null;
  if (!value.length || value.length > 24 && size == null) return null;
  const out = [];
  for (const item of value) {
    const count = wholeCount(item);
    if (count == null) return null;
    out.push(count);
  }
  return out;
}

function legacyBands() {
  return [18, 19, 20, 21].map(hour => ({
    label: `${hour}h–${hour + 1}h`,
    from: hour * 60,
    to: (hour + 1) * 60
  }));
}

function bandList(value, size) {
  if (!Array.isArray(value) || value.length !== size) return null;
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const label = String(item.label || '').trim();
    const from = wholeCount(item.from);
    const to = wholeCount(item.to);
    if (!label || label.length > 20 || /[\u0000-\u001f]/.test(label)) return null;
    if (from == null || to == null || to <= from || to > 24 * 60) return null;
    out.push({ label, from, to });
  }
  return out;
}

function subsidiaryList(value, bands) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 200) return null;
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const name = String(item.name || '').trim();
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) return null;
    const days = countList(item.days, 7);
    const counts = countList(item.bands, bands);
    if (!days || !counts) return null;
    out.push({ name, days, bands: counts });
  }
  return out;
}

function countSlice(value) {
  if (!value || typeof value !== 'object') return null;
  const weekdays = countList(value.weekdays, 7);
  const hours = countList(value.hours);
  const tickets = wholeCount(value.tickets);
  if (!weekdays || !hours || tickets == null) return null;
  let bands = Array.isArray(value.bands) ? bandList(value.bands, hours.length) : null;
  if (!bands && hours.length === 4 && value.bands == null) bands = legacyBands();
  if (!bands) return null;
  const subsidiaries = subsidiaryList(value.subsidiaries, hours.length);
  if (!subsidiaries) return null;
  return { weekdays, hours, bands, subsidiaries, tickets };
}

function cleanSavedDay(input) {
  const date = String(input && input.date || '');
  const user = String(input && input.user || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!user || user.length > 80 || /[\u0000-\u001f]/.test(user)) return null;
  const counts = input && input.counts;
  const all = countSlice(counts && counts.all);
  const todo = countSlice(counts && counts.todo);
  const clarification = countSlice(counts && counts.clarification);
  if (!all || !todo || !clarification) return null;
  const savedAt = typeof input.savedAt === 'string' && input.savedAt.length <= 40 ? input.savedAt : '';
  return { date, user, savedAt, counts: { all, todo, clarification } };
}

const NOTE_SUBS = ['Chile', 'Peru', 'Colombia', 'Mexico'];

function cleanNoteText(value, max) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return '';
  return text;
}

function cleanSubsidiaries(value) {
  if (!Array.isArray(value) || !value.length || value.length > NOTE_SUBS.length) return null;
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !NOTE_SUBS.includes(item) || seen.has(item)) return null;
    seen.add(item);
  }
  return NOTE_SUBS.filter(name => seen.has(name));
}

function cleanStoredNote(input) {
  if (!input || typeof input !== 'object') return null;
  const title = cleanNoteText(input.title, 120);
  const description = cleanNoteText(input.description, 4000);
  const subsidiaries = cleanSubsidiaries(input.subsidiaries);
  const id = String(input.id || '');
  const date = String(input.date || '');
  const savedAt = typeof input.savedAt === 'string' && input.savedAt.length <= 40 ? input.savedAt : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!title || !description || !subsidiaries || !/^[a-z0-9]{8,32}$/.test(id)) return null;
  return { id, date, title, description, subsidiaries, priority: input.priority === true, savedAt };
}

function readStore(filePath) {
  const file = metricsPath(filePath);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { days: [], notes: [] };
    const error = new Error('Não foi possível ler as métricas salvas.');
    error.status = 500;
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    const error = new Error('O arquivo de métricas está ilegível.');
    error.status = 500;
    throw error;
  }
  const token = String(process.env.BEARER_TOKEN || '');
  const keep = item => item && !(token.length >= 4 && JSON.stringify(item).includes(token));
  const days = Array.isArray(parsed && parsed.days)
    ? parsed.days.map(cleanSavedDay).filter(keep)
    : [];
  const notes = Array.isArray(parsed && parsed.notes)
    ? parsed.notes.map(cleanStoredNote).filter(keep)
    : [];
  days.sort((a, b) => a.date.localeCompare(b.date) || a.user.localeCompare(b.user, 'pt'));
  notes.sort((a, b) => a.date.localeCompare(b.date) || String(b.savedAt).localeCompare(String(a.savedAt)));
  return { days, notes };
}

function readMetrics(filePath) {
  return { days: readStore(filePath).days };
}

function publicDay(day) {
  return {
    date: day.date,
    user: day.user,
    savedAt: day.savedAt,
    counts: day.counts
  };
}

function writeStore(filePath, store) {
  const file = metricsPath(filePath);
  const token = String(process.env.BEARER_TOKEN || '');
  const body = JSON.stringify({ days: store.days, notes: store.notes }, null, 2);
  if (token.length >= 4 && body.includes(token)) {
    const err = new Error('O arquivo de métricas não pode guardar o token.');
    err.status = 400;
    throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

function saveMetricsDay(input, filePath) {
  const clean = cleanSavedDay(input);
  if (!clean) {
    const err = new Error('Dia de métricas inválido.');
    err.status = 400;
    throw err;
  }
  const token = String(process.env.BEARER_TOKEN || '');
  if (token.length >= 4 && clean.user.includes(token)) {
    const err = new Error('O arquivo de métricas não pode guardar o token.');
    err.status = 400;
    throw err;
  }
  const store = readStore(filePath);
  const savedAt = new Date().toISOString();
  const next = { ...clean, savedAt };
  const key = foldName(clean.user);
  const days = store.days.filter(day => !(day.date === clean.date && foldName(day.user) === key));
  days.push(next);
  days.sort((a, b) => a.date.localeCompare(b.date) || a.user.localeCompare(b.user, 'pt'));
  writeStore(filePath, { days, notes: store.notes });
  return publicDay(next);
}

function saveNote(input, filePath) {
  const title = cleanNoteText(input && input.title, 120);
  const description = cleanNoteText(input && input.description, 4000);
  const subsidiaries = cleanSubsidiaries(input && input.subsidiaries);
  const date = String(input && input.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !title || !description || !subsidiaries) {
    const err = new Error('Anotação inválida. Informe o dia, o título, a descrição e ao menos uma subsidiary.');
    err.status = 400;
    throw err;
  }
  const token = String(process.env.BEARER_TOKEN || '');
  if (token.length >= 4 && `${title}\n${description}`.includes(token)) {
    const err = new Error('A anotação não pode guardar o token.');
    err.status = 400;
    throw err;
  }
  const store = readStore(filePath);
  if (store.notes.length >= 200) {
    const err = new Error('O arquivo já tem anotações demais.');
    err.status = 400;
    throw err;
  }
  const note = cleanStoredNote({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    date,
    title,
    description,
    subsidiaries,
    priority: input && input.priority === true,
    savedAt: new Date().toISOString()
  });
  if (!note) {
    const err = new Error('Anotação inválida.');
    err.status = 400;
    throw err;
  }
  store.notes.unshift(note);
  writeStore(filePath, store);
  return note;
}

function savedForSearch(filters, filePath) {
  const store = readMetrics(filePath);
  const key = foldName(filters.user);
  const saved = [];
  const pending = [];
  filters.days.forEach(day => {
    const found = store.days.find(item => item.date === day && foldName(item.user) === key);
    if (found) saved.push(publicDay(found));
    else pending.push(day);
  });
  return { saved, pending };
}

async function runSearch(input, fetchImpl = global.fetch, filePath = METRICS_FILE) {
  const filters = jira.assertSearchInput(input);
  const split = savedForSearch(filters, filePath);
  if (!split.pending.length) {
    return {
      jql: '',
      total: 0,
      fetched: 0,
      matched: 0,
      dropped: 0,
      truncated: false,
      changelog: true,
      issues: [],
      saved: split.saved,
      queried: []
    };
  }
  const pendingFilters = { ...filters, days: split.pending };
  const config = jiraConfig();
  const catalog = await loadFieldCatalog(config, fetchImpl);
  const subsidiaryField = jira.subsidiaryFieldId(catalog);
  const configurationField = jira.configurationFieldId(catalog);
  const extraFields = [...new Set([subsidiaryField, configurationField].filter(Boolean))];
  const fields = jira.JIRA_FIELDS.concat(extraFields);
  const jql = jira.buildSearchJql(pendingFilters);
  const collected = await jira.collectIssues(body => jiraPost(config, body, fetchImpl), jql, fields);
  for (const issue of collected.issues) {
    issue.changelog = { histories: await loadChangelog(config, issue.key, fetchImpl) };
  }
  const built = jira.buildRows(collected.issues, { ...pendingFilters, subsidiaryField, configurationField });
  return {
    jql,
    total: built.rows.length,
    fetched: built.rows.length,
    matched: built.rows.length,
    dropped: 0,
    truncated: collected.truncated,
    changelog: true,
    subsidiaryField,
    issues: built.rows.map(row => ({ ...row, url: browseUrl(config.baseUrl, row.key) })),
    saved: split.saved,
    queried: split.pending
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > 65536) {
        failed = true;
        const err = new Error('Pedido grande demais.');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', err => { if (!failed) reject(err); });
  });
}

function safeFile(urlPath) {
  let pathname;
  try { pathname = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) return null;
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const parts = rel.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  const full = path.resolve(ROOT, rel);
  const root = ROOT.endsWith(path.sep) ? ROOT : `${ROOT}${path.sep}`;
  if (full !== ROOT && !full.startsWith(root)) return null;
  if (!MIME[path.extname(full).toLowerCase()]) return null;
  return full;
}

function sendFile(res, filePath, method) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJson(res, 404, { error: 'Não encontrado.' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleRequest(req, res, options) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/jira/search') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST.' });
      return;
    }
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw || '{}'); } catch {
      sendJson(res, 400, { error: 'JSON inválido.' });
      return;
    }
    const result = await runSearch(body, options.fetchImpl || global.fetch, options.metricsPath);
    sendJson(res, 200, result);
    return;
  }
  if (url.pathname === '/api/jira/notes') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use POST.' });
      return;
    }
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw || '{}'); } catch {
      sendJson(res, 400, { error: 'JSON inválido.' });
      return;
    }
    const note = saveNote(body, options.metricsPath);
    sendJson(res, 200, { note, notes: readStore(options.metricsPath).notes });
    return;
  }
  if (url.pathname === '/api/jira/metrics') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const store = readStore(options.metricsPath);
      sendJson(res, 200, { days: store.days.map(publicDay), notes: store.notes });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Use GET ou POST.' });
      return;
    }
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw || '{}'); } catch {
      sendJson(res, 400, { error: 'JSON inválido.' });
      return;
    }
    sendJson(res, 200, { day: saveMetricsDay(body, options.metricsPath) });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Método não suportado.' });
    return;
  }
  const filePath = safeFile(url.pathname);
  if (!filePath) {
    sendJson(res, 404, { error: 'Não encontrado.' });
    return;
  }
  sendFile(res, filePath, req.method);
}

function createHandler(options = {}) {
  return async function handler(req, res) {
    try {
      await handleRequest(req, res, options);
    } catch (err) {
      if (res.headersSent) return;
      const token = String(process.env.BEARER_TOKEN || '');
      sendJson(res, err.status || 502, { error: publicMessage(err, token) });
    }
  };
}

if (require.main === module) {
  loadEnvFile(path.join(ROOT, '.env'));
  const port = Number(process.env.PORT) || 8787;
  http.createServer(createHandler()).listen(port, '127.0.0.1', () => {
    console.log(`SDS em http://127.0.0.1:${port}`);
  });
}

module.exports = {
  createHandler,
  loadEnvFile,
  searchUrl,
  browseUrl,
  runSearch,
  publicMessage
};
