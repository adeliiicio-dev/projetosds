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
  error: ''
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

function jrSetGuide(id) {
  const weekly = document.getElementById('rpGuideSemanal');
  const v2 = document.getElementById('rpGuideV2');
  if (!weekly || !v2) return;
  weekly.classList.toggle('rp-guide-off', id !== 'semanal');
  v2.classList.toggle('rp-guide-off', id !== 'v2');
  document.querySelectorAll('[data-rp-guide]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.rpGuide === id);
  });
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
  button.disabled = jrState.loading;
  button.innerHTML = jrState.loading
    ? '<i class="bi bi-hourglass-split"></i> Consultando…'
    : '<i class="bi bi-search"></i> Consultar';

  const counts = {
    all: jrState.issues.length,
    todo: jrFilter(jrState.issues, 'todo').length,
    clarification: jrFilter(jrState.issues, 'clarification').length
  };
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
  const visible = jrFilter(jrState.issues, jrState.transition);
  const noun = visible.length === 1 ? 'ticket' : 'tickets';
  meta.innerHTML = `<p class="muted mb-2">${visible.length} ${noun} neste filtro.</p>${notes.map(note => `<p class="muted mb-2">${jrEsc(note)}</p>`).join('')}`;
  table.innerHTML = visible.length ? `<div class="table-wrap"><table class="table table-sm table-dark table-bordered mb-0">
      <thead><tr><th>Key</th><th>Summary</th><th>Status</th><th>Assignee</th><th>Movimento</th></tr></thead>
      <tbody>${visible.map(row => `<tr>
        <td>${jrKeyCell(row)}</td>
        <td class="jr-summary" title="${jrEsc(row.summary)}">${jrEsc(row.summary || '—')}</td>
        <td>${jrEsc(row.status || '—')}</td>
        <td>${jrEsc(row.assignee || '—')}</td>
        <td class="jr-move">${jrEsc(row.moveText || '—')}</td>
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
    jrState.issues = Array.isArray(data.issues) ? data.issues : [];
    jrState.error = '';
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

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const screen = document.getElementById('rpGuideV2');
    if (!screen) return;
    const today = jrToday();
    jrState.weekStart = jrMonday(today);
    jrState.days = new Set([today]);
    const savedUser = jrLoadUser();
    if (savedUser) document.getElementById('jrUser').value = savedUser;
    jrRenderSlots();
    jrRenderDays();
    jrRenderResults();

    document.getElementById('rpGuides').addEventListener('click', event => {
      const btn = event.target.closest('[data-rp-guide]');
      if (btn) jrSetGuide(btn.dataset.rpGuide);
    });
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
    document.getElementById('jrForm').addEventListener('submit', jrConsult);
    const applyMove = event => {
      const radio = event.target.closest('input[name="jrMove"]');
      if (!radio) return;
      jrState.transition = radio.value;
      jrRenderResults();
    };
    document.getElementById('jrMoves').addEventListener('change', applyMove);
    document.getElementById('jrMoves').addEventListener('click', applyMove);
  });
}
