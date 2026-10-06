/* ===== Triagem > Special price: país, site, conferência do template contra Minimum prices ===== */

const SP_SITES = ['eStore', 'Marketplace', 'EPP', 'SME', 'SMB'];

// Site -> Catalog_version (o mesmo valor salvo em "Minimum prices"). Editar aqui ao incluir outros países.
const SP_SITE_CATALOG = {
  CL: {
    eStore: 'clEstoreProductCatalog',
    Marketplace: 'cl3pdProductCatalog',
    EPP: 'clEppProductCatalog',
    SMB: 'clEppSMBProductCatalog'
  },
  CO: {},
  PE: {},
  MX: {}
};

const SP_COLUMNS = ['modelCode', 'price', 'currency', 'unit', 'cmsSite', 'minqtd', 'discountPercent', 'userPriceGroup', 'validityFrom', 'validityTo'];
const SP_REQUIRED = ['modelCode', 'price', 'validityFrom', 'validityTo'];
const SP_TABLE_ROWS = 300;

const spState = {
  country: 'CL',
  site: 'eStore',
  onlyErrors: null // null = automático (liga quando há erros)
};

function spCountry(code) {
  return MP_COUNTRIES.find(c => c.code === (code || spState.country));
}

function spCatalogFor(code, site) {
  return (SP_SITE_CATALOG[code] || {})[site] || null;
}

/* ---------- Referência: dados salvos em Minimum prices ---------- */

function spReference(code, catalog) {
  const country = spCountry(code);
  const base = { priceColumn: country.priceColumn, countryName: country.name };
  const saved = mpLoadAll()[code];
  if (!saved) {
    return { ...base, error: `Nenhuma planilha de Minimum prices salva para ${country.name}. Salve primeiro no menu "Minimum prices".` };
  }
  const cats = mpSavedCatalogs(saved);
  const found = cats.find(c => c.name.toUpperCase() === catalog.toUpperCase());
  if (!found) {
    return { ...base, savedCatalogs: cats, error: `Catálogo "${catalog}" não encontrado nos dados de Minimum prices de ${country.name}.` };
  }
  const map = new Map();
  saved.rows.forEach(r => {
    if (String(r[1]).toUpperCase() === catalog.toUpperCase()) map.set(String(r[0]).toUpperCase(), r[2]);
  });
  return { ...base, map, catalog: found.name, count: map.size, savedAt: saved.savedAt };
}

function spSiteInfo() {
  const { country, site } = spState;
  const c = spCountry(country);
  const catalog = spCatalogFor(country, site);
  if (!catalog) {
    return { catalog: null, ref: null, error: `O site ${site} não está configurado para ${c.name} (nenhum catálogo definido).` };
  }
  const ref = spReference(country, catalog);
  return { catalog, ref, error: ref.error || null };
}

/* ---------- Datas ---------- */

function spPad(n) { return String(n).padStart(2, '0'); }

