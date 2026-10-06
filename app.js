/* ===== Navegação ===== */
function showScreen(name, menuItem) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('screen-' + name);
  if (target) target.classList.add('active');
  if (name === 'special-price' && typeof spRefresh === 'function') spRefresh(); // pega dados novos de Minimum prices

  const active = menuItem || name;
  document.querySelectorAll('.side-button').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === active);
  });
}

/* ===== Estado ===== */
const state = {
  pumi: null,      // { text, result }
  template: null   // { file, workbook }
};

/* ===== Utilidades ===== */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function setupDropzone(zoneId, inputId, onFile) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files[0]) onFile(input.files[0]);
  });
  ['dragenter', 'dragover'].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev =>
    zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove('dragover'); }));
  zone.addEventListener('drop', e => {
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
}

function hasExt(file, exts) {
  const name = file.name.toLowerCase();
  return exts.some(x => name.endsWith(x));
}

// Atualiza a conferência do template e o resultado geral (specialprice.js).
function updateStartButton() {
  if (typeof spRefresh === 'function') spRefresh();
}

/* ===== PUMI (e-mail) ===== */
function highlightSnippet(s) {
  return `<span class="ev-snippet">${escapeHtml(s.before)}<mark>${escapeHtml(s.match)}</mark>${escapeHtml(s.after)}</span>`;
}

function evidenceItem({ status, title, summary, snippets, extra }) {
  const icon = { ok: 'bi-check-circle-fill', fail: 'bi-x-circle-fill', info: 'bi-info-circle-fill' }[status];
  return `
    <div class="check-item check-${status}">
      <div class="check-head"><i class="bi ${icon}"></i><strong>${escapeHtml(title)}</strong><span>${summary}</span></div>
      ${snippets && snippets.length ? `<div class="check-evidence">${snippets.map(highlightSnippet).join('')}</div>` : ''}
      ${extra || ''}
    </div>`;
}

function renderPumiResult(result) {
  const { approvers, foundApprovers, approversOk, pending, pendingOk, completed } = result;

  const approverItems = approvers.map(a => a.count > 0
    ? `<div class="approver found"><i class="bi bi-check-lg"></i> ${escapeHtml(a.name)} <small>(${a.count}x)</small></div>
       <div class="check-evidence">${a.snippets.map(highlightSnippet).join('')}</div>`
    : `<div class="approver missing"><i class="bi bi-dash-lg"></i> ${escapeHtml(a.name)} <small>(não encontrado)</small></div>`
  ).join('');

  return `
    <div class="result-banner ${result.ok ? 'result-ok' : 'result-fail'}">
      <i class="bi ${result.ok ? 'bi-check-circle-fill' : 'bi-x-circle-fill'}"></i>
      <div>
        <div class="result-title">${result.ok ? 'SUCESSO' : 'FALHA'}</div>
        <div class="result-sub">${result.ok
          ? 'Aprovador encontrado e nenhum "pending" no arquivo.'
          : [!approversOk ? 'Nenhum dos 3 aprovadores foi encontrado.' : '', !pendingOk ? 'Existe "pending" no arquivo.' : ''].filter(Boolean).join(' ')}</div>
      </div>
    </div>

    ${evidenceItem({
      status: approversOk ? 'ok' : 'fail',
      title: 'Aprovadores',
      summary: `${foundApprovers.length} de ${approvers.length} presentes (precisa de pelo menos 1)`,
      extra: `<div class="approver-list">${approverItems}</div>`
    })}

    ${evidenceItem({
      status: pendingOk ? 'ok' : 'fail',
      title: 'Sem "pending"',
      summary: pendingOk ? 'Nenhuma ocorrência de "pending"' : `${pending.count} ocorrência(s) de "pending"`,
      snippets: pending.snippets
    })}

    ${evidenceItem({
      status: completed.count > 0 ? 'ok' : 'info',
      title: 'Approval completed (informativo)',
      summary: completed.count > 0 ? `${completed.count} ocorrência(s)` : 'Não escrito no arquivo (não obrigatório)',
      snippets: completed.snippets
    })}`;
}

function renderPumi() {
  const resultBox = document.getElementById('pumiResult');
  if (!state.pumi || !state.pumi.result) {
    resultBox.classList.add('d-none');
    resultBox.innerHTML = '';
    return;
  }
  resultBox.classList.remove('d-none');
  resultBox.innerHTML = renderPumiResult(state.pumi.result);
}

function handlePumiText() {
  const text = cleanInvisible(document.getElementById('pumiText').value);
  state.pumi = text.trim() ? { text, result: checkPumi(text) } : null;
  renderPumi();
  updateStartButton();
}

/* ===== Template (Excel) ===== */
const PREVIEW_MAX_ROWS = 100;

function renderSheet(sheetName) {
  const { workbook } = state.template;
  const ws = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);

  document.getElementById('sheetStats').textContent =
    `${rows.length} linhas × ${maxCols} colunas`;

  const table = document.getElementById('previewTable');
  const shown = rows.slice(0, PREVIEW_MAX_ROWS);
  const head = '<thead><tr><th>#</th>' +
    Array.from({ length: maxCols }, (_, i) => `<th>${XLSX.utils.encode_col(i)}</th>`).join('') +
    '</tr></thead>';
  const bodyHtml = '<tbody>' + shown.map((r, i) =>
    `<tr><td class="muted">${i + 1}</td>` +
    Array.from({ length: maxCols }, (_, c) => `<td title="${escapeHtml(r[c])}">${escapeHtml(r[c])}</td>`).join('') +
    '</tr>').join('') + '</tbody>';
  table.innerHTML = head + bodyHtml;

  document.getElementById('previewNote').textContent =
    rows.length > PREVIEW_MAX_ROWS ? `Mostrando as primeiras ${PREVIEW_MAX_ROWS} linhas.` : '';
}

