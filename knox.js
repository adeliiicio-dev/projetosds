/* ===== Triagem > Knox approval: configuration type + action ===== */

const KNOX_ROWS = [
  ["Add On", "Modify Stackability", true],
  ["Add On", "STG Test", false],
  ["Add On", "Publish", true],
  ["Add On", "Modify Priority", false],
  ["Add On", "Modify Message in Cart", false],
  ["Add On", "Modify SKU/Categorie", true],
  ["Add On", "Modify Dates (Start/End)", true],
  ["Add On", "Modify Bridge Page", false],
  ["Add On", "Modify Discount", true],
  ["Add On", "Creation", true],
  ["Benefits", "Modify SKU/Categorie", false],
  ["Benefits", "Creation", false],
  ["Benefits", "Modify Priority", false],
  ["Benefits", "STG Test", false],
  ["Benefits", "Publish", false],
  ["Benefits", "Modify Dates (Start/End)", false],
  ["BIN", "Creation", true],
  ["BIN", "STG Test", false],
  ["BIN", "Modify SKU/Categorie", true],
  ["BIN", "Modify Message in Cart", false],
  ["BIN", "Modify Stackability", true],
  ["BIN", "Modify BIN codes", true],
  ["BIN", "Modify Discount", true],
  ["BIN", "Publish", true],
  ["BIN", "Modify Priority", false],
  ["Blacklist", "Creation", false],
  ["BOGO", "Modify Message in Cart", false],
  ["BOGO", "Modify SKU/Categorie", true],
  ["BOGO", "Modify Stackability", true],
  ["BOGO", "Creation", true],
  ["BOGO", "Modify Bridge Page", false],
  ["BOGO", "STG Test", false],
  ["BOGO", "Publish", true],
  ["BOGO", "Modify Dates (Start/End)", true],
  ["BOGO", "Modify Discount", true],
  ["BOGO", "Modify Priority", false],
  ["Delivey Mode/Service Configuration", "Creation", false],
  ["Delivery Mode/Service Creation", "Creation", false],
  ["Fcode Creation", "Creation", true],
  ["Fcode Promotion", "STG Test", false],
  ["Fcode Promotion", "Modify Priority", false],
  ["Fcode Promotion", "Modify Discount", true],
  ["Fcode Promotion", "Modify Stackability", true],
  ["Fcode Promotion", "Publish", true],
  ["Fcode Promotion", "Modify Message in Cart", false],
  ["Fcode Promotion", "Creation", true],
  ["Fcode Promotion", "Modify Dates (Start/End)", true],
  ["Fcode Promotion", "Modify SKU/Categorie", true],
  ["Free Delivery", "Modify Priority", false],
  ["Free Delivery", "Modify Dates (Start/End)", false],
  ["Free Delivery", "Creation", false],
  ["Free Delivery", "STG Test", false],
  ["Free Delivery", "Publish", false],
  ["Free Delivery", "Modify Message in Cart", false],
  ["Free Delivery", "Modify Discount", false],
  ["Free Delivery", "Modify SKU/Categorie", false],
  ["Free Delivery", "Modify Stackability", false],
  ["General Issue", "Issue", false],
  ["Gift", "Modify Message in Cart", false],
  ["Gift", "Creation", false],
  ["Gift", "Modify Priority", false],
  ["Gift", "Modify SKU/Categorie", false],
  ["Gift", "STG Test", false],
  ["Gift", "Publish", false],
  ["Gift", "Modify Stackability", false],
  ["Gift", "Modify Bridge Page", false],
  ["Gift", "Modify Dates (Start/End)", false],
  ["Gift", "Modify Discount", false],
  ["Insurama (SEPR)", "Creation", false],
  ["Intallments Prices", "Creation", false],
  ["Merch Flag", "Creation", false],
  ["Minimum Price", "Creation", false],
  ["Must Purchase With", "Modify Message in Cart", false],
  ["Must Purchase With", "Modify Dates (Start/End)", true],
  ["Must Purchase With", "Modify Stackability", true],
  ["Must Purchase With", "Publish", true],
  ["Must Purchase With", "Modify SKU/Categorie", true],
  ["Must Purchase With", "Creation", true],
  ["Must Purchase With", "STG Test", false],
  ["Must Purchase With", "Modify Priority", false],
  ["Must Purchase With", "Modify Discount", true],
  ["Other Promotions", "Creation", true],
  ["Payment Method", "Modify Dates (Start/End)", true],
  ["Payment Method", "Creation", true],
  ["Payment Method", "Publish", true],
  ["Payment Method", "STG Test", false],
  ["Payment Method", "Modify Stackability", true],
  ["Payment Method", "Modify Priority", false],
  ["Payment Method", "Modify Message in Cart", false],
  ["Payment Method", "Modift Payment Mode", true],
  ["Payment Method", "Modify Discount", true],
  ["Payment Method", "Modify SKU/Categorie", true],
  ["Progressive Discount", "Modify Priority", false],
  ["Progressive Discount", "Modify Stackability", true],
  ["Progressive Discount", "Modify Message in Cart", false],
  ["Progressive Discount", "Modify Dates (Start/End)", true],
  ["Progressive Discount", "Modify Discount", true],
  ["Progressive Discount", "Creation", true],
  ["Progressive Discount", "STG Test", false],
  ["Progressive Discount", "Add Voucher Code", true],
  ["Progressive Discount", "Modify SKU/Categorie", true],
  ["Progressive Discount", "Publish", true],
  ["Rewards Boost", "Modify Priority", false],
  ["Rewards Boost", "Modify Stackability", true],
  ["Rewards Boost", "Modify Message in Cart", false],
  ["Rewards Boost", "Modify Dates (Start/End)", true],
  ["Rewards Boost", "Modify Discount", true],
  ["Rewards Boost", "Creation", true],
  ["Rewards Boost", "STG Test", false],
  ["Rewards Boost", "Modify SKU/Categorie", true],
  ["Rewards Boost", "Publish", true],
  ["SC+", "Promotion", true],
  ["SC+", "Creation (Bundle)", false],
  ["SC+", "Update (Bundle)", false],
  ["SC+", "Creation (Standalone)", true],
  ["SC+", "Update (Standalone)", false],
  ["SKU Configuration", "Creation", false],
  ["SKU Creation", "Creation", false],
  ["Special Prices", "Creation", true],
  ["Special Prices", "Erase/Update Special Prices", false],
  ["Screen Repair", "Creation", false],
  ["Stock Configuration", "Creation", false],
  ["Trade In (serviço)", "Creation", false],
  ["Trade In (PROMO)", "Modify Stackability", true],
  ["Trade In (PROMO)", "Modify Discount", true],
  ["Trade In (PROMO)", "Creation", true],
  ["Trade In (PROMO)", "Modify Message in Cart", false],
  ["Trade In (PROMO)", "STG Test", false],
  ["Trade In (PROMO)", "Modify Dates (Start/End)", true],
  ["Trade In (PROMO)", "Modify SKU/Categorie", true],
  ["Trade In (PROMO)", "Publish", true],
  ["Trade In (PROMO)", "Modify Priority", false],
  ["Trade Up (serviço)", "Creation", false],
  ["Trade Up (PROMO)", "Publish", true],
  ["Trade Up (PROMO)", "STG Test", false],
  ["Trade Up (PROMO)", "Modify Dates (Start/End)", true],
  ["Trade Up (PROMO)", "Modify SKU/Categorie", true],
  ["Trade Up (PROMO)", "Modify Discount", true],
  ["Trade Up (PROMO)", "Modify Priority", false],
  ["Trade Up (PROMO)", "Modify Message in Cart", false],
  ["Trade Up (PROMO)", "Modify Stackability", true],
  ["Trade Up (PROMO)", "Creation", true],
  ["Voucher/Cupom", "Modify Stackability", true],
  ["Voucher/Cupom", "STG Test", false],
  ["Voucher/Cupom", "Creation", true],
  ["Voucher/Cupom", "Add Voucher Code", true],
  ["Voucher/Cupom", "Modify Priority", false],
  ["Voucher/Cupom", "Modify Dates (Start/End)", true],
  ["Voucher/Cupom", "Modify Message in Cart", false],
  ["Voucher/Cupom", "Modify SKU/Categorie", true],
  ["Voucher/Cupom", "Modify Discount", true],
  ["Voucher/Cupom", "Publish", true],
  ["Warranty", "Promotion", true],
  ["Warranty", "Creation (Bundle)", false],
  ["Warranty", "Update (Bundle)", false],
  ["Warranty", "Creation (Standalone)", true],
  ["Warranty", "Update (Standalone)", false],
  ["Warehouse", "Creation", false],
  ["Welcome Discount", "Creation", true],
  ["Welcome Discount", "Modify Message in Cart", false],
  ["Welcome Discount", "STG Test", false],
  ["Welcome Discount", "Modify SKU/Categorie", true],
  ["Welcome Discount", "Modify Discount", true],
  ["Welcome Discount", "Modify Stackability", true],
  ["Welcome Discount", "Modify Priority", false],
  ["Welcome Discount", "Publish", true],
  ["Welcome Discount", "Modify Dates (Start/End)", true],
  ["Whitelist", "Creation", false],
];

