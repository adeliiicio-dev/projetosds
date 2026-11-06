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
const RP_CREATED_COL = 3;
const RP_UPDATED_COL = 4;
const RP_SUB_COL = 8;

const RP_MONTHS = {
  jan: 0, janeiro: 0, feb: 1, fev: 1, fevereiro: 1, mar: 2, marco: 2,
  apr: 3, abr: 3, abril: 3, may: 4, mai: 4, maio: 4, jun: 5, junho: 5,
  jul: 6, julho: 6, aug: 7, ago: 7, agosto: 7, sep: 8, set: 8, setembro: 8,
  oct: 9, out: 9, outubro: 9, nov: 10, novembro: 10, dec: 11, dez: 11, dezembro: 11
};

const RP_SLOTS = [
  { id: 'h18', label: '18h–19h' },
  { id: 'h19', label: '19h–20h' },
  { id: 'h20', label: '20h–21h' },
  { id: 'h21', label: '21h–22h' }
];

const RP_WEEKEND = new Set(['sab', 'dom']);

const rpState = {
  day: 'seg',
  texts: {},
  hideWeekend: false
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

function rpUtcDate(year, month, day) {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const time = Date.UTC(year, month, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return time;
}

function rpParseDate(raw) {
  const s = rpCleanCell(raw);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return rpUtcDate(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let year = +m[3];
    if (year < 100) year += 2000;
    return rpUtcDate(year, +m[2] - 1, +m[1]);
  }
  m = s.match(/^(\d{1,2})(?:\s+de)?[\s\/\-.]+([A-Za-zçÇ.]+)(?:\s+de)?[\s\/\-.]+(\d{2,4})/);
  if (m) {
    const month = RP_MONTHS[rpFold(m[2]).replace(/\./g, '')];
    if (month != null) {
      let year = +m[3];
      if (year < 100) year += 2000;
      return rpUtcDate(year, month, +m[1]);
    }
  }
  m = s.match(/^([A-Za-zçÇ.]+)\s+(\d{1,2}),?\s+(\d{2,4})/);
  if (m) {
    const month = RP_MONTHS[rpFold(m[1]).replace(/\./g, '')];
    if (month != null) {
      let year = +m[3];
      if (year < 100) year += 2000;
      return rpUtcDate(year, month, +m[2]);
    }
  }
  return null;
}

function rpFmtDate(time) {
  const date = new Date(time);
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
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
    const when = rpParseDate(row.cells[RP_UPDATED_COL]) ?? rpParseDate(row.cells[RP_CREATED_COL]);
    rows.push({ key, subsidiary: rpCleanCell(row.cells[RP_SUB_COL]) || '(vazio)', when });
  });
  const warning = rows.length ? '' : 'Nenhuma Key na colagem.';
  return { rows, count: rows.length, error: '', warning };
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
    localStorage.setItem(RP_STORAGE_KEY, JSON.stringify({
      day: rpState.day,
      texts: rpState.texts,
      hideWeekend: rpState.hideWeekend
    }));
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
  rpState.hideWeekend = saved.hideWeekend === true;
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
    const color = it.win && it.value > 0 ? '#f87171' : '#6b86ff';
    return `<g>
      <title>${rpEsc(it.label)}: ${it.value}</title>
      <text x="0" y="${y + 16}" fill="#cdd5ff" font-size="11" font-family="Inter, sans-serif">${rpEsc(rpShort(it.label, 12))}</text>
      <rect x="${labelW}" y="${y + 4}" width="${bw}" height="16" rx="4" fill="${color}"></rect>
      <text x="${labelW + bw + 6}" y="${y + 16}" fill="#f8fafc" font-size="11" font-family="Inter, sans-serif">${it.value}</text>
    </g>`;
  }).join('');
  return `<svg class="rp-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet" role="img">${bars}</svg>`;
}

function rpNames(list, labelOf) {
  if (!list.length) return 'Nenhum';
  return list.map(labelOf).join(', ');
}

function rpCoveredRange(report) {
  const dates = [];
  RP_DAYS.forEach(day => {
    const counts = new Map();
    report.boxes.filter(b => b.day === day.id).forEach(box => {
      box.rows.forEach(row => {
        if (row.when == null) return;
        counts.set(row.when, (counts.get(row.when) || 0) + 1);
      });
    });
    let best = null;
    let hits = 0;
    counts.forEach((n, time) => {
      if (n > hits || (n === hits && (best == null || time < best))) {
        best = time;
        hits = n;
      }
    });
    if (best != null) dates.push(best);
  });
  if (!dates.length) return '';
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  return min === max ? rpFmtDate(min) : `${rpFmtDate(min)} a ${rpFmtDate(max)}`;
}

