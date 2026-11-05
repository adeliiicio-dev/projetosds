/* ===== Reports: relatório semanal de triagem (quatro faixas por dia) ===== */

const RP_STORAGE_KEY = 'sds-reports-v1';

const RP_DAYS = [
  { id: 'seg', name: 'Segunda', short: 'Seg' },
  { id: 'ter', name: 'Terça', short: 'Ter' },
  { id: 'qua', name: 'Quarta', short: 'Qua' },
  { id: 'qui', name: 'Quinta', short: 'Qui' },
  { id: 'sex', name: 'Sexta', short: 'Sex' },
  { id: 'sab', name: 'Sábado', short: 'Sáb' },
  { id: 'dom', name: 'Domingo', short: 'Dom' }
];

const RP_KEY_COL = 0;
const RP_SUB_COL = 8;

const RP_SLOTS = [
  { id: 'h18', label: '18h–19h' },
  { id: 'h19', label: '19h–20h' },
  { id: 'h20', label: '20h–21h' },
  { id: 'h21', label: '21h–22h' }
];

const rpState = {
  day: 'seg',
  texts: {}
};

function rpBlankTexts() {
  const texts = {};
  RP_DAYS.forEach(d => {
    texts[d.id] = {};
    RP_SLOTS.forEach(s => { texts[d.id][s.id] = ''; });
  });
  return texts;
}

function rpFold(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function rpNorm(text) {
  return rpFold(text).replace(/[^a-z0-9]/g, '');
}

function rpEsc(s) {
  if (typeof escapeHtml === 'function') return escapeHtml(s);
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function rpDecodeHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rpCleanCell(s) {
  let t = String(s ?? '').replace(/\u00a0/g, ' ').trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1).replace(/""/g, '"').trim();
  }
  return t.replace(/\s+/g, ' ').trim();
}

function rpKeyOf(raw) {
  const m = String(raw || '').toUpperCase().match(/[A-Z][A-Z0-9]+-\d+/);
  if (m) return m[0];
  const t = rpCleanCell(raw);
  return t ? t.toUpperCase() : '';
}

function rpSplitDelimited(line, delim) {
  const s = String(line ?? '');
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQ && s[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delim && !inQ) {
      out.push(rpCleanCell(cur));
      cur = '';
    } else cur += ch;
  }
  out.push(rpCleanCell(cur));
  return out;
}

function rpDelimScore(lines, delim) {
  const widths = lines.map(s => rpSplitDelimited(s, delim).length);
  const freq = new Map();
  widths.forEach(w => { if (w > 1) freq.set(w, (freq.get(w) || 0) + 1); });
  let width = 1;
  let hits = 0;
  freq.forEach((n, w) => { if (n > hits || (n === hits && w > width)) { hits = n; width = w; } });
  return { width, hits };
}

function rpSheetFromHtml(html) {
  const raw = String(html || '');
  if (!/<table/i.test(raw)) return null;
  const tables = raw.match(/<table[\s\S]*?<\/table>/gi) || [];
  let best = null;
  tables.forEach(table => {
    const rows = [];
    const trs = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    trs.forEach(tr => {
      const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(rpDecodeHtml);
      if (cells.some(c => c)) rows.push({ cells });
    });
    const width = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
    if (width >= 2 && (!best || width > best.width || (width === best.width && rows.length > best.rows.length))) {
      best = { rows, width };
    }
  });
  if (!best) return null;
  best.rows.forEach(r => { while (r.cells.length < best.width) r.cells.push(''); });
  return best;
}

function rpSplitSheet(text) {
  const htmlSheet = rpSheetFromHtml(text);
  if (htmlSheet && htmlSheet.width >= 2) return htmlSheet;
  const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')
    .map(s => s.replace(/\u00a0/g, ' '))
    .filter(s => s.trim() !== '');
  if (!lines.length) return null;
  const sample = lines.slice(0, 25);
  let best = { delim: '\t', ...rpDelimScore(sample, '\t') };
  [';', ',', '|'].forEach(d => {
    const score = rpDelimScore(sample, d);
    if (score.hits > best.hits || (score.hits === best.hits && score.width > best.width)) {
      best = { delim: d, ...score };
    }
  });
  const delim = best.width >= 2 ? best.delim : '\t';
  const rows = lines.map(line => ({ cells: rpSplitDelimited(line, delim) }));
  const width = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
  rows.forEach(r => { while (r.cells.length < width) r.cells.push(''); });
  return { rows, width };
}

