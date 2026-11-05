/* ===== Reports: relatório semanal de triagem (quatro faixas por dia) ===== */

const RP_STORAGE_KEY = 'sds-reports-v1';

const RP_DAYS = [
  { id: 'seg', name: 'Segunda' },
  { id: 'ter', name: 'Terça' },
  { id: 'qua', name: 'Quarta' },
  { id: 'qui', name: 'Quinta' },
  { id: 'sex', name: 'Sexta' },
  { id: 'sab', name: 'Sábado' },
  { id: 'dom', name: 'Domingo' }
];

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

function rpFindHeader(rows) {
  const n = Math.min(rows.length, 15);
  for (let i = 0; i < n; i++) {
    const norm = rows[i].cells.map(rpNorm);
    const hasKey = norm.some(c => c === 'key' || c === 'issuekey' || c === 'chave');
    const hasOther = norm.some(c => c === 'summary' || c === 'issuetype' || c === 'status' || c === 'coesubsidiaries' || c === 'assignee');
    if (hasKey && hasOther) return i;
  }
  return -1;
}

function rpFindCol(headers, names) {
  for (let i = 0; i < headers.length; i++) {
    if (names.some(n => headers[i] === n)) return i;
  }
  for (let i = 0; i < headers.length; i++) {
    if (names.some(n => n.length > 4 && headers[i].includes(n))) return i;
  }
  return -1;
}

function rpParseBox(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return { rows: [], count: 0, error: '', warning: '' };
  const sheet = rpSplitSheet(raw);
  if (!sheet || !sheet.rows.length) {
    return { rows: [], count: 0, error: 'Não foi possível ler a colagem.', warning: '' };
  }
  const headerAt = rpFindHeader(sheet.rows);
  if (headerAt < 0) {
    return { rows: [], count: 0, error: 'Cabeçalho Key não encontrado.', warning: '' };
  }
  const headers = sheet.rows[headerAt].cells.map(rpNorm);
  const keyIdx = rpFindCol(headers, ['key', 'issuekey', 'chave']);
  if (keyIdx < 0) {
    return { rows: [], count: 0, error: 'Cabeçalho Key não encontrado.', warning: '' };
  }
  const subIdx = rpFindCol(headers, ['coesubsidiaries', 'coesubsidiary']);
  const warning = subIdx < 0 ? 'Coluna COE_subsidiaries não encontrada.' : '';
  const seen = new Set();
  const rows = [];
  for (let i = headerAt + 1; i < sheet.rows.length; i++) {
    const cells = sheet.rows[i].cells;
    if (!cells.some(c => rpCleanCell(c))) continue;
    const key = rpKeyOf(cells[keyIdx]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const subsidiary = subIdx < 0
      ? '(sem COE_subsidiaries)'
      : (rpCleanCell(cells[subIdx]) || '(vazio)');
    rows.push({ key, subsidiary });
  }
  return { rows, count: rows.length, error: '', warning };
}

function rpDayById(id) {
  return RP_DAYS.find(d => d.id === id) || RP_DAYS[0];
}

function rpSlotById(id) {
  return RP_SLOTS.find(s => s.id === id) || RP_SLOTS[0];
}

// Cada caixa conta Key única. No dia, a Key entra uma vez na subsidiary da primeira faixa que a trouxe.
function rpBuildReport(texts) {
  const boxes = [];
  RP_DAYS.forEach(day => {
    RP_SLOTS.forEach(slot => {
      const parsed = rpParseBox(texts?.[day.id]?.[slot.id] || '');
      boxes.push({ day: day.id, slot: slot.id, ...parsed });
    });
  });

  const max = boxes.reduce((m, b) => Math.max(m, b.count), 0);
  const winners = max > 0 ? boxes.filter(b => b.count === max) : [];

  const subs = new Map();
  RP_DAYS.forEach(day => {
    const seen = new Map();
    RP_SLOTS.forEach(slot => {
      const box = boxes.find(b => b.day === day.id && b.slot === slot.id);
      box.rows.forEach(row => {
        if (!seen.has(row.key)) seen.set(row.key, row.subsidiary);
      });
    });
    seen.forEach(subsidiary => {
      if (!subs.has(subsidiary)) {
        const days = {};
        RP_DAYS.forEach(d => { days[d.id] = 0; });
        subs.set(subsidiary, { name: subsidiary, days, total: 0 });
      }
      const rec = subs.get(subsidiary);
      rec.days[day.id] += 1;
      rec.total += 1;
    });
  });

  const subsidiaries = Array.from(subs.values()).sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.name.localeCompare(b.name, 'pt');
  });

  return { boxes, max, winners, subsidiaries };
}

