/* ===== Triagem > Voucher: PUMI + conferência da planilha colada ===== */

const VC_TABLE_ROWS = 100;

const vcState = {
  pumi: null,       // { text, result }
  template: null,   // { text }
  templateOk: null
};

function vcCleanCell(s) {
  return String(s ?? '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .trim();
}

function vcBlank(s) {
  return !vcCleanCell(s);
}

function vcRowAllEmpty(cells) {
  return !cells.length || cells.every(vcBlank);
}

function vcFindHeader(norm, aliases) {
  const keys = aliases.map(mpNormKey);
  for (let i = 0; i < norm.length; i++) {
    if (keys.some(k => norm[i] === k)) return i;
  }
  for (let i = 0; i < norm.length; i++) {
    if (keys.some(k => k && (norm[i].includes(k) || k.includes(norm[i]) && norm[i].length >= 8))) return i;
  }
  return -1;
}

function vcParseTemplate(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((content, i) => ({ content, line: i + 1 }));
  let headerIdx = -1, delim = '\t';
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const d = mpDetectDelimiter(lines[i].content);
    const norm = lines[i].content.split(d).map(c => mpNormKey(mpStripQuotes(c)));
    if (vcFindHeader(norm, ['typeofdiscount', 'type of discount']) >= 0) {
      headerIdx = i; delim = d; break;
    }
  }
  if (headerIdx < 0) {
    return { headerFound: false, missing: ['Type of discount (cabeçalho não encontrado)'], columns: {}, headers: [], rows: [] };
  }

  const rawHeaders = lines[headerIdx].content.split(delim).map(c => mpStripQuotes(c));
  const norm = rawHeaders.map(mpNormKey);
  const typeIdx = vcFindHeader(norm, ['typeofdiscount']);
  const valueByName = vcFindHeader(norm, ['discountspricevalue', 'discountpricevalue', 'pricevalue']);
  const startIdx = vcFindHeader(norm, ['startdateandtime', 'startdatetime', 'startdate']);
  const endIdx = vcFindHeader(norm, ['enddateandtime', 'enddatetime', 'enddate']);
  const msgIdx = vcFindHeader(norm, ['promotionmessageinthecart', 'promotionmessage']);

  const missing = [];
  if (typeIdx < 0) missing.push('Type of discount');
  const valueIdx = typeIdx >= 0 ? typeIdx + 1 : -1;
  if (typeIdx >= 0 && (valueIdx >= rawHeaders.length || !String(rawHeaders[valueIdx] || '').trim())) {
    missing.push('Discounts/Price Value (coluna ao lado de Type of discount)');
  }
  if (typeIdx >= 0 && valueByName >= 0 && valueByName !== valueIdx) {
    missing.push('Discounts/Price Value precisa ficar logo ao lado de Type of discount');
  }
  if (startIdx < 0) missing.push('Start Date and Time');
  if (endIdx < 0) missing.push('End Date and Time');

  const rows = [];
  lines.slice(headerIdx + 1).forEach(({ content, line }) => {
    if (!content.trim()) return;
    const cells = content.split(delim).map(c => vcCleanCell(mpStripQuotes(c)));
    if (vcRowAllEmpty(cells)) return;
    rows.push({ line, cells });
  });

  return {
    headerFound: true,
    missing,
    headers: rawHeaders,
    columns: { type: typeIdx, value: valueIdx, start: startIdx, end: endIdx, message: msgIdx },
    rows
  };
}

function vcKind(type) {
  const t = foldText(String(type || ''));
  if (/percent/.test(t) || t.includes('%')) return 'percentage';
  return 'fixed';
}

function vcHasPercent(v) {
  return /%/.test(String(v || ''));
}