function rpRowsToTsv(rows) {
  return rows.map(r => r.cells.map(c => String(c ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t')).join('\n');
}

function rpIsHeaderRow(cells) {
  const norm = (cells || []).map(rpNorm);
  if (norm[0] === 'key' || norm[0] === 'issuekey' || norm[0] === 'chave') return true;
  const names = ['key', 'summary', 'status', 'created', 'reporter', 'assignee', 'coesubsidiaries', 'actions'];
  return names.filter(n => norm.includes(n)).length >= 3;
}

function rpParseBox(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return { rows: [], count: 0, error: '', warning: '' };
  const sheet = rpSplitSheet(raw);
  if (!sheet || !sheet.rows.length) {
    return { rows: [], count: 0, error: 'Não foi possível ler a colagem.', warning: '' };
  }
  const seen = new Set();
  const rows = [];
  sheet.rows.forEach(row => {
    if (rpIsHeaderRow(row.cells)) return;
    const key = rpKeyOf(row.cells[RP_KEY_COL]);
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key) || seen.has(key)) return;
    seen.add(key);
    rows.push({ key, subsidiary: rpCleanCell(row.cells[RP_SUB_COL]) || '(vazio)' });
  });
  const warning = rows.length ? '' : 'Nenhuma Key na colagem.';
  return { rows, count: rows.length, error: '', warning };
}

function rpFmt(n) {
  const rounded = Math.round(n * 10) / 10;
  const [whole, frac] = rounded.toFixed(1).split('.');
  return frac === '0' ? whole : `${whole},${frac}`;
}

function rpShort(text, max) {
  const t = String(text || '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function rpDayById(id) {
  return RP_DAYS.find(d => d.id === id) || RP_DAYS[0];
}

function rpSlotById(id) {
  return RP_SLOTS.find(s => s.id === id) || RP_SLOTS[0];
}

// Key única dentro da faixa. A mesma Key em outra faixa conta de novo, na subsidiary daquela faixa.
function rpBuildReport(texts) {
  const boxes = [];
  RP_DAYS.forEach(day => {
    RP_SLOTS.forEach(slot => {
      const parsed = rpParseBox(texts?.[day.id]?.[slot.id] || '');
      boxes.push({ day: day.id, slot: slot.id, ...parsed });
    });
  });

  const subs = new Map();
  const touchSub = name => {
    if (!subs.has(name)) {
      const days = {};
      RP_DAYS.forEach(d => { days[d.id] = 0; });
      subs.set(name, { name, days, total: 0 });
    }
    return subs.get(name);
  };
  boxes.forEach(box => {
    box.rows.forEach(row => {
      const rec = touchSub(row.subsidiary);
      rec.days[box.day] += 1;
      rec.total += 1;
    });
  });

  const subsidiaries = Array.from(subs.values()).sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.name.localeCompare(b.name, 'pt');
  });

  const dayTotals = RP_DAYS.map(day => ({
    id: day.id,
    total: boxes.filter(b => b.day === day.id).reduce((sum, b) => sum + b.count, 0)
  }));
  const periodTotals = RP_SLOTS.map(slot => ({
    id: slot.id,
    total: boxes.filter(b => b.slot === slot.id).reduce((sum, b) => sum + b.count, 0)
  }));
  const total = dayTotals.reduce((sum, d) => sum + d.total, 0);
  const periodMax = periodTotals.reduce((m, p) => Math.max(m, p.total), 0);
  const periodWinners = periodMax > 0 ? periodTotals.filter(p => p.total === periodMax) : [];
  const subMax = subsidiaries.reduce((m, s) => Math.max(m, s.total), 0);
  const subWinners = subMax > 0 ? subsidiaries.filter(s => s.total === subMax) : [];
  const boxMax = boxes.reduce((m, b) => Math.max(m, b.count), 0);
  const boxWinners = boxMax > 0 ? boxes.filter(b => b.count === boxMax) : [];

  return {
    boxes, subsidiaries, dayTotals, periodTotals, total,
    periodMax, periodWinners, subMax, subWinners, boxMax, boxWinners,
    averagePerDay: total / RP_DAYS.length,
    averagePerPeriod: total / RP_SLOTS.length
  };
}

function rpLoad() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = JSON.parse(localStorage.getItem(RP_STORAGE_KEY));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