function knoxNorm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00a0/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function knoxSplit(text) {
  const line = String(text || '').replace(/\u00a0/g, ' ').trim();
  const parts = line.split(/\s*[-–—]\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { type: parts.slice(0, -1).join(' - '), action: parts[parts.length - 1] };
  }
  return { type: line, action: '' };
}

const KNOX_INDEX = KNOX_ROWS.map(([type, action, knox]) => ({
  type, action, knox, nt: knoxNorm(type), na: knoxNorm(action)
}));

function knoxLookup(text) {
  const raw = String(text || '').trim();
  if (!knoxNorm(raw)) return { status: 'empty' };

  const { type, action } = knoxSplit(raw);
  const nt = knoxNorm(type);
  const na = knoxNorm(action);

  let hit = KNOX_INDEX.find(r => r.nt === nt && r.na === na);
  if (!hit && na) {
    hit = KNOX_INDEX.find(r => r.na === na && (r.nt === nt || r.nt.includes(nt) || nt.includes(r.nt)));
  }
  if (hit) {
    return { status: 'ok', knox: hit.knox, type: hit.type, action: hit.action, mixed: false, rows: [hit] };
  }

  const same = KNOX_INDEX.filter(r => r.nt === nt || (!na && (r.nt.includes(nt) || nt.includes(r.nt))));
  if (same.length) {
    const yes = same.filter(r => r.knox);
    const no = same.filter(r => !r.knox);
    const mixed = yes.length > 0 && no.length > 0;
    return {
      status: 'ok',
      knox: mixed ? null : yes.length > 0,
      type: same[0].type,
      action: '',
      mixed,
      rows: same
    };
  }

  return { status: 'miss', raw };
}

