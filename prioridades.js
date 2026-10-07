/* ===== Lista de prioridades: montar planilha (tabela atual + tabela nova do país) ===== */

const PR_COUNTRIES = [
  { code: 'CO', name: 'Colômbia', sub: 'SAMCOL' },
  { code: 'MX', name: 'México', sub: 'SEM' },
  { code: 'CL', name: 'Chile', sub: 'SECH' },
  { code: 'PE', name: 'Peru', sub: 'SEPR' }
];

const PR_OUT_COLUMNS = ['Sub', 'Ticket', 'Status', 'Assignee', 'Priority', 'Link', 'Comentário', 'Campaigns'];
const PR_JIRA_LOOKUP = "'https://samsung.sharepoint.com/sites/COESDSLA/Shared Documents/GBA Documents & Files/Dashboards 2026/Dashboard CoE - TLC - TNE/[updateJira.xlsx]updateJira'!$A:$E";
const PR_JIRA_BROWSE = 'https://jira.secext.samsung.net/browse/';
const PR_TABLE_ROWS = 200;

const prState = {
  country: 'CO',
  startRow: 2,
  ticketCol: -1,
  commentCol: -1,
  noComment: false,
  pickedTicket: false,
  pickedComment: false,
  built: []
};

function prCountry(code) {
  return PR_COUNTRIES.find(c => c.code === (code || prState.country));
}

function prNormKey(s) {
  return foldText(String(s || '')).replace(/[^a-z0-9]/g, '');
}

function prExtractTicket(raw) {
  const m = String(raw || '').match(/LC-\d{5}(?!\d)/i);
  return m ? m[0].toUpperCase() : '';
}

function prTicketFromRow(cells) {
  for (let i = 0; i < (cells || []).length; i++) {
    const t = prExtractTicket(cells[i]);
    if (t) return t;
  }
  return '';
}

function prDecodeHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function prSheetFromHtml(html) {
  const raw = String(html || '');
  if (!/<table/i.test(raw)) return null;
  const tables = raw.match(/<table[\s\S]*?<\/table>/gi) || [];
  let best = null;
  tables.forEach(table => {
    const rows = [];
    const trs = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    trs.forEach((tr, i) => {
      const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(td => prDecodeHtml(td));
      if (cells.some(c => c)) rows.push({ line: i + 1, cells });
    });
    const width = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
    if (width >= 2 && (!best || width > best.width || (width === best.width && rows.length > best.rows.length))) {
      best = { delim: 'html', rows, width };
    }
  });
  if (!best) return null;
  best.rows.forEach(r => { while (r.cells.length < best.width) r.cells.push(''); });
  return best;
}