function rpSave() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(RP_STORAGE_KEY, JSON.stringify({ day: rpState.day, texts: rpState.texts }));
    rpState.saveError = '';
  } catch {
    rpState.saveError = 'Não coube no navegador. O relatório desta aba continua valendo.';
  }
}

function rpHydrate() {
  rpState.texts = rpBlankTexts();
  const saved = rpLoad();
  if (!saved) return;
  if (RP_DAYS.some(d => d.id === saved.day)) rpState.day = saved.day;
  RP_DAYS.forEach(d => {
    RP_SLOTS.forEach(s => {
      const value = saved.texts?.[d.id]?.[s.id];
      if (typeof value === 'string') rpState.texts[d.id][s.id] = value;
    });
  });
}

function rpDayCount(dayId) {
  return RP_SLOTS.reduce((sum, slot) => sum + rpParseBox(rpState.texts[dayId][slot.id]).count, 0);
}

function rpRenderDays() {
  const root = document.getElementById('rpDays');
  if (!root) return;
  root.innerHTML = RP_DAYS.map(d => {
    const n = rpDayCount(d.id);
    const status = n ? `${n} ticket${n === 1 ? '' : 's'}` : 'vazio';
    return `<button type="button" class="country-tab${d.id === rpState.day ? ' active' : ''}" data-rp-day="${d.id}">
      <span class="country-tab-name">${rpEsc(d.name)}</span>
      <span class="country-tab-status${n ? ' saved' : ''}">${status}</span>
    </button>`;
  }).join('');
}

function rpSlotMeta(parsed) {
  if (parsed.error) return { cls: 'bad', text: parsed.error };
  if (!parsed.count && !parsed.warning) return { cls: '', text: 'Vazio' };
  const base = `${parsed.count} ticket${parsed.count === 1 ? '' : 's'}`;
  if (parsed.warning) return { cls: 'warn', text: `${base}. ${parsed.warning}` };
  return { cls: 'ok', text: base };
}

function rpRenderSlots() {
  const root = document.getElementById('rpSlots');
  const title = document.getElementById('rpDayTitle');
  if (!root) return;
  const day = rpDayById(rpState.day);
  if (title) title.textContent = day.name;
  root.innerHTML = RP_SLOTS.map(slot => {
    const parsed = rpParseBox(rpState.texts[day.id][slot.id]);
    const meta = rpSlotMeta(parsed);
    return `<div class="rp-slot">
      <div class="rp-slot-label">${rpEsc(slot.label)}</div>
      <textarea class="form-control pumi-textarea" rows="6" data-rp-slot="${slot.id}"
        placeholder="Cole o Jira das ${rpEsc(slot.label)}..." spellcheck="false"></textarea>
      <div class="rp-slot-meta ${meta.cls}" data-rp-meta="${slot.id}">${rpEsc(meta.text)}</div>
    </div>`;
  }).join('');
  root.querySelectorAll('textarea[data-rp-slot]').forEach(el => {
    el.value = rpState.texts[day.id][el.dataset.rpSlot] || '';
  });
}

function rpUpdateSlotMeta(slotId) {
  const el = document.querySelector(`[data-rp-meta="${slotId}"]`);
  if (!el) return;
  const meta = rpSlotMeta(rpParseBox(rpState.texts[rpState.day][slotId]));
  el.className = `rp-slot-meta ${meta.cls}`;
  el.textContent = meta.text;
}

function rpBars(items) {
  const max = Math.max(1, ...items.map(it => it.value));
  const rowH = 26;
  const width = 360;
  const labelW = 78;
  const height = Math.max(items.length * rowH, rowH);
  const bars = items.map((it, i) => {
    const y = i * rowH;
    const bw = it.value ? Math.max(2, (it.value / max) * (width - labelW - 36)) : 0;
    const color = it.win && it.value > 0 ? '#34d399' : '#6b86ff';
    return `<g>
      <title>${rpEsc(it.label)}: ${it.value}</title>
      <text x="0" y="${y + 16}" fill="#cdd5ff" font-size="11" font-family="Inter, sans-serif">${rpEsc(rpShort(it.label, 12))}</text>
      <rect x="${labelW}" y="${y + 4}" width="${bw}" height="16" rx="4" fill="${color}"></rect>
      <text x="${labelW + bw + 6}" y="${y + 16}" fill="#f8fafc" font-size="11" font-family="Inter, sans-serif">${it.value}</text>
    </g>`;
  }).join('');
  return `<svg class="rp-chart" viewBox="0 0 ${width} ${height}" role="img">${bars}</svg>`;
}

