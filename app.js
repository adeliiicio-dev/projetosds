/* ===== Navegação ===== */
function showScreen(name, menuItem) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('screen-' + name);
  if (target) target.classList.add('active');

  const active = menuItem || name;
  document.querySelectorAll('.side-button').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === active);
  });
}

/* ===== Estado ===== */
const state = {
  pumi: null,      // { file, headers, body }
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

function updateStartButton() {
  document.getElementById('btnIniciar').disabled = !(state.pumi && state.template);
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
  const info = document.getElementById('pumiInfo');
  const resultBox = document.getElementById('pumiResult');
  const zone = document.getElementById('pumiDrop');
  if (!state.pumi) {
    info.classList.add('d-none');
    info.innerHTML = '';
    resultBox.classList.add('d-none');
    resultBox.innerHTML = '';
    zone.classList.remove('has-file');
    return;
  }
  const { file, meta, text, note, result } = state.pumi;
  zone.classList.add('has-file');
  info.classList.remove('d-none');
  info.innerHTML = `
    <dl>
      <dt>Arquivo</dt><dd>${escapeHtml(file.name)} (${formatSize(file.size)})</dd>
      ${meta.from ? `<dt>De</dt><dd>${escapeHtml(meta.from)}</dd>` : ''}
      ${meta.to ? `<dt>Para</dt><dd>${escapeHtml(meta.to)}</dd>` : ''}
      ${meta.subject ? `<dt>Assunto</dt><dd>${escapeHtml(meta.subject)}</dd>` : ''}
      ${meta.date ? `<dt>Data</dt><dd>${escapeHtml(String(meta.date))}</dd>` : ''}
      ${note ? `<dt>Obs.</dt><dd class="text-warning">${escapeHtml(note)}</dd>` : ''}
    </dl>`;

  resultBox.classList.remove('d-none');
  resultBox.innerHTML = renderPumiResult(result) + `
    <details class="mt-3">
      <summary class="muted">Ver texto lido do arquivo</summary>
      <div class="email-body">${escapeHtml(flattenSpaces(text).slice(0, 20000))}</div>
    </details>`;
}

async function handlePumi(file) {
  if (!hasExt(file, ['.eml', '.msg'])) {
    alert('Formato inválido. Use .eml ou .msg.');
    return;
  }
  try {
    const { meta, text, note } = await readPumiFile(file);
    state.pumi = { file, meta, text, note, result: checkPumi(text) };
    renderPumi();
    updateStartButton();
  } catch (err) {
    alert('Não foi possível ler o e-mail: ' + err.message);
  }
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
    const workbook = XLSX.read(buffer, { type: 'array' });
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
  document.getElementById('pumiInput').value = '';
  document.getElementById('templateInput').value = '';
  renderPumi();
  renderTemplate();
  updateStartButton();
}

document.addEventListener('DOMContentLoaded', () => {
  setupDropzone('pumiDrop', 'pumiInput', handlePumi);
  setupDropzone('templateDrop', 'templateInput', handleTemplate);

  document.getElementById('sheetSelect').addEventListener('change', e => renderSheet(e.target.value));
  document.getElementById('btnLimpar').addEventListener('click', clearAll);
  document.getElementById('btnIniciar').addEventListener('click', () => {
    // TODO: lógica da triagem de Special price (aguardando detalhes)
    alert('Arquivos carregados. Lógica da triagem será definida na próxima etapa.');
  });
});
