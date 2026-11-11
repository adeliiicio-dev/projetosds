/* ===== Report v2: monta a busca read-only e lê o payload do Jira ===== */

const JIRA_PAGE_SIZE = 50;
const JIRA_MAX_ISSUES = 1000;
const JIRA_FIELDS = ['summary', 'status', 'assignee', 'updated'];
const COE_SUBSIDIARIES_NAME = 'COE_subsidiaries';
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

function windowHit(parts, windows) {
  if (!parts) return false;
  return windows.some(window => (
    window.date === parts.date && parts.minutes >= window.start && parts.minutes < window.end
  ));
}

function qualifyingParts(iso, windows) {
  const zoned = zonedParts(iso);
  if (windowHit(zoned, windows)) return zoned;
  const wall = wallClock(iso);
  if (windowHit(wall, windows)) return wall;
  return null;
}

function formatParts(parts) {
  if (!parts || !parts.date) return '';
  const [, month, day] = parts.date.split('-');
  const hour = String(Math.floor(parts.minutes / 60)).padStart(2, '0');
  const minute = String(parts.minutes % 60).padStart(2, '0');
  return `${day}/${month}, ${hour}:${minute}`;
}

function authorNames(author) {
  if (!author) return [];
  if (typeof author === 'string') return [author];
  return ['displayName', 'name', 'key'].map(key => author[key]).filter(Boolean);
}

function nameTokens(value) {
  return foldStatus(value).split(' ').filter(word => word.length >= 3);
}

function tokensCover(needles, hay) {
  return needles.every(word => hay.some(part => part === word || part.startsWith(word)));
}

function authorMatches(user, author) {
  const query = nameTokens(user);
  const names = authorNames(author);
  if (!query.length || !names.length) return false;
  return names.some(name => {
    const parts = nameTokens(name);
    if (!parts.length) return false;
    return tokensCover(query, parts) || tokensCover(parts, query);
  });
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
      const parsed = `${rawFrom}\n${rawTo}`.match(ORIGINAL_NEW);
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
  const when = move.parts ? formatParts(move.parts) : (move.at ? formatWhen(move.at) : '');
  return when ? `${label} · ${when}` : label;
}

function changeKind(change) {
  if (!change) return '';
  if (change.kind === 'todo' || change.kind === 'clarification') return change.kind;
  return statusMoveKind(change.from, change.to);
}

function metricParts(change) {
  if (!change) return null;
  if (change.date && Number.isFinite(Number(change.minutes))) {
    return { date: change.date, minutes: Number(change.minutes) };
  }
  return zonedParts(change.at);
}

function fieldKey(name) {
  return foldStatus(name).replace(/[^a-z0-9]/g, '');
}

function subsidiaryFieldId(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.values) ? payload.values : []);
  const wanted = fieldKey(COE_SUBSIDIARIES_NAME);
  const matches = list.filter(field => fieldKey(field && (field.name || field.untranslatedName)) === wanted);
  if (!matches.length) return '';
  const exact = matches.find(field => (
    String(field.name || '') === COE_SUBSIDIARIES_NAME
    || String(field.untranslatedName || '') === COE_SUBSIDIARIES_NAME
  ));
  const id = String((exact || matches[0]).id || '');
  if (!/^(customfield_\d+|[A-Za-z][A-Za-z0-9_]*)$/.test(id)) return '';
  return id;
}

function subsidiaryText(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return value.map(subsidiaryText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if (value.value != null && value.value !== '') return subsidiaryText(value.value);
    if (value.name != null && value.name !== '') return subsidiaryText(value.name);
  }
  return '';
}

function readSubsidiary(fields, fieldId) {
  const source = fields && fieldId && Object.prototype.hasOwnProperty.call(fields, fieldId)
    ? fields[fieldId]
    : (fields && (fields.COE_subsidiaries != null ? fields.COE_subsidiaries : fields.coeSubsidiaries));
  return subsidiaryText(source) || '(vazio)';
}

function clockLabel(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return minute ? `${hour}h${String(minute).padStart(2, '0')}` : `${hour}h`;
}

function hourBands(timeFrom, timeTo) {
  if (!isTime(timeFrom || '') || !isTime(timeTo || '')) return [];
  const start = toMinutes(timeFrom);
  const end = toMinutes(timeTo);
  if (end <= start) return [];
  const bands = [];
  let cursor = start;
  while (cursor < end) {
    const bandEnd = Math.min(end, (Math.floor(cursor / 60) + 1) * 60);
    bands.push({
      from: cursor,
      to: bandEnd,
      label: `${clockLabel(cursor)}–${clockLabel(bandEnd)}`
    });
    cursor = bandEnd;
  }
  return bands;
}

function weekdayIndex(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return -1;
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (utc.getUTCDay() + 6) % 7;
}

