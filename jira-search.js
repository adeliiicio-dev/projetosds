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
  const when = clean.days.map(day => {
    const start = jqlQuote(jiraStamp(day, clean.timeFrom));
    const stop = jqlQuote(jiraStamp(day, end));
    return `status changed BY ${quotedUser} DURING (${start}, ${stop})`;
  }).join(' OR ');
  return `(${when}) ORDER BY updated DESC`;
}

function foldStatus(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ORIGINAL_NEW = /original\s*:\s*([^[\]]+?)\s*\[\s*\d+\s*\]\s*new\s*:\s*([^[\]]+?)\s*\[\s*\d+\s*\]/i

function cleanStatus(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^(original|new)\s*:\s*/i, '').trim();
  const cut = text.indexOf('[');
  if (cut >= 0) text = text.slice(0, cut).trim();
  return text;
}

function statusEnds(from, to) {
  const found = `${from || ''}\n${to || ''}`.match(ORIGINAL_NEW);
  if (found) return { from: found[1].trim(), to: found[2].trim() };
  return { from: cleanStatus(from), to: cleanStatus(to) };
}

function statusMoveKind(from, to) {
  const ends = statusEnds(from, to);
  if (foldStatus(ends.from) !== 'request') return '';
  const dest = foldStatus(ends.to);
  if (dest === 'to do' || dest === 'todo') return 'todo';
  if (dest === 'clarification' || dest === 'clarificacao') return 'clarification';
  return '';
}

function samePerson(query, author) {
  const wanted = foldStatus(query);
  if (!wanted) return false;
  const raw = String(query || '').trim().toLowerCase();
  const values = [];
  if (typeof author === 'string') values.push(author);
  else if (author) {
    ['displayName', 'name', 'key', 'accountId', 'emailAddress'].forEach(key => {
      if (author[key]) values.push(author[key]);
    });
  }
  const words = wanted.split(' ').filter(Boolean);
  return values.some(value => {
    if (String(value).trim().toLowerCase() === raw) return true;
    const name = foldStatus(value);
    if (!name) return false;
    if (name === wanted) return true;
    const nameWords = name.split(' ').filter(Boolean);
    return words.every(word => nameWords.includes(word));
  });
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

function wallClock(iso) {
  const match = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return null;
  return { date: match[1], minutes: Number(match[2]) * 60 + Number(match[3]) };
}

function inChosenWindow(iso, windows) {
  if (instantInWindows(iso, windows)) return true;
  const wall = wallClock(iso);
  if (!wall) return false;
  return windows.some(window => (
    window.date === wall.date && wall.minutes >= window.start && wall.minutes < window.end
  ));
}

function authorBlob(author) {
  if (!author) return '';
  if (typeof author === 'string') return author;
  return ['displayName', 'name', 'key', 'accountId', 'emailAddress']
    .map(key => author[key] || '')
    .filter(Boolean)
    .join(' ');
}

function authorMatches(user, author) {
  if (samePerson(user, author)) return true;
  const wanted = foldStatus(user);
  const blob = foldStatus(authorBlob(author));
  if (!blob) return true;
  const words = wanted.split(' ').filter(word => word.length >= 2);
  const authorWords = blob.split(' ').filter(word => word.length >= 2);
  if (!words.length || !authorWords.length) return false;
  return words.some(word => authorWords.some(part => (
    part === word || part.startsWith(word) || word.startsWith(part)
  )));
}

function historyList(issue) {
  const changelog = issue && issue.changelog;
  if (!changelog) return [];
  if (Array.isArray(changelog)) return changelog;
  if (Array.isArray(changelog.histories)) return changelog.histories;
  if (Array.isArray(changelog.values)) return changelog.values;
  return [];
}

function statusText(name, id) {
  const text = name != null && String(name).trim() ? String(name) : '';
  if (text) return text;
  const raw = id != null ? String(id) : '';
  if (raw && !/^\d+$/.test(raw)) return raw;
  return '';
}

function statusHistory(issue) {
  const out = [];
  historyList(issue).forEach(history => {
    const author = personName(history && history.author);
    const at = history && history.created ? history.created : '';
    const items = history && Array.isArray(history.items) ? history.items : [];
    items.forEach(item => {
      const rawFrom = statusText(item && item.fromString, item && item.from);
      const rawTo = statusText(item && item.toString, item && item.to);
      const field = String(item && item.field || '');
      const parsed = `${rawFrom}\n${rawTo}\n${JSON.stringify(item || {})}`.match(ORIGINAL_NEW);
      const status = field.toLowerCase() === 'status' || !!parsed;
      if (!status) return;
      const ends = parsed
        ? { from: parsed[1].trim(), to: parsed[2].trim() }
        : statusEnds(rawFrom, rawTo);
      out.push({
        from: ends.from,
        to: ends.to,
        at,
        author: history && history.author,
        authorName: author,
        field,
        status: true,
        kind: statusMoveKind(ends.from, ends.to)
      });
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
  const label = move.status ? `${move.from || '—'} → ${move.to || '—'}` : `Alterou ${move.field || 'campo'}`;
  const bits = [label];
  const when = move.at ? formatWhen(move.at) : '';
  if (when) bits.push(when);
  if (move.authorName) bits.push(move.authorName);
  return bits.join(' · ');
}

function toRow(issue, windows, user) {
  const fields = issue && issue.fields ? issue.fields : {};
  const history = statusHistory(issue).map(move => ({
    ...move,
    inWindow: move.at ? inChosenWindow(move.at, windows) : false,
    byUser: authorMatches(user, move.author)
  }));
  const mine = history.filter(move => move.status && move.inWindow && move.byUser);
  const statusMoves = mine;
  const kinds = [...new Set(statusMoves.map(move => move.kind).filter(Boolean))];
  const shown = statusMoves.length ? statusMoves : mine;
  return {
    key: issue && issue.key ? issue.key : '',
    summary: typeof fields.summary === 'string' ? fields.summary : '',
    status: statusName(fields.status),
    assignee: personName(fields.assignee),
    moveText: shown.map(oneMove).join('\n'),
    kinds,
    inWindow: mine.length > 0,
    payload: {
      key: issue && issue.key ? issue.key : '',
      fields: {
        summary: fields.summary ?? null,
        status: fields.status ?? null,
        assignee: fields.assignee ?? null,
        updated: fields.updated ?? null
      },
      statusChanges: statusMoves.map(move => ({
        from: move.from,
        to: move.to,
        at: move.at,
        author: move.authorName
      }))
    }
  };
}

function buildRows(issues, filters) {
  const windows = buildWindows(filters);
  const rows = [];
  let dropped = 0;
  issues.forEach(issue => {
    const row = toRow(issue, windows, filters.user);
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

  while (issues.length < total) {
    const body = { jql, fields, startAt, maxResults: JIRA_PAGE_SIZE };
    const page = await postPage(body);
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
    changelog: false
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