function knoxBanner(item) {
  if (item.status === 'miss') {
    return `<div class="result-banner result-fail">
      <i class="bi bi-x-circle-fill"></i>
      <div>
        <div class="result-title">NÃO ACHEI</div>
        <div class="result-sub">Não encontrei <strong>${escapeHtml(item.raw)}</strong> na tabela de Knox.</div>
      </div>
    </div>`;
  }

  const label = `${item.type}${item.action ? ' — ' + item.action : ''}`;
  if (item.mixed) {
    const yes = item.rows.filter(r => r.knox).map(r => r.action).join(', ');
    const no = item.rows.filter(r => !r.knox).map(r => r.action).join(', ');
    return `<div class="result-banner result-wait">
      <i class="bi bi-info-circle-fill"></i>
      <div>
        <div class="result-title">DEPENDE DA ACTION</div>
        <div class="result-sub"><strong>${escapeHtml(item.type)}</strong> tem Knox em algumas actions. Cole também a action (ex.: Type - Creation).</div>
        <div class="result-sub mt-1">Knox SIM: ${escapeHtml(yes || '—')}</div>
        <div class="result-sub">Knox NÃO: ${escapeHtml(no || '—')}</div>
      </div>
    </div>`;
  }

  if (item.knox) {
    return `<div class="result-banner result-ok">
      <i class="bi bi-check-circle-fill"></i>
      <div>
        <div class="result-title">É KNOX APPROVAL</div>
        <div class="result-sub">${escapeHtml(label)}</div>
      </div>
    </div>`;
  }

  return `<div class="result-banner result-fail">
    <i class="bi bi-x-circle-fill"></i>
    <div>
      <div class="result-title">NÃO É KNOX APPROVAL</div>
      <div class="result-sub">${escapeHtml(label)}</div>
    </div>
  </div>`;
}

function knoxClear() {
  const ta = document.getElementById('knoxText');
  if (ta) ta.value = '';
  knoxRefresh();
}

function knoxRefresh() {
  const ta = document.getElementById('knoxText');
  const out = document.getElementById('knoxResult');
  if (!ta || !out) return;

  const lines = String(ta.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) {
    out.innerHTML = '<div class="result-banner result-wait"><i class="bi bi-hourglass-split"></i><div><div class="result-title">AGUARDANDO</div><div class="result-sub">Cole o configuration type e a action, no formato Type - Action.</div></div></div>';
    return;
  }

  out.innerHTML = lines.map(line => knoxBanner(knoxLookup(line))).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  const ta = document.getElementById('knoxText');
  const clear = document.getElementById('btnKnoxLimpar');
  if (ta) {
    ta.addEventListener('input', knoxRefresh);
    ta.addEventListener('paste', () => setTimeout(knoxRefresh, 0));
  }
  if (clear) {
    clear.addEventListener('click', knoxClear);
  }
  knoxRefresh();
});
