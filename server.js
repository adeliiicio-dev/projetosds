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

function changelogUrl(baseUrl, key, startAt) {
  if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(key || '')) {
    const err = new Error('Chave de ticket inválida.');
    err.status = 400;
    throw err;
  }
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/rest\/api\/\d+\/search$/i, '');
  url.pathname = `${prefix}/rest/api/2/issue/${encodeURIComponent(key)}/changelog`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  url.searchParams.set('startAt', String(startAt));
  url.searchParams.set('maxResults', '100');
  return url;
}

async function jiraCall(config, url, method, body, fetchImpl) {
  const allowed = method === 'POST'
    ? url.pathname.endsWith('/rest/api/2/search')
    : method === 'GET' && /\/rest\/api\/2\/issue\/[^/]+\/changelog$/.test(url.pathname);
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

async function loadChangelog(config, key, fetchImpl) {
  if (!/^[A-Z][A-Z0-9]+-\d+$/i.test(key || '')) return [];
  const histories = [];
  let startAt = 0;
  let total = Infinity;
  while (histories.length < total && startAt < 5000) {
    const page = await jiraCall(config, changelogUrl(config.baseUrl, key, startAt), 'GET', null, fetchImpl);
    const batch = Array.isArray(page.values) ? page.values : (Array.isArray(page.histories) ? page.histories : []);
    const pageTotal = Number(page.total);
    if (Number.isFinite(pageTotal)) total = pageTotal;
    if (!batch.length) break;
    histories.push(...batch);
    if (histories.length >= total || batch.length < 100) break;
    const next = startAt + batch.length;
    if (next <= startAt) break;
    startAt = next;
  }
  return histories;
}

async function runSearch(input, fetchImpl = global.fetch) {
  const filters = jira.assertSearchInput(input);
  const config = jiraConfig();
  const jql = jira.buildSearchJql(filters);
  const collected = await jira.collectIssues(body => jiraPost(config, body, fetchImpl), jql, jira.JIRA_FIELDS);
  for (const issue of collected.issues) {
    issue.changelog = { histories: await loadChangelog(config, issue.key, fetchImpl) };
  }
  const built = jira.buildRows(collected.issues, filters);
  return {
    jql,
    total: built.rows.length,
    fetched: built.rows.length,
    matched: built.rows.length,
    dropped: 0,
    truncated: collected.truncated,
    changelog: true,
    issues: built.rows.map(row => ({ ...row, url: browseUrl(config.baseUrl, row.key) }))
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
    const result = await runSearch(body, options.fetchImpl || global.fetch);
    sendJson(res, 200, result);
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