function spFmtTs(ts) {
  const d = new Date(ts);
  const date = `${spPad(d.getUTCDate())}/${spPad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  return d.getUTCHours() || d.getUTCMinutes() ? `${date} ${spPad(d.getUTCHours())}:${spPad(d.getUTCMinutes())}` : date;
}

// Retorna { empty } | { invalid, display } | { ts, display }. ts em "horário de parede" (UTC), em minutos.
function spParseDate(v) {
  if (v === '' || v === null || v === undefined) return { empty: true };
  const round = ms => Math.round(ms / 60000) * 60000;

  if (v instanceof Date) {
    if (isNaN(v)) return { invalid: true, display: String(v) };
    const ts = round(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds(), v.getMilliseconds()));
    return { ts, display: spFmtTs(ts) };
  }
  if (typeof v === 'number') {
    if (v < 1 || v > 80000) return { invalid: true, display: String(v) };
    const ts = round((v - 25569) * 86400000);
    return { ts, display: spFmtTs(ts) };
  }

  const s = String(v).trim();
  if (!s) return { empty: true };
  const time = '(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?';
  let m, y, mo, d, h, mi, se;

  if ((m = s.match(new RegExp('^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})' + time)))) {
    [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]];
  } else if ((m = s.match(new RegExp('^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})' + time)))) {
    let a = Number(m[1]), b = Number(m[2]);
    if (b > 12 && a <= 12) [a, b] = [b, a]; // mm/dd/aaaa
    [y, mo, d, h, mi, se] = [m[3], b, a, m[4], m[5], m[6]];
  } else {
    return { invalid: true, display: s };
  }
  [y, mo, d] = [Number(y), Number(mo), Number(d)];
  h = Number(h || 0); mi = Number(mi || 0); se = Number(se || 0);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return { invalid: true, display: s };
  const ts = round(date.getTime());
  return { ts, display: spFmtTs(ts) };
}

/* ---------- Leitura do template ---------- */

function spParseTemplate(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
  const offset = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0;

  let headerIdx = -1;
  for (let i = 0; i < Math.min(aoa.length, 10); i++) {
    if (aoa[i].some(c => mpNormKey(c) === 'modelcode')) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return { headerFound: false, columns: {}, missing: ['modelCode (cabeçalho não encontrado)'], rows: [] };

  const norm = aoa[headerIdx].map(mpNormKey);
  const columns = {};
  SP_COLUMNS.forEach(c => { columns[c] = norm.indexOf(mpNormKey(c)); });
  const missing = SP_REQUIRED.filter(c => columns[c] < 0);

  const rows = [];
  aoa.slice(headerIdx + 1).forEach((cells, i) => {
    if (!cells.some(c => String(c).trim() !== '')) return;
    rows.push({ line: offset + headerIdx + 1 + i + 1, cells });
  });
  return { headerFound: true, columns, missing, rows };
}

function spToNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === '' || v === null || v === undefined) return null;
  return mpParsePrice(v);
}

/* ---------- Conferência ---------- */

function spEvaluate(parsed, ref) {
  const get = (cells, col) => (parsed.columns[col] >= 0 ? cells[parsed.columns[col]] : '');
  const results = [];

  parsed.rows.forEach(({ line, cells }) => {
    const issues = [];
    const modelCode = String(get(cells, 'modelCode') ?? '').trim();
    const price = spToNumber(get(cells, 'price'));
    const from = spParseDate(get(cells, 'validityFrom'));
    const to = spParseDate(get(cells, 'validityTo'));
    let refPrice;

    if (!modelCode) issues.push({ type: 'invalid', msg: 'modelCode vazio' });
    if (price === null) issues.push({ type: 'invalid', msg: `price vazio ou inválido ("${get(cells, 'price')}")` });

    if (modelCode) {
      refPrice = ref.map.get(modelCode.toUpperCase());
      if (refPrice === undefined) {
        issues.push({ type: 'notfound', msg: `modelCode não encontrado em Minimum prices (${ref.catalog})` });
      } else if (refPrice === 0) {
        issues.push({ type: 'zero', msg: `${ref.priceColumn} é zero em Minimum prices` });
      } else if (price !== null && price < refPrice) {
        issues.push({ type: 'price', msg: `price ${mpFmtNumber(price)} menor que ${ref.priceColumn} ${mpFmtNumber(refPrice)}` });
      }
    }

    if (from.invalid) issues.push({ type: 'date', msg: `validityFrom inválida ("${from.display}")` });
    if (to.invalid) issues.push({ type: 'date', msg: `validityTo inválida ("${to.display}")` });
    if (from.ts !== undefined && to.ts !== undefined && from.ts > to.ts) {
      issues.push({ type: 'date', msg: `validityFrom (${from.display}) maior que validityTo (${to.display})` });
    }

    results.push({
      line, modelCode, price, refPrice, issues,
      cmsSite: String(get(cells, 'cmsSite') ?? '').trim(),
      from: from.display || '', to: to.display || ''
    });
  });
  return results;
}

/* ---------- Renderização: seletores ---------- */

function spRenderSelectors() {
  const all = mpLoadAll();
  document.getElementById('spCountryTabs').innerHTML = MP_COUNTRIES.map(c => {
    const saved = all[c.code];
    return `
      <button type="button" class="country-tab ${c.code === spState.country ? 'active' : ''}" data-sp-country="${c.code}">
        <span class="country-tab-code">${c.code}</span>
        <span class="country-tab-name">${escapeHtml(c.name)}</span>
        <span class="country-tab-status ${saved ? 'saved' : ''}">${saved ? 'Minimum prices: ' + saved.rows.length : 'sem Minimum prices'}</span>
      </button>`;
  }).join('');

  document.getElementById('spSites').innerHTML = SP_SITES.map(s => `
    <button type="button" class="catalog-pill ${s === spState.site ? 'active' : ''} ${spCatalogFor(spState.country, s) ? '' : 'pill-unset'}" data-sp-site="${s}">${s}</button>`).join('');

  const info = spSiteInfo();
  const c = spCountry();
  let html;
  if (info.error) {
    html = `<div class="result-banner result-fail">
        <i class="bi bi-x-circle-fill"></i>
        <div>
          <div class="result-title">ERRO NO SITE</div>
          <div class="result-sub">${escapeHtml(info.error)}${info.catalog ? ` Catálogo esperado: <strong>${escapeHtml(info.catalog)}</strong>.` : ''}
            ${info.ref && info.ref.savedCatalogs && info.ref.savedCatalogs.length
              ? `<br>Catálogos salvos em Minimum prices: ${info.ref.savedCatalogs.map(k => escapeHtml(k.name)).join(', ')}.` : ''}
            ${!info.catalog ? `<br>Sites configurados: ${Object.keys(SP_SITE_CATALOG[spState.country] || {}).join(', ') || 'nenhum'}.` : ''}</div>
        </div>
      </div>`;
  } else {
    html = `<div class="check-item check-ok">
        <div class="check-head"><i class="bi bi-check-circle-fill"></i>
          <strong>Site ${escapeHtml(spState.site)}</strong>
          <span>catálogo <mark>${escapeHtml(info.catalog)}</mark> encontrado em Minimum prices de ${escapeHtml(c.name)}
            (${info.ref.count} modelos) · preço de referência: <strong>${info.ref.priceColumn}</strong></span></div>
      </div>`;
  }
  document.getElementById('spSiteStatus').innerHTML = html;
}

/* ---------- Renderização: resultado do template ---------- */

function spCheckItem(status, title, summary, evidence) {
  const icon = { ok: 'bi-check-circle-fill', fail: 'bi-x-circle-fill', warn: 'bi-exclamation-triangle-fill', info: 'bi-info-circle-fill' }[status];
  return `
    <div class="check-item check-${status}">
      <div class="check-head"><i class="bi ${icon}"></i><strong>${escapeHtml(title)}</strong><span>${summary}</span></div>
      ${evidence && evidence.length ? `<div class="check-evidence">${evidence.join('')}</div>` : ''}
    </div>`;
}

function spEvidence(results, type, limit = 8) {
  const list = results.filter(r => r.issues.some(i => i.type === type));
  const lines = list.slice(0, limit).map(r => {
    const issue = r.issues.find(i => i.type === type);
    return `<span class="ev-snippet">linha ${r.line} · <mark>${escapeHtml(r.modelCode || '(vazio)')}</mark> · ${escapeHtml(issue.msg)}</span>`;
  });
  if (list.length > limit) lines.push(`<div class="muted small">... e mais ${list.length - limit}</div>`);
  return lines;
}

function spRunTemplate() {
  const box = document.getElementById('spTemplateResult');
  spState.templateOk = null;

  if (!state.template) { box.innerHTML = ''; return; }

  const sheetName = document.getElementById('sheetSelect').value || state.template.workbook.SheetNames[0];
  const parsed = spParseTemplate(state.template.workbook, sheetName);
  const info = spSiteInfo();
  const c = spCountry();

  const chips = SP_COLUMNS.map(col => {
    const idx = parsed.columns[col];
    const found = idx !== undefined && idx >= 0;
    const required = SP_REQUIRED.includes(col);
    const cls = found ? (required ? 'chip-ok' : '') : (required ? 'chip-fail' : 'chip-off');
    return `<div class="col-chip ${cls}"><strong>${col}</strong><span>${found ? `coluna ${idx + 1}` : (required ? 'NÃO ENCONTRADA' : 'não encontrada')}</span>${required ? '<em>usada na conferência</em>' : ''}</div>`;
  }).join('');
  const chipsHtml = `<div class="col-chips mt-3">${chips}</div>`;

  const bannerFail = (title, sub) => `
    <div class="result-banner result-fail mt-3"><i class="bi bi-x-circle-fill"></i>
      <div><div class="result-title">${title}</div><div class="result-sub">${sub}</div></div></div>`;

  if (parsed.missing.length) {
    spState.templateOk = false;
    box.innerHTML = bannerFail('TEMPLATE NÃO RECONHECIDO', `Coluna obrigatória não encontrada: ${escapeHtml(parsed.missing.join(', '))}.`) + chipsHtml;
    return;
  }
  if (info.error) {
    spState.templateOk = false;
    box.innerHTML = bannerFail('NÃO FOI POSSÍVEL COMPARAR', `${escapeHtml(info.error)} Veja o aviso de erro do site acima.`) + chipsHtml;
    return;
  }
  if (!parsed.rows.length) {
    spState.templateOk = false;
    box.innerHTML = bannerFail('TEMPLATE SEM LINHAS', 'Nenhuma linha de dados abaixo do cabeçalho.') + chipsHtml;
    return;
  }

  const ref = info.ref;
  const results = spEvaluate(parsed, ref);
  const count = type => results.filter(r => r.issues.some(i => i.type === type)).length;
  const failedRows = results.filter(r => r.issues.length).length;
  const ok = failedRows === 0;
  spState.templateOk = ok;
  spState.templateSummary = `${results.length} linhas, ${failedRows} com erro`;

  const nInvalid = count('invalid'), nNotFound = count('notfound'), nPrice = count('price'), nZero = count('zero'), nDate = count('date');
  const pc = ref.priceColumn;

  // cmsSite: informativo (não reprova)
  const sites = new Map();
  results.forEach(r => sites.set(r.cmsSite || '(vazio)', (sites.get(r.cmsSite || '(vazio)') || 0) + 1));
  const cmsDiff = Array.from(sites.keys()).some(k => k.toUpperCase() !== info.catalog.toUpperCase());
  const cmsItem = spCheckItem(cmsDiff ? 'warn' : 'ok', 'cmsSite do template (informativo)',
    cmsDiff ? `diferente do catálogo do site selecionado (<mark>${escapeHtml(info.catalog)}</mark>) — não reprova`
            : `igual ao catálogo do site selecionado (<mark>${escapeHtml(info.catalog)}</mark>)`,
    [`<span class="ev-snippet">${Array.from(sites, ([k, n]) => `<mark>${escapeHtml(k)}</mark> · ${n} linha(s)`).join(' &nbsp;|&nbsp; ')}</span>`]);

  const checks = [
    spCheckItem(nInvalid ? 'fail' : 'ok', 'Dados válidos (modelCode e price preenchidos)',
      nInvalid ? `${nInvalid} linha(s) com problema` : 'todas as linhas OK', spEvidence(results, 'invalid')),
    spCheckItem(nNotFound ? 'fail' : 'ok', `modelCode encontrado em Minimum prices (${info.catalog})`,
      nNotFound ? `${nNotFound} modelCode não encontrado(s)` : `todos encontrados (${results.length - nInvalid})`, spEvidence(results, 'notfound')),
    spCheckItem(nPrice ? 'fail' : 'ok', `price do template não menor que ${pc}`,
      nPrice ? `${nPrice} linha(s) com preço abaixo do mínimo` : 'nenhum preço abaixo do mínimo', spEvidence(results, 'price')),
    spCheckItem(nZero ? 'fail' : 'ok', `${pc} diferente de zero`,
      nZero ? `${nZero} modelo(s) com ${pc} zero` : `nenhum ${pc} zero`, spEvidence(results, 'zero')),
    spCheckItem(nDate ? 'fail' : 'ok', 'validityFrom não maior que validityTo',
      nDate ? `${nDate} linha(s) com problema de data` : 'todas as datas OK', spEvidence(results, 'date')),
    cmsItem
  ].join('');

  // Tabela com a prova linha a linha
  const onlyErrors = spState.onlyErrors === null ? !ok : spState.onlyErrors;
  const view = onlyErrors ? results.filter(r => r.issues.length) : results;
  const shown = view.slice(0, SP_TABLE_ROWS);
  const table = `
    <div class="d-flex flex-wrap align-items-center gap-3 mt-3 mb-2">
      <div class="form-check m-0">
        <input class="form-check-input" type="checkbox" id="spOnlyErrors" ${onlyErrors ? 'checked' : ''}>
        <label class="form-check-label" for="spOnlyErrors">Mostrar só linhas com erro</label>
      </div>
      <div class="muted small">${view.length} de ${results.length} linhas${view.length > SP_TABLE_ROWS ? ` (mostrando ${SP_TABLE_ROWS})` : ''}</div>
    </div>
    <div class="table-wrap">
      <table class="table table-sm table-dark table-bordered mb-0">
        <thead><tr><th>Linha</th><th>modelCode</th><th>price (template)</th><th>${pc} (Minimum prices)</th><th>cmsSite</th><th>validityFrom</th><th>validityTo</th><th>Resultado</th></tr></thead>
        <tbody>${shown.map(r => `
          <tr class="${r.issues.length ? 'row-fail' : ''}">
            <td class="muted">${r.line}</td>
            <td><strong>${escapeHtml(r.modelCode)}</strong></td>
            <td class="num">${r.price === null ? '-' : mpFmtNumber(r.price)}</td>
            <td class="num ${r.refPrice === 0 ? 'cell-bad' : 'price-read'}">${r.refPrice === undefined ? '-' : mpFmtNumber(r.refPrice)}</td>
            <td>${escapeHtml(r.cmsSite)}</td>
            <td>${escapeHtml(r.from)}</td>
            <td>${escapeHtml(r.to)}</td>
            <td>${r.issues.length
              ? `<span class="status-bad"><i class="bi bi-x-circle-fill"></i> ${r.issues.map(i => escapeHtml(i.msg)).join('; ')}</span>`
              : '<span class="status-good"><i class="bi bi-check-circle-fill"></i> OK</span>'}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;

  box.innerHTML = `
    <div class="result-banner ${ok ? 'result-ok' : 'result-fail'} mt-3">
      <i class="bi ${ok ? 'bi-check-circle-fill' : 'bi-x-circle-fill'}"></i>
      <div>
        <div class="result-title">${ok ? 'TEMPLATE OK' : 'TEMPLATE COM ERROS'}</div>
        <div class="result-sub">${escapeHtml(c.name)} · site ${escapeHtml(spState.site)} (${escapeHtml(info.catalog)}) · ${results.length} linhas lidas, ${failedRows} com erro ·
          referência: ${pc} de Minimum prices salvo em ${mpFmtDate(ref.savedAt)}</div>
      </div>
    </div>
    <div class="mt-3">${checks}</div>
    ${table}
    <details class="mt-3"><summary class="muted">Ver colunas reconhecidas no template</summary>${chipsHtml}</details>`;
}

/* ---------- Resultado geral (PUMI + template) ---------- */

function spRenderOverall() {
  const box = document.getElementById('spOverall');
  const info = spSiteInfo();
  const pumi = state.pumi && state.pumi.result ? (state.pumi.result.ok ? 'ok' : 'fail') : 'wait';
  const tpl = state.template ? (spState.templateOk ? 'ok' : 'fail') : 'wait';
  const site = info.error ? 'fail' : 'ok';

  const line = (status, label, text) => {
    const icon = { ok: 'bi-check-circle-fill', fail: 'bi-x-circle-fill', wait: 'bi-hourglass-split' }[status];
    return `<div class="overall-line overall-${status}"><i class="bi ${icon}"></i><strong>${label}</strong><span>${text}</span></div>`;
  };

  const anyFail = [pumi, tpl, site].includes('fail');
  const allOk = pumi === 'ok' && tpl === 'ok' && site === 'ok';
  const banner = allOk
    ? '<div class="result-banner result-ok"><i class="bi bi-check-circle-fill"></i><div><div class="result-title">TRIAGEM APROVADA</div><div class="result-sub">PUMI, site e template conferem.</div></div></div>'
    : anyFail
      ? '<div class="result-banner result-fail"><i class="bi bi-x-circle-fill"></i><div><div class="result-title">TRIAGEM REPROVADA</div><div class="result-sub">Veja os itens com erro abaixo.</div></div></div>'
      : '<div class="result-banner result-wait"><i class="bi bi-hourglass-split"></i><div><div class="result-title">AGUARDANDO</div><div class="result-sub">Cole o PUMI e anexe o template para concluir.</div></div></div>';

  box.innerHTML = `${banner}
    <div class="overall-list">
      ${line(site, 'Site', info.error ? escapeHtml(info.error) : `${escapeHtml(spState.site)} → ${escapeHtml(info.catalog)}`)}
      ${line(pumi, 'PUMI', pumi === 'wait' ? 'não colado' : (pumi === 'ok' ? 'aprovador encontrado e sem "pending"' : 'reprovado (veja o resultado do PUMI)'))}
      ${line(tpl, 'Template', tpl === 'wait' ? 'não anexado' : (tpl === 'ok' ? 'todas as regras OK' : 'com erros (veja o resultado do template)'))}
    </div>`;
}

function spRefresh() {
  spRenderSelectors();
  spRunTemplate();
  spRenderOverall();
}

/* ---------- Eventos ---------- */

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('spCountryTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-sp-country]');
    if (!b) return;
    spState.country = b.dataset.spCountry;
    spRefresh();
  });
  document.getElementById('spSites').addEventListener('click', e => {
    const b = e.target.closest('[data-sp-site]');
    if (!b) return;
    spState.site = b.dataset.spSite;
    spRefresh();
  });
  document.getElementById('spTemplateResult').addEventListener('change', e => {
    if (e.target.id === 'spOnlyErrors') {
      spState.onlyErrors = e.target.checked;
      spRunTemplate();
    }
  });
  spRefresh();
});

if (typeof module !== 'undefined') {
  module.exports = { spParseDate, spEvaluate, spParseTemplate };
}
