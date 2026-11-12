/* ===== Report v2: consulta read-only de tickets no Jira ===== */

const JR_SLOTS = [
  { label: '18h–19h', from: '18:00', to: '19:00' },
  { label: '19h–20h', from: '19:00', to: '20:00' },
  { label: '20h–21h', from: '20:00', to: '21:00' },
  { label: '21h–22h', from: '21:00', to: '22:00' }
];

const JR_DAY_SHORT = (typeof RP_DAYS !== 'undefined' ? RP_DAYS : [
  { short: 'Seg' }, { short: 'Ter' }, { short: 'Qua' }, { short: 'Qui' },
  { short: 'Sex' }, { short: 'Sáb' }, { short: 'Dom' }
]).map(day => day.short);

const JR_USER_KEY = 'sds-report-v2-user';
const JR_SUBS = ['Chile', 'Peru', 'Colombia', 'Mexico'];
const JR_SLIDE = [
  { code: 'SAMCOL', sub: 'Colombia' },
  { code: 'SECH', sub: 'Chile' },
  { code: 'SEM', sub: 'Mexico' },
  { code: 'SEPR', sub: 'Peru' }
];

function jrLoadUser() {
  try {
    if (typeof localStorage === 'undefined') return '';
    const name = localStorage.getItem(JR_USER_KEY);
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

function jrSaveUser(name) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(JR_USER_KEY, name);
  } catch {
    /* a busca segue com o nome que está no campo */
  }
}

const jrState = {
  weekStart: '',
  days: new Set(),
  issues: [],
  info: null,
  transition: 'all',
  loading: false,
  error: '',
  savedDays: [],
  period: 'current',
  range: null,
  picked: new Set(),
  notes: [],
  noteStatus: '',
  noteSaving: false
};

