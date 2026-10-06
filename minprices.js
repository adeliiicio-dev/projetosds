/* ===== Minimum prices: colar planilha por país, reconhecer, salvar e provar ===== */

const MP_COUNTRIES = [
  { code: 'CL', name: 'Chile', priceColumn: 'MSP' },                         // exceção: Chile usa MSP
  { code: 'CO', name: 'Colômbia', priceColumn: 'Minimum_Product_Price' },
  { code: 'PE', name: 'Peru', priceColumn: 'Minimum_Product_Price' },
  { code: 'MX', name: 'México', priceColumn: 'Minimum_Product_Price' }
];

const MP_KEY_COLUMN = 'Variant_Product';
const MP_CATALOG_COLUMN = 'Catalog_version';

const MP_COLUMNS = [
  'Variant_Product', 'Minimum_Product_Price', 'Catalog_version', 'Catalog_status',
  'Product_Division_Category', 'Sales Status', 'Approval Status', 'MSP',
  'allow Sync MSP Price', 'enable MSP Special Price Validation', 'BaseProduct', 'RRP'
];

const MP_STORAGE_KEY = 'sds.minPrices.v3';
const MP_PREVIEW_ROWS = 50;
const MP_SAVED_ROWS = 100;
const MP_NO_CATALOG = '(sem catálogo)';

const mpState = {
  country: 'CL',
  drafts: {},          // texto colado por país (só em memória)
  parsed: null,
  previewCatalog: '',  // filtro de catálogo na prévia ('' = todos)
  lastSave: null       // { code, savedAt, priceColumn, expected, matched }
};

function mpCountry(code) {
  return MP_COUNTRIES.find(c => c.code === (code || mpState.country));
}

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

