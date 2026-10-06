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

// Remove caracteres invisíveis (usados como "preenchimento" em e-mails automáticos).
function cleanInvisible(text) {
  return text
    .replace(/[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u00AD\u034F\u061C\u180E\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function partFileName(headers) {
  const blob = ((headers['content-disposition'] || '') + ';' + (headers['content-type'] || '')).replace(/\r?\n/g, ' ');
  const star = blob.match(/(?:file)?name\*\s*=\s*(?:utf-8''|iso-8859-1''|us-ascii'')?([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/["']/g, '')); } catch { /* ignore */ }
  }
  const m = blob.match(/(?:file)?name\s*=\s*"?([^";]+)"?/i);
  return m ? m[1].trim() : '';
}

function looksLikeHtml(text) {
  return /<(html|body|div|p|table|br|span|meta)\b/i.test(text.slice(0, 4000));
}

function looksLikeBase64Blob(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (s.length < 20000) return false;
  const n = (s.match(/[A-Za-z0-9+/=]/g) || []).length;
  return n / s.length > 0.95;
}

function collectTextParts(raw, parts, info, depth = 0) {
  if (depth > 10) return;
  const { headers, body } = splitEntity(raw);
  const ctype = headers['content-type'] || '';
  const lower = (ctype || 'text/plain').toLowerCase();
  const encoding = (headers['content-transfer-encoding'] || '7bit').toLowerCase();
  const charset = (ctype.match(/charset="?([^";]+)"?/i) || [])[1] || '';
  const typeName = (lower.split(';')[0] || '').trim() || 'text/plain';
  const disposition = (headers['content-disposition'] || '').toLowerCase();
  const fileName = partFileName(headers);

  if (lower.startsWith('multipart/')) {
    const bm = ctype.match(/boundary\s*=\s*"?([^";\s]+)"?/i);
    if (!bm) { info.push({ type: typeName, status: 'sem boundary, ignorado' }); return; }
    info.push({ type: typeName, status: 'container' });
    // Delimitador sempre no início da linha (evita confundir boundaries parecidos).
    const delim = new RegExp('(?:^|\\r?\\n)--' + escapeRegex(bm[1]) + '(?:--)?[ \\t]*(?=\\r?\\n|$)');
    const chunks = body.split(delim);
    chunks.slice(1).forEach(chunk => {
      if (!chunk.trim()) return;
      collectTextParts(chunk.replace(/^\r?\n/, ''), parts, info, depth + 1);
    });
    return;
  }

  // Anexo: não entra na conferência (nem e-mail encaminhado, nem arquivo).
  if (/^\s*attachment/.test(disposition) || lower.startsWith('message/rfc822')) {
    info.push({
      type: typeName, encoding, size: body.length,
      status: 'ignorado (anexo' + (fileName ? ': ' + fileName : '') + ')'
    });
    return;
  }
  const isText = typeName.startsWith('text/') || !ctype;
  if (!isText || typeName === 'text/calendar') {
    info.push({ type: typeName, encoding, size: body.length, status: 'ignorado (não é texto)' });
    return;
  }
  if (fileName && !/^\s*inline/.test(disposition) && typeName !== 'text/html') {
    info.push({ type: typeName, encoding, size: body.length, status: 'ignorado (anexo: ' + fileName + ')' });
    return;
  }

  const bytes = decodeBodyBytes(body, encoding);
  if (looksBinary(bytes)) {
    info.push({ type: typeName, encoding, size: bytes.length, status: 'ignorado (conteúdo binário, provável anexo)' });
    return;
  }
  if (!ctype && looksLikeBase64Blob(body)) {
    info.push({ type: typeName, encoding, size: bytes.length, status: 'ignorado (bloco base64 sem tipo, provável anexo)' });
    return;
  }
  const decoded = cleanInvisible(decodeBytesWithCharset(bytes, charset));
  const text = (typeName === 'text/html' || looksLikeHtml(decoded)) ? htmlToText(decoded) : decoded;
  parts.push(text);
  info.push({
    type: typeName, encoding, charset: charset || '(não informado)',
    size: bytes.length, chars: flattenSpaces(text).length, status: 'lido',
    preview: flattenSpaces(text).slice(0, 200)
  });
}

// Pega o valor de um cabeçalho em qualquer ponto do início do arquivo (com linhas dobradas).
function pickHeader(raw, name) {
  const head = raw.slice(0, 30000).replace(/\r?\n[ \t]+/g, ' ');
  const m = head.match(new RegExp('^' + name + ':[ \\t]*([^\\r\\n]*)', 'im'));
  return m ? m[1].trim() : '';
}

// Garante que a leitura comece nos cabeçalhos MIME, mesmo com linhas em branco/BOM no início.
function normalizeRoot(raw) {
  raw = raw.replace(/^(?:\xEF\xBB\xBF|\uFEFF|[\s\0])+/, '');
  if (!splitEntity(raw).headers['content-type']) {
    const m = raw.match(/^content-type:/im);
    if (m && m.index > 0) raw = raw.slice(m.index);
  }
  return raw;
}

function readEml(buffer) {
  const bytes = new Uint8Array(buffer);
  let raw = '';
  const utf16 = bytes.length > 1 &&
    ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF));
  if (utf16) {
    raw = new TextDecoder(bytes[0] === 0xFF ? 'utf-16le' : 'utf-16be').decode(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 0x8000) {
      raw += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
  }
  // Final de linha antigo (só CR): converte para LF.
  if (!/\n/.test(raw.slice(0, 5000)) && /\r/.test(raw.slice(0, 5000))) raw = raw.replace(/\r/g, '\n');
  const original = raw;
  raw = normalizeRoot(raw);
  let { headers } = splitEntity(raw);
  headers = {
    ...headers,
    from: headers.from || pickHeader(original, 'from'),
    to: headers.to || pickHeader(original, 'to'),
    cc: headers.cc || pickHeader(original, 'cc'),
    subject: headers.subject || pickHeader(original, 'subject'),
    date: headers.date || pickHeader(original, 'date')
  };
  const parts = [];
  const partsInfo = [];
  collectTextParts(raw, parts, partsInfo);

  const meta = {
    from: decodeMimeWordsPumi(headers.from || ''),
    to: decodeMimeWordsPumi(headers.to || ''),
    cc: decodeMimeWordsPumi(headers.cc || ''),
    subject: decodeMimeWordsPumi(headers.subject || ''),
    date: headers.date || ''
  };
  // Só o corpo do e-mail: cabeçalhos (De/Para/Cc/Assunto) e anexos ficam fora da conferência.
  const text = parts.join('\n');
  const readCount = partsInfo.filter(p => p.status === 'lido').length;
  const note = readCount === 0 ? 'Nenhuma parte de texto foi encontrada neste e-mail.' : '';
  return { meta, text, searchText: text, note, partsInfo };
}

/* ---------- Leitura de .msg ---------- */

// Só trechos legíveis (6+ caracteres imprimíveis seguidos), em UTF-16 e 8 bits.
function scanBinaryStrings(buffer) {
  const bytes = new Uint8Array(buffer);
  const decoded = [
    new TextDecoder('utf-16le').decode(bytes),
    new TextDecoder('utf-16le').decode(bytes.subarray(1)),
    new TextDecoder('latin1').decode(bytes)
  ];
  const runs = [];
  decoded.forEach(s => (s.match(/[\x20-\x7e\u00a0-\u024f]{6,}/g) || []).forEach(r => runs.push(r)));
  return runs.join('\n');
}

// RTF (descomprimido) -> texto simples.
function rtfToText(rtf) {
  const skipDest = /^(fonttbl|colortbl|stylesheet|pict|info|header|footer|object|themedata|datastore|latentstyles|listtable|listoverridetable|generator|fldinst)$/;
  let out = '';
  let skipping = false;
  const stack = [];
  let i = 0;
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === '{') {
      stack.push(skipping);
      i++;
      const m = rtf.slice(i, i + 40).match(/^(\\\*)?\\([a-zA-Z]+)/);
      if (m && (m[1] || skipDest.test(m[2]))) skipping = true;
    } else if (c === '}') {
      skipping = stack.length ? stack.pop() : false;
      i++;
    } else if (c === '\\') {
      const n = rtf[i + 1];
      if (n === "'") {
        if (!skipping) out += String.fromCharCode(parseInt(rtf.substr(i + 2, 2), 16));
        i += 4;
      } else if (/[a-zA-Z]/.test(n)) {
        const m = rtf.slice(i).match(/^\\([a-zA-Z]+)(-?\d+)? ?/);
        const word = m[1];
        if (!skipping) {
          if (word === 'par' || word === 'line' || word === 'row') out += '\n';
          else if (word === 'tab' || word === 'cell') out += ' ';
          else if (word === 'u' && m[2] !== undefined) {
            let code = parseInt(m[2], 10);
            if (code < 0) code += 65536;
            out += String.fromCharCode(code);
            i += m[0].length;
            if (rtf[i] === '?') i++; // caractere substituto
            continue;
          }
        }
        i += m[0].length;
      } else {
        if (!skipping && (n === '\\' || n === '{' || n === '}')) out += n;
        else if (!skipping && n === '~') out += ' ';
        i += 2;
      }
    } else {
      if (!skipping && c !== '\r' && c !== '\n') out += c;
      i++;
    }
  }
  return out;
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

    let rtfText = '';
    if (d.compressedRtf && d.compressedRtf.length && typeof decompressRTFLib === 'function') {
      try {
        const bytes = decompressRTFLib(d.compressedRtf);
        rtfText = rtfToText(Array.from(bytes, b => String.fromCharCode(b)).join(''));
      } catch (e) { console.warn('RTF não decodificado:', e); }
    }

    const recipients = (d.recipients || []).map(r => `${r.name || ''} ${r.email || r.smtpAddress || ''}`.trim());
    const meta = {
      from: `${d.senderName || ''} ${d.senderEmail || d.senderSmtpAddress || ''}`.trim(),
      to: recipients.join('; '),
      cc: '',
      subject: d.subject || '',
      date: d.messageDeliveryTime || d.creationTime || d.clientSubmitTime || ''
    };

    const skipped = (d.attachments || []).map(a => ({
      type: a.mimeType || a.contentType || 'attachment',
      status: 'ignorado (anexo: ' + (a.fileName || a.name || 'sem nome') + ')'
    }));

    // Só o corpo (texto, HTML, RTF). Remetente, destinatários e anexos ficam fora.
    const readable = cleanInvisible([d.body || '', html ? htmlToText(html) : '', rtfText].join('\n'));
    if (!readable.trim()) {
      return {
        meta, text: '', searchText: '', partsInfo: skipped,
        note: 'Não foi possível ler o corpo do .msg. Anexos foram ignorados.',
        unreadable: 'Não foi possível separar o corpo deste .msg.'
      };
    }
    return { meta, text: readable, searchText: readable, note: '', partsInfo: skipped };
  } catch (err) {
    console.warn('msgreader indisponível:', err);
    return {
      meta: { from: '', to: '', cc: '', subject: '', date: '' },
      text: '', searchText: '', partsInfo: [],
      note: 'Não foi possível ler o corpo deste .msg. Anexos não foram consultados.',
      unreadable: 'Não foi possível ler o corpo deste .msg.'
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

// Identifica o tipo real do arquivo pelos primeiros bytes (não pela extensão).
function detectMagic(bytes) {
  const hex = Array.from(bytes.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join(' ');
  const starts = (...sig) => sig.every((b, i) => bytes[i] === b);
  let kind = null, label = '';
  if (starts(0xD0, 0xCF, 0x11, 0xE0)) { kind = 'ole'; label = 'formato .msg do Outlook'; }
  else if (starts(0x50, 0x4B, 0x03, 0x04)) { kind = 'zip'; label = 'arquivo compactado (ZIP)'; }
  else if (starts(0x1F, 0x8B)) { kind = 'gzip'; label = 'arquivo compactado (GZIP)'; }
  else if (starts(0x25, 0x50, 0x44, 0x46)) { kind = 'pdf'; label = 'PDF'; }
  return { kind, label, hex };
}

function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8000);
  if (!n) return false;
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) { if (i > 1 && bytes[i - 1] !== 0) ctrl++; continue; }
    if (b < 9 || b === 11 || b === 12 || (b > 13 && b < 32)) ctrl++;
  }
  return ctrl / n > 0.02;
}

