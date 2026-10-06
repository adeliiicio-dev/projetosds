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
  template: null   // { text }
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
          ? 'Aprovador encontrado e nenhum "pending" no corpo do e-mail.'
          : [!approversOk ? 'Nenhum dos 3 aprovadores foi encontrado no corpo.' : '', !pendingOk ? 'Existe "pending" no corpo do e-mail.' : ''].filter(Boolean).join(' ')}</div>
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
      summary: completed.count > 0 ? `${completed.count} ocorrência(s)` : 'Não escrito no corpo (não obrigatório)',
      snippets: completed.snippets
    })}`;
}

function formatPartLine(p) {
  return [p.type || '(sem tipo)', p.encoding, p.charset && 'charset ' + p.charset,
    p.size != null && formatSize(p.size), p.chars != null && p.chars + ' caracteres', p.status]
    .filter(Boolean).join(' · ') + (p.preview ? '\n   início: ' + p.preview : '');
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

  const { file, meta, text, note, result, partsInfo, unreadable } = state.pumi;
  if (file) zone.classList.add('has-file');
  else zone.classList.remove('has-file');

  if (file || (meta && (meta.from || meta.subject))) {
    info.classList.remove('d-none');
    info.innerHTML = `
      <dl>
        ${file ? `<dt>Arquivo</dt><dd>${escapeHtml(file.name)} (${formatSize(file.size)})</dd>` : '<dt>Origem</dt><dd>Texto colado</dd>'}
        ${meta && meta.from ? `<dt>De</dt><dd>${escapeHtml(meta.from)}</dd>` : ''}
        ${meta && meta.to ? `<dt>Para</dt><dd>${escapeHtml(meta.to)}</dd>` : ''}
        ${meta && meta.subject ? `<dt>Assunto</dt><dd>${escapeHtml(meta.subject)}</dd>` : ''}
        ${meta && meta.date ? `<dt>Data</dt><dd>${escapeHtml(String(meta.date))}</dd>` : ''}
        <dt>Conferência</dt><dd>Só o corpo do e-mail. Anexos e cabeçalhos (De/Para/Cc) ficam de fora.</dd>
        ${note ? `<dt>Obs.</dt><dd class="text-warning">${escapeHtml(note)}</dd>` : ''}
      </dl>`;
  } else {
    info.classList.add('d-none');
    info.innerHTML = '';
  }

  resultBox.classList.remove('d-none');
  if (!result) {
    resultBox.innerHTML = `
      <div class="result-banner result-fail">
        <i class="bi bi-exclamation-triangle-fill"></i>
        <div>
          <div class="result-title">NÃO FOI POSSÍVEL LER O ARQUIVO</div>
          <div class="result-sub">${escapeHtml(unreadable || note || 'Sem texto no corpo do e-mail.')}</div>
        </div>
      </div>`;
    return;
  }

  const extras = `
    <details class="mt-3">
      <summary class="muted">Ver texto lido do corpo</summary>
      <div class="email-body">${escapeHtml(flattenSpaces(text || '').slice(0, 20000))}</div>
    </details>
    ${partsInfo && partsInfo.length ? `
    <details class="mt-2">
      <summary class="muted">Ver estrutura do e-mail (partes lidas e anexos ignorados)</summary>
      <div class="email-body">${partsInfo.map(p => escapeHtml(formatPartLine(p))).join('\n\n')}</div>
    </details>` : ''}`;
  resultBox.innerHTML = renderPumiResult(result) + extras;
}

async function handlePumi(file) {
  if (!hasExt(file, ['.eml', '.msg'])) {
    alert('Formato inválido. Use .eml ou .msg.');
    return;
  }
  try {
    const { meta, text, searchText, note, partsInfo, unreadable } = await readPumiFile(file);
    document.getElementById('pumiText').value = '';
    state.pumi = {
      file, meta, text, note, unreadable, partsInfo: partsInfo || [],
      result: unreadable ? null : checkPumi(searchText || text)
    };
    renderPumi();
    updateStartButton();
  } catch (err) {
    alert('Não foi possível ler o e-mail: ' + err.message);
  }
}

function handlePumiText() {
  const text = cleanInvisible(document.getElementById('pumiText').value);
  if (!text.trim()) {
    if (state.pumi && state.pumi.file) return;
    state.pumi = null;
    renderPumi();
    updateStartButton();
    return;
  }
  const input = document.getElementById('pumiInput');
  if (input) input.value = '';
  state.pumi = { text, result: checkPumi(text) };
  renderPumi();
  updateStartButton();
}

/* ===== Template (colado como texto) ===== */
function handleTemplateText() {
  const text = cleanInvisible(document.getElementById('templateText').value);
  state.template = text.trim() ? { text } : null;
  updateStartButton();
}

/* ===== Ações ===== */
function clearAll() {
  state.pumi = null;
  state.template = null;
  document.getElementById('pumiText').value = '';
  document.getElementById('pumiInput').value = '';
  document.getElementById('templateText').value = '';
  renderPumi();
  updateStartButton();
}

document.addEventListener('DOMContentLoaded', () => {
  setupDropzone('pumiDrop', 'pumiInput', handlePumi);
  let pumiTimer;
  document.getElementById('pumiText').addEventListener('input', () => {
    clearTimeout(pumiTimer);
    pumiTimer = setTimeout(handlePumiText, 250);
  });
  let templateTimer;
  document.getElementById('templateText').addEventListener('input', () => {
    clearTimeout(templateTimer);
    templateTimer = setTimeout(handleTemplateText, 250);
  });
  document.getElementById('btnLimpar').addEventListener('click', clearAll);
});