function rpPeriodCountries(report, slotId) {
  const counts = new Map();
  report.boxes.filter(b => b.slot === slotId).forEach(box => {
    box.rows.forEach(row => {
      counts.set(row.subsidiary, (counts.get(row.subsidiary) || 0) + 1);
    });
  });
  return Array.from(counts, ([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'pt'));
}

function rpNiceMax(max) {
  if (max <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function rpMatrixChart(days, report) {
  const colors = ['#6b86ff', '#38bdf8', '#fbbf24', '#f87171'];
  const series = days.map(day => RP_SLOTS.map(slot => (
    report.boxes.find(b => b.day === day.id && b.slot === slot.id).count
  )));
  const max = rpNiceMax(Math.max(1, ...series.flat()));
  const n = Math.max(days.length, 1);
  const width = 560;
  const height = 248;
  const padL = 34;
  const padR = 10;
  const padT = 14;
  const padB = 28;
  const legendH = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB - legendH;
  const baseY = padT + plotH;
  const groupW = plotW / n;
  const inner = groupW * 0.8;
  const barW = inner / RP_SLOTS.length;
  const ticks = [0, max / 2, max].filter((v, i, list) => list.indexOf(v) === i);
  const grid = ticks.map(v => {
    const y = baseY - (v / max) * plotH;
    const label = Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
    return `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="#26327a" stroke-width="1"></line>
      <text x="${padL - 6}" y="${y + 4}" fill="#9aa6d6" font-size="10" text-anchor="end" font-family="Inter, sans-serif">${label}</text>`;
  }).join('');
  const groups = days.map((day, i) => {
    const x0 = padL + i * groupW + (groupW - inner) / 2;
    const bars = RP_SLOTS.map((slot, s) => {
      const value = series[i][s];
      const h = (value / max) * plotH;
      const x = x0 + s * barW + 1;
      const y = baseY - h;
      return `<g>
        <title>${rpEsc(day.short)} ${rpEsc(slot.label)}: ${value}</title>
        <rect x="${x}" y="${y}" width="${Math.max(barW - 2, 1)}" height="${h}" rx="2" fill="${colors[s]}"></rect>
      </g>`;
    }).join('');
    const labelX = padL + i * groupW + groupW / 2;
    return `${bars}<text x="${labelX}" y="${baseY + 16}" fill="#cdd5ff" font-size="11" text-anchor="middle" font-family="Inter, sans-serif">${rpEsc(day.short)}</text>`;
  }).join('');
  const legendW = 124;
  const legend = RP_SLOTS.map((slot, s) => {
    const x = padL + s * legendW;
    const y = height - 12;
    return `<rect x="${x}" y="${y - 8}" width="10" height="10" rx="2" fill="${colors[s]}"></rect>
      <text x="${x + 14}" y="${y}" fill="#cdd5ff" font-size="11" font-family="Inter, sans-serif">${rpEsc(slot.label)}</text>`;
  }).join('');
  return `<svg class="rp-chart rp-chart-matrix" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMinYMin meet" role="img">
    <title>Tickets por dia e faixa</title>
    ${grid}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${baseY}" stroke="#9aa6d6" stroke-width="1"></line>
    <line x1="${padL}" y1="${baseY}" x2="${width - padR}" y2="${baseY}" stroke="#9aa6d6" stroke-width="1"></line>
    ${groups}
    ${legend}
  </svg>`;
}

function rpSubDayPeaks(report) {
  const peaks = {};
  RP_DAYS.forEach(day => {
    const max = report.subsidiaries.reduce((m, rec) => Math.max(m, rec.days[day.id] || 0), 0);
    peaks[day.id] = max > 0
      ? report.subsidiaries.filter(rec => rec.days[day.id] === max).map(rec => rec.name)
      : [];
  });
  return peaks;
}

function rpDayPeaks(report) {
  const peaks = {};
  RP_DAYS.forEach(day => {
    const counts = RP_SLOTS.map(slot => ({
      id: slot.id,
      count: report.boxes.find(b => b.day === day.id && b.slot === slot.id).count
    }));
    const max = counts.reduce((m, c) => Math.max(m, c.count), 0);
    peaks[day.id] = max > 0 ? counts.filter(c => c.count === max).map(c => c.id) : [];
  });
  return peaks;
}

function rpRenderReport() {
  const root = document.getElementById('rpReport');
  if (!root) return;
  const report = rpBuildReport(rpState.texts);
  const dayPeaks = rpDayPeaks(report);
  const winPeriods = new Set(report.periodWinners.map(p => p.id));
  const winSubs = new Set(report.subWinners.map(s => s.name));

  const faixaDays = rpState.hideWeekend ? RP_DAYS.filter(d => !RP_WEEKEND.has(d.id)) : RP_DAYS;
  const faixaTotal = faixaDays.reduce((sum, day) => sum + report.dayTotals.find(d => d.id === day.id).total, 0);
  const faixaPeriods = RP_SLOTS.map(slot => ({
    id: slot.id,
    total: faixaDays.reduce((sum, day) => sum + report.boxes.find(b => b.day === day.id && b.slot === slot.id).count, 0)
  }));
  const slotHead = RP_SLOTS.map(s => `<th>${rpEsc(s.label)}</th>`).join('');
  const slotBody = faixaDays.map(day => {
    const dayTotal = report.dayTotals.find(d => d.id === day.id).total;
    const peaks = new Set(dayPeaks[day.id]);
    const cells = RP_SLOTS.map(slot => {
      const box = report.boxes.find(b => b.day === day.id && b.slot === slot.id);
      return `<td class="num${peaks.has(slot.id) ? ' rp-win' : ''}">${box.count}</td>`;
    }).join('');
    return `<tr><th>${rpEsc(day.short)}</th>${cells}<td class="num">${dayTotal}</td></tr>`;
  }).join('');
  const slotFoot = faixaPeriods.map(p => `<th class="num">${p.total}</th>`).join('');
  const slotChart = rpMatrixChart(faixaDays, report);

  const subHead = RP_DAYS.map(d => `<th>${rpEsc(d.short)}</th>`).join('');
  const subDayPeaks = rpSubDayPeaks(report);
  const subBody = report.subsidiaries.map(rec => {
    const days = RP_DAYS.map(d => {
      const win = subDayPeaks[d.id].includes(rec.name) ? ' rp-win' : '';
      return `<td class="num${win}">${rec.days[d.id]}</td>`;
    }).join('');
    return `<tr><th>${rpEsc(rec.name)}</th>${days}<td class="num">${rec.total}</td></tr>`;
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
  const periodCountries = report.periodWinners.map(p => {
    const parts = rpPeriodCountries(report, p.id).map(c => `${rpEsc(c.name)} ${c.total}`).join(' · ');
    const prefix = report.periodWinners.length > 1 ? `${rpEsc(rpSlotById(p.id).label)}: ` : '';
    return `<em>${prefix}${parts}</em>`;
  }).join('');
  const covered = rpCoveredRange(report);
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
        ${covered ? `<span class="rp-covered">${rpEsc(covered)}</span>` : ''}
      </div>
      <div class="rp-stats rp-stats-2">
        <div class="rp-stat"><span>Total de tickets</span><strong>${report.total}</strong></div>
        <div class="rp-stat"><span>Período com mais tickets</span><strong>${rpEsc(periodLabel)}</strong>${periodCountries}</div>
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
      <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <p class="muted mb-0">Total: ${faixaTotal} ticket${faixaTotal === 1 ? '' : 's'}. A marca vermelha é a faixa com mais tickets naquele dia.</p>
        <label class="rp-check no-print"><input type="checkbox" id="rpHideWeekend"${rpState.hideWeekend ? ' checked' : ''}> Ocultar fim de semana</label>
      </div>
      <div class="rp-pair">
        <div class="rp-pane"><div class="table-wrap rp-fit"><table class="table table-sm table-dark table-bordered mb-0 rp-table">
          <thead><tr><th>Dia</th>${slotHead}<th>Total</th></tr></thead>
          <tbody>${slotBody}</tbody>
          <tfoot><tr><th>Total</th>${slotFoot}<th class="num">${faixaTotal}</th></tr></tfoot>
        </table></div></div>
        <div class="rp-pane"><div class="rp-chart-wrap">${slotChart}</div></div>
      </div>
    </div>
    <div class="section-card rp-coe">
      <div class="section-title">
        <i class="bi bi-diagram-3 text-accent fs-4"></i>
        <h4 class="m-0">COE_subsidiaries por dia</h4>
      </div>
      <p class="muted mb-3">Total: ${report.total} ticket${report.total === 1 ? '' : 's'}. O mesmo total da tabela de faixas.</p>
      <div class="rp-pair">
        <div class="rp-pane"><div class="table-wrap">${subTable}</div></div>
        <div class="rp-pane"><div class="rp-chart-wrap rp-chart-left">${subChart}</div></div>
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
    document.getElementById('rpReport').addEventListener('change', e => {
      if (e.target.id !== 'rpHideWeekend') return;
      rpState.hideWeekend = e.target.checked;
      rpSave();
      rpRenderReport();
    });
    document.getElementById('rpPrint').addEventListener('click', () => window.print());
    rpRefresh();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    rpParseBox, rpBuildReport, rpBlankTexts, rpDayPeaks, rpSubDayPeaks,
    rpParseDate, rpCoveredRange, rpPeriodCountries, rpFmtDate,
    RP_DAYS, RP_SLOTS, RP_WEEKEND
  };
}
