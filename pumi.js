/* ===== PUMI: leitura de e-mail (.eml / .msg) e conferência ===== */

const PUMI_APPROVERS = [
  'Felipe Mello Sobreira',
  'Raphael Constantino Arsianian Lorenzato',
  'Alpoim Fonseca Correa'
];

/* ---------- Utilidades de texto ---------- */

// Mesmo tamanho do texto original: permite usar índices do texto "dobrado" no original.
function foldText(text) {
  let out = '';
  for (const c of text.split('')) {
    const d = c.normalize('NFD')[0] || c;
    out += (d.toLowerCase()[0] || d);
  }
  return out;
}

function flattenSpaces(text) {
  return text.replace(/[\s\u00a0]+/g, ' ').trim();
}

function htmlToText(html) {
  const prepared = html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|th|li|h[1-6]|table)>/gi, ' $& ');
  const doc = new DOMParser().parseFromString(prepared, 'text/html');
  return doc.body ? doc.body.textContent : prepared.replace(/<[^>]+>/g, ' ');
}

function decodeMimeWordsPumi(str) {
  return str.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
      } else {
        const raw = text.replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
        bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
      }
      return new TextDecoder(charset).decode(bytes);
    } catch { return text; }
  });
}

/* ---------- Leitura de .eml ---------- */

function splitEntity(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  const headerBlock = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  const headers = {};
  headerBlock.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(line => {
    const i = line.indexOf(':');
    if (i > 0) {
      const key = line.slice(0, i).trim().toLowerCase();
      if (!(key in headers)) headers[key] = line.slice(i + 1).trim();
    }
  });
  return { headers, body };
}

