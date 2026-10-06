/* ===== Navegação ===== */
function showScreen(name, menuItem) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById('screen-' + name);
  if (target) target.classList.add('active');
  if (name === 'special-price' && typeof spRefresh === 'function') spRefresh();
  if (name === 'voucher' && typeof vcRefresh === 'function') vcRefresh();
  if (name === 'prioridades' && typeof prRefresh === 'function') prRefresh();

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
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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
  document.getElementById('templateText').value = '';
  renderPumi();
  updateStartButton();
}

document.addEventListener('DOMContentLoaded', () => {
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