function rpNames(list, labelOf) {
  if (!list.length) return 'Nenhum';
  return list.map(labelOf).join(', ');
}

function rpRenderReport() {
  const root = document.getElementById('rpReport');
  if (!root) return;
  const report = rpBuildReport(rpState.texts);
  const winPeriods = new Set(report.periodWinners.map(p => p.id));
  const winSubs = new Set(report.subWinners.map(s => s.name));

  const slotHead = RP_SLOTS.map(s => `<th class="${winPeriods.has(s.id) ? 'rp-win' : ''}">${rpEsc(s.label)}</th>`).join('');
  const slotBody = RP_DAYS.map(day => {
    const dayTotal = report.dayTotals.find(d => d.id === day.id).total;
    const cells = RP_SLOTS.map(slot => {
      const box = report.boxes.find(b => b.day === day.id && b.slot === slot.id);
      return `<td class="num${winPeriods.has(slot.id) && box.count ? ' rp-win' : ''}">${box.count}</td>`;
    }).join('');
    return `<tr><th>${rpEsc(day.short)}</th>${cells}<td class="num">${dayTotal}</td></tr>`;
  }).join('');
  const slotFoot = RP_SLOTS.map(slot => {
    const n = report.periodTotals.find(p => p.id === slot.id).total;
    return `<th class="num${winPeriods.has(slot.id) && n ? ' rp-win' : ''}">${n}</th>`;
  }).join('');
  const slotChart = rpBars(RP_DAYS.map(day => {
    const value = report.dayTotals.find(d => d.id === day.id).total;
    const maxDay = Math.max(...report.dayTotals.map(d => d.total));
    return { label: day.short, value, win: value > 0 && value === maxDay };
  }));

  const subHead = RP_DAYS.map(d => `<th>${rpEsc(d.short)}</th>`).join('');
  const subBody = report.subsidiaries.map(rec => {
    const days = RP_DAYS.map(d => `<td class="num">${rec.days[d.id]}</td>`).join('');
    const win = winSubs.has(rec.name) ? ' rp-win' : '';
    return `<tr><th class="${win}">${rpEsc(rec.name)}</th>${days}<td class="num${win}">${rec.total}</td></tr>`;
  }).join('');
  const subDayFoot = RP_DAYS.map(day => `<th class="num">${report.dayTotals.find(d => d.id === day.id).total}</th>`).join('');
  const subTable = report.subsidiaries.length
    ? `<table class="table table-sm table-dark table-bordered mb-0 rp-table">
        <thead><tr><th>COE</th>${subHead}<th>Total</th></tr></thead>
        <tbody>${subBody}</tbody>
        <tfoot><tr><th>Total</th>${subDayFoot}<th class="num">${report.total}</th></tr></tfoot>
      </table>`
    : `<p class="muted mb-0">Nenhum COE_subsidiaries ainda.</p>`;
  const subChart = rpBars((report.subsidiaries.length ? report.subsidiaries : [{ name: '—', total: 0 }]).map(rec => ({
    label: rec.name,
    value: rec.total,
    win: winSubs.has(rec.name)
  })));

  const periodLabel = rpNames(report.periodWinners, p => `${rpSlotById(p.id).label} (${p.total})`);
  const subLabel = rpNames(report.subWinners, s => `${s.name} (${s.total})`);
  const weekChart = rpBars(RP_SLOTS.map(slot => {
    const value = report.periodTotals.find(p => p.id === slot.id).total;
    return { label: slot.label, value, win: winPeriods.has(slot.id) && value > 0 };
  }));
  const saveNote = rpState.saveError ? `<p class="muted">${rpEsc(rpState.saveError)}</p>` : '';

  root.innerHTML = `
    ${saveNote}
    <div class="section-card">
      <div class="section-title">
        <i class="bi bi-calendar-week text-accent fs-4"></i>
        <h4 class="m-0">Semana</h4>
      </div>
      <div class="rp-stats">
        <div class="rp-stat"><span>Total de tickets</span><strong>${report.total}</strong></div>
        <div class="rp-stat"><span>Média por dia</span><strong>${rpFmt(report.averagePerDay)}</strong><em>total ÷ 7</em></div>
        <div class="rp-stat"><span>Média por período</span><strong>${rpFmt(report.averagePerPeriod)}</strong><em>total ÷ 4</em></div>
        <div class="rp-stat"><span>Período com mais tickets</span><strong>${rpEsc(periodLabel)}</strong><em>Sub que mais demandou: ${rpEsc(subLabel)}</em></div>
      </div>
      <div class="rp-pair">
        <div class="rp-pane"><div class="rp-chart-wrap">${weekChart}</div></div>
        <div class="rp-pane"><div class="rp-chart-wrap">${subChart}</div></div>
      </div>
    </div>
    <div class="section-card">
      <div class="section-title">
        <i class="bi bi-clock text-accent fs-4"></i>
        <h4 class="m-0">Tickets triados por faixa</h4>
      </div>
      <p class="muted mb-3">Total: ${report.total} ticket${report.total === 1 ? '' : 's'}. A marca verde é o período com mais tickets na semana.</p>
      <div class="rp-pair">
        <div class="rp-pane"><div class="table-wrap"><table class="table table-sm table-dark table-bordered mb-0 rp-table">
          <thead><tr><th>Dia</th>${slotHead}<th>Total</th></tr></thead>
          <tbody>${slotBody}</tbody>
          <tfoot><tr><th>Total</th>${slotFoot}<th class="num">${report.total}</th></tr></tfoot>
        </table></div></div>
        <div class="rp-pane"><div class="rp-chart-wrap">${slotChart}</div></div>
      </div>
    </div>
    <div class="section-card">
      <div class="section-title">
        <i class="bi bi-diagram-3 text-accent fs-4"></i>
        <h4 class="m-0">COE_subsidiaries por dia</h4>
      </div>
      <p class="muted mb-3">Total: ${report.total} ticket${report.total === 1 ? '' : 's'}. O mesmo total da tabela de faixas.</p>
      <div class="rp-pair">
        <div class="rp-pane"><div class="table-wrap">${subTable}</div></div>
        <div class="rp-pane"><div class="rp-chart-wrap">${subChart}</div></div>
      </div>
    </div>`;
}

