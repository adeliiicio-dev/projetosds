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
const MP_OVERRIDE_KEY = 'sds.minPriceOverrides.v1';
const MP_PREVIEW_ROWS = 50;
const MP_SAVED_ROWS = 100;
const MP_NO_CATALOG = '(sem catálogo)';

const mpState = {
  country: 'CL',
  drafts: {},          // texto colado por país (só em memória)
  overrideDrafts: {},
  parsed: null,
  overrideParsed: null,
  previewCatalog: '',  // filtro de catálogo na prévia ('' = todos)
  lastSave: null,      // { code, savedAt, priceColumn, expected, matched }
  lastOverrideSave: null
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

// Vírgula sempre é centavos. Ponto é milhar. "234.222,234" = 234222.234; "199.990" = 199990.
function mpParsePrice(raw) {
  let s = String(raw ?? '').trim().replace(/[^\d.,-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const comma = s.lastIndexOf(',');
  if (comma >= 0) {
    const intPart = s.slice(0, comma).replace(/[.,]/g, '');
    const frac = s.slice(comma + 1).replace(/\D/g, '');
    s = (intPart || '0') + (frac ? '.' + frac : '');
  } else if ((s.match(/\./g) || []).length > 1 || /^-?\d{1,3}\.\d{3}$/.test(s)) {
    s = s.replace(/\./g, '');
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

function mpLoadOverrides() {
  try { return JSON.parse(localStorage.getItem(MP_OVERRIDE_KEY)) || {}; }
  catch { return {}; }
}

function mpSaveOverrideCountry(code, rows) {
  const all = mpLoadOverrides();
  all[code] = { savedAt: new Date().toISOString(), rows };
  localStorage.setItem(MP_OVERRIDE_KEY, JSON.stringify(all));
  return all[code];
}

function mpMergeOverrideCountry(code, incoming) {
  const map = new Map();
  (mpLoadOverrides()[code]?.rows || []).forEach(r => map.set(String(r[0]).toUpperCase(), r));
  incoming.forEach(r => map.set(String(r[0]).toUpperCase(), [r[0], r[1]]));
  return mpSaveOverrideCountry(code, Array.from(map.values()));
}

function mpDeleteOverrides(code) {
  const all = mpLoadOverrides();
  delete all[code];
  localStorage.setItem(MP_OVERRIDE_KEY, JSON.stringify(all));
}

function mpOverrideMap(code) {
  const m = new Map();
  (mpLoadOverrides()[code]?.rows || []).forEach(r => m.set(String(r[0]).toUpperCase(), r[1]));
  return m;
}

function mpParseOverride(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n')
    .map((content, i) => ({ content, lineNo: i + 1 }))
    .filter(l => l.content.trim() !== '');
  if (!lines.length) return null;

  let headerIdx = -1, delim = '\t';
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const d = mpDetectDelimiter(lines[i].content);
    const cells = lines[i].content.split(d).map(c => mpNormKey(mpStripQuotes(c)));
    if (cells.includes('modelcode') || cells.includes('minproductprice') || cells.includes('variantproduct')) {
      headerIdx = i; delim = d; break;
    }
  }
  const headerFound = headerIdx >= 0;
  if (!headerFound) delim = mpDetectDelimiter(lines[0].content);

  let modelIdx = 0, priceIdx = 1;
  if (headerFound) {
    const norm = lines[headerIdx].content.split(delim).map(c => mpNormKey(mpStripQuotes(c)));
    const find = aliases => {
      for (const a of aliases) { const i = norm.indexOf(a); if (i >= 0) return i; }
      return -1;
    };
    modelIdx = find(['modelcode', 'variantproduct']);
    priceIdx = find(['minproductprice', 'minimumproductprice', 'msp']);
  }

  const missing = [];
  if (modelIdx < 0) missing.push('modelCode');
  if (priceIdx < 0) missing.push('minProductPrice');
  if (missing.length) return { headerFound, missing, rows: [] };

  const rows = [];
  const seen = new Map();
  lines.slice(headerFound ? headerIdx + 1 : 0).forEach(({ content, lineNo }) => {
    const cells = content.split(delim).map(mpStripQuotes);
    const model = String(cells[modelIdx] || '').trim();
    const rawPrice = cells[priceIdx] ?? '';
    const price = mpParsePrice(rawPrice);
    if (!model || price === null) return;
    if (mpNormKey(model) === 'modelcode') return;
    seen.set(model.toUpperCase(), { lineNo, model, rawPrice, price });
  });
  seen.forEach(r => rows.push(r));
  return { headerFound, missing: [], modelIdx, priceIdx, rows };
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
  const ov = mpLoadOverrides();
  document.getElementById('mpTabs').innerHTML = MP_COUNTRIES.map(c => {
    const saved = all[c.code];
    const extra = ov[c.code];
    const extras = extra?.rows?.length || 0;
    const lines = [];
    if (saved) {
      lines.push(saved.rows.length + ' registros');
      if (saved.savedAt) lines.push('oficial: ' + mpFmtDate(saved.savedAt));
    } else {
      lines.push('sem oficial');
    }
    if (extras) {
      lines.push(extras + ' extra' + (extras > 1 ? 's' : '') + (extra.savedAt ? ' · ' + mpFmtDate(extra.savedAt) : ''));
    }
    return `
      <button type="button" class="country-tab ${c.code === mpState.country ? 'active' : ''}" data-country="${c.code}">
        <span class="country-tab-code">${c.code}</span>
        <span class="country-tab-name">${escapeHtml(c.name)}</span>
        <span class="country-tab-status ${saved || extras ? 'saved' : ''}">${lines.join('<br>')}</span>
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

function mpRenderSaved() {
  const all = mpLoadAll();
  const code = mpState.country;
  const c = mpCountry();

  document.getElementById('mpSavedCards').innerHTML = MP_COUNTRIES.map(k => {
    const s = all[k.code];
    const extras = mpLoadOverrides()[k.code]?.rows?.length || 0;
    const cats = s ? mpSavedCatalogs(s) : [];
    return `
      <div class="saved-card ${k.code === code ? 'active' : ''} ${s ? '' : 'empty'}">
        <div class="saved-card-head"><strong>${escapeHtml(k.name)}</strong><span>${k.code}</span></div>
        ${s ? `
          <div class="saved-card-count">${s.rows.length}<small> registros</small></div>
          <div class="muted small">Preço de: <strong>${s.priceColumn}</strong></div>
          <div class="saved-card-cats">${cats.map(x => `<span class="catalog-tag">${escapeHtml(x.name)} <small>${x.count}</small></span>`).join('')}</div>
          <div class="muted small mt-1">Salvo em ${mpFmtDate(s.savedAt)}</div>`
          : '<div class="muted small mt-2">Nenhuma planilha oficial.</div>'}
        ${extras ? `<div class="muted small mt-1">Fora do padrão: <strong>${extras}</strong></div>` : ''}
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

function mpRenderSaveProof() {
  const box = document.getElementById('mpSaveProof');
  const s = mpState.lastSave && mpState.lastSave.code === mpState.country ? mpState.lastSave : null;
  const saved = mpLoadAll()[mpState.country];
  if (s) {
    const ok = s.matched === s.expected && s.expected > 0;
    box.innerHTML = `
      <div class="result-banner ${ok ? 'result-ok' : 'result-fail'} mt-3">
        <i class="bi ${ok ? 'bi-check-circle-fill' : 'bi-x-circle-fill'}"></i>
        <div>
          <div class="result-title">${ok ? 'SALVO' : 'FALHA AO SALVAR'}</div>
          <div class="result-sub">${escapeHtml(mpCountry(s.code).name)} · última atualização ${mpFmtDate(s.savedAt)} · preço da coluna <strong>${s.priceColumn}</strong> ·
            conferência na leitura de volta: <strong>${s.matched} de ${s.expected}</strong> registros (${MP_KEY_COLUMN} + catálogo) com o mesmo preço.
            Preços fora do padrão deste país foram apagados.</div>
        </div>
      </div>`;
    return;
  }
  if (saved && saved.savedAt) {
    box.innerHTML = `
      <div class="result-banner result-wait mt-3">
        <i class="bi bi-clock-history"></i>
        <div>
          <div class="result-title">ÚLTIMA ATUALIZAÇÃO</div>
          <div class="result-sub">${escapeHtml(mpCountry().name)} · oficial ${mpFmtDate(saved.savedAt)} · ${saved.rows.length} registros · coluna <strong>${escapeHtml(saved.priceColumn)}</strong>.</div>
        </div>
      </div>`;
    return;
  }
  box.innerHTML = '<div class="muted small mt-3">Nenhuma planilha oficial salva neste país.</div>';
}

function mpRenderOverride() {
  const rec = document.getElementById('mpOvRecognition');
  const proof = document.getElementById('mpOvProof');
  const tableBox = document.getElementById('mpOvTable');
  const p = mpState.overrideParsed;
  const c = mpCountry();
  const saveBtn = document.getElementById('mpOvSave');
  const saveAll = document.getElementById('mpOvSaveAll');
  const delBtn = document.getElementById('mpOvDelete');
  const savedOv = mpLoadOverrides()[mpState.country];

  const canSave = !!(p && !p.missing.length && p.rows.length);
  saveBtn.disabled = !canSave;
  saveAll.disabled = !canSave;
  delBtn.disabled = !(savedOv && savedOv.rows.length);

  if (!p) rec.innerHTML = '';
  else if (p.missing.length || !p.rows.length) {
    rec.innerHTML = `<div class="result-banner result-fail">
      <i class="bi bi-x-circle-fill"></i>
      <div><div class="result-title">PLANILHA EXTRA NÃO RECONHECIDA</div>
        <div class="result-sub">${p.missing.length ? 'Falta coluna: ' + p.missing.join(', ') + '.' : 'Nenhuma linha com modelCode e minProductPrice válidos.'}</div></div></div>`;
  } else {
    rec.innerHTML = `<div class="result-banner result-ok">
      <i class="bi bi-check-circle-fill"></i>
      <div><div class="result-title">EXTRA RECONHECIDA</div>
        <div class="result-sub">${p.rows.length} modelCode(s). Salvar neste país ou nos 4. Vale por cima da planilha oficial.</div></div></div>
      <div class="table-wrap mt-3"><table class="table table-sm table-dark table-bordered mb-0">
        <thead><tr><th>modelCode</th><th>minProductPrice (lido)</th></tr></thead>
        <tbody>${p.rows.slice(0, MP_PREVIEW_ROWS).map(r => `<tr><td><strong>${escapeHtml(r.model)}</strong></td><td class="price-read">${mpFmtNumber(r.price)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${p.rows.length > MP_PREVIEW_ROWS ? `<div class="muted small mt-2">Mostrando ${MP_PREVIEW_ROWS} de ${p.rows.length}.</div>` : ''}`;
  }

  const ls = mpState.lastOverrideSave;
  if (ls) {
    proof.innerHTML = `<div class="result-banner result-ok mt-3">
      <i class="bi bi-check-circle-fill"></i>
      <div><div class="result-title">EXTRAS SALVOS</div>
        <div class="result-sub">${escapeHtml(ls.scope)} · ${ls.count} modelCode(s) · ${mpFmtDate(ls.savedAt)}</div></div></div>`;
  } else if (savedOv && savedOv.savedAt) {
    proof.innerHTML = `<div class="result-banner result-wait mt-3">
      <i class="bi bi-clock-history"></i>
      <div><div class="result-title">ÚLTIMA ATUALIZAÇÃO DOS EXTRAS</div>
        <div class="result-sub">${escapeHtml(c.name)} · ${mpFmtDate(savedOv.savedAt)} · ${savedOv.rows.length} modelCode(s).</div></div></div>`;
  } else {
    proof.innerHTML = '<div class="muted small mt-3">Nenhum extra salvo neste país.</div>';
  }

  if (!savedOv || !savedOv.rows.length) {
    tableBox.innerHTML = '<div class="muted">Nenhum preço extra salvo neste país.</div>';
    return;
  }
  tableBox.innerHTML = `
    <div class="muted small mb-2">Valendo agora em ${escapeHtml(c.name)} (${savedOv.rows.length}) · salvo ${mpFmtDate(savedOv.savedAt)}</div>
    <div class="table-wrap"><table class="table table-sm table-dark table-bordered mb-0">
      <thead><tr><th>modelCode</th><th>minProductPrice</th></tr></thead>
      <tbody>${savedOv.rows.slice(0, MP_SAVED_ROWS).map(r => `<tr><td><strong>${escapeHtml(r[0])}</strong></td><td class="price-read">${mpFmtNumber(r[1])}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

function mpReparseOverride() {
  const box = mpEl('mpOvText');
  if (!box) { mpState.overrideParsed = null; return; }
  const text = cleanInvisible(box.value);
  mpState.overrideParsed = text.trim() ? mpParseOverride(text) : null;
}

function mpOnOverridePaste() {
  mpReparseOverride();
  mpState.lastOverrideSave = null;
  mpRenderOverride();
}

function mpSaveOverride(allCountries) {
  const p = mpState.overrideParsed;
  if (!p || !p.rows.length) return;
  const incoming = p.rows.map(r => [r.model, r.price]);
  const codes = allCountries ? MP_COUNTRIES.map(c => c.code) : [mpState.country];
  const label = allCountries ? '4 países' : mpCountry().name;
  if (!confirm(`Atualizar ${incoming.length} preço(s) extra(s) em ${label}? Modelos já salvos neste destino são sobrescritos; os outros extras permanecem.`)) return;
  try {
    let last;
    codes.forEach(code => { last = mpMergeOverrideCountry(code, incoming); });
    mpState.lastOverrideSave = { scope: label, count: incoming.length, savedAt: last.savedAt };
  } catch (err) {
    alert('Não foi possível salvar: ' + err.message);
    return;
  }
  mpRenderTabs();
  mpRenderOverride();
  mpRenderSaved();
}

function mpClearOverrideText() {
  document.getElementById('mpOvText').value = '';
  mpState.overrideDrafts[mpState.country] = '';
  mpState.overrideParsed = null;
  mpState.lastOverrideSave = null;
  mpRenderOverride();
}

function mpDeleteOverride() {
  const code = mpState.country;
  const n = mpLoadOverrides()[code]?.rows?.length || 0;
  if (!n) return;
  if (!confirm(`Apagar ${n} preço(s) extra(s) de ${mpCountry(code).name}?`)) return;
  mpDeleteOverrides(code);
  mpState.lastOverrideSave = null;
  mpRenderTabs();
  mpRenderOverride();
  mpRenderSaved();
}

function mpEl(id) { return document.getElementById(id); }

function mpRenderAll() {
  const c = mpCountry();
  const card = mpEl('mpCardTitle');
  if (card) card.textContent = `Planilha do dia - ${c.name}`;
  const ovTitle = mpEl('mpOvTitle');
  if (ovTitle) ovTitle.textContent = `Preços fora do padrão - ${c.name}`;
  const save = mpEl('mpSave');
  if (save) save.innerHTML = `<i class="bi bi-save"></i> Salvar planilha de ${escapeHtml(c.name)}`;
  const ovSave = mpEl('mpOvSave');
  if (ovSave) ovSave.innerHTML = `<i class="bi bi-save"></i> Salvar em ${escapeHtml(c.name)}`;
  mpRenderTabs();
  mpRenderNotice();
  mpRenderRecognition();
  mpRenderSaveProof();
  if (mpEl('mpOvText')) mpRenderOverride();
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
  const ovBox = mpEl('mpOvText');
  if (ovBox) mpState.overrideDrafts[mpState.country] = ovBox.value;
  mpState.country = code;
  document.getElementById('mpText').value = mpState.drafts[code] || '';
  if (ovBox) ovBox.value = mpState.overrideDrafts[code] || '';
  document.getElementById('mpFilter').value = '';
  document.getElementById('mpCatalogFilter').value = '';
  mpReparse();
  mpReparseOverride();
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
  const extrasN = mpLoadOverrides()[code]?.rows?.length || 0;
  let ask = '';
  if (prev) ask = `Já existe planilha salva para ${c.name} (${prev.rows.length} registros, ${mpFmtDate(prev.savedAt)}).\nSubstituir?`;
  if (extrasN) ask += (ask ? '\n' : '') + `Os ${extrasN} preço(s) fora do padrão deste país serão apagados.`;
  if (ask && !confirm(ask)) return;
  try {
    const saved = mpSaveCountry(code, p);
    const v = mpVerifySaved(code, p);
    mpState.lastSave = { code, savedAt: saved.savedAt, priceColumn: saved.priceColumn, expected: v.expected, matched: v.matched };
    mpDeleteOverrides(code);
    mpState.lastOverrideSave = null;
  } catch (err) {
    alert('Não foi possível salvar (armazenamento do navegador cheio?): ' + err.message);
    return;
  }
  mpRenderTabs();
  mpRenderSaveProof();
  mpRenderOverride();
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
  const ovText = mpEl('mpOvText');
  if (ovText) {
    let ovTimer;
    ovText.addEventListener('input', () => {
      clearTimeout(ovTimer);
      ovTimer = setTimeout(mpOnOverridePaste, 250);
    });
    mpEl('mpOvSave')?.addEventListener('click', () => mpSaveOverride(false));
    mpEl('mpOvSaveAll')?.addEventListener('click', () => mpSaveOverride(true));
    mpEl('mpOvClear')?.addEventListener('click', mpClearOverrideText);
    mpEl('mpOvDelete')?.addEventListener('click', mpDeleteOverride);
  }
  mpRenderAll();
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mpParse, mpParsePrice, mpParseOverride, mpOverrideMap, mpMergeOverrideCountry, mpLoadOverrides };
}