function decodeBodyBytes(body, encoding) {
  const enc = (encoding || '7bit').toLowerCase();
  if (enc === 'base64') {
    try { return Uint8Array.from(atob(body.replace(/[^A-Za-z0-9+/=]/g, '')), c => c.charCodeAt(0)); }
    catch { return new Uint8Array(0); }
  }
  let raw = body;
  if (enc === 'quoted-printable') {
    raw = body.replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return Uint8Array.from(raw, c => c.charCodeAt(0) & 0xff);
}

function decodeBytesWithCharset(bytes, charset) {
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

function collectTextParts(raw, parts, depth = 0) {
  if (depth > 10) return;
  const { headers, body } = splitEntity(raw);
  const ctype = headers['content-type'] || 'text/plain';
  const lower = ctype.toLowerCase();

  if (lower.startsWith('multipart/')) {
    const bm = ctype.match(/boundary="?([^";]+)"?/i);
    if (!bm) return;
    const delim = '--' + bm[1];
    body.split(delim).slice(1).forEach(chunk => {
      if (chunk.startsWith('--')) return;
      collectTextParts(chunk.replace(/^\r?\n/, ''), parts, depth + 1);
    });
    return;
  }
  if (lower.startsWith('message/rfc822')) {
    collectTextParts(body, parts, depth + 1);
    return;
  }
  const disposition = (headers['content-disposition'] || '').toLowerCase();
  const isText = lower.startsWith('text/plain') || lower.startsWith('text/html') || !headers['content-type'];
  if (!isText || disposition.startsWith('attachment')) return;

  const charset = (ctype.match(/charset="?([^";]+)"?/i) || [])[1];
  const bytes = decodeBodyBytes(body, headers['content-transfer-encoding']);
  const text = decodeBytesWithCharset(bytes, charset);
  parts.push(lower.startsWith('text/html') ? htmlToText(text) : text);
}

function readEml(buffer) {
  const bytes = new Uint8Array(buffer);
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    raw += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  const { headers } = splitEntity(raw);
  const parts = [];
  collectTextParts(raw, parts);

  const meta = {
    from: decodeMimeWordsPumi(headers.from || ''),
    to: decodeMimeWordsPumi(headers.to || ''),
    cc: decodeMimeWordsPumi(headers.cc || ''),
    subject: decodeMimeWordsPumi(headers.subject || ''),
    date: headers.date || ''
  };
  const text = [meta.from, meta.to, meta.cc, meta.subject, ...parts].join('\n');
  return { meta, text, note: '' };
}

/* ---------- Leitura de .msg ---------- */

function scanBinaryStrings(buffer) {
  // Plano B: lê o binário como UTF-16 (dois alinhamentos) e como texto simples.
  const bytes = new Uint8Array(buffer);
  const u16a = new TextDecoder('utf-16le').decode(bytes);
  const u16b = new TextDecoder('utf-16le').decode(bytes.subarray(1));
  const latin = new TextDecoder('latin1').decode(bytes);
  const clean = s => s.replace(/[^\x20-\x7e\u00a0-\u024f\n\r\t]+/g, ' ');
  return [u16a, u16b, latin].map(clean).join('\n');
}

async function loadMsgReader() {
  // Biblioteca local: vendor/msgreader.bundle.js (expõe window.MsgReaderLib)
  if (typeof MsgReaderLib !== 'function') throw new Error('MsgReader não encontrado');
  return MsgReaderLib;
}

async function readMsg(buffer) {
  try {
    const MsgReader = await loadMsgReader();
    const d = new MsgReader(buffer).getFileData();
    let html = d.bodyHtml || '';
    if (!html && d.html && d.html.length) html = new TextDecoder('utf-8').decode(d.html);

    const recipients = (d.recipients || []).map(r => `${r.name || ''} ${r.email || r.smtpAddress || ''}`.trim());
    const meta = {
      from: `${d.senderName || ''} ${d.senderEmail || d.senderSmtpAddress || ''}`.trim(),
      to: recipients.join('; '),
      cc: '',
      subject: d.subject || '',
      date: d.messageDeliveryTime || d.creationTime || d.clientSubmitTime || ''
    };
    // Texto estruturado + varredura do binário (pega conteúdo que a biblioteca não expõe).
    const text = [meta.from, meta.to, meta.subject, d.headers || '', d.body || '',
      html ? htmlToText(html) : '', scanBinaryStrings(buffer)].join('\n');
    return { meta, text, note: '' };
  } catch (err) {
    console.warn('msgreader indisponível, usando leitura simplificada:', err);
    return {
      meta: { from: '', to: '', cc: '', subject: '', date: '' },
      text: scanBinaryStrings(buffer),
      note: 'Leitura simplificada do .msg (biblioteca indisponível). Confira a prova abaixo.'
    };
  }
}

/* ---------- Conferência ---------- */

function snippetsFor(flat, folded, regex, radius = 70, max = 5) {
  const results = [];
  const re = new RegExp(regex.source, 'g');
  let m;
  while ((m = re.exec(folded)) && results.length < max) {
    const start = Math.max(0, m.index - radius);
    const end = Math.min(flat.length, m.index + m[0].length + radius);
    results.push({
      before: (start > 0 ? '…' : '') + flat.slice(start, m.index),
      match: flat.slice(m.index, m.index + m[0].length),
      after: flat.slice(m.index + m[0].length, end) + (end < flat.length ? '…' : '')
    });
    if (m[0].length === 0) re.lastIndex++;
  }
  return results;
}

function countMatches(folded, regex) {
  return (folded.match(new RegExp(regex.source, 'g')) || []).length;
}

// Acha o aprovador por primeiro + último nome, em qualquer ordem, próximos entre si.
// Cobre: "Felipe Mello Sobreira", "Sobreira, Felipe", "felipe.sobreira@...", "Felipe M. Sobreira".
function findApprover(flat, folded, name, radius = 70, max = 2) {
  const tokens = foldText(name).split(/\s+/).filter(Boolean);
  const required = tokens.length > 1 ? [tokens[0], tokens[tokens.length - 1]] : tokens;
  const span = tokens.length + 4; // janela em palavras

  const words = [];
  const re = /[a-z0-9]+/g;
  let m;
  while ((m = re.exec(folded))) words.push({ w: m[0], start: m.index, end: m.index + m[0].length });

  let count = 0;
  const snippets = [];
  for (let i = 0; i < words.length; i++) {
    if (!required.includes(words[i].w)) continue;
    const seen = new Set([words[i].w]);
    let last = i;
    for (let j = i + 1; j < Math.min(words.length, i + span) && seen.size < required.length; j++) {
      if (required.includes(words[j].w)) { seen.add(words[j].w); last = j; }
    }
    if (seen.size < required.length) continue;

    count++;
    if (snippets.length < max) {
      const s = words[i].start, e = words[last].end;
      const from = Math.max(0, s - radius), to = Math.min(flat.length, e + radius);
      snippets.push({
        before: (from > 0 ? '…' : '') + flat.slice(from, s),
        match: flat.slice(s, e),
        after: flat.slice(e, to) + (to < flat.length ? '…' : '')
      });
    }
    i = last; // evita contar a mesma ocorrência duas vezes
  }
  return { count, snippets };
}

function checkPumi(rawText) {
  const flat = flattenSpaces(rawText);
  const folded = foldText(flat);

  const approvers = PUMI_APPROVERS.map(name => {
    const { count, snippets } = findApprover(flat, folded, name);
    return { name, count, snippets };
  });
  const foundApprovers = approvers.filter(a => a.count > 0);

  const pendingRe = /pending/;
  const pending = {
    count: countMatches(folded, pendingRe),
    snippets: snippetsFor(flat, folded, pendingRe, 80, 5)
  };

  const completedRe = /approval[\W_]{1,6}completed/;
  const completed = {
    count: countMatches(folded, completedRe),
    snippets: snippetsFor(flat, folded, completedRe, 80, 3)
  };

  const approversOk = foundApprovers.length > 0;
  const pendingOk = pending.count === 0;
  return {
    ok: approversOk && pendingOk,
    approvers, foundApprovers, approversOk,
    pending, pendingOk,
    completed
  };
}

async function readPumiFile(file) {
  const buffer = await file.arrayBuffer();
  const isMsg = file.name.toLowerCase().endsWith('.msg');
  return isMsg ? readMsg(buffer) : readEml(buffer);
}

if (typeof module !== 'undefined') {
  module.exports = { readEml, checkPumi, PUMI_APPROVERS };
}