function jrEsc(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(value);
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function jrAddDays(iso, count) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function jrMonday(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  return jrAddDays(iso, delta);
}

function jrToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function jrFmt(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function jrWeekDates(monday) {
  return JR_DAY_SHORT.map((short, index) => ({ short, date: jrAddDays(monday, index) }));
}

function jrFilter(rows, transition) {
  const list = Array.isArray(rows) ? rows : [];
  if (transition === 'todo' || transition === 'clarification') {
    return list.filter(row => Array.isArray(row.kinds) && row.kinds.includes(transition));
  }
  return list.slice();
}

function jrRenderSlots() {
  const host = document.getElementById('jrSlots');
  const from = document.getElementById('jrFrom');
  const to = document.getElementById('jrTo');
  if (!host || !from || !to) return;
  const start = from.value.slice(0, 5);
  const end = to.value.slice(0, 5);
  host.innerHTML = JR_SLOTS.map(slot => {
    const on = slot.from === start && slot.to === end;
    const cls = on ? 'btn-samsung' : 'btn-outline-secondary';
    return `<button type="button" class="btn btn-sm ${cls}" data-jr-from="${slot.from}" data-jr-to="${slot.to}">${slot.label}</button>`;
  }).join('');
}

function jrRenderDays() {
  const host = document.getElementById('jrDays');
  const label = document.getElementById('jrWeekLabel');
  const extra = document.getElementById('jrExtraDays');
  if (!host || !label || !extra) return;
  const dates = jrWeekDates(jrState.weekStart);
  label.textContent = `${jrFmt(dates[0].date)} – ${jrFmt(dates[6].date)}`;
  host.innerHTML = dates.map(day => {
    const checked = jrState.days.has(day.date) ? ' checked' : '';
    const shortDate = `${day.date.slice(8, 10)}/${day.date.slice(5, 7)}`;
    return `<label class="rp-check"><input type="checkbox" data-jr-day="${day.date}"${checked}> ${jrEsc(day.short)} ${shortDate}</label>`;
  }).join('');
  const outside = [...jrState.days].filter(day => !dates.some(item => item.date === day)).sort();
  extra.innerHTML = outside.map(day => (
    `<button type="button" class="btn btn-sm btn-outline-secondary" data-jr-drop="${day}">${jrFmt(day)} <i class="bi bi-x"></i></button>`
  )).join('');
}

function jrDayKey(day) {
  return `${day.date}|${encodeURIComponent(String(day.user || '').trim().toLowerCase())}`;
}

function jrWeekdayLabel(date) {
  const [year, month, day] = date.split('-').map(Number);
  const index = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return JR_DAY_SHORT[index] || '';
}

function jrCurrentUser() {
  const input = typeof document !== 'undefined' ? document.getElementById('jrUser') : null;
  return input ? input.value.trim() : '';
}

function jrFoldUser(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function jrSavedForCurrent() {
  const key = jrFoldUser(jrCurrentUser());
  if (!key) return [];
  return jrState.savedDays.filter(day => jrFoldUser(day.user) === key);
}

function jrSliceBands(slice) {
  if (slice && Array.isArray(slice.bands) && slice.bands.length) return slice.bands;
  return (slice && slice.hours || []).map((_, index) => ({ label: `Faixa ${index + 1}` }));
}

function jrSumSlices(list) {
  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  const bands = [];
  const bandAt = new Map();
  list.forEach(slice => {
    jrSliceBands(slice).forEach(band => {
      if (!bandAt.has(band.label)) {
        bandAt.set(band.label, bands.length);
        bands.push({ label: band.label, from: band.from, to: band.to });
      }
    });
  });
  const hours = bands.map(() => 0);
  const subs = new Map();
  const ensure = name => {
    if (!subs.has(name)) subs.set(name, { name, days: [0, 0, 0, 0, 0, 0, 0], bands: bands.map(() => 0) });
    return subs.get(name);
  };
  let tickets = 0;
  list.forEach(slice => {
    (slice.weekdays || []).forEach((count, index) => { if (index < 7) weekdays[index] += count; });
    const sliceBands = jrSliceBands(slice);
    (slice.hours || []).forEach((count, index) => {
      const at = bandAt.get(sliceBands[index] && sliceBands[index].label);
      if (at != null) hours[at] += count;
    });
    tickets += slice.tickets || 0;
    (slice.subsidiaries || []).forEach(rec => {
      const row = ensure(rec.name);
      (rec.days || []).forEach((count, index) => { if (index < 7) row.days[index] += count; });
      (rec.bands || []).forEach((count, index) => {
        const at = bandAt.get(sliceBands[index] && sliceBands[index].label);
        if (at != null) row.bands[at] += count;
      });
    });
  });
  const subsidiaries = Array.from(subs.values()).sort((a, b) => {
    const total = rec => rec.days.reduce((sum, count) => sum + count, 0);
    return total(b) - total(a) || a.name.localeCompare(b.name, 'pt');
  });
  return { weekdays, hours, bands, subsidiaries, tickets };
}

function jrCountTable(caption, items, quantity) {
  const body = items.map(item => `<tr><th>${jrEsc(item.label)}</th><td class="num">${item.value}</td></tr>`).join('');
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const head = quantity || 'Mudanças';
  return `<div class="table-wrap rp-fit"><table class="table table-sm table-dark table-bordered mb-0 rp-table">
    <thead><tr><th>${jrEsc(caption)}</th><th>${jrEsc(head)}</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><th>Total</th><th class="num">${total}</th></tr></tfoot>
  </table></div>`;
}

function jrRenderMetrics() {
  const host = document.getElementById('jrMetrics');
  if (!host) return;
  if (jrState.loading || typeof jiraSearch === 'undefined') {
    host.innerHTML = '';
    return;
  }
  const hasCurrent = !!(jrState.info && !jrState.error);
  if (!hasCurrent && !jrState.savedDays.length) {
    host.innerHTML = '';
    return;
  }
  let metrics;
  let summaryMetrics;
  let source;
  const ownSaved = jrSavedForCurrent();
  if (jrState.period === 'saved') {
    const chosen = ownSaved.filter(day => jrState.picked.has(jrDayKey(day)));
    const slices = chosen.map(day => (day.counts && (day.counts[jrState.transition] || day.counts.all)) || { weekdays: [], hours: [], tickets: 0 });
    const allSlices = chosen.map(day => (day.counts && day.counts.all) || { weekdays: [], hours: [], tickets: 0 });
    metrics = jrSumSlices(slices);
    summaryMetrics = jrSumSlices(allSlices);
    source = chosen.length
      ? 'Números lidos do arquivo, só Request → To do e Request → Clarification dessa pessoa, sem nova consulta ao Jira.'
      : 'Escolha ao menos um dia salvo dessa pessoa.';
  } else {
    metrics = jiraSearch.metricsForRows(jrState.issues, jrCurrentUser(), jrState.transition, jrState.range);
    summaryMetrics = jiraSearch.metricsForRows(jrState.issues, jrCurrentUser(), 'all', jrState.range);
    const from = jrState.range ? jrState.range.timeFrom : '';
    const to = jrState.range ? jrState.range.timeTo : '';
    source = `Números da consulta atual, no mesmo filtro da tabela, entre ${from} e ${to}.`;
  }
  const noun = metrics.tickets === 1 ? 'mudança' : 'mudanças';
  const savedBoxes = ownSaved.map(day => {
    const key = jrDayKey(day);
    const checked = jrState.picked.has(key) ? ' checked' : '';
    const label = `${jrFmt(day.date)} ${jrWeekdayLabel(day.date)} · ${day.user}`;
    return `<label class="rp-check"><input type="checkbox" data-jr-picked="${jrEsc(key)}"${checked}${jrState.period === 'saved' ? '' : ' disabled'}> ${jrEsc(label)}</label>`;
  }).join('');
  const subBoards = JR_SUBS.map(name => `<h4 class="m-0 mt-4">${jrEsc(name)}</h4>${jrMetricPair(jrSubCounts(metrics, name), metrics.bands, name)}${jrExtraTables(name)}`).join('');
  host.innerHTML = `<div class="section-card">
    <div class="section-title">
      <i class="bi bi-bar-chart text-accent fs-4"></i>
      <h4 class="m-0">Métricas</h4>
    </div>
    <div class="jr-days mb-2">
      <label class="rp-check"><input type="radio" name="jrPeriod" value="current"${jrState.period === 'current' ? ' checked' : ''}${hasCurrent ? '' : ' disabled'}> Consulta atual</label>
      <label class="rp-check"><input type="radio" name="jrPeriod" value="saved"${jrState.period === 'saved' ? ' checked' : ''}${ownSaved.length ? '' : ' disabled'}> Dias salvos</label>
    </div>
    <div class="jr-days mb-3">${savedBoxes}</div>
    <p class="muted mb-3">${metrics.tickets} ${noun} dele na faixa escolhida, no horário de Brasília. ${jrEsc(source)} Cada mudança entra em um dia e em uma faixa.</p>
    <h4 class="m-0 mb-3">Todas Subs</h4>
    ${jrMetricPair(metrics, metrics.bands, '')}
    ${jrExtraTables('')}
    ${subBoards}
    ${jrSummary(summaryMetrics)}
  </div>`;
}

function jrSubMatch(value, name) {
  if (!name) return true;
  const key = jrFoldSub(name);
  return String(value || '').split(',').map(jrFoldSub).filter(Boolean).includes(key);
}

function jrSliceSubTotal(slice, name) {
  if (!name) return (slice && slice.tickets) || 0;
  let total = 0;
  ((slice && slice.subsidiaries) || []).forEach(rec => {
    if (!jrSubMatch(rec.name, name)) return;
    total += (rec.days || []).reduce((sum, count) => sum + (count || 0), 0);
  });
  return total;
}

function jrBlockStats(rows, name) {
  let todo = 0;
  let clarification = 0;
  let corrected = 0;
  (rows || []).forEach(row => {
    if (!jrSubMatch(row && row.subsidiary, name)) return;
    const changes = row && row.payload && Array.isArray(row.payload.statusChanges) ? row.payload.statusChanges : [];
    changes.forEach(change => {
      if (change.kind === 'todo') todo += 1;
      else if (change.kind === 'clarification') clarification += 1;
    });
    if (row.corrected) corrected += 1;
  });
  return { todo, clarification, corrected };
}

function jrStatsFor(name) {
  if (jrState.period !== 'saved') return jrBlockStats(jrState.issues, name);
  const chosen = jrSavedForCurrent().filter(day => jrState.picked.has(jrDayKey(day)));
  const sum = kind => chosen.reduce((total, day) => {
    const slice = day.counts && day.counts[kind];
    return total + jrSliceSubTotal(slice, name);
  }, 0);
  const dates = new Set(chosen.map(day => day.date));
  const rows = (jrState.issues || []).filter(row => {
    const changes = row && row.payload && row.payload.statusChanges || [];
    return changes.some(change => dates.has(change.date));
  });
  return { todo: sum('todo'), clarification: sum('clarification'), corrected: jrBlockStats(rows, name).corrected };
}

function jrPeriodDates() {
  if (jrState.period === 'saved') {
    return jrSavedForCurrent().filter(day => jrState.picked.has(jrDayKey(day))).map(day => day.date);
  }
  const info = jrState.info || {};
  const queried = Array.isArray(info.queried) ? info.queried : [];
  const saved = Array.isArray(info.saved) ? info.saved.map(day => day.date) : [];
  return [...new Set(queried.concat(saved))];
}

function jrPriorityCount(sub, dates) {
  const wanted = new Set(dates);
  return (jrState.notes || []).filter(note => (
    note && note.priority === true && wanted.has(note.date) && Array.isArray(note.subsidiaries) && note.subsidiaries.includes(sub)
  )).length;
}

function jrSlideTable() {
  const dates = jrPeriodDates();
  const rows = JR_SLIDE.map(item => {
    const stats = jrStatsFor(item.sub);
    return {
      code: item.code,
      tickets: stats.todo + stats.clarification,
      todo: stats.todo,
      clarification: stats.clarification,
      priority: jrPriorityCount(item.sub, dates)
    };
  });
  const total = rows.reduce((sum, row) => ({
    tickets: sum.tickets + row.tickets,
    todo: sum.todo + row.todo,
    clarification: sum.clarification + row.clarification,
    priority: sum.priority + row.priority
  }), { tickets: 0, todo: 0, clarification: 0, priority: 0 });
  const share = (count, tickets) => {
    const percent = tickets ? Math.round((count / tickets) * 100) : 0;
    return `${count} (${percent}%)`;
  };
  const line = (label, row) => `<tr><th>${jrEsc(label)}</th><td class="num">${row.tickets}</td><td class="num">${share(row.todo, row.tickets)}</td><td class="num">${share(row.clarification, row.tickets)}</td><td class="num">${row.priority}</td></tr>`;
  const body = rows.map(row => line(row.code, row)).join('');
  return `<div class="table-wrap rp-fit"><table class="table table-sm table-dark table-bordered mb-0 rp-table">
    <thead><tr><th>Sub</th><th>Tickets (quantidade)</th><th>To do</th><th>Clarification</th><th>Priority request</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot>${line('Total', total)}</tfoot>
  </table></div>`;
}

function jrExtraTables(name) {
  const stats = jrStatsFor(name);
  const types = jrCountTable('Tipo de movimentação', [
    { label: 'Request → To do', value: stats.todo },
    { label: 'Request → Clarification', value: stats.clarification }
  ]);
  const fixed = jrCountTable('Tickets corrigidos', [
    { label: 'Clarification → Request → To do', value: stats.corrected }
  ], 'Tickets');
  if (name) {
    return `<div class="rp-pair mt-3">
      <div class="rp-pane">${types}</div>
      <div class="rp-pane">${fixed}</div>
    </div>
    ${jrPromotionTable(name)}`;
  }
  return `<div class="rp-pair mt-3">
    <div class="rp-pane">${types}<div class="mt-3">${fixed}</div></div>
    <div class="rp-pane">${jrSlideTable()}</div>
  </div>
  ${jrLeadSentences()}
  ${jrPromotionTable('')}`;
}

function jrPromotionSource() {
  const issues = Array.isArray(jrState.issues) ? jrState.issues : [];
  if (jrState.period !== 'saved') return issues;
  const dates = new Set(jrPeriodDates());
  return issues.map(row => {
    const changes = (row && row.payload && row.payload.statusChanges || []).filter(change => dates.has(change && change.date));
    return { ...row, payload: { ...(row.payload || {}), statusChanges: changes } };
  });
}

function jrPromotionTable(name) {
  const items = typeof jiraSearch !== 'undefined' && jiraSearch.promotionCounts
    ? jiraSearch.promotionCounts(jrPromotionSource(), name, jrCurrentUser())
    : [];
  return `<div class="mt-3">${jrCountTable('Type of promotion', items, 'Quantity')}</div>`;
}

function jrTied(items) {
  const ranked = (items || []).filter(item => item && item.value > 0 && item.label);
  if (!ranked.length) return { names: 'none', value: 0 };
  const max = Math.max(...ranked.map(item => item.value));
  return {
    names: ranked.filter(item => item.value === max).map(item => item.label).join(', '),
    value: max
  };
}

function jrClockLabel(minutes) {
  const hour = Math.floor(Number(minutes) / 60);
  const minute = Number(minutes) % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function jrRangeLabel(bands) {
  if (jrState.range && jrState.range.timeFrom && jrState.range.timeTo) {
    return `${jrState.range.timeFrom}–${jrState.range.timeTo}`;
  }
  const list = (bands || []).filter(band => Number.isFinite(Number(band.from)) && Number.isFinite(Number(band.to)));
  if (!list.length) return 'the selected period';
  const from = Math.min(...list.map(band => Number(band.from)));
  const to = Math.max(...list.map(band => Number(band.to)));
  return `${jrClockLabel(from)}–${jrClockLabel(to)}`;
}

function jrAllMetrics() {
  if (jrState.period === 'saved') {
    const slices = jrSavedForCurrent()
      .filter(day => jrState.picked.has(jrDayKey(day)))
      .map(day => (day.counts && day.counts.all) || { weekdays: [], hours: [], tickets: 0 });
    return jrSumSlices(slices);
  }
  if (typeof jiraSearch === 'undefined') return { weekdays: [], hours: [], bands: [] };
  return jiraSearch.metricsForRows(jrState.issues, jrCurrentUser(), 'all', jrState.range);
}

function jrNightOverlap(bands) {
  return (bands || []).some(band => Number(band.to) > 18 * 60 && Number(band.from) < 24 * 60);
}

function jrLeadSentences() {
  const metrics = jrAllMetrics();
  const dates = jrPeriodDates();
  const night = jrNightOverlap(metrics.bands);
  const subs = JR_SLIDE.map(item => {
    const stats = jrStatsFor(item.sub);
    return {
      label: item.code,
      tickets: stats.todo + stats.clarification,
      priority: night ? jrPriorityCount(item.sub, dates) : 0
    };
  });
  const subsidiary = jrTied(subs.map(row => ({ label: row.label, value: row.tickets })));
  const band = jrTied((metrics.bands || []).map((item, index) => ({
    label: item.label,
    value: (metrics.hours || [])[index] || 0
  })));
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const weekday = jrTied(weekdays.map((label, index) => ({
    label,
    value: (metrics.weekdays || [])[index] || 0
  })));
  const priority = jrTied(subs.map(row => ({ label: row.label, value: row.priority })));
  const range = jrRangeLabel(metrics.bands);
  return `<div class="mt-3">
    <p class="mb-1">The subsidiary with the most tickets in the period ${jrEsc(range)} was ${jrEsc(subsidiary.names)} with ${subsidiary.value}.</p>
    <p class="mb-1">The period with the most tickets is ${jrEsc(band.names)} with ${band.value}.</p>
    <p class="mb-1">The weekday with the most tickets was ${jrEsc(weekday.names)}.</p>
    <p class="mb-0">The subsidiary with the most priority requests in the night period (tickets from 18:00 onward) was ${jrEsc(priority.names)} with ${priority.value}.</p>
  </div>`;
}

function jrFoldSub(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function jrSubCounts(metrics, name) {
  const key = jrFoldSub(name);
  const days = [0, 0, 0, 0, 0, 0, 0];
  const hours = (metrics.bands || []).map(() => 0);
  (metrics.subsidiaries || []).forEach(rec => {
    const parts = String(rec.name || '').split(',').map(jrFoldSub).filter(Boolean);
    if (!parts.includes(key)) return;
    (rec.days || []).forEach((count, index) => { if (index < 7) days[index] += count || 0; });
    (rec.bands || []).forEach((count, index) => { if (index < hours.length) hours[index] += count || 0; });
  });
  return { weekdays: days, hours };
}

function jrWeekdayIndex(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return -1;
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (utc.getUTCDay() + 6) % 7;
}

function jrAddWeekdays(target, counts) {
  (counts || []).forEach((count, index) => { if (index < 7) target[index] += count || 0; });
}

function jrWeekdaySplit(name) {
  const todo = [0, 0, 0, 0, 0, 0, 0];
  const clarification = [0, 0, 0, 0, 0, 0, 0];
  if (jrState.period === 'saved') {
    jrSavedForCurrent().filter(day => jrState.picked.has(jrDayKey(day))).forEach(day => {
      const counts = day.counts || {};
      jrAddWeekdays(todo, name ? jrSubDays(counts.todo, name) : (counts.todo && counts.todo.weekdays));
      jrAddWeekdays(clarification, name ? jrSubDays(counts.clarification, name) : (counts.clarification && counts.clarification.weekdays));
    });
    return { todo, clarification };
  }
  (jrState.issues || []).forEach(row => {
    const changes = row && row.payload && Array.isArray(row.payload.statusChanges) ? row.payload.statusChanges : [];
    changes.forEach(change => {
      if (!jrSubMatch(change && (change.subsidiary || row.subsidiary), name)) return;
      const index = jrWeekdayIndex(change && change.date);
      if (index < 0) return;
      if (change.kind === 'todo') todo[index] += 1;
      else if (change.kind === 'clarification') clarification[index] += 1;
    });
  });
  return { todo, clarification };
}

function jrSubDays(slice, name) {
  const days = [0, 0, 0, 0, 0, 0, 0];
  ((slice && slice.subsidiaries) || []).forEach(rec => {
    if (!jrSubMatch(rec.name, name)) return;
    jrAddWeekdays(days, rec.days);
  });
  return days;
}

function jrWeekdayTable(name) {
  const split = jrWeekdaySplit(name);
  const body = JR_DAY_SHORT.map((label, index) => {
    const todo = split.todo[index] || 0;
    const clarification = split.clarification[index] || 0;
    return `<tr><th>${jrEsc(label)}</th><td class="num">${todo}</td><td class="num">${clarification}</td><td class="num">${todo + clarification}</td></tr>`;
  }).join('');
  const todoTotal = split.todo.reduce((sum, count) => sum + count, 0);
  const clarTotal = split.clarification.reduce((sum, count) => sum + count, 0);
  return `<div class="table-wrap rp-fit"><table class="table table-sm table-dark table-bordered mb-0 rp-table">
    <thead><tr><th>Dia</th><th>To do</th><th>Clarification</th><th>Mudanças</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><th>Total</th><th class="num">${todoTotal}</th><th class="num">${clarTotal}</th><th class="num">${todoTotal + clarTotal}</th></tr></tfoot>
  </table></div>`;
}

function jrMetricPair(counts, bands, name) {
  const hours = (bands || []).map((band, index) => ({ label: band.label, value: (counts.hours || [])[index] || 0 }));
  return `<div class="rp-pair">
    <div class="rp-pane">${jrWeekdayTable(name)}</div>
    <div class="rp-pane">${jrCountTable('Hora', hours)}</div>
  </div>`;
}

function jrSummary(metrics) {
  const leaders = jiraSearch.metricLeaders(metrics || {});
  return `<div class="mt-4">
    <p class="mb-1"><strong>Sub com mais tickets noturnos:</strong> ${jrEsc(leaders.nightSubsidiary)}</p>
    <p class="mb-0"><strong>Faixa de horário com mais tickets:</strong> ${jrEsc(leaders.busiestBand)}</p>
  </div>`;
}

function jrMoveText(row, transition) {
  const changes = (row.payload && row.payload.statusChanges) || [];
  const kept = transition === 'todo' || transition === 'clarification'
    ? changes.filter(change => change.kind === transition)
    : changes;
  return kept.map(change => change.text || `${change.from || '—'} → ${change.to || '—'}`).join('\n');
}

function jrKeyCell(row) {
  const key = row.key || '—';
  if (!row.url) return jrEsc(key);
  return `<a class="jr-key" href="${jrEsc(row.url)}" target="_blank" rel="noopener">${jrEsc(key)}</a>`;
}

function jrRenderResults() {
  const message = document.getElementById('jrMessage');
  const meta = document.getElementById('jrMeta');
  const table = document.getElementById('jrTable');
  const payload = document.getElementById('jrPayload');
  const button = document.getElementById('jrSearch');
  if (!message || !meta || !table || !payload || !button) return;
  jrRenderMetrics();
  button.disabled = jrState.loading;
  button.innerHTML = jrState.loading
    ? '<i class="bi bi-hourglass-split"></i> Consultando…'
    : '<i class="bi bi-search"></i> Consultar';

  const counts = typeof jiraSearch !== 'undefined'
    ? jiraSearch.countMoves(jrState.issues)
    : { all: 0, todo: 0, clarification: 0 };
  const countAll = document.getElementById('jrCountAll');
  const countTodo = document.getElementById('jrCountTodo');
  const countClar = document.getElementById('jrCountClar');
  if (countAll) countAll.textContent = jrState.info ? ` (${counts.all})` : '';
  if (countTodo) countTodo.textContent = jrState.info ? ` (${counts.todo})` : '';
  if (countClar) countClar.textContent = jrState.info ? ` (${counts.clarification})` : '';

  if (jrState.loading) {
    message.innerHTML = '<p class="muted mb-0">Consultando o Jira…</p>';
    meta.innerHTML = '';
    table.innerHTML = '';
    payload.innerHTML = '';
    return;
  }
  if (jrState.error) {
    message.innerHTML = `<div class="result-banner result-fail"><i class="bi bi-exclamation-triangle-fill"></i><div><div class="result-title">Consulta não concluída</div><div class="result-sub">${jrEsc(jrState.error)}</div></div></div>`;
    meta.innerHTML = '';
    table.innerHTML = '';
    payload.innerHTML = '';
    return;
  }
  message.innerHTML = '';
  if (!jrState.info) {
    meta.innerHTML = '';
    table.innerHTML = '<p class="muted mb-0">Faça uma consulta para ver os tickets.</p>';
    payload.innerHTML = '';
    return;
  }

  const notes = [];
  if (jrState.info.truncated) notes.push('A busca atingiu o limite e pode haver mais tickets.');
  if (Array.isArray(jrState.info.saved) && jrState.info.saved.length) {
    const savedLabel = jrState.info.saved.map(day => jrFmt(day.date)).join(', ');
    notes.push(`Já salvo, sem nova consulta ao Jira: ${savedLabel}.`);
  }
  const visible = jrFilter(jrState.issues, jrState.transition);
  const selected = jrState.transition === 'todo' ? counts.todo : jrState.transition === 'clarification' ? counts.clarification : counts.all;
  const noun = selected === 1 ? 'mudança' : 'mudanças';
  meta.innerHTML = `<p class="muted mb-2">${selected} ${noun} neste filtro.</p>${notes.map(note => `<p class="muted mb-2">${jrEsc(note)}</p>`).join('')}`;
  table.innerHTML = visible.length ? `<div class="table-wrap"><table class="table table-sm table-dark table-bordered mb-0">
      <thead><tr><th>Key</th><th>Summary</th><th>Movimento</th></tr></thead>
      <tbody>${visible.map(row => `<tr>
        <td>${jrKeyCell(row)}</td>
        <td class="jr-summary" title="${jrEsc(row.summary)}">${jrEsc(row.summary || '—')}</td>
        <td class="jr-move">${jrEsc(jrMoveText(row, jrState.transition) || '—')}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted mb-0">Nenhum ticket para este filtro.</p>';

  const preview = {
    jql: jrState.info.jql,
    total: jrState.info.total,
    issues: jrState.issues.slice(0, 100).map(row => row.payload)
  };
  payload.innerHTML = `<details class="mt-3"><summary>Payload lido</summary><pre class="jr-payload">${jrEsc(JSON.stringify(preview, null, 2))}</pre></details>`;
}

async function jrConsult(event) {
  event.preventDefault();
  if (jrState.loading) return;
  const user = document.getElementById('jrUser').value.trim();
  const timeFrom = document.getElementById('jrFrom').value.slice(0, 5);
  const timeTo = document.getElementById('jrTo').value.slice(0, 5);
  const days = [...jrState.days];
  if (!user) {
    jrState.error = 'Informe o nome do usuário.';
    jrState.info = null;
    jrState.issues = [];
    jrRenderResults();
    return;
  }
  if (!timeFrom || !timeTo || timeFrom >= timeTo) {
    jrState.error = timeFrom && timeTo && timeFrom >= timeTo
      ? 'O horário final precisa ser depois do inicial.'
      : 'Informe a faixa de horário.';
    jrState.info = null;
    jrState.issues = [];
    jrRenderResults();
    return;
  }
  if (!days.length) {
    jrState.error = 'Escolha ao menos um dia.';
    jrState.info = null;
    jrState.issues = [];
    jrRenderResults();
    return;
  }
  jrSaveUser(user);
  jrState.loading = true;
  jrState.error = '';
  jrRenderResults();
  try {
    const response = await fetch('/api/jira/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ user, timeFrom, timeTo, days }),
      signal: AbortSignal.timeout(120000)
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) throw new Error(data && data.error || 'Não foi possível consultar o Jira.');
    jrState.info = data;
    jrState.range = { timeFrom, timeTo };
    jrState.issues = Array.isArray(data.issues) ? data.issues : [];
    jrState.error = '';
    jrState.period = 'current';
    jrMergeSaved(Array.isArray(data.saved) ? data.saved : []);
  } catch (err) {
    jrState.info = null;
    jrState.issues = [];
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      jrState.error = 'O Jira demorou demais para responder.';
    } else if (!err || err.message === 'Failed to fetch' || /NetworkError|Failed to fetch/i.test(err.message || '')) {
      jrState.error = 'Não foi possível consultar o Jira. Abra a ferramenta com node server.js.';
    } else {
      jrState.error = err.message || 'Não foi possível consultar o Jira.';
    }
  } finally {
    jrState.loading = false;
    jrRenderResults();
  }
}

function jrMergeSaved(days) {
  days.forEach(day => {
    const key = jrDayKey(day);
    jrState.savedDays = jrState.savedDays.filter(item => jrDayKey(item) !== key);
    jrState.savedDays.push(day);
    jrState.picked.add(key);
  });
  jrState.savedDays.sort((a, b) => a.date.localeCompare(b.date) || String(a.user).localeCompare(String(b.user), 'pt'));
}

async function jrLoadSaved() {
  try {
    const response = await fetch('/api/jira/metrics', { headers: { Accept: 'application/json' } });
    const data = await response.json();
    const days = data && Array.isArray(data.days) ? data.days : [];
    jrState.savedDays = days;
    jrState.notes = data && Array.isArray(data.notes) ? data.notes : [];
    days.forEach(day => jrState.picked.add(jrDayKey(day)));
    if (!jrState.info && days.length) jrState.period = 'saved';
  } catch {
    /* a lista salva fica vazia se o servidor local não responder */
  }
  jrRenderResults();
  jrRenderNotes();
}

function jrSelectedDay() {
  const active = document.querySelector('#rpDays [data-rp-day].active');
  if (!active) return { id: '', date: '', name: '' };
  const name = active.querySelector('.country-tab-name');
  return {
    id: active.dataset.rpDay || '',
    date: active.dataset.rpDate || '',
    name: name ? name.textContent.trim() : ''
  };
}

function jrNoteDateValue() {
  const input = document.getElementById('jrNoteDate');
  if (input && /^\d{4}-\d{2}-\d{2}$/.test(input.value)) return input.value;
  return jrSelectedDay().date;
}

function jrSyncNoteDate(force) {
  const input = document.getElementById('jrNoteDate');
  const selected = jrSelectedDay();
  if (!input || !selected.date) return;
  if (force || !input.value) input.value = selected.date;
}

function jrRenderNotes() {
  const status = document.getElementById('jrNoteStatus');
  const list = document.getElementById('jrNoteList');
  const dayLine = document.getElementById('jrNoteDay');
  const date = jrNoteDateValue();
  if (dayLine) {
    dayLine.textContent = date ? `Esta anotação entra em ${jrFmt(date)}.` : 'Informe a data da anotação.';
  }
  if (status) status.textContent = jrState.noteStatus;
  if (!list) return;
  const notes = (Array.isArray(jrState.notes) ? jrState.notes : []).filter(note => note.date === date);
  if (!date) {
    list.innerHTML = '';
    return;
  }
  if (!notes.length) {
    list.innerHTML = '<p class="muted mb-0">Nenhuma anotação nesta data.</p>';
    return;
  }
  list.innerHTML = notes.map(note => `<article class="border rounded p-3 mb-2">
      <strong>${jrEsc(note.title)}</strong>
      <span class="muted"> · ${jrEsc(jrFmt(note.date))} · ${jrEsc((note.subsidiaries || []).join(', '))}${note.priority ? ' · Priority request' : ''}</span>
      <p class="mb-0 mt-2">${jrEsc(note.description).replace(/\n/g, '<br>')}</p>
    </article>`).join('');
}

async function jrSaveNote(event) {
  event.preventDefault();
  if (jrState.noteSaving) return;
  const title = document.getElementById('jrNoteTitle').value.trim();
  const description = document.getElementById('jrNoteBody').value.trim();
  const subsidiaries = [...document.querySelectorAll('input[name="jrNoteSub"]:checked')].map(box => box.value);
  const date = jrNoteDateValue();
  const priority = !!document.getElementById('jrNotePriority').checked;
  if (!date || !title || !description || !subsidiaries.length) {
    jrState.noteStatus = 'Informe a data, o título, a descrição e ao menos uma subsidiary.';
    jrRenderNotes();
    return;
  }
  jrState.noteSaving = true;
  jrState.noteStatus = 'Salvando…';
  jrRenderNotes();
  try {
    const response = await fetch('/api/jira/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ date, title, description, subsidiaries, priority })
    });
    const data = await response.json();
    if (!response.ok) throw new Error((data && data.error) || 'Não foi possível salvar a anotação.');
    jrState.notes = Array.isArray(data.notes) ? data.notes : [];
    document.getElementById('jrNoteTitle').value = '';
    document.getElementById('jrNoteBody').value = '';
    document.querySelectorAll('input[name="jrNoteSub"]').forEach(box => { box.checked = false; });
    document.getElementById('jrNotePriority').checked = false;
    jrState.noteStatus = `Anotação salva em ${jrFmt(date)}.`;
    jrRenderResults();
  } catch (err) {
    jrState.noteStatus = err.message || 'Não foi possível salvar a anotação.';
  } finally {
    jrState.noteSaving = false;
    jrRenderNotes();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const screen = document.getElementById('jrForm');
    if (!screen) return;
    const today = jrToday();
    jrState.weekStart = jrMonday(today);
    jrState.days = new Set([today]);
    const savedUser = jrLoadUser();
    if (savedUser) document.getElementById('jrUser').value = savedUser;
    jrRenderSlots();
    jrRenderDays();
    jrSyncNoteDate(true);
    jrRenderResults();
    jrLoadSaved();

    document.getElementById('jrPrevWeek').addEventListener('click', () => {
      jrState.weekStart = jrAddDays(jrState.weekStart, -7);
      jrRenderDays();
    });
    document.getElementById('jrNextWeek').addEventListener('click', () => {
      jrState.weekStart = jrAddDays(jrState.weekStart, 7);
      jrRenderDays();
    });
    document.getElementById('jrDays').addEventListener('change', event => {
      const box = event.target.closest('[data-jr-day]');
      if (!box) return;
      if (box.checked) jrState.days.add(box.dataset.jrDay);
      else jrState.days.delete(box.dataset.jrDay);
    });
    document.getElementById('jrExtraDays').addEventListener('click', event => {
      const btn = event.target.closest('[data-jr-drop]');
      if (!btn) return;
      jrState.days.delete(btn.dataset.jrDrop);
      jrRenderDays();
    });
    document.getElementById('jrSlots').addEventListener('click', event => {
      const btn = event.target.closest('[data-jr-from]');
      if (!btn) return;
      document.getElementById('jrFrom').value = btn.dataset.jrFrom;
      document.getElementById('jrTo').value = btn.dataset.jrTo;
      jrRenderSlots();
    });
    document.getElementById('jrFrom').addEventListener('input', jrRenderSlots);
    document.getElementById('jrTo').addEventListener('input', jrRenderSlots);
    document.getElementById('jrUser').addEventListener('input', jrRenderResults);
    document.getElementById('jrForm').addEventListener('submit', jrConsult);
    document.getElementById('jrNoteForm').addEventListener('submit', jrSaveNote);
    const reportDays = document.getElementById('rpDays');
    if (reportDays) reportDays.addEventListener('click', () => {
      jrSyncNoteDate(true);
      jrRenderNotes();
    });
    const noteDate = document.getElementById('jrNoteDate');
    if (noteDate) noteDate.addEventListener('input', jrRenderNotes);
    const applyMove = event => {
      const radio = event.target.closest('input[name="jrMove"]');
      if (!radio) return;
      jrState.transition = radio.value;
      jrRenderResults();
    };
    document.getElementById('jrMoves').addEventListener('change', applyMove);
    document.getElementById('jrMoves').addEventListener('click', applyMove);
    const metrics = document.getElementById('jrMetrics');
    metrics.addEventListener('change', event => {
      const period = event.target.closest('input[name="jrPeriod"]');
      if (period) {
        jrState.period = period.value === 'saved' ? 'saved' : 'current';
        jrRenderResults();
        return;
      }
      const picked = event.target.closest('[data-jr-picked]');
      if (!picked) return;
      if (picked.checked) jrState.picked.add(picked.dataset.jrPicked);
      else jrState.picked.delete(picked.dataset.jrPicked);
      jrRenderResults();
    });
  });
}