function vcEvaluate(parsed) {
  const get = (cells, key) => {
    const i = parsed.columns[key];
    return i >= 0 ? (cells[i] ?? '') : '';
  };
  return parsed.rows.map(({ line, cells }) => {
    const type = vcCleanCell(get(cells, 'type'));
    const value = vcCleanCell(get(cells, 'value'));
    const message = vcCleanCell(get(cells, 'message'));
    const from = spParseDate(get(cells, 'start'));
    const to = spParseDate(get(cells, 'end'));
    const kind = vcKind(type);
    const num = mpParsePrice(value);
    const issues = [];

    if (!type) issues.push({ type: 'discount', msg: 'Type of discount vazio' });
    if (!value) issues.push({ type: 'discount', msg: 'Discounts/Price Value vazio' });
    else if (kind === 'percentage') {
      if (num === null || !vcHasPercent(value)) {
        issues.push({ type: 'discount', msg: `Type é percentage, o valor ao lado precisa ser um número com % ("${value}")` });
      }
    } else if (num === null || vcHasPercent(value)) {
      issues.push({ type: 'discount', msg: `Type é "${type || 'fixed'}", o valor ao lado precisa ser um número fixo, sem % ("${value}")` });
    }

    if (from.empty) issues.push({ type: 'date', msg: 'Start Date and Time vazio' });
    if (to.empty) issues.push({ type: 'date', msg: 'End Date and Time vazio' });
    if (from.invalid) issues.push({ type: 'date', msg: `Start Date and Time inválida ("${from.display}")` });
    if (to.invalid) issues.push({ type: 'date', msg: `End Date and Time inválida ("${to.display}")` });
    if (from.ts !== undefined && to.ts !== undefined && from.ts > to.ts) {
      issues.push({ type: 'date', msg: `Start (${from.display}) maior que End (${to.display})` });
    }

    return {
      line, type, value, kind, message, issues,
      from: from.display || String(get(cells, 'start') || ''),
      to: to.display || String(get(cells, 'end') || '')
    };
  });
}

function vcCheckItem(status, title, summary, evidence) {
  const icon = { ok: 'bi-check-circle-fill', fail: 'bi-x-circle-fill', info: 'bi-info-circle-fill' }[status];
  return `
    <div class="check-item check-${status}">
      <div class="check-head"><i class="bi ${icon}"></i><strong>${escapeHtml(title)}</strong><span>${summary}</span></div>
      ${evidence && evidence.length ? `<div class="check-evidence">${evidence.join('')}</div>` : ''}
    </div>`;
}

function vcEvidence(results, issueType, limit = 8) {
  const list = results.filter(r => r.issues.some(i => i.type === issueType));
  const lines = list.slice(0, limit).map(r => {
    const issue = r.issues.find(i => i.type === issueType);
    return `<span class="ev-snippet">linha ${r.line} · <mark>${escapeHtml(r.type || '(vazio)')}</mark> · ${escapeHtml(issue.msg)}</span>`;
  });
  if (list.length > limit) lines.push(`<div class="muted small">... e mais ${list.length - limit}</div>`);
  return lines;
}

