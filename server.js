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
    return 'O Jira recusou o acesso. Confira JIRA_USER e JIRA_API_TOKEN no .env.';
  }
  let message = String(err && err.message || 'Falha ao consultar o Jira.');
  if (token && token.length >= 4 && message.includes(token)) message = 'Falha ao consultar o Jira.';
  return message.slice(0, 400);
}

function jiraConfig() {
  const baseUrl = String(process.env.JIRA_URL || '').trim();
  const user = String(process.env.JIRA_USER || '').trim();
  const token = String(process.env.JIRA_API_TOKEN || '').trim();
  if (!baseUrl || !user || !token) {
    const err = new Error('Jira não configurado. Preencha JIRA_URL, JIRA_USER e JIRA_API_TOKEN no arquivo .env.');
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
  return { baseUrl: parsed.toString(), user, token };
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

function jiraError(data, status) {
  const parts = [];
  if (data && Array.isArray(data.errorMessages)) parts.push(...data.errorMessages.map(String));
  if (data && data.errors && typeof data.errors === 'object') {
    Object.values(data.errors).forEach(value => parts.push(String(value)));
  }
  const err = new Error(parts.filter(Boolean).join(' ') || `O Jira respondeu ${status}.`);
  err.status = status;
  return err;
}

async function jiraPost(config, body, fetchImpl) {
  const url = searchUrl(config.baseUrl);
  if (!url.pathname.endsWith('/rest/api/2/search')) {
    const err = new Error('Consulta Jira bloqueada.');
    err.status = 500;
    throw err;
  }
  const auth = Buffer.from(`${config.user}:${config.token}`, 'utf8').toString('base64');
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
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
  if (!response.ok) throw jiraError(data, response.status);
  return data || {};
}

async function runSearch(input, fetchImpl = global.fetch) {
  const filters = jira.assertSearchInput(input);
  const config = jiraConfig();
  const jql = jira.buildSearchJql(filters);
  const collected = await jira.collectIssues(body => jiraPost(config, body, fetchImpl), jql, jira.JIRA_FIELDS);
  const built = jira.buildRows(collected.issues, filters);
  return {
    jql,
    total: collected.total,
    fetched: collected.issues.length,
    matched: built.rows.length,
    dropped: built.dropped,
    truncated: collected.truncated,
    changelog: collected.changelog,
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
      const token = String(process.env.JIRA_API_TOKEN || '');
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