function metricsForRows(rows, user, transition, range) {
  const bands = hourBands(range && range.timeFrom, range && range.timeTo);
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  const hours = bands.map(() => 0);
  const subs = new Map();
  const chosen = new Map();
  const wanted = foldStatus(user);
  const touch = name => {
    if (!subs.has(name)) {
      subs.set(name, {
        name,
        days: [0, 0, 0, 0, 0, 0, 0],
        bands: bands.map(() => 0)
      });
    }
    return subs.get(name);
  };
  (Array.isArray(rows) ? rows : []).forEach((row, rowIndex) => {
    const changes = row && row.payload && Array.isArray(row.payload.statusChanges) ? row.payload.statusChanges : [];
    const id = row && row.key ? String(row.key) : `row-${rowIndex}`;
    changes.forEach((change, changeIndex) => {
      const kind = changeKind(change);
      if (kind !== 'todo' && kind !== 'clarification') return;
      if ((transition === 'todo' || transition === 'clarification') && kind !== transition) return;
      if (wanted && change && change.author && !authorMatches(user, change.author)) return;
      const parts = metricParts(change);
      if (!parts) return;
      const day = weekdayIndex(parts.date);
      const band = bands.findIndex(item => parts.minutes >= item.from && parts.minutes < item.to);
      if (day < 0 || band < 0) return;
      const parsed = Date.parse(change && change.at);
      const instant = Number.isFinite(parsed) ? parsed : changeIndex;
      const current = chosen.get(id);
      if (current && (instant < current.instant || (instant === current.instant && changeIndex <= current.changeIndex))) return;
      chosen.set(id, { change, day, band, instant, changeIndex });
    });
  });
  chosen.forEach(item => {
    weekdays[item.day] += 1;
    hours[item.band] += 1;
    const rec = touch(subsidiaryText(item.change && item.change.subsidiary) || '(vazio)');
    rec.days[item.day] += 1;
    rec.bands[item.band] += 1;
  });
  const tickets = weekdays.reduce((sum, count) => sum + count, 0);
  const subsidiaries = Array.from(subs.values()).sort((a, b) => {
    const total = rec => rec.days.reduce((sum, count) => sum + count, 0);
    return total(b) - total(a) || a.name.localeCompare(b.name, 'pt');
  });
  return { weekdays, hours, bands, subsidiaries, tickets };
}

function countMoves(rows) {
  let todo = 0;
  let clarification = 0;
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const changes = row && row.payload && Array.isArray(row.payload.statusChanges) ? row.payload.statusChanges : [];
    changes.forEach(change => {
      const kind = changeKind(change);
      if (kind === 'todo') todo += 1;
      else if (kind === 'clarification') clarification += 1;
    });
  });
  return { all: todo + clarification, todo, clarification };
}

function toRow(issue, windows, user, fieldId) {
  const fields = issue && issue.fields ? issue.fields : {};
  const history = statusHistory(issue).map(move => {
    const parts = move.at ? qualifyingParts(move.at, windows) : null;
    return {
      ...move,
      parts,
      inWindow: !!parts,
      byUser: authorMatches(user, move.author)
    };
  });
  const statusMoves = history.filter(move => (
    move.status && move.inWindow && move.byUser && (move.kind === 'todo' || move.kind === 'clarification')
  ));
  const kinds = [...new Set(statusMoves.map(move => move.kind))];
  const shown = statusMoves;
  const subsidiary = readSubsidiary(fields, fieldId);
  return {
    key: issue && issue.key ? issue.key : '',
    summary: typeof fields.summary === 'string' ? fields.summary : '',
    status: statusName(fields.status),
    assignee: personName(fields.assignee),
    moveText: shown.map(oneMove).join('\n'),
    subsidiary,
    kinds,
    inWindow: statusMoves.length > 0,
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
        date: move.parts.date,
        minutes: move.parts.minutes,
        author: authorNames(move.author).join(' '),
        subsidiary,
        kind: move.kind,
        text: oneMove(move)
      }))
    }
  };
}

function buildRows(issues, filters) {
  const windows = buildWindows(filters);
  const rows = [];
  let dropped = 0;
  issues.forEach(issue => {
    const row = toRow(issue, windows, filters.user, filters.subsidiaryField);
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
  COE_SUBSIDIARIES_NAME,
  subsidiaryFieldId,
  hourBands,
  assertSearchInput,
  buildSearchJql,
  statusMoveKind,
  zonedParts,
  instantInWindows,
  buildRows,
  filterByTransition,
  metricsForRows,
  countMoves,
  collectIssues
};

if (typeof module !== 'undefined' && module.exports) module.exports = jiraSearchApi;
if (typeof window !== 'undefined') window.jiraSearch = jiraSearchApi;