function vcRenderPumi() {
  const box = document.getElementById('vcPumiResult');
  if (!vcState.pumi || !vcState.pumi.result) {
    box.classList.add('d-none');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('d-none');
  box.innerHTML = renderPumiResult(vcState.pumi.result);
}

function vcHandlePumi() {
  const text = cleanInvisible(document.getElementById('vcPumiText').value);
  vcState.pumi = text.trim() ? { text, result: checkPumi(text) } : null;
  vcRenderPumi();
  vcRenderOverall();
}

function vcHandleTemplate() {
  const text = cleanInvisible(document.getElementById('vcTemplateText').value);
  vcState.template = text.trim() ? { text } : null;
  vcRunTemplate();
  vcRenderOverall();
}

function vcRunTemplate() {
  const box = document.getElementById('vcTemplateResult');
  vcState.templateOk = null;
  if (!vcState.template) { box.innerHTML = ''; return; }

  const parsed = vcParseTemplate(vcState.template.text);
  const colChip = (label, idx, required) => {
    const found = idx !== undefined && idx >= 0;
    const cls = found ? 'chip-ok' : (required ? 'chip-fail' : 'chip-off');
    return `<div class="col-chip ${cls}"><strong>${escapeHtml(label)}</strong><span>${found ? `coluna ${idx + 1}${parsed.headers[idx] ? ' · ' + parsed.headers[idx] : ''}` : (required ? 'NÃO ENCONTRADA' : 'não encontrada')}</span></div>`;
  };

  const chips = parsed.headerFound ? `<div class="col-chips mt-3">
    ${colChip('Type of discount', parsed.columns.type, true)}
    ${colChip('Discounts/Price Value (ao lado)', parsed.columns.value, true)}
    ${colChip('Start Date and Time', parsed.columns.start, true)}
    ${colChip('End Date and Time', parsed.columns.end, true)}
    ${colChip('Promotion message in the cart', parsed.columns.message, false)}
  </div>` : '';

  if (!parsed.headerFound || parsed.missing.length) {
    vcState.templateOk = false;
    box.innerHTML = `
      <div class="result-banner result-fail mt-3"><i class="bi bi-x-circle-fill"></i>
        <div><div class="result-title">FALHA</div>
          <div class="result-sub">${escapeHtml(parsed.missing.join('; ') || 'Cabeçalho da planilha não encontrado.')}</div></div></div>${chips}`;
    return;
  }

  const results = vcEvaluate(parsed);
  const discFails = results.filter(r => r.issues.some(i => i.type === 'discount'));
  const dateFails = results.filter(r => r.issues.some(i => i.type === 'date'));
  const ok = discFails.length === 0 && dateFails.length === 0 && results.length > 0;
  vcState.templateOk = ok && results.length > 0;
  if (!results.length) vcState.templateOk = false;

  const messages = [];
  const seen = new Set();
  results.forEach(r => {
    const key = r.message || '(vazio)';
    if (seen.has(key)) return;
    seen.add(key);
    messages.push(r);
  });

  const shown = results.slice(0, VC_TABLE_ROWS);
  const table = `
    <div class="table-wrap mt-3"><table class="table table-sm table-dark mb-0">
      <thead><tr><th>#</th><th>Type of discount</th><th>Discounts/Price Value</th><th>Start</th><th>End</th><th>Promotion message in the cart</th><th>Status</th></tr></thead>
      <tbody>${shown.map(r => `
        <tr class="${r.issues.length ? 'row-fail' : ''}">
          <td>${r.line}</td>
          <td>${escapeHtml(r.type)}</td>
          <td class="${r.issues.some(i => i.type === 'discount') ? 'cell-bad' : ''}">${escapeHtml(r.value)}</td>
          <td class="${r.issues.some(i => i.type === 'date') ? 'cell-bad' : ''}">${escapeHtml(r.from)}</td>
          <td class="${r.issues.some(i => i.type === 'date') ? 'cell-bad' : ''}">${escapeHtml(r.to)}</td>
          <td>${escapeHtml(r.message || '(vazio)')}</td>
          <td class="${r.issues.length ? 'status-bad' : 'status-good'}">${r.issues.length ? r.issues.map(i => escapeHtml(i.msg)).join('; ') : 'OK'}</td>
        </tr>`).join('')}
      </tbody></table></div>
      ${results.length > VC_TABLE_ROWS ? `<div class="muted small mt-2">Mostrando as primeiras ${VC_TABLE_ROWS} de ${results.length} linhas.</div>` : ''}`;

  box.innerHTML = `
    <div class="result-banner ${ok ? 'result-ok' : 'result-fail'} mt-3">
      <i class="bi ${ok ? 'bi-check-circle-fill' : 'bi-x-circle-fill'}"></i>
      <div>
        <div class="result-title">${ok ? 'SUCESSO' : 'FALHA'}</div>
        <div class="result-sub">${ok
          ? `${results.length} linha(s) conferida(s): percentage com %, demais valores fixos, datas OK.`
          : (!results.length ? 'Nenhuma linha de dados depois do cabeçalho.'
            : `${discFails.length} erro(s) de desconto, ${dateFails.length} erro(s) de data.`)}</div>
      </div>
    </div>
    ${vcCheckItem(discFails.length ? 'fail' : 'ok', 'Type of discount × Discounts/Price Value',
      discFails.length ? `${discFails.length} linha(s) fora da regra` : 'percentage com %; fixed/outros com valor numérico fixo',
      vcEvidence(results, 'discount'))}
    ${vcCheckItem(dateFails.length ? 'fail' : 'ok', 'Start Date and Time × End Date and Time',
      dateFails.length ? `${dateFails.length} linha(s) com data inválida ou start > end` : 'start não é maior que end',
      vcEvidence(results, 'date'))}
    ${vcCheckItem('info', 'Promotion message in the cart',
      messages.length ? `${messages.length} mensagem(ns) distinta(s)` : 'coluna não encontrada ou vazia',
      messages.map(r => `<span class="ev-snippet">linha ${r.line} · <mark>${escapeHtml(r.message || '(vazio)')}</mark></span>`))}
    ${chips}${table}`;
}

function vcRenderOverall() {
  const box = document.getElementById('vcOverall');
  const pumi = vcState.pumi && vcState.pumi.result ? (vcState.pumi.result.ok ? 'ok' : 'fail') : 'wait';
  const tpl = vcState.template ? (vcState.templateOk ? 'ok' : 'fail') : 'wait';
  const line = (status, label, text) => {
    const icon = { ok: 'bi-check-circle-fill', fail: 'bi-x-circle-fill', wait: 'bi-hourglass-split' }[status];
    return `<div class="overall-line overall-${status}"><i class="bi ${icon}"></i><strong>${label}</strong><span>${text}</span></div>`;
  };
  const anyFail = [pumi, tpl].includes('fail');
  const allOk = pumi === 'ok' && tpl === 'ok';
  const banner = allOk
    ? '<div class="result-banner result-ok"><i class="bi bi-check-circle-fill"></i><div><div class="result-title">TRIAGEM APROVADA</div><div class="result-sub">PUMI e template conferem.</div></div></div>'
    : anyFail
      ? '<div class="result-banner result-fail"><i class="bi bi-x-circle-fill"></i><div><div class="result-title">TRIAGEM REPROVADA</div><div class="result-sub">Veja os itens com erro abaixo.</div></div></div>'
      : '<div class="result-banner result-wait"><i class="bi bi-hourglass-split"></i><div><div class="result-title">AGUARDANDO</div><div class="result-sub">Cole o PUMI e a planilha do voucher.</div></div></div>';
  box.innerHTML = `${banner}<div class="overall-list">
    ${line(pumi, 'PUMI', pumi === 'wait' ? 'não colado' : (pumi === 'ok' ? 'aprovador encontrado e sem "pending"' : 'reprovado'))}
    ${line(tpl, 'Template', tpl === 'wait' ? 'não colado' : (tpl === 'ok' ? 'todas as regras OK' : 'com erros'))}
  </div>`;
}

function vcRefresh() {
  vcRenderPumi();
  vcRunTemplate();
  vcRenderOverall();
}

function vcClear() {
  vcState.pumi = null;
  vcState.template = null;
  vcState.templateOk = null;
  document.getElementById('vcPumiText').value = '';
  document.getElementById('vcTemplateText').value = '';
  vcRefresh();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    let pumiTimer, tplTimer;
    document.getElementById('vcPumiText').addEventListener('input', () => {
      clearTimeout(pumiTimer);
      pumiTimer = setTimeout(vcHandlePumi, 250);
    });
    document.getElementById('vcTemplateText').addEventListener('input', () => {
      clearTimeout(tplTimer);
      tplTimer = setTimeout(vcHandleTemplate, 250);
    });
    document.getElementById('btnVcLimpar').addEventListener('click', vcClear);
    vcRenderOverall();
  });
}

if (typeof module !== 'undefined') {
  module.exports = { vcParseTemplate, vcEvaluate, vcKind, vcRowAllEmpty, vcBlank };
}
