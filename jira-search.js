/* ===== Report v2: monta a busca read-only e lê o payload do Jira ===== */

const JIRA_PAGE_SIZE = 50;
const JIRA_MAX_ISSUES = 1000;
const JIRA_FIELDS = ['summary', 'status', 'assignee', 'updated'];
const JIRA_TZ = 'America/Sao_Paulo';

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function isTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function toMinutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function minuteBefore(value) {
  const total = toMinutes(value) - 1;
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function jqlQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function jiraStamp(day, time) {
  return `${day.replace(/-/g, '/')} ${time}`;
}

function assertSearchInput(input) {
  if (!input || typeof input !== 'object') fail(400, 'Filtros inválidos.');
  const user = String(input.user || '').trim();
  const timeFrom = String(input.timeFrom || '').trim().slice(0, 5);
  const timeTo = String(input.timeTo || '').trim().slice(0, 5);
  const days = Array.isArray(input.days) ? input.days.map(day => String(day || '').trim()) : [];
  if (!user) fail(400, 'Informe o nome do usuário.');
  if (user.length > 200 || /[\u0000-\u001f]/.test(user)) fail(400, 'Nome de usuário inválido.');
  if (!isTime(timeFrom) || !isTime(timeTo)) fail(400, 'Informe a faixa de horário.');
  if (toMinutes(timeFrom) >= toMinutes(timeTo)) fail(400, 'O horário final precisa ser depois do inicial.');
  const uniqueDays = [...new Set(days)].sort();
  if (!uniqueDays.length) fail(400, 'Escolha ao menos um dia.');
  if (uniqueDays.length > 31 || uniqueDays.some(day => !isIsoDate(day))) fail(400, 'Dia inválido.');
  return { user, timeFrom, timeTo, days: uniqueDays };
}

function buildSearchJql(filters) {
  const clean = assertSearchInput(filters);
  const quotedUser = jqlQuote(clean.user);
  const end = minuteBefore(clean.timeTo);
  const who = `(assignee = ${quotedUser} OR reporter = ${quotedUser} OR status changed BY ${quotedUser})`;
  const when = clean.days.map(day => {
    const start = jqlQuote(jiraStamp(day, clean.timeFrom));
    const stop = jqlQuote(jiraStamp(day, end));
    return `((updated >= ${start} AND updated <= ${stop}) OR (status changed DURING (${start}, ${stop})))`;
  }).join(' OR ');
  return `${who} AND (${when}) ORDER BY updated DESC`;
}

function foldStatus(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function statusMoveKind(from, to) {
  if (foldStatus(from) !== 'request') return '';
  const dest = foldStatus(to);
  if (dest === 'to do' || dest === 'todo') return 'todo';
  if (dest === 'clarification' || dest === 'clarificacao') return 'clarification';
  return '';
}

function personName(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.displayName || value.name || value.emailAddress || '';
}

function statusName(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.name || '';
}

function zonedParts(iso, timeZone = JIRA_TZ) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const bag = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).forEach(part => { bag[part.type] = part.value; });
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    date: `${bag.year}-${bag.month}-${bag.day}`,
    minutes: hour * 60 + Number(bag.minute)
  };
}

function buildWindows(filters) {
  const start = toMinutes(filters.timeFrom);
  const end = toMinutes(filters.timeTo);
  return filters.days.map(date => ({ date, start, end }));
}

function instantInWindows(iso, windows) {
  const parts = zonedParts(iso);
  if (!parts) return false;
  return windows.some(window => (
    window.date === parts.date && parts.minutes >= window.start && parts.minutes < window.end
  ));
}