async function readPumiFile(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const magic = detectMagic(bytes);
  const isMsgExt = file.name.toLowerCase().endsWith('.msg');

  // .msg de verdade, mesmo com extensão .eml
  if (magic.kind === 'ole') {
    const r = await readMsg(buffer);
    if (!isMsgExt) r.note = ((r.note ? r.note + ' ' : '') + 'O arquivo é um .msg do Outlook com extensão .eml.').trim();
    return r;
  }
  if (isMsgExt) return readMsg(buffer);

  const utf16 = bytes.length > 1 && ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF));
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 8000); i++) head += String.fromCharCode(bytes[i]);
  const looksLikeEmail = /^(content-type|mime-version|from|return-path|received|subject|date):/im.test(head);
  // .eml com anexo binário cru ainda é e-mail: não recusar o arquivo inteiro.
  if (!utf16 && !looksLikeEmail && (magic.kind || looksBinary(bytes))) {
    const what = magic.label || 'conteúdo binário (provavelmente criptografado ou protegido)';
    return {
      meta: { from: '', to: '', cc: '', subject: '', date: '' },
      text: '', searchText: '', partsInfo: [],
      note: '',
      unreadable: `Este arquivo não é um e-mail em texto: parece ${what}. Primeiros bytes: ${magic.hex}`
    };
  }
  return readEml(buffer);
}

if (typeof module !== 'undefined') {
  module.exports = { readEml, readPumiFile, checkPumi, PUMI_APPROVERS };
}
