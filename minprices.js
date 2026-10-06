/* ===== Minimum prices: colar planilha por país, reconhecer, salvar e provar ===== */

const MP_COUNTRIES = [
  { code: 'CL', name: 'Chile' },
  { code: 'CO', name: 'Colômbia' },
  { code: 'PE', name: 'Peru' },
  { code: 'MX', name: 'México' }
];

const MP_COLUMNS = ['modelCode', 'modelName', 'category', 'unit', 'minQuantityToPurchase', 'catalogVersion', 'minProductPrice'];
const MP_REQUIRED = ['modelCode', 'minProductPrice'];
const MP_STORAGE_KEY = 'sds.minPrices.v1';
const MP_PREVIEW_ROWS = 50;
const MP_SAVED_ROWS = 100;

const mpState = {
  country: 'CL',
  drafts: {},   // texto colado por país (só em memória)
  parsed: null,
  lastSave: null // { code, savedAt, expected, matched }
};

/* ---------- Leitura da planilha colada ---------- */

function mpNormKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mpStripQuotes(s) {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"').trim() : t;
}

// Converte "1.234,56", "1,234.56", "$ 1234.5", "12345" em número. Retorna null se não for número.
function mpParsePrice(raw) {
  let s = String(raw ?? '').trim().replace(/[^\d.,-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  if (dots && commas) {
    const decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thousandSep = decimalSep === '.' ? ',' : '.';
    s = s.split(thousandSep).join('').replace(decimalSep, '.');
  } else if (commas) {
    if (commas > 1 || /,\d{3}$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  } else if (dots > 1 || /^-?\d{1,3}\.\d{3}$/.test(s)) {
    s = s.replace(/\./g, ''); // "199.990" = milhar (padrão de Chile/Colômbia/Peru)
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function mpDetectDelimiter(line) {
  const counts = ['\t', ';', ','].map(d => ({ d, n: line.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : '\t';
}

function mpParse(text) {
  const lines = text.replace(/\r/g, '').split('\n')
    .map((content, i) => ({ content, lineNo: i + 1 }))
    .filter(l => l.content.trim() !== '');
  if (!lines.length) return null;

  // Procura a linha de cabeçalho (com modelCode) nas primeiras linhas.
  let headerIdx = -1, delim = '\t';
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const d = mpDetectDelimiter(lines[i].content);
    const cells = lines[i].content.split(d).map(c => mpNormKey(mpStripQuotes(c)));
    if (cells.includes('modelcode')) { headerIdx = i; delim = d; break; }
  }
  const headerFound = headerIdx >= 0;
  if (!headerFound) delim = mpDetectDelimiter(lines[0].content);

  const columns = {};
  let headerCells = [];
  if (headerFound) {
    headerCells = lines[headerIdx].content.split(delim).map(c => mpStripQuotes(c));
    const norm = headerCells.map(mpNormKey);
    MP_COLUMNS.forEach(col => { columns[col] = norm.indexOf(mpNormKey(col)); });
  } else {
    MP_COLUMNS.forEach((col, i) => { columns[col] = i; });
  }

  const dataLines = lines.slice(headerFound ? headerIdx + 1 : 0);
  const byCode = new Map();
  const ignored = [];
  const duplicates = new Map();

  const missingRequired = MP_REQUIRED.filter(c => columns[c] < 0);
  if (!missingRequired.length) {
    dataLines.forEach(({ content, lineNo }) => {
      const cells = content.split(delim).map(mpStripQuotes);
      const get = col => (columns[col] >= 0 ? (cells[columns[col]] ?? '') : '');
      const code = get('modelCode').trim();
      if (mpNormKey(code) === 'modelcode') return; // cabeçalho repetido
      if (!code) { ignored.push({ lineNo, reason: 'modelCode vazio', content }); return; }
      const rawPrice = get('minProductPrice');
      const price = mpParsePrice(rawPrice);
      if (price === null) {
        ignored.push({ lineNo, reason: `minProductPrice inválido: "${rawPrice}"`, content });
        return;
      }
      const key = code.toUpperCase();
      if (byCode.has(key)) {
        const d = duplicates.get(key) || { code, lines: [byCode.get(key).lineNo], prices: [byCode.get(key).minProductPrice] };
        d.lines.push(lineNo);
        d.prices.push(price);
        duplicates.set(key, d);
      }
      byCode.set(key, {
        lineNo, modelCode: code, modelName: get('modelName').trim(), category: get('category').trim(),
        unit: get('unit').trim(), minQuantityToPurchase: get('minQuantityToPurchase').trim(),
        catalogVersion: get('catalogVersion').trim(), minProductPriceRaw: rawPrice.trim(), minProductPrice: price
      });
    });
  }

  const rows = Array.from(byCode.values());
  const prices = rows.map(r => r.minProductPrice);
  return {
    delim, headerFound, headerCells, columns, missingRequired,
    totalLines: dataLines.length,
    rows, ignored, duplicates: Array.from(duplicates.values()),
    minPrice: prices.length ? Math.min(...prices) : null,
    maxPrice: prices.length ? Math.max(...prices) : null
  };
}

/* ---------- Armazenamento (localStorage do navegador) ---------- */

const MP_FIELDS = ['modelCode', 'modelName', 'category', 'unit', 'minQuantityToPurchase', 'catalogVersion', 'minProductPrice'];

function mpLoadAll() {
  try { return JSON.parse(localStorage.getItem(MP_STORAGE_KEY)) || {}; }
  catch { return {}; }
}

function mpSaveCountry(code, parsed) {
  const all = mpLoadAll();
  all[code] = {
    country: code,
    savedAt: new Date().toISOString(),
    fields: MP_FIELDS,
    rows: parsed.rows.map(r => MP_FIELDS.map(f => r[f]))
  };
  localStorage.setItem(MP_STORAGE_KEY, JSON.stringify(all)); // pode lançar erro de cota
  return all[code];
}

function mpDeleteCountry(code) {
  const all = mpLoadAll();
  delete all[code];
  localStorage.setItem(MP_STORAGE_KEY, JSON.stringify(all));
}

// Lê de volta do armazenamento e compara cada modelCode -> minProductPrice com o que foi colado.
function mpVerifySaved(code, parsed) {
  const saved = mpLoadAll()[code];
  const map = new Map();
  if (saved) {
    const iCode = saved.fields.indexOf('modelCode');
    const iPrice = saved.fields.indexOf('minProductPrice');
    saved.rows.forEach(r => map.set(String(r[iCode]).toUpperCase(), r[iPrice]));
  }
  let matched = 0;
  parsed.rows.forEach(r => {
    if (map.get(r.modelCode.toUpperCase()) === r.minProductPrice) matched++;
  });
  return { expected: parsed.rows.length, matched, stored: map.size };
}

/* ---------- Formatação ---------- */

function mpFmtNumber(n) {
  return n === null || n === undefined ? '-' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
}

function mpFmtDate(iso) {
  return iso ? new Date(iso).toLocaleString('pt-BR') : '-';
}

function mpCountryName(code) {
  return MP_COUNTRIES.find(c => c.code === code).name;
}

/* ---------- Renderização ---------- */

function mpRenderTabs() {
  const all = mpLoadAll();
  document.getElementById('mpTabs').innerHTML = MP_COUNTRIES.map(c => {
    const saved = all[c.code];
    return `
      <button type="button" class="country-tab ${c.code === mpState.country ? 'active' : ''}" data-country="${c.code}">
        <span class="country-tab-code">${c.code}</span>
        <span class="country-tab-name">${escapeHtml(c.name)}</span>
        <span class="country-tab-status ${saved ? 'saved' : ''}">${saved ? saved.rows.length + ' modelos' : 'sem dados'}</span>
      </button>`;
  }).join('');
}

function mpRenderRecognition() {
  const box = document.getElementById('mpRecognition');
  const saveBtn = document.getElementById('mpSave');
  const p = mpState.parsed;
  const name = mpCountryName(mpState.country);

  if (!p) {
    box.innerHTML = '';
    saveBtn.disabled = true;
    return;
  }

  const invalid = p.missingRequired.length > 0 || p.rows.length === 0;
  saveBtn.disabled = invalid;

  const banner = invalid
    ? `<div class="result-banner result-fail">
         <i class="bi bi-x-circle-fill"></i>
         <div>
           <div class="result-title">PLANILHA NÃO RECONHECIDA</div>
           <div class="result-sub">${p.missingRequired.length
             ? `Coluna obrigatória não encontrada: ${p.missingRequired.join(', ')}.`
             : 'Nenhuma linha válida (modelCode e minProductPrice preenchidos).'}</div>
         </div>
       </div>`
    : `<div class="result-banner result-ok">
         <i class="bi bi-check-circle-fill"></i>
         <div>
           <div class="result-title">PLANILHA RECONHECIDA</div>
           <div class="result-sub">${p.rows.length} modelos válidos para ${escapeHtml(name)}. Confira abaixo e clique em salvar.</div>
         </div>
       </div>`;

  const chips = MP_COLUMNS.map(col => {
    const idx = p.columns[col];
    const found = idx >= 0;
    const required = MP_REQUIRED.includes(col);
    const cls = found ? 'chip-ok' : (required ? 'chip-fail' : 'chip-warn');
    const where = found
      ? (p.headerFound ? `coluna ${idx + 1} ("${escapeHtml(p.headerCells[idx])}")` : `coluna ${idx + 1} (por posição)`)
      : (required ? 'NÃO ENCONTRADA' : 'não encontrada (opcional)');
    return `<div class="col-chip ${cls}"><strong>${col}</strong><span>${where}</span></div>`;
  }).join('');

  const dupWarn = p.duplicates.length
    ? `<div class="check-item check-info"><div class="check-head"><i class="bi bi-info-circle-fill"></i><strong>${p.duplicates.length} modelCode repetido(s)</strong><span>vale a última linha</span></div>
         <div class="check-evidence">${p.duplicates.slice(0, 10).map(d =>
           `<span class="ev-snippet"><mark>${escapeHtml(d.code)}</mark> linhas ${d.lines.join(', ')} · preços ${d.prices.map(mpFmtNumber).join(' / ')}</span>`).join('')}</div></div>`
    : '';

  const ignoredWarn = p.ignored.length
    ? `<div class="check-item check-fail"><div class="check-head"><i class="bi bi-x-circle-fill"></i><strong>${p.ignored.length} linha(s) ignorada(s)</strong><span>não serão salvas</span></div>
         <div class="check-evidence">${p.ignored.slice(0, 20).map(i =>
           `<span class="ev-snippet">linha ${i.lineNo}: <mark>${escapeHtml(i.reason)}</mark> · ${escapeHtml(i.content.slice(0, 120))}</span>`).join('')}
         ${p.ignored.length > 20 ? `<div class="muted small">... e mais ${p.ignored.length - 20}</div>` : ''}</div></div>`
    : '';

  const preview = p.rows.slice(0, MP_PREVIEW_ROWS);
  const table = `
    <div class="table-wrap mt-3">
      <table class="table table-sm table-dark table-bordered mb-0">
        <thead><tr><th>#</th>${MP_COLUMNS.map(c => `<th>${c}</th>`).join('')}<th>Preço lido</th></tr></thead>
        <tbody>${preview.map((r, i) => `
          <tr>
            <td class="muted">${i + 1}</td>
            <td title="${escapeHtml(r.modelCode)}"><strong>${escapeHtml(r.modelCode)}</strong></td>
            <td title="${escapeHtml(r.modelName)}">${escapeHtml(r.modelName)}</td>
            <td>${escapeHtml(r.category)}</td>
            <td>${escapeHtml(r.unit)}</td>
            <td>${escapeHtml(r.minQuantityToPurchase)}</td>
            <td>${escapeHtml(r.catalogVersion)}</td>
            <td>${escapeHtml(r.minProductPriceRaw)}</td>
            <td class="price-read">${mpFmtNumber(r.minProductPrice)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    ${p.rows.length > MP_PREVIEW_ROWS ? `<div class="muted small mt-2">Mostrando as primeiras ${MP_PREVIEW_ROWS} de ${p.rows.length} linhas.</div>` : ''}`;

  box.innerHTML = `
    ${banner}
    <div class="stats">
      <div class="stat"><span>Linhas lidas</span><strong>${p.totalLines}</strong></div>
      <div class="stat stat-ok"><span>Válidas</span><strong>${p.rows.length}</strong></div>
      <div class="stat ${p.ignored.length ? 'stat-fail' : ''}"><span>Ignoradas</span><strong>${p.ignored.length}</strong></div>
      <div class="stat"><span>Repetidas</span><strong>${p.duplicates.length}</strong></div>
      <div class="stat"><span>Menor preço</span><strong>${mpFmtNumber(p.minPrice)}</strong></div>
      <div class="stat"><span>Maior preço</span><strong>${mpFmtNumber(p.maxPrice)}</strong></div>
    </div>
    <div class="muted small mb-2">Cabeçalho ${p.headerFound ? 'encontrado' : 'NÃO encontrado (usei a ordem padrão das colunas)'} · separador: ${p.delim === '\t' ? 'tabulação (Excel)' : '"' + p.delim + '"'}</div>
    <div class="col-chips">${chips}</div>
    ${ignoredWarn}
    ${dupWarn}
    ${invalid ? '' : table}`;
}

function mpRenderSaveProof() {
  const box = document.getElementById('mpSaveProof');
  const s = mpState.lastSave;
  if (!s || s.code !== mpState.country) { box.innerHTML = ''; return; }
  const ok = s.matched === s.expected && s.expected > 0;
  box.innerHTML = `
    <div class="result-banner ${ok ? 'result-ok' : 'result-fail'} mt-3">
      <i class="bi ${ok ? 'bi-check-circle-fill' : 'bi-x-circle-fill'}"></i>
      <div>
        <div class="result-title">${ok ? 'SALVO' : 'FALHA AO SALVAR'}</div>
        <div class="result-sub">${escapeHtml(mpCountryName(s.code))} · ${mpFmtDate(s.savedAt)} ·
          conferência na leitura de volta: <strong>${s.matched} de ${s.expected}</strong> modelCode com o mesmo minProductPrice.</div>
      </div>
    </div>`;
}

function mpRenderSaved() {
  const all = mpLoadAll();
  const code = mpState.country;
  const name = mpCountryName(code);

  document.getElementById('mpSavedCards').innerHTML = MP_COUNTRIES.map(c => {
    const s = all[c.code];
    const prices = s ? s.rows.map(r => r[s.fields.indexOf('minProductPrice')]) : [];
    return `
      <div class="saved-card ${c.code === code ? 'active' : ''} ${s ? '' : 'empty'}">
        <div class="saved-card-head"><strong>${escapeHtml(c.name)}</strong><span>${c.code}</span></div>
        ${s ? `
          <div class="saved-card-count">${s.rows.length}<small> modelos</small></div>
          <div class="muted small">Preço mín.: ${mpFmtNumber(Math.min(...prices))} · máx.: ${mpFmtNumber(Math.max(...prices))}</div>
          <div class="muted small">Salvo em ${mpFmtDate(s.savedAt)}</div>`
          : '<div class="muted small mt-2">Nenhuma planilha salva.</div>'}
      </div>`;
  }).join('');

  const s = all[code];
  const tableBox = document.getElementById('mpSavedTable');
  document.getElementById('mpSavedTitle').textContent = `Dados salvos - ${name}`;
  document.getElementById('mpDelete').disabled = !s;
  document.getElementById('mpFilter').disabled = !s;

  if (!s) {
    tableBox.innerHTML = '<div class="muted">Nada salvo para este país ainda.</div>';
    return;
  }
  const q = mpNormKey(document.getElementById('mpFilter').value);
  const iCode = s.fields.indexOf('modelCode');
  const iName = s.fields.indexOf('modelName');
  const filtered = q ? s.rows.filter(r => mpNormKey(r[iCode]).includes(q) || mpNormKey(r[iName]).includes(q)) : s.rows;
  const shown = filtered.slice(0, MP_SAVED_ROWS);

  tableBox.innerHTML = `
    <div class="table-wrap">
      <table class="table table-sm table-dark table-bordered mb-0">
        <thead><tr>${s.fields.map(f => `<th>${f}</th>`).join('')}</tr></thead>
        <tbody>${shown.map(r => `<tr>${r.map((v, i) => i === s.fields.indexOf('minProductPrice')
          ? `<td class="price-read">${mpFmtNumber(v)}</td>`
          : `<td title="${escapeHtml(v)}">${escapeHtml(v)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="muted small mt-2">${filtered.length} de ${s.rows.length} modelos${filtered.length > MP_SAVED_ROWS ? ` (mostrando ${MP_SAVED_ROWS})` : ''}.</div>`;
}

function mpRenderAll() {
  const name = mpCountryName(mpState.country);
  document.getElementById('mpCardTitle').textContent = `Planilha do dia - ${name}`;
  document.getElementById('mpSave').innerHTML = `<i class="bi bi-save"></i> Salvar planilha de ${escapeHtml(name)}`;
  mpRenderTabs();
  mpRenderRecognition();
  mpRenderSaveProof();
  mpRenderSaved();
}

/* ---------- Ações ---------- */

function mpSelectCountry(code) {
  mpState.drafts[mpState.country] = document.getElementById('mpText').value;
  mpState.country = code;
  const text = mpState.drafts[code] || '';
  document.getElementById('mpText').value = text;
  document.getElementById('mpFilter').value = '';
  mpState.parsed = text.trim() ? mpParse(cleanInvisible(text)) : null;
  mpRenderAll();
}

function mpOnPaste() {
  const text = cleanInvisible(document.getElementById('mpText').value);
  mpState.parsed = text.trim() ? mpParse(text) : null;
  mpState.lastSave = null;
  mpRenderRecognition();
  mpRenderSaveProof();
}

function mpSave() {
  const p = mpState.parsed;
  if (!p || !p.rows.length) return;
  const code = mpState.country;
  const prev = mpLoadAll()[code];
  if (prev && !confirm(`Já existe planilha salva para ${mpCountryName(code)} (${prev.rows.length} modelos, ${mpFmtDate(prev.savedAt)}).\nSubstituir?`)) return;
  try {
    const saved = mpSaveCountry(code, p);
    const v = mpVerifySaved(code, p);
    mpState.lastSave = { code, savedAt: saved.savedAt, expected: v.expected, matched: v.matched };
  } catch (err) {
    alert('Não foi possível salvar (armazenamento do navegador cheio?): ' + err.message);
    return;
  }
  mpRenderTabs();
  mpRenderSaveProof();
  mpRenderSaved();
}

function mpDelete() {
  const code = mpState.country;
  if (!confirm(`Apagar os dados salvos de ${mpCountryName(code)}?`)) return;
  mpDeleteCountry(code);
  mpState.lastSave = null;
  mpRenderAll();
}

function mpClearText() {
  document.getElementById('mpText').value = '';
  mpState.drafts[mpState.country] = '';
  mpState.parsed = null;
  mpState.lastSave = null;
  mpRenderRecognition();
  mpRenderSaveProof();
}

document.addEventListener('DOMContentLoaded', () => {
  let timer;
  document.getElementById('mpText').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(mpOnPaste, 250);
  });
  document.getElementById('mpTabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-country]');
    if (btn) mpSelectCountry(btn.dataset.country);
  });
  document.getElementById('mpSave').addEventListener('click', mpSave);
  document.getElementById('mpClear').addEventListener('click', mpClearText);
  document.getElementById('mpDelete').addEventListener('click', mpDelete);
  document.getElementById('mpFilter').addEventListener('input', mpRenderSaved);
  mpRenderAll();
});

if (typeof module !== 'undefined') {
  module.exports = { mpParse, mpParsePrice };
}
