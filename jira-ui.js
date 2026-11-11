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

function jrCountTable(caption, items) {
  const body = items.map(item => `<tr><th>${jrEsc(item.label)}</th><td class="num">${item.value}</td></tr>`).join('');
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return `<div class="table-wrap rp-fit"><table class="table table-sm table-dark table-bordered mb-0 rp-table">
    <thead><tr><th>${jrEsc(caption)}</th><th>Mudanças</th></tr></thead>
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
  const subBoards = JR_SUBS.map(name => `<h4 class="m-0 mt-4">${jrEsc(name)}</h4>${jrMetricPair(jrSubCounts(metrics, name), metrics.bands)}`).join('');
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
    ${jrMetricPair(metrics, metrics.bands)}
    ${subBoards}
    ${jrSummary(summaryMetrics)}
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

function jrMetricPair(counts, bands) {
  const days = JR_DAY_SHORT.map((label, index) => ({ label, value: (counts.weekdays || [])[index] || 0 }));
  const hours = (bands || []).map((band, index) => ({ label: band.label, value: (counts.hours || [])[index] || 0 }));
  return `<div class="rp-pair">
    <div class="rp-pane">${jrCountTable('Dia', days)}</div>
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

function jrRenderNotes() {
  const status = document.getElementById('jrNoteStatus');
  const list = document.getElementById('jrNoteList');
  const dayLine = document.getElementById('jrNoteDay');
  const selected = jrSelectedDay();
  const saved = selected.date
    ? jrState.savedDays.filter(day => day.date === selected.date)
    : [];
  if (dayLine) {
    if (!selected.date) {
      dayLine.textContent = '';
    } else {
      const metrics = saved.length
        ? `Métricas salvas neste dia: ${saved.map(day => day.user).join(', ')}.`
        : 'Nenhuma métrica salva neste dia ainda.';
      dayLine.textContent = `Esta anotação entra em ${selected.name}, ${jrFmt(selected.date)}, junto com as métricas desse dia. ${metrics}`;
    }
  }
  if (status) status.textContent = jrState.noteStatus;
  if (!list) return;
  const notes = (Array.isArray(jrState.notes) ? jrState.notes : []).filter(note => note.date === selected.date);
  if (!selected.date) {
    list.innerHTML = '';
    return;
  }
  if (!notes.length) {
    list.innerHTML = '<p class="muted mb-0">Nenhuma anotação neste dia.</p>';
    return;
  }
  list.innerHTML = notes.map(note => `<article class="border rounded p-3 mb-2">
      <strong>${jrEsc(note.title)}</strong>
      <span class="muted"> · ${jrEsc(jrFmt(note.date))} · ${jrEsc((note.subsidiaries || []).join(', '))}</span>
      <p class="mb-0 mt-2">${jrEsc(note.description).replace(/\n/g, '<br>')}</p>
    </article>`).join('');
}

async function jrSaveNote(event) {
  event.preventDefault();
  if (jrState.noteSaving) return;
  const title = document.getElementById('jrNoteTitle').value.trim();
  const description = document.getElementById('jrNoteBody').value.trim();
  const subsidiaries = [...document.querySelectorAll('input[name="jrNoteSub"]:checked')].map(box => box.value);
  const selected = jrSelectedDay();
  if (!selected.date || !title || !description || !subsidiaries.length) {
    jrState.noteStatus = 'Informe título, descrição e ao menos uma subsidiary.';
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
      body: JSON.stringify({ date: selected.date, title, description, subsidiaries })
    });
    const data = await response.json();
    if (!response.ok) throw new Error((data && data.error) || 'Não foi possível salvar a anotação.');
    jrState.notes = Array.isArray(data.notes) ? data.notes : [];
    document.getElementById('jrNoteTitle').value = '';
    document.getElementById('jrNoteBody').value = '';
    document.querySelectorAll('input[name="jrNoteSub"]').forEach(box => { box.checked = false; });
    jrState.noteStatus = `Anotação salva em ${jrFmt(selected.date)}.`;
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
    if (reportDays) reportDays.addEventListener('click', () => jrRenderNotes());
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