function statusHistory(issue) {
  const histories = issue && issue.changelog && Array.isArray(issue.changelog.histories)
    ? issue.changelog.histories
    : [];
  const out = [];
  histories.forEach(history => {
    const author = personName(history && history.author);
    const at = history && history.created ? history.created : '';
    const items = history && Array.isArray(history.items) ? history.items : [];
    items.forEach(item => {
      if (String(item && item.field || '').toLowerCase() !== 'status') return;
      const from = item.fromString || '';
      const to = item.toString || '';
      out.push({ from, to, at, author, kind: statusMoveKind(from, to) });
    });
  });
  return out;
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: JIRA_TZ,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function oneMove(move) {
  const bits = [`${move.from || '—'} → ${move.to || '—'}`];
  const when = move.at ? formatWhen(move.at) : '';
  if (when) bits.push(when);
  if (move.author) bits.push(move.author);
  return bits.join(' · ');
}

function moveText(moves) {
  const inside = moves.filter(move => move.inWindow);
  if (inside.length) return inside.map(oneMove).join('\n');
  if (!moves.length) return '';
  const latest = [...moves].sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  return `Fora da faixa: ${oneMove(latest)}`;
}

function toRow(issue, windows) {
  const fields = issue && issue.fields ? issue.fields : {};
  const history = statusHistory(issue);
  const moves = history.map(move => ({
    ...move,
    inWindow: move.at ? instantInWindows(move.at, windows) : false
  }));
  const updatedIn = fields.updated ? instantInWindows(fields.updated, windows) : false;
  const inWindow = updatedIn || moves.some(move => move.inWindow) || (!fields.updated && !history.length);
  const kinds = [...new Set(moves.filter(move => move.inWindow && move.kind).map(move => move.kind))];
  return {
    key: issue && issue.key ? issue.key : '',
    summary: typeof fields.summary === 'string' ? fields.summary : '',
    status: statusName(fields.status),
    assignee: personName(fields.assignee),
    moveText: moveText(moves),
    kinds,
    inWindow,
    payload: {
      key: issue && issue.key ? issue.key : '',
      fields: {
        summary: fields.summary ?? null,
        status: fields.status ?? null,
        assignee: fields.assignee ?? null,
        updated: fields.updated ?? null
      },
      statusChanges: history.map(move => ({
        from: move.from,
        to: move.to,
        at: move.at,
        author: move.author
      }))
    }
  };
}

function buildRows(issues, filters) {
  const windows = buildWindows(filters);
  const rows = [];
  let dropped = 0;
  issues.forEach(issue => {
    const row = toRow(issue, windows);
    if (!row.inWindow) {
      dropped += 1;
      return;
    }
    rows.push(row);
  });
  return { rows, dropped };
}

function filterByTransition(rows, transition) {
  const list = Array.isArray(rows) ? rows : [];
  if (transition === 'todo' || transition === 'clarification') {
    return list.filter(row => Array.isArray(row.kinds) && row.kinds.includes(transition));
  }
  return list.slice();
}

async function collectIssues(postPage, jql, fields = JIRA_FIELDS) {
  const issues = [];
  const seen = new Set();
  let startAt = 0;
  let total = Infinity;
  let truncated = false;
  let useExpand = true;

  while (issues.length < total) {
    const body = { jql, fields, startAt, maxResults: JIRA_PAGE_SIZE };
    if (useExpand) body.expand = 'changelog';
    let page;
    try {
      page = await postPage(body);
    } catch (err) {
      const message = String(err && err.message || '');
      if (useExpand && startAt === 0 && err && err.status === 400 && /expand|changelog/i.test(message)) {
        useExpand = false;
        continue;
      }
      throw err;
    }
    const batch = page && Array.isArray(page.issues) ? page.issues : [];
    const pageTotal = Number(page && page.total);
    if (Number.isFinite(pageTotal)) total = pageTotal;
    if (!batch.length) break;
    let added = 0;
    for (const issue of batch) {
      const key = issue && issue.key;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      issues.push(issue);
      added += 1;
      if (issues.length >= JIRA_MAX_ISSUES) break;
    }
    if (!added) break;
    if (issues.length >= JIRA_MAX_ISSUES && issues.length < total) truncated = true;
    if (issues.length >= total || issues.length >= JIRA_MAX_ISSUES) break;
    if (batch.length < JIRA_PAGE_SIZE) break;
    const next = startAt + batch.length;
    if (next <= startAt) break;
    startAt = next;
  }

  return {
    issues,
    total: Number.isFinite(total) ? total : issues.length,
    truncated,
    changelog: useExpand
  };
}

const jiraSearchApi = {
  JIRA_PAGE_SIZE,
  JIRA_MAX_ISSUES,
  JIRA_FIELDS,
  JIRA_TZ,
  assertSearchInput,
  buildSearchJql,
  statusMoveKind,
  zonedParts,
  instantInWindows,
  buildRows,
  filterByTransition,
  collectIssues
};

if (typeof module !== 'undefined' && module.exports) module.exports = jiraSearchApi;
if (typeof window !== 'undefined') window.jiraSearch = jiraSearchApi;