function rpRefresh() {
  rpRenderDays();
  rpRenderSlots();
  rpRenderReport();
}

function rpSetDay(dayId) {
  if (!RP_DAYS.some(d => d.id === dayId)) return;
  rpState.day = dayId;
  rpSave();
  rpRefresh();
}

function rpClearDay() {
  RP_SLOTS.forEach(s => { rpState.texts[rpState.day][s.id] = ''; });
  rpSave();
  rpRefresh();
}

function rpClearWeek() {
  rpState.texts = rpBlankTexts();
  rpSave();
  rpRefresh();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const screen = document.getElementById('screen-reports');
    if (!screen) return;
    rpHydrate();
    document.getElementById('rpDays').addEventListener('click', e => {
      const btn = e.target.closest('[data-rp-day]');
      if (btn) rpSetDay(btn.dataset.rpDay);
    });
    document.getElementById('rpSlots').addEventListener('input', e => {
      const box = e.target.closest('textarea[data-rp-slot]');
      if (!box) return;
      rpState.texts[rpState.day][box.dataset.rpSlot] = box.value;
      rpSave();
      rpUpdateSlotMeta(box.dataset.rpSlot);
      rpRenderDays();
      rpRenderReport();
    });
    document.getElementById('rpSlots').addEventListener('paste', e => {
      const box = e.target.closest('textarea[data-rp-slot]');
      if (!box || !e.clipboardData) return;
      const html = e.clipboardData.getData('text/html');
      const plain = e.clipboardData.getData('text/plain');
      const fromHtml = rpSheetFromHtml(html);
      const fromPlain = rpSplitSheet(plain || '');
      const htmlW = fromHtml ? fromHtml.width : 0;
      const plainW = fromPlain ? fromPlain.width : 0;
      if (fromHtml && htmlW >= 2 && htmlW >= plainW) {
        e.preventDefault();
        box.value = rpRowsToTsv(fromHtml.rows);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    document.getElementById('rpClearDay').addEventListener('click', rpClearDay);
    document.getElementById('rpClearWeek').addEventListener('click', rpClearWeek);
    rpRefresh();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rpParseBox, rpBuildReport, rpBlankTexts, RP_DAYS, RP_SLOTS };
}