function renderTemplate() {
  const info = document.getElementById('templateInfo');
  const zone = document.getElementById('templateDrop');
  const preview = document.getElementById('templatePreview');

  if (!state.template) {
    info.classList.add('d-none');
    preview.classList.add('d-none');
    zone.classList.remove('has-file');
    return;
  }
  const { file, workbook } = state.template;
  zone.classList.add('has-file');
  info.classList.remove('d-none');
  info.innerHTML = `
    <dl>
      <dt>Arquivo</dt><dd>${escapeHtml(file.name)} (${formatSize(file.size)})</dd>
      <dt>Abas</dt><dd>${workbook.SheetNames.map(escapeHtml).join(', ')}</dd>
    </dl>`;

  const select = document.getElementById('sheetSelect');
  select.innerHTML = workbook.SheetNames
    .map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  preview.classList.remove('d-none');
  renderSheet(workbook.SheetNames[0]);
}

async function handleTemplate(file) {
  if (!hasExt(file, ['.xlsx', '.xls', '.xlsm'])) {
    alert('Formato inválido. Use .xlsx, .xls ou .xlsm.');
    return;
  }
  if (typeof XLSX === 'undefined') {
    alert('Biblioteca de Excel não carregou. Verifique a conexão com a internet.');
    return;
  }
  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
    state.template = { file, workbook };
    renderTemplate();
    updateStartButton();
  } catch (err) {
    alert('Não foi possível ler o Excel: ' + err.message);
  }
}

/* ===== Ações ===== */
function clearAll() {
  state.pumi = null;
  state.template = null;
  document.getElementById('pumiText').value = '';
  document.getElementById('templateInput').value = '';
  renderPumi();
  renderTemplate();
  updateStartButton();
}

document.addEventListener('DOMContentLoaded', () => {
  let pumiTimer;
  document.getElementById('pumiText').addEventListener('input', () => {
    clearTimeout(pumiTimer);
    pumiTimer = setTimeout(handlePumiText, 250);
  });
  setupDropzone('templateDrop', 'templateInput', handleTemplate);

  document.getElementById('sheetSelect').addEventListener('change', e => {
    renderSheet(e.target.value);
    updateStartButton();
  });
  document.getElementById('btnLimpar').addEventListener('click', clearAll);
});