function prRowsToTsv(rows) {
  return rows.map(r => r.cells.map(c => String(c ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t')).join('\n');
}

function prSplitLoose(line) {
  const s = String(line || '').replace(/\u00a0/g, ' ').trim();
  if (!s) return [''];
  const urls = s.match(/https?:\/\/[^\s]+/gi) || [];
  let work = s;
  urls.forEach((u, i) => { work = work.replace(u, ` \u0001${i}\u0001 `); });
  const parts = work.split(/[ \t]+/).map(p => p.trim()).filter(Boolean);
  const cells = [];
  const after = [];
  let seenTicket = false;
  parts.forEach(p => {
    const um = p.match(/\u0001(\d+)\u0001/);
    if (um) { cells.push(urls[Number(um[1])]); seenTicket = true; return; }
    if (prExtractTicket(p)) { cells.push(prExtractTicket(p)); seenTicket = true; return; }
    if (!seenTicket) cells.push(p);
    else after.push(p);
  });
  if (after.length) cells.push(after.join(' '));
  return cells.length ? cells : [s];
}

function prSplitCells(line, delim) {
  const s = String(line ?? '').replace(/\u00a0/g, ' ');
  if (delim === 'spaces') {
    return s.trim().split(/\s{2,}|\t+/).map(c => mpStripQuotes(c.trim()));
  }
  if (delim === '\t') return s.split('\t').map(c => mpStripQuotes(c.trim()));
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQ && s[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delim && !inQ) {
      out.push(mpStripQuotes(cur.replace(/\u00a0/g, ' ').trim()));
      cur = '';
    } else cur += ch;
  }
  out.push(mpStripQuotes(cur.replace(/\u00a0/g, ' ').trim()));
  return out;
}

function prDelimScore(lines, delim) {
  const widths = lines.map(s => prSplitCells(s, delim).length);
  const freq = new Map();
  widths.forEach(w => { if (w > 1) freq.set(w, (freq.get(w) || 0) + 1); });
  let width = 1, hits = 0;
  freq.forEach((n, w) => { if (n > hits || (n === hits && w > width)) { hits = n; width = w; } });
  return { width, hits };
}

function prDetectDelimiter(lines) {
  const sample = lines.slice(0, 25).map(l => l.content);
  const tab = prDelimScore(sample, '\t');
  if (tab.hits >= 2 && tab.width >= 2) return '\t';
  let best = { delim: '\t', hits: tab.hits, width: tab.width };
  [';', ',', '|'].forEach(d => {
    const s = prDelimScore(sample, d);
    if (s.hits > best.hits || (s.hits === best.hits && s.width > best.width)) {
      best = { delim: d, hits: s.hits, width: s.width };
    }
  });
  if (best.hits >= 2 && best.width >= 2) return best.delim;
  const sp = prDelimScore(sample, 'spaces');
  if (sp.hits >= 2 && sp.width > best.width) return 'spaces';
  return best.hits ? best.delim : (tab.width >= 2 ? '\t' : (sp.width >= 2 ? 'spaces' : best.delim));
}

function prSplitSheet(text) {
  const htmlSheet = prSheetFromHtml(text);
  if (htmlSheet && htmlSheet.width >= 2) return htmlSheet;
  const lines = String(text || '').replace(/\r/g, '').split('\n')
    .map((content, i) => ({ content, line: i + 1 }))
    .filter(l => l.content.trim() !== '');
  if (!lines.length) return null;
  const delim = prDetectDelimiter(lines);
  let rows = lines.map(({ content, line }) => ({
    line,
    cells: prSplitCells(content, delim)
  }));
  let width = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
  if (width < 2) {
    rows = lines.map(({ content, line }) => ({ line, cells: prSplitLoose(content) }));
    width = rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
  }
  rows.forEach(r => { while (r.cells.length < width) r.cells.push(''); });
  return { delim, rows, width };
}

function prPickHeaderIdx(rows, width) {
  const n = Math.min(rows.length, 8);
  for (let i = 0; i < n; i++) {
    const filled = rows[i].cells.filter(c => String(c).trim()).length;
    const tickets = rows[i].cells.filter(c => prExtractTicket(c)).length;
    if (tickets === 0 && filled >= Math.max(2, width - 1)) return i;
  }
  return 0;
}

function prFindHeader(headers, aliases) {
  const keys = aliases.map(prNormKey);
  const norm = headers.map(prNormKey);
  for (let i = 0; i < norm.length; i++) {
    if (keys.some(k => norm[i] === k)) return i;
  }
  for (let i = 0; i < norm.length; i++) {
    if (keys.some(k => k && norm[i].includes(k))) return i;
  }
  return -1;
}

function prScoreTicketCols(dataRows, width) {
  const scores = Array.from({ length: width }, () => 0);
  dataRows.forEach(r => {
    for (let i = 0; i < width; i++) {
      if (prExtractTicket(r.cells[i])) scores[i]++;
    }
  });
  let idx = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[idx]) idx = i;
  return { idx: scores[idx] > 0 ? idx : -1, scores };
}

function prParseCurrent(text) {
  const sheet = prSplitSheet(text);
  if (!sheet) return { ok: false, error: 'Cole a tabela atual.', rows: [], headers: [] };
  const headerIdx = prPickHeaderIdx(sheet.rows, sheet.width);
  const first = sheet.rows[headerIdx].cells;
  const looksHeader = !prTicketFromRow(first);
  const data = looksHeader ? sheet.rows.slice(headerIdx + 1) : sheet.rows.slice(headerIdx);
  const commentIdx = looksHeader ? prFindHeader(first, ['comentario', 'comment', 'comments']) : -1;
  const subIdx = looksHeader ? prFindHeader(first, ['sub']) : -1;
  const rows = [];
  const seen = new Set();
  data.forEach(r => {
    const ticket = prTicketFromRow(r.cells);
    if (!ticket) return;
    if (seen.has(ticket)) return;
    seen.add(ticket);
    rows.push({
      ticket,
      sub: subIdx >= 0 ? String(r.cells[subIdx] || '').trim() : '',
      comment: commentIdx >= 0 ? String(r.cells[commentIdx] || '').trim() : '',
      line: r.line
    });
  });
  return { ok: true, error: '', headers: first, rows, commentIdx };
}

function prParseNew(text) {
  const sheet = prSplitSheet(text);
  if (!sheet) return { ok: false, error: 'Cole a tabela nova.', rows: [], headers: [], width: 0, samples: [] };
  const headerIdx = prPickHeaderIdx(sheet.rows, sheet.width);
  const first = sheet.rows[headerIdx].cells;
  const looksHeader = !prTicketFromRow(first);
  const headerRow = looksHeader ? first : first.map((_, i) => '');
  const data = looksHeader ? sheet.rows.slice(headerIdx + 1) : sheet.rows.slice(headerIdx);
  const headers = headerRow.map((h, i) => String(h || '').trim() || ('Coluna ' + (i + 1)));
  const samples = [];
  for (let i = 0; i < sheet.width; i++) {
    const hit = data.find(r => String(r.cells[i] || '').trim());
    samples[i] = hit ? String(hit.cells[i]).trim().slice(0, 40) : '';
  }
  const scored = prScoreTicketCols(data, sheet.width);
  const namedTicket = prFindHeader(headers, ['ticket', 'link', 'key', 'issue', 'jira']);
  const namedComment = prFindHeader(headers, [
    'comentario', 'comentarios', 'comment', 'comments', 'notes', 'note', 'nota', 'notas',
    'obs', 'observacao', 'observacoes', 'observacion', 'observaciones',
    'descripcion', 'description', 'descricao', 'justificacion', 'justificativa',
    'motivo', 'remarks', 'detalle', 'detalhe', 'details'
  ]);
  let ticketCol = namedTicket >= 0 && scored.scores[namedTicket] > 0 ? namedTicket : scored.idx;
  let commentCol = namedComment;
  if (commentCol < 0 && sheet.width >= 2) {
    commentCol = sheet.width - 1;
    if (commentCol === ticketCol) commentCol = ticketCol > 0 ? 0 : -1;
  }
  return {
    ok: data.length > 0,
    error: data.length ? '' : 'Nenhuma linha de dados na tabela nova.',
    headers,
    data,
    width: sheet.width,
    ticketCol,
    commentCol,
    scores: scored.scores,
    samples,
    hasHeader: looksHeader
  };
}

function prNewTickets(parsed, ticketCol, commentCol, noComment) {
  const seen = new Set();
  const dups = [];
  const rows = [];
  parsed.data.forEach(r => {
    const ticket = (ticketCol >= 0 ? prExtractTicket(r.cells[ticketCol] || '') : '') || prTicketFromRow(r.cells);
    if (!ticket) return;
    if (seen.has(ticket)) { dups.push(ticket); return; }
    seen.add(ticket);
    const comment = (!noComment && commentCol >= 0) ? String(r.cells[commentCol] || '').trim() : '';
    rows.push({ ticket, comment, line: r.line, raw: r.cells[ticketCol] });
  });
  return { rows, dups };
}

function prMerge(currentRows, newRows, sub) {
  const oldMap = new Map();
  currentRows.forEach(r => { if (!oldMap.has(r.ticket)) oldMap.set(r.ticket, r); });
  const seen = new Set();
  const out = [];
  const stats = { fromNew: 0, overlap: 0, commentNew: 0, commentOld: 0, fromOld: 0 };

  newRows.forEach(n => {
    if (seen.has(n.ticket)) return;
    seen.add(n.ticket);
    const old = oldMap.get(n.ticket);
    const hasNewComment = !!(n.comment && n.comment.trim());
    const comment = hasNewComment ? n.comment : (old ? old.comment : '');
    if (old) stats.overlap++;
    else stats.fromNew++;
    if (hasNewComment && old) stats.commentNew++;
    else if (!hasNewComment && old && old.comment) stats.commentOld++;
    out.push({
      ticket: n.ticket,
      sub,
      comment,
      source: old ? 'ambos' : 'nova',
      commentFrom: hasNewComment ? 'nova' : (old && old.comment ? 'atual' : '')
    });
  });

  currentRows.forEach(o => {
    if (seen.has(o.ticket)) return;
    seen.add(o.ticket);
    stats.fromOld++;
    out.push({
      ticket: o.ticket,
      sub: o.sub || sub,
      comment: o.comment,
      source: 'atual',
      commentFrom: o.comment ? 'atual' : ''
    });
  });

  return { rows: out, stats };
}

function prFormulaStatus(row) { return `=VLOOKUP(B${row},${PR_JIRA_LOOKUP},3,0)`; }
function prFormulaAssignee(row) { return `=VLOOKUP(B${row},${PR_JIRA_LOOKUP},2,0)`; }
function prFormulaLink(row) {
  return `=HYPERLINK(IF(B${row}="","",CONCATENATE("${PR_JIRA_BROWSE}",B${row})))`;
}
function prFormulaCampaigns(row) { return `=VLOOKUP(B${row},${PR_JIRA_LOOKUP},5,0)`; }

function prBuildSheet(merged, startRow) {
  const start = Math.max(1, Number(startRow) || 2);
  return merged.map((r, i) => {
    const excelRow = start + i;
    return {
      excelRow,
      Sub: r.sub,
      Ticket: r.ticket,
      Status: prFormulaStatus(excelRow),
      Assignee: prFormulaAssignee(excelRow),
      Priority: i + 1,
      Link: prFormulaLink(excelRow),
      Comentário: r.comment,
      Campaigns: prFormulaCampaigns(excelRow),
      source: r.source,
      commentFrom: r.commentFrom
    };
  });
}

function prToTsv(built, withHeader) {
  const lines = [];
  if (withHeader) lines.push(PR_OUT_COLUMNS.join('\t'));
  built.forEach(r => {
    lines.push(PR_OUT_COLUMNS.map(c => String(r[c] ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t'));
  });
  return lines.join('\r\n');
}

function prSelOptions(headers, selected, scores, samples) {
  return headers.map((h, i) => {
    const n = scores && scores[i] ? ` (${scores[i]} ticket${scores[i] > 1 ? 's' : ''})` : '';
    const ex = samples && samples[i] ? ` — ${samples[i]}` : '';
    return `<option value="${i}" ${i === selected ? 'selected' : ''}>${i + 1}. ${escapeHtml(h || '(vazio)')}${n}${escapeHtml(ex)}</option>`;
  }).join('');
}

function prRenderCountry() {
  document.getElementById('prTabs').innerHTML = PR_COUNTRIES.map(c => `
    <button type="button" class="country-tab ${c.code === prState.country ? 'active' : ''}" data-pr-country="${c.code}">
      <span class="country-tab-code">${c.code}</span>
      <span class="country-tab-name">${escapeHtml(c.name)}</span>
      <span class="country-tab-status">Sub: ${c.sub}</span>
    </button>`).join('');
}

function prRefresh() {
  prRenderCountry();
  const c = prCountry();
  const current = prParseCurrent(document.getElementById('prCurrentText').value);
  const neu = prParseNew(document.getElementById('prNewText').value);

  if (neu.ok) {
    if (!prState.pickedTicket || prState.ticketCol < 0 || prState.ticketCol >= neu.width) {
      prState.ticketCol = neu.ticketCol;
    }
    if (!prState.pickedComment && neu.commentCol >= 0) prState.commentCol = neu.commentCol;
    if (prState.commentCol >= neu.width) prState.commentCol = -1;
  }

  const colBox = document.getElementById('prNewCols');
  if (!neu.ok) {
    colBox.innerHTML = neu.error ? `<div class="muted">${escapeHtml(neu.error)}</div>` : '';
  } else {
    colBox.innerHTML = `
      <div class="muted small mb-2">${neu.width} coluna(s) lida(s)${neu.width < 2 ? ' — se faltou coluna, copie de novo no Excel (Ctrl+A na planilha, não só o que aparece).' : ''}.</div>
      <div class="d-flex flex-wrap gap-3 align-items-end">
        <div>
          <label class="form-label mb-1" for="prTicketCol">Coluna do ticket (LC- + 5 dígitos)</label>
          <select id="prTicketCol" class="form-select form-select-sm" style="min-width: 280px">
            ${prSelOptions(neu.headers, prState.ticketCol, neu.scores, neu.samples)}
          </select>
        </div>
        <div class="form-check mt-4">
          <input class="form-check-input" type="checkbox" id="prNoComment" ${prState.noComment ? 'checked' : ''}>
          <label class="form-check-label" for="prNoComment">Não tem comentário</label>
        </div>
        <div id="prCommentWrap" style="${prState.noComment ? 'display:none' : ''}">
          <label class="form-label mb-1" for="prCommentCol">Coluna de comentário</label>
          <select id="prCommentCol" class="form-select form-select-sm" style="min-width: 280px">
            <option value="-1" ${prState.commentCol < 0 ? 'selected' : ''}>— escolher —</option>
            ${prSelOptions(neu.headers, prState.commentCol, null, neu.samples)}
          </select>
          <div class="catalog-list mt-2" id="prCommentChips">
            ${neu.headers.map((h, i) => `
              <button type="button" class="catalog-pill ${i === prState.commentCol ? 'active' : ''}" data-pr-comment="${i}">
                ${escapeHtml(h)}<small>${escapeHtml(neu.samples[i] || 'col. ' + (i + 1))}</small>
              </button>`).join('')}
          </div>
        </div>
      </div>
      <div class="muted small mt-2">Sub desta montagem: <strong>${escapeHtml(c.sub)}</strong> (${escapeHtml(c.name)}). Ticket = LC- + 5 dígitos (ex.: LC-53019), em qualquer coluna. Nova primeiro; o que sobrar da atual vai abaixo.</div>`;
    document.getElementById('prTicketCol').addEventListener('change', e => {
      prState.ticketCol = Number(e.target.value);
      prState.pickedTicket = true;
      prRefresh();
    });
    document.getElementById('prNoComment').addEventListener('change', e => {
      prState.noComment = e.target.checked;
      prRefresh();
    });
    const cc = document.getElementById('prCommentCol');
    if (cc) cc.addEventListener('change', e => {
      prState.commentCol = Number(e.target.value);
      prState.pickedComment = true;
      prRefresh();
    });
    const chips = document.getElementById('prCommentChips');
    if (chips) chips.addEventListener('click', e => {
      const b = e.target.closest('[data-pr-comment]');
      if (!b) return;
      prState.commentCol = Number(b.dataset.prComment);
      prState.pickedComment = true;
      prRefresh();
    });
  }

  const out = document.getElementById('prResult');
  const hasCurrent = !!(document.getElementById('prCurrentText').value || '').trim();
  const hasNew = !!(document.getElementById('prNewText').value || '').trim();
  if (!hasCurrent && !hasNew) {
    out.innerHTML = '<div class="result-banner result-wait"><i class="bi bi-hourglass-split"></i><div><div class="result-title">AGUARDANDO</div><div class="result-sub">Cole a tabela atual e a tabela nova do país.</div></div></div>';
    prState.built = [];
    return;
  }
  if (hasCurrent && !current.ok) {
    out.innerHTML = `<div class="result-banner result-fail"><i class="bi bi-x-circle-fill"></i><div><div class="result-title">FALHA NA TABELA ATUAL</div><div class="result-sub">${escapeHtml(current.error)}</div></div></div>`;
    prState.built = [];
    return;
  }
  if (hasNew && !neu.ok) {
    out.innerHTML = `<div class="result-banner result-fail"><i class="bi bi-x-circle-fill"></i><div><div class="result-title">FALHA NA TABELA NOVA</div><div class="result-sub">${escapeHtml(neu.error)}</div></div></div>`;
    prState.built = [];
    return;
  }
  if (!hasNew) {
    out.innerHTML = `<div class="check-item check-info"><div class="check-head"><i class="bi bi-info-circle-fill"></i><strong>Tabela atual</strong><span>${current.rows.length} ticket(s) LC-##### lido(s). Cole a tabela nova para montar.</span></div></div>`;
    prState.built = [];
    return;
  }

  const extracted = prNewTickets(neu, prState.ticketCol, prState.noComment ? -1 : prState.commentCol, prState.noComment);
  if (!extracted.rows.length) {
    out.innerHTML = '<div class="result-banner result-fail"><i class="bi bi-x-circle-fill"></i><div><div class="result-title">SEM TICKET</div><div class="result-sub">Não achei LC- + 5 dígitos (ex.: LC-53019) na tabela nova.</div></div></div>';
    prState.built = [];
    return;
  }
  const merged = prMerge(current.ok ? current.rows : [], extracted.rows, c.sub);
  const built = prBuildSheet(merged.rows, prState.startRow);
  prState.built = built;

  const st = merged.stats;
  const shown = built.slice(0, PR_TABLE_ROWS);
  out.innerHTML = `
    <div class="result-banner result-ok">
      <i class="bi bi-check-circle-fill"></i>
      <div>
        <div class="result-title">PLANILHA MONTADA</div>
        <div class="result-sub">${built.length} linha(s) · nova ${extracted.rows.length} · atual ${current.ok ? current.rows.length : 0} (sobra ${st.fromOld}) · Priority 1…${built.length} · fórmulas a partir da linha ${prState.startRow}.</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat stat-ok"><span>Só na nova</span><strong>${st.fromNew}</strong></div>
      <div class="stat"><span>Já existiam (ordem da nova)</span><strong>${st.overlap}</strong></div>
      <div class="stat"><span>Só na atual (vão abaixo)</span><strong>${st.fromOld}</strong></div>
      <div class="stat"><span>Comentário da nova</span><strong>${st.commentNew}</strong></div>
      <div class="stat"><span>Comentário herdado</span><strong>${st.commentOld}</strong></div>
    </div>
    ${hasCurrent && current.ok && !current.rows.length ? '<div class="check-item check-info"><div class="check-head"><i class="bi bi-info-circle-fill"></i><strong>Tabela atual</strong><span>nenhum LC- + 5 dígitos. Só a nova entrou.</span></div></div>' : ''}
    ${extracted.dups.length ? `<div class="check-item check-info"><div class="check-head"><i class="bi bi-info-circle-fill"></i><strong>Duplicados na nova</strong><span>mantive a primeira ocorrência: ${escapeHtml([...new Set(extracted.dups)].join(', '))}</span></div></div>` : ''}
    <div class="table-wrap"><table class="table table-sm table-dark mb-0">
      <thead><tr>${PR_OUT_COLUMNS.map(h => `<th>${escapeHtml(h)}</th>`).join('')}<th>Origem</th></tr></thead>
      <tbody>${shown.map(r => `<tr>
        <td>${escapeHtml(r.Sub)}</td>
        <td><strong>${escapeHtml(r.Ticket)}</strong></td>
        <td class="pr-formula" title="${escapeHtml(r.Status)}">=VLOOKUP(B${r.excelRow}…,3,0)</td>
        <td class="pr-formula" title="${escapeHtml(r.Assignee)}">=VLOOKUP(B${r.excelRow}…,2,0)</td>
        <td>${r.Priority}</td>
        <td class="pr-formula" title="${escapeHtml(r.Link)}">=HYPERLINK(…B${r.excelRow})</td>
        <td>${escapeHtml(r.Comentário)}</td>
        <td class="pr-formula" title="${escapeHtml(r.Campaigns)}">=VLOOKUP(B${r.excelRow}…,5,0)</td>
        <td class="muted">${escapeHtml(r.source)}${r.commentFrom ? ' · com. ' + r.commentFrom : ''}</td>
      </tr>`).join('')}</tbody></table></div>
      ${built.length > PR_TABLE_ROWS ? `<div class="muted small mt-2">Prévia: ${PR_TABLE_ROWS} de ${built.length} linhas. O copiar leva todas.</div>` : ''}
      <div class="muted small mt-2">Use <strong>Copiar linhas</strong> ou <strong>Baixar Excel</strong>. Colar o texto puro faz o Excel pôr <code>'</code> na frente da fórmula e ela não calcula.</div>`;
}

function prFormulaCells(built) {
  return built.map(r => PR_OUT_COLUMNS.map(c => {
    const v = r[c];
    if (typeof v === 'string' && v.charAt(0) === '=') return 0;
    if (c === 'Priority') return Number(v);
    return v == null ? '' : v;
  }));
}

function prApplyFormulas(ws, built) {
  built.forEach((r, ri) => {
    PR_OUT_COLUMNS.forEach((c, ci) => {
      const v = r[c];
      if (typeof v === 'string' && v.charAt(0) === '=') {
        ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = { t: 'n', f: v.replace(/^=/, ''), v: 0 };
      }
    });
  });
}

function prFillTable(built) {
  const table = document.createElement('table');
  built.forEach(r => {
    const tr = document.createElement('tr');
    PR_OUT_COLUMNS.forEach(c => {
      const td = document.createElement('td');
      td.textContent = String(r[c] ?? '');
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  return table;
}

function prCopied(btn) {
  const html = btn.innerHTML;
  btn.textContent = 'Copiado';
  setTimeout(() => { btn.innerHTML = html; }, 1500);
}

function prCopy() {
  const built = prState.built;
  if (!built || !built.length) { alert('Nada para copiar. Cole as tabelas primeiro.'); return; }
  const btn = document.getElementById('prCopy');
  const host = document.getElementById('prClip');
  host.innerHTML = '';
  host.appendChild(prFillTable(built));
  const table = host.querySelector('table');
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNode(table);
  sel.removeAllRanges();
  sel.addRange(range);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  sel.removeAllRanges();
  host.innerHTML = '';
  if (ok) { prCopied(btn); return; }
  alert('Não deu para copiar como tabela. Use Baixar Excel.');
}

function prDownloadXlsx() {
  const built = prState.built;
  if (!built || !built.length) { alert('Nada para baixar. Cole as tabelas primeiro.'); return; }
  if (typeof XLSX === 'undefined') { alert('Biblioteca de Excel não carregou.'); return; }
  const ws = XLSX.utils.aoa_to_sheet(prFormulaCells(built));
  prApplyFormulas(ws, built);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Prioridades');
  XLSX.writeFile(wb, 'prioridades.xlsx');
}

function prPasteInto(e) {
  const html = e.clipboardData ? e.clipboardData.getData('text/html') : '';
  const plain = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  const fromHtml = prSheetFromHtml(html);
  const fromPlain = prSplitSheet(plain || '');
  const htmlW = fromHtml ? fromHtml.width : 0;
  const plainW = fromPlain ? fromPlain.width : 0;
  if (fromHtml && htmlW >= 2 && htmlW > plainW) {
    e.preventDefault();
    e.target.value = prRowsToTsv(fromHtml.rows);
    if (e.target.id === 'prNewText') {
      prState.pickedTicket = false;
      prState.pickedComment = false;
    }
    prRefresh();
  }
}

function prClear() {
  document.getElementById('prCurrentText').value = '';
  document.getElementById('prNewText').value = '';
  prState.ticketCol = -1;
  prState.commentCol = -1;
  prState.noComment = false;
  prState.pickedTicket = false;
  prState.pickedComment = false;
  prState.built = [];
  prRefresh();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    prRenderCountry();
    document.getElementById('prTabs').addEventListener('click', e => {
      const b = e.target.closest('[data-pr-country]');
      if (!b) return;
      prState.country = b.dataset.prCountry;
      prRefresh();
    });
    let t1, t2;
    document.getElementById('prCurrentText').addEventListener('input', () => {
      clearTimeout(t1); t1 = setTimeout(prRefresh, 250);
    });
    document.getElementById('prNewText').addEventListener('paste', prPasteInto);
    document.getElementById('prCurrentText').addEventListener('paste', prPasteInto);
    document.getElementById('prNewText').addEventListener('input', () => {
      prState.pickedTicket = false;
      prState.pickedComment = false;
      clearTimeout(t2); t2 = setTimeout(prRefresh, 250);
    });
    document.getElementById('prStartRow').addEventListener('change', e => {
      prState.startRow = Math.max(1, parseInt(e.target.value, 10) || 2);
      prRefresh();
    });
    document.getElementById('prCopy').addEventListener('click', prCopy);
    document.getElementById('prXlsx').addEventListener('click', prDownloadXlsx);
    document.getElementById('prClear').addEventListener('click', prClear);
    prRefresh();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    prExtractTicket, prTicketFromRow, prParseCurrent, prParseNew, prNewTickets, prMerge, prBuildSheet, prToTsv, prFormulaStatus, prFormulaLink, prDetectDelimiter, prSplitSheet, prSheetFromHtml, prSplitLoose
  };
}