// Lista os catálogos com a quantidade de modelos em cada um.
function mpCatalogsOf(rows) {
  const map = new Map();
  rows.forEach(r => map.set(r.catalog, (map.get(r.catalog) || 0) + 1));
  return Array.from(map, ([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// priceColumn: coluna de onde sai o preço salvo (depende do país).
function mpParse(text, priceColumn) {
  const lines = text.replace(/\r/g, '').split('\n')
    .map((content, i) => ({ content, lineNo: i + 1 }))
    .filter(l => l.content.trim() !== '');
  if (!lines.length) return null;

  const keyNorm = mpNormKey(MP_KEY_COLUMN);

  // Procura a linha de cabeçalho (com Variant_Product) nas primeiras linhas.
  let headerIdx = -1, delim = '\t';
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const d = mpDetectDelimiter(lines[i].content);
    const cells = lines[i].content.split(d).map(c => mpNormKey(mpStripQuotes(c)));
    if (cells.includes(keyNorm)) { headerIdx = i; delim = d; break; }
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

  const required = [MP_KEY_COLUMN, MP_CATALOG_COLUMN, priceColumn];
  const missingRequired = required.filter(c => columns[c] < 0);

  const dataLines = lines.slice(headerFound ? headerIdx + 1 : 0);
  const byKey = new Map();   // Variant_Product + Catalog_version
  let ignoredCount = 0;
  const conflicts = new Map();

  if (!missingRequired.length) {
    dataLines.forEach(({ content, lineNo }) => {
      const cells = content.split(delim).map(mpStripQuotes);
      const get = col => (cells[columns[col]] ?? '').trim();
      const variant = get(MP_KEY_COLUMN);
      if (mpNormKey(variant) === keyNorm) return; // cabeçalho repetido
      const price = mpParsePrice(get(priceColumn));
      if (!variant || price === null) { ignoredCount++; return; }
      const catalog = get(MP_CATALOG_COLUMN) || MP_NO_CATALOG;
      const key = variant.toUpperCase() + '||' + catalog.toUpperCase();
      const prev = byKey.get(key);
      if (prev && prev.price !== price) {
        const c = conflicts.get(key) || { variant, catalog, lines: [prev.lineNo], prices: [prev.price] };
        c.lines.push(lineNo);
        c.prices.push(price);
        conflicts.set(key, c);
      }
      byKey.set(key, { lineNo, variant, catalog, rawPrice: get(priceColumn), price });
    });
  }

  const rows = Array.from(byKey.values());
  return {
    priceColumn, delim, headerFound, headerCells, columns, missingRequired,
    rows, ignoredCount,
    catalogs: mpCatalogsOf(rows),
    conflicts: Array.from(conflicts.values())
  };
}

/* ---------- Armazenamento (localStorage do navegador) ---------- */

function mpLoadAll() {
  try { return JSON.parse(localStorage.getItem(MP_STORAGE_KEY)) || {}; }
  catch { return {}; }
}

// Salva por país: [Variant_Product, Catalog_version, preço] (preço da coluna priceColumn).
function mpSaveCountry(code, parsed) {
  const all = mpLoadAll();
  all[code] = {
    country: code,
    savedAt: new Date().toISOString(),
    priceColumn: parsed.priceColumn,
    rows: parsed.rows.map(r => [r.variant, r.catalog, r.price])
  };
  localStorage.setItem(MP_STORAGE_KEY, JSON.stringify(all)); // pode lançar erro de cota
  return all[code];
}

function mpDeleteCountry(code) {
  const all = mpLoadAll();
  delete all[code];
  localStorage.setItem(MP_STORAGE_KEY, JSON.stringify(all));
}

// Lê de volta do armazenamento e compara cada Variant_Product + catálogo -> preço com o que foi colado.
function mpVerifySaved(code, parsed) {
  const saved = mpLoadAll()[code];
  const map = new Map();
  if (saved) saved.rows.forEach(r => map.set(String(r[0]).toUpperCase() + '||' + String(r[1]).toUpperCase(), r[2]));
  let matched = 0;
  parsed.rows.forEach(r => {
    if (map.get(r.variant.toUpperCase() + '||' + r.catalog.toUpperCase()) === r.price) matched++;
  });
  return { expected: parsed.rows.length, matched };
}

function mpSavedCatalogs(saved) {
  return mpCatalogsOf(saved.rows.map(r => ({ catalog: r[1] })));
}

/* ---------- Formatação ---------- */

function mpFmtNumber(n) {
  return n === null || n === undefined ? '-' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
}

function mpFmtDate(iso) {
  return iso ? new Date(iso).toLocaleString('pt-BR') : '-';
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
        <span class="country-tab-status ${saved ? 'saved' : ''}">${saved ? saved.rows.length + ' registros' : 'sem dados'}</span>
      </button>`;
  }).join('');
}

function mpRenderNotice() {
  const c = mpCountry();
  const isException = c.priceColumn !== 'Minimum_Product_Price';
  document.getElementById('mpNotice').innerHTML = isException
    ? `<div class="check-item check-warn">
         <div class="check-head"><i class="bi bi-exclamation-triangle-fill"></i>
           <strong>Atenção: ${escapeHtml(c.name)} é exceção.</strong>
           <span>O preço salvo vem da coluna <mark class="mark-warn">${c.priceColumn}</mark>, e não de Minimum_Product_Price.</span></div>
       </div>`
    : `<div class="check-item check-info">
         <div class="check-head"><i class="bi bi-info-circle-fill"></i>
           <strong>${escapeHtml(c.name)}:</strong>
           <span>salva ${MP_KEY_COLUMN} + ${MP_CATALOG_COLUMN} + <mark>${c.priceColumn}</mark>.</span></div>
       </div>`;
}

function mpRenderRecognition() {
  const box = document.getElementById('mpRecognition');
  const saveBtn = document.getElementById('mpSave');
  const p = mpState.parsed;
  const c = mpCountry();

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
             : `Nenhuma linha com ${MP_KEY_COLUMN} e ${p.priceColumn} preenchidos.`}</div>
         </div>
       </div>`
    : `<div class="result-banner result-ok">
         <i class="bi bi-check-circle-fill"></i>
         <div>
           <div class="result-title">PLANILHA RECONHECIDA</div>
           <div class="result-sub">${escapeHtml(c.name)}: ${p.rows.length} registros em ${p.catalogs.length} catálogo(s). Confira abaixo e clique em salvar.</div>
         </div>
       </div>`;

  const chips = MP_COLUMNS.map(col => {
    const idx = p.columns[col];
    const found = idx >= 0;
    const role = col === MP_KEY_COLUMN ? 'CHAVE' : col === MP_CATALOG_COLUMN ? 'CATÁLOGO' : col === p.priceColumn ? 'PREÇO' : '';
    const cls = role ? (found ? 'chip-ok' : 'chip-fail') : (found ? '' : 'chip-off');
    const where = found
      ? (p.headerFound ? `coluna ${idx + 1}` : `coluna ${idx + 1} (por posição)`)
      : (role ? 'NÃO ENCONTRADA' : 'não encontrada');
    const tag = role ? `<em>${role} · salva</em>` : '<em class="off">não salva</em>';
    return `<div class="col-chip ${cls}"><strong>${col}</strong><span>${where}</span>${tag}</div>`;
  }).join('');

  let catalogBlock = '', table = '';
  if (!invalid) {
    const sel = mpState.previewCatalog;
    catalogBlock = `
      <div class="catalog-box">
        <div class="catalog-box-title"><i class="bi bi-collection"></i> Catalog_version encontrados em ${escapeHtml(c.name)}</div>
        <div class="catalog-list">
          <button type="button" class="catalog-pill ${sel === '' ? 'active' : ''}" data-catalog="">Todos <small>${p.rows.length}</small></button>
          ${p.catalogs.map(k => `<button type="button" class="catalog-pill ${sel === k.name ? 'active' : ''}" data-catalog="${escapeHtml(k.name)}">${escapeHtml(k.name)} <small>${k.count}</small></button>`).join('')}
        </div>
      </div>`;

    const filtered = sel ? p.rows.filter(r => r.catalog === sel) : p.rows;
    const preview = filtered.slice(0, MP_PREVIEW_ROWS);
    table = `
      <div class="table-wrap mt-3">
        <table class="table table-sm table-dark table-bordered mb-0">
          <thead><tr><th>#</th><th>${MP_KEY_COLUMN}</th><th>${MP_CATALOG_COLUMN}</th><th>${p.priceColumn} (como veio)</th><th>Preço lido (será salvo)</th></tr></thead>
          <tbody>${preview.map((r, i) => `
            <tr>
              <td class="muted">${i + 1}</td>
              <td><strong>${escapeHtml(r.variant)}</strong></td>
              <td>${escapeHtml(r.catalog)}</td>
              <td>${escapeHtml(r.rawPrice)}</td>
              <td class="price-read">${mpFmtNumber(r.price)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="muted small mt-2">${filtered.length > MP_PREVIEW_ROWS ? `Mostrando as primeiras ${MP_PREVIEW_ROWS} de ${filtered.length} registros.` : `${filtered.length} registros.`}</div>`;
  }

  const conflictWarn = p.conflicts.length
    ? `<div class="check-item check-warn mt-3"><div class="check-head"><i class="bi bi-exclamation-triangle-fill"></i><strong>${p.conflicts.length} ${MP_KEY_COLUMN} repetido(s) no mesmo catálogo com preços diferentes</strong><span>vale a última linha</span></div>
         <div class="check-evidence">${p.conflicts.slice(0, 10).map(d =>
           `<span class="ev-snippet"><mark>${escapeHtml(d.variant)}</mark> · ${escapeHtml(d.catalog)} · linhas ${d.lines.join(', ')} · preços ${d.prices.map(mpFmtNumber).join(' / ')}</span>`).join('')}</div></div>`
    : '';

  const ignoredNote = p.ignoredCount
    ? `<div class="muted small mt-2">${p.ignoredCount} linha(s) sem ${MP_KEY_COLUMN} ou sem preço válido não serão salvas.</div>`
    : '';

  box.innerHTML = `
    ${banner}
    <div class="col-chips">${chips}</div>
    ${catalogBlock}
    ${conflictWarn}
    ${table}
    ${ignoredNote}`;
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
        <div class="result-sub">${escapeHtml(mpCountry(s.code).name)} · ${mpFmtDate(s.savedAt)} · preço da coluna <strong>${s.priceColumn}</strong> ·
          conferência na leitura de volta: <strong>${s.matched} de ${s.expected}</strong> registros (${MP_KEY_COLUMN} + catálogo) com o mesmo preço.</div>
      </div>
    </div>`;
}

function mpRenderSaved() {
  const all = mpLoadAll();
  const code = mpState.country;
  const c = mpCountry();

  document.getElementById('mpSavedCards').innerHTML = MP_COUNTRIES.map(k => {
    const s = all[k.code];
    const cats = s ? mpSavedCatalogs(s) : [];
    return `
      <div class="saved-card ${k.code === code ? 'active' : ''} ${s ? '' : 'empty'}">
        <div class="saved-card-head"><strong>${escapeHtml(k.name)}</strong><span>${k.code}</span></div>
        ${s ? `
          <div class="saved-card-count">${s.rows.length}<small> registros</small></div>
          <div class="muted small">Preço de: <strong>${s.priceColumn}</strong></div>
          <div class="saved-card-cats">${cats.map(x => `<span class="catalog-tag">${escapeHtml(x.name)} <small>${x.count}</small></span>`).join('')}</div>
          <div class="muted small mt-1">Salvo em ${mpFmtDate(s.savedAt)}</div>`
          : '<div class="muted small mt-2">Nenhuma planilha salva.</div>'}
      </div>`;
  }).join('');

  const s = all[code];
  const tableBox = document.getElementById('mpSavedTable');
  const catSelect = document.getElementById('mpCatalogFilter');
  document.getElementById('mpSavedTitle').textContent = `Dados salvos - ${c.name}`;
  document.getElementById('mpDelete').disabled = !s;
  document.getElementById('mpFilter').disabled = !s;
  catSelect.disabled = !s;

  if (!s) {
    catSelect.innerHTML = '<option value="">Todos os catálogos</option>';
    tableBox.innerHTML = '<div class="muted">Nada salvo para este país ainda.</div>';
    return;
  }

  const prevSel = catSelect.value;
  const cats = mpSavedCatalogs(s);
  catSelect.innerHTML = '<option value="">Todos os catálogos</option>' +
    cats.map(x => `<option value="${escapeHtml(x.name)}">${escapeHtml(x.name)} (${x.count})</option>`).join('');
  catSelect.value = cats.some(x => x.name === prevSel) ? prevSel : '';

  const q = mpNormKey(document.getElementById('mpFilter').value);
  const cat = catSelect.value;
  const filtered = s.rows.filter(r => (!q || mpNormKey(r[0]).includes(q)) && (!cat || r[1] === cat));
  const shown = filtered.slice(0, MP_SAVED_ROWS);

  tableBox.innerHTML = `
    <div class="table-wrap">
      <table class="table table-sm table-dark table-bordered mb-0">
        <thead><tr><th>${MP_KEY_COLUMN}</th><th>${MP_CATALOG_COLUMN}</th><th>${s.priceColumn} (preço salvo)</th></tr></thead>
        <tbody>${shown.map(r => `<tr><td><strong>${escapeHtml(r[0])}</strong></td><td>${escapeHtml(r[1])}</td><td class="price-read">${mpFmtNumber(r[2])}</td></tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="muted small mt-2">${filtered.length} de ${s.rows.length} registros${filtered.length > MP_SAVED_ROWS ? ` (mostrando ${MP_SAVED_ROWS})` : ''}.</div>`;
}

function mpRenderAll() {
  const c = mpCountry();
  document.getElementById('mpCardTitle').textContent = `Planilha do dia - ${c.name}`;
  document.getElementById('mpSave').innerHTML = `<i class="bi bi-save"></i> Salvar planilha de ${escapeHtml(c.name)}`;
  mpRenderTabs();
  mpRenderNotice();
  mpRenderRecognition();
  mpRenderSaveProof();
  mpRenderSaved();
}

/* ---------- Ações ---------- */

function mpReparse() {
  const text = cleanInvisible(document.getElementById('mpText').value);
  mpState.parsed = text.trim() ? mpParse(text, mpCountry().priceColumn) : null;
  mpState.previewCatalog = '';
}

function mpSelectCountry(code) {
  mpState.drafts[mpState.country] = document.getElementById('mpText').value;
  mpState.country = code;
  document.getElementById('mpText').value = mpState.drafts[code] || '';
  document.getElementById('mpFilter').value = '';
  document.getElementById('mpCatalogFilter').value = '';
  mpReparse();
  mpRenderAll();
}

function mpOnPaste() {
  mpReparse();
  mpState.lastSave = null;
  mpRenderRecognition();
  mpRenderSaveProof();
}

function mpSave() {
  const p = mpState.parsed;
  if (!p || !p.rows.length) return;
  const code = mpState.country;
  const c = mpCountry();
  const prev = mpLoadAll()[code];
  if (prev && !confirm(`Já existe planilha salva para ${c.name} (${prev.rows.length} registros, ${mpFmtDate(prev.savedAt)}).\nSubstituir?`)) return;
  try {
    const saved = mpSaveCountry(code, p);
    const v = mpVerifySaved(code, p);
    mpState.lastSave = { code, savedAt: saved.savedAt, priceColumn: saved.priceColumn, expected: v.expected, matched: v.matched };
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
  if (!confirm(`Apagar os dados salvos de ${mpCountry(code).name}?`)) return;
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
  document.getElementById('mpRecognition').addEventListener('click', e => {
    const pill = e.target.closest('[data-catalog]');
    if (!pill) return;
    mpState.previewCatalog = pill.dataset.catalog;
    mpRenderRecognition();
  });
  document.getElementById('mpSave').addEventListener('click', mpSave);
  document.getElementById('mpClear').addEventListener('click', mpClearText);
  document.getElementById('mpDelete').addEventListener('click', mpDelete);
  document.getElementById('mpFilter').addEventListener('input', mpRenderSaved);
  document.getElementById('mpCatalogFilter').addEventListener('change', mpRenderSaved);
  mpRenderAll();
});

if (typeof module !== 'undefined') {
  module.exports = { mpParse, mpParsePrice };
}