function rpWinnerLabel(winners) {
  return winners.map(w => `${rpDayById(w.day).name} ${rpSlotById(w.slot).label}`).join(', ');
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

function rpRenderReport() {
  const root = document.getElementById('rpReport');
  if (!root) return;
  const report = rpBuildReport(rpState.texts);
  const winSet = new Set(report.winners.map(w => `${w.day}:${w.slot}`));

  let banner;
  if (!report.winners.length) {
    banner = `<div class="result-banner result-wait"><i class="bi bi-bar-chart"></i><div><div class="result-title">Nenhuma faixa com tickets</div><div class="result-sub">Cole o Jira em alguma faixa.</div></div></div>`;
  } else if (report.winners.length === 1) {
    const w = report.winners[0];
    banner = `<div class="result-banner result-ok"><i class="bi bi-trophy"></i><div><div class="result-title">Faixa com mais tickets</div><div class="result-sub">${rpEsc(rpDayById(w.day).name)} ${rpEsc(rpSlotById(w.slot).label)} · ${w.count} ticket${w.count === 1 ? '' : 's'}</div></div></div>`;
  } else {
    banner = `<div class="result-banner result-ok"><i class="bi bi-trophy"></i><div><div class="result-title">Faixas empatadas no topo</div><div class="result-sub">${rpEsc(rpWinnerLabel(report.winners))} · ${report.max} tickets cada</div></div></div>`;
  }

  const head = RP_SLOTS.map(s => `<th>${rpEsc(s.label)}</th>`).join('');
  const body = RP_DAYS.map(day => {
    const cells = RP_SLOTS.map(slot => {
      const box = report.boxes.find(b => b.day === day.id && b.slot === slot.id);
      const win = winSet.has(`${day.id}:${slot.id}`) ? ' rp-win' : '';
      const label = box.error ? '—' : String(box.count);
      return `<td class="num${win}">${rpEsc(label)}</td>`;
    }).join('');
    return `<tr><th>${rpEsc(day.name)}</th>${cells}</tr>`;
  }).join('');

  let subsTable;
  if (!report.subsidiaries.length) {
    subsTable = `<p class="muted mb-0">Nenhum COE_subsidiaries ainda.</p>`;
  } else {
    const subHead = RP_DAYS.map(d => `<th>${rpEsc(d.name)}</th>`).join('');
    const subBody = report.subsidiaries.map(rec => {
      const days = RP_DAYS.map(d => `<td class="num">${rec.days[d.id]}</td>`).join('');
      return `<tr><th>${rpEsc(rec.name)}</th>${days}<td class="num">${rec.total}</td></tr>`;
    }).join('');
    subsTable = `<div class="table-wrap"><table class="table table-sm table-dark table-bordered mb-0">
      <thead><tr><th>COE_subsidiaries</th>${subHead}<th>Total</th></tr></thead>
      <tbody>${subBody}</tbody>
    </table></div>
    <p class="muted mt-2 mb-0">No dia, a Key conta uma vez. A subsidiary é a da primeira faixa do dia em que a Key apareceu. O total soma os dias.</p>`;
  }

  const saveNote = rpState.saveError ? `<p class="muted">${rpEsc(rpState.saveError)}</p>` : '';

  root.innerHTML = `
    ${banner}
    ${saveNote}
    <div class="section-card">
      <div class="section-title">
        <i class="bi bi-clock text-accent fs-4"></i>
        <h4 class="m-0">Tickets triados por faixa</h4>
      </div>
      <p class="muted mb-3">Cada número é a quantidade de Keys únicas daquela caixa. A marca verde é a faixa com mais tickets.</p>
      <div class="table-wrap"><table class="table table-sm table-dark table-bordered mb-0">
        <thead><tr><th>Dia</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>
    <div class="section-card">
      <div class="section-title">
        <i class="bi bi-diagram-3 text-accent fs-4"></i>
        <h4 class="m-0">COE_subsidiaries por dia</h4>
      </div>
      ${subsTable}
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
