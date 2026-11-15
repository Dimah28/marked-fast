// Marked-fast: a fast drop-in replacement for marked 18.1.3.
//
// How it works: block splitting is done by marked 18.1.3 itself (MIT, vendored
// in ./vendor/marked/ and used through its public Lexer export), so every block
// boundary is exactly marked's. Each block is then rendered by the original
// inline/block renderer in this file, which is written to be fast: plain text
// is scanned by hand instead of by the big inline regexes, and the inline
// constructs are only attempted where they can start. Anything this renderer
// cannot prove it handles exactly is delegated, block by block, back to
// marked itself, so correctness never depends on the fast path being complete.
//
// parse(markdown) returns exactly what marked.parse(markdown) returns with
// marked's default options, and keeps nothing from one call to the next.

import { Lexer, marked } from './vendor/marked/marked.esm.js';

// Marked's own inline grammar (GFM), used at the positions where a construct
// can start. These are the kit starter's rules, read at runtime, not copied.
const IG = Lexer.rules.inline.gfm;
const RE_ESCAPE = IG.escape;
const RE_TAG = IG.tag;
const RE_LINK = IG.link;
const RE_REFLINK = IG.reflink;
const RE_NOLINK = IG.nolink;
const RE_CODE = IG.code;
const RE_BR = IG.br;
const RE_AUTOLINK = IG.autolink;
const RE_URL = IG.url;
const RE_BACKPEDAL = IG._backpedal;
const RE_EM_L = IG.emStrongLDelim;
const RE_EM_R_AST = IG.emStrongRDelimAst;
const RE_EM_R_UND = IG.emStrongRDelimUnd;
const RE_DEL_L = IG.delLDelim;
const RE_DEL_R = IG.delRDelim;
const RE_REFLINK_SEARCH = IG.reflinkSearch;
const RE_BLOCK_SKIP = IG.blockSkip;
const RE_ANY_PUNCT_OUTSIDE_CODE = IG.anyPunctuationOutsideCode;

// ---------------------------------------------------------------- helpers

const ESCAPE_REPLACEMENTS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESCAPE_TEST = /[&<>"']/;
const RE_ESCAPE_REPLACE = /[&<>"']/g;
const RE_ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RE_ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function escapeHtml(html, encode) {
  if (encode) {
    if (RE_ESCAPE_TEST.test(html)) return html.replace(RE_ESCAPE_REPLACE, (ch) => ESCAPE_REPLACEMENTS[ch]);
  } else if (RE_ESCAPE_TEST_NO_ENCODE.test(html)) {
    return html.replace(RE_ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPE_REPLACEMENTS[ch]);
  }
  return html;
}

const RE_NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericRefs(text) {
  if (!RE_NUMERIC_REF.test(text)) return text;
  return text.replace(RE_NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

const RE_PERCENT_DECODE = /%25/g;
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(RE_PERCENT_DECODE, '%');
  } catch {
    return null;
  }
  return href;
}

const RE_MULTI_SPACE = /\s+/g;
function normalizeLabel(label) {
  return label.trim().replace(RE_MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the closing bracket that drops the level below zero, -2 when more
// openers than closers remain, -1 when neither bracket occurs.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

const RE_PUNCT = /[\p{P}\p{S}]/u;
const RE_PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const RE_ALPHA_NUM = /[\p{L}\p{N}]/u;
const RE_ASCII_PUNCT = /^[!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]$/;

function isPunctOrSpaceNoStar(ch) {
  return ch !== '*' && ch !== '_' && RE_PUNCT_OR_SPACE.test(ch);
}

// ------------------------------------------------------- shared lexer state

// One Lexer, reused across parse() calls and reset each time. Only blockTokens
// is used on it; inline tokenizing is done by this file, so the inline queue
// it builds is discarded.
const blockLexer = new Lexer();
const CR_RE = /\r\n|\r/g;

// ------------------------------------------------------------ inline parsing

// Mutable per-document state, matching marked's lexer state: inLink carries
// across inline runs, inRawBlock is reset for every run.
function newDocState() {
  return { inLink: false };
}

// Result of an inline run: html, and whether a non-image link was produced
// anywhere in it (used to reject links whose label holds a link).
// Returns null when the run holds something this renderer will not decide.
function inlineRun(src, links, doc, textMode) {
  // st is shared by nested label parses: inRawBlock carries into them (as in
  // marked, only the top-level lex() resets it per run) and inLink/doc are
  // document-wide. linkEmitted is saved and restored around each label parse
  // by the link handler itself.
  const st = { links, doc, textMode, inRawBlock: false, linkEmitted: false };
  const out = inlineLoop(st, src, 0, src.length);
  if (out === null) return null;
  return { html: out.html, hasLink: st.linkEmitted };
}

// Per-loop context, built fresh for every inline run (including nested label
// parses, whose source differs): whether a link can match at all, the masked
// source emphasis/del need, and the closer hints, computed once per run.
function newCtx(st, src, start, end) {
  return {
    start, end,
    hasParen: src.indexOf(')', start) !== -1 && src.indexOf(')', start) < end,
    masked: null,
    lastStar: -2, lastUnd: -2, lastDel: -2,
  };
}

// Parse src[start..end) as inline content. Returns { html, end } or null.
function inlineLoop(st, src, start, end) {
  let html = '';
  let i = start;
  let textBuf = '';
  let bufRaw = false; // the buffered text was scanned while inRawBlock
  let prevChar = '';
  let keepPrevChar = false;
  const cx = newCtx(st, src, start, end);

  const flushText = () => {
    if (textBuf === '') return;
    // Raw-block text is literal; otherwise numeric references are decoded,
    // and HTML-escaping applies everywhere except plain-text (alt) mode.
    let s = bufRaw ? textBuf : decodeNumericRefs(textBuf);
    if (!st.textMode && !bufRaw) s = escapeHtml(s);
    html += s;
    textBuf = '';
  };
  // Append raw scanned text to the buffer, flushing first if the raw-block
  // state changed since the buffer started.
  const pushText = (s) => {
    if (s === '') return;
    if (textBuf !== '' && bufRaw !== st.inRawBlock) flushText();
    if (textBuf === '') bufRaw = st.inRawBlock;
    textBuf += s;
  };

  while (i < end) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[i];

    // --- escape: \ + ASCII punctuation
    if (ch === '\\' && i + 1 < end && RE_ASCII_PUNCT.test(src[i + 1])) {
      flushText();
      const c = src[i + 1];
      if (st.textMode) html += c;
      else html += escapeHtml(c);
      i += 2;
      continue;
    }

    // --- tag / autolink: <
    if (ch === '<') {
      const tag = tryTag(st, src, i, end);
      if (tag !== null) {
        flushText();
        html += tag.html;
        i = tag.end;
        continue;
      }
      const auto = tryAutolink(st, src, i, end);
      if (auto !== null) {
        flushText();
        html += auto.html;
        i = auto.end;
        continue;
      }
    }

    // --- link / image: [ or ![
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const link = tryLink(st, src, i, end);
      if (link === 'BAIL') return null;
      if (link !== null) {
        flushText();
        html += link.html;
        i = link.end;
        continue;
      }
      const ref = tryReflink(st, src, i, end);
      if (ref === 'BAIL') return null;
      if (ref !== null) {
        flushText();
        if (ref.firstChar) {
          if (st.textMode) html += ref.firstChar;
          else html += escapeHtml(ref.firstChar);
          i += 1;
        } else {
          html += ref.html;
          i = ref.end;
        }
        continue;
      }
    }

    // --- emphasis / strong: * or _
    if (ch === '*' || ch === '_') {
      const em = tryEmStrong(st, cx, src, i, end, prevChar);
      if (em === 'BAIL') return null;
      if (em !== null) {
        flushText();
        html += em.html;
        i = em.end;
        continue;
      }
    }

    // --- code span: `
    if (ch === '`') {
      const code = tryCodespan(st, src, i, end);
      if (code !== null) {
        flushText();
        html += code.html;
        i = code.end;
        continue;
      }
    }

    // --- hard break: two or more spaces, or backslash, before a newline
    if ((ch === ' ' || ch === '\\') && i < end) {
      const br = tryBr(st, src, i, end);
      if (br !== null) {
        flushText();
        html += br.html;
        i = br.end;
        continue;
      }
    }

    // --- strikethrough: ~
    if (ch === '~') {
      const del = tryDel(st, cx, src, i, end, prevChar);
      if (del === 'BAIL') return null;
      if (del !== null) {
        flushText();
        html += del.html;
        i = del.end;
        continue;
      }
    }

    // --- GFM extended autolink: only outside a link. Autolinks and extended
    // urls do not set linkEmitted (only outputLink does), so a label holding
    // one still becomes a link, as in marked.
    if (!st.doc.inLink && isWordChar(ch)) {
      const url = tryUrl(st, src, i, end);
      if (url === 'BAIL') return null;
      if (url !== null) {
        flushText();
        html += url.html;
        i = url.end;
        continue;
      }
    }

    // --- plain text: scan to the next position where a construct can start
    const runEnd = scanTextRun(st, src, i, end);
    if (runEnd === i) {
      // No construct matched and the scanner stopped at once: consume text
      // the way marked's inlineText would -- a whole run of backticks or
      // tildes, otherwise one character -- so the loop always progresses.
      let piece = src[i];
      if (piece === '`' || piece === '~') {
        let k = i + 1;
        while (k < end && src[k] === piece) k++;
        piece = src.slice(i, k);
      }
      pushText(piece);
      if (src[i] !== '_') prevChar = src[i];
      keepPrevChar = true;
      i += piece.length;
      continue;
    }
    const run = src.slice(i, runEnd);
    pushText(run);
    if (run.charCodeAt(run.length - 1) !== 95) prevChar = run.charAt(run.length - 1);
    keepPrevChar = true;
    i = runEnd;
  }
  flushText();
  return { html, end: i };
}

function isWordChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

// Word-boundary check for _: \b in marked's text regex is ASCII.
function isAsciiWordChar(ch) {
  return isWordChar(ch);
}

const EMAIL_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?_`{|}~-'.split(''));

// Scan a plain-text run starting at i: stop before the next position where an
// inline construct can start. Never stops inside an entity reference: the
// trigger characters cannot occur inside one, except _ which is only a stop
// at an ASCII word boundary.
// Fast email-character test: a 128-entry table over ASCII codes.
const EMAIL_CODE = new Uint8Array(128);
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-") EMAIL_CODE[ch.charCodeAt(0)] = 1;
const isEmailCharCode = (code) => code < 128 && EMAIL_CODE[code] === 1;

// Next position where a plain-text run must stop: the same stops marked's
// inline text regex uses, found with one regex exec instead of a char loop.
//   \ < [ ` * ~ _            -- a construct can start
//   ![                      -- an image can start
//   two spaces + \n         -- a hard break
//   www.                     -- only when the previous char is start, a
//                              whitespace char, *, _, ~ or (
//   http / https / ftp://    -- case-insensitive scheme start
//   mailto: / xmpp:          -- only when the previous char is not ASCII
//                              alphanumeric
// The email-word stop (a word of email characters holding an @) is computed
// separately: it is the start of the email-character run before the first
// '@' that has one, and a regex cannot express it without quadratic
// backtracking on long words without '@'.
const RE_NEXT_STOP = /[\\<\[`*~_]|!\[| {2,}\n|(?<![^\s*_~(])www\.|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<=[^a-zA-Z0-9])(?:mailto|xmpp):/g;

function scanTextRun(st, src, i, end) {
  let emailStop = end;
  let at = src.indexOf('@', i);
  while (at !== -1 && at < end) {
    let w = at - 1;
    if (w >= i && isEmailCharCode(src.charCodeAt(w))) {
      while (w >= i && isEmailCharCode(src.charCodeAt(w))) w--;
      emailStop = w + 1;
      break;
    }
    at = src.indexOf('@', at + 1);
  }
  RE_NEXT_STOP.lastIndex = i;
  const m = RE_NEXT_STOP.exec(src);
  const simpleStop = (m !== null && m.index < end) ? m.index : end;
  return simpleStop < emailStop ? simpleStop : emailStop;
}

// ------------------------------------------------------- inline constructs

const RE_START_A_TAG = /^<a /i;
const RE_END_A_TAG = /^<\/a>/i;
const RE_START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_OUTPUT_LINK_REPLACE = /\\([\[\]])/g;

// A raw HTML tag at i. Updates the link/raw-block state exactly as marked's
// tag tokenizer does, and renders as its own text in both modes.
function tryTag(st, src, i, end) {
  RE_TAG.lastIndex = 0;
  const m = RE_TAG.exec(src.slice(i, end));
  if (!m) return null;
  const tag = m[0];
  if (!st.doc.inLink && RE_START_A_TAG.test(tag)) st.doc.inLink = true;
  else if (st.doc.inLink && RE_END_A_TAG.test(tag)) st.doc.inLink = false;
  if (!st.inRawBlock && RE_START_PRE_TAG.test(tag)) st.inRawBlock = true;
  else if (st.inRawBlock && RE_END_PRE_TAG.test(tag)) st.inRawBlock = false;
  return { html: tag, end: i + tag.length };
}

// Render a link (or autolink) to HTML, as marked's renderer does. When the
// destination cannot be encoded the link is dropped and only its text stays.
function renderLinkHtml(href, title, innerHtml, autolink, textMode) {
  if (textMode) return innerHtml;
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return innerHtml;
  const escHref = escapeHtml(cleanHref, autolink);
  let out = '<a href="' + escHref + '"';
  if (title) out += ' title="' + escapeHtml(title) + '"';
  return out + '>' + innerHtml + '</a>';
}

function tryAutolink(st, src, i, end) {
  RE_AUTOLINK.lastIndex = 0;
  const m = RE_AUTOLINK.exec(src.slice(i, end));
  if (!m) return null;
  const text = m[1];
  const href = m[2] === '@' ? 'mailto:' + text : text;
  const inner = st.textMode ? text : escapeHtml(text, true);
  return { html: renderLinkHtml(href, '', inner, true, st.textMode), end: i + m[0].length };
}

// Whether the label of a link ends inside an HTML tag or autolink that
// started within it (marked's isLabelEndInsideToken): such a label is not a
// link label at all.
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let k = 0; k < label.length; k++) {
    if (label[k] === '\\') {
      k++;
      continue;
    }
    if (label[k] === '`') {
      RE_CODE.lastIndex = 0;
      const code = RE_CODE.exec(label.slice(k));
      if (code) {
        k += code[0].length - 1;
        continue;
      }
    }
    if (label[k] !== '<') continue;
    const tokenSrc = src.slice(labelStart + k);
    RE_TAG.lastIndex = 0;
    const tag = RE_TAG.exec(tokenSrc);
    let token = tag;
    if (!token) {
      RE_AUTOLINK.lastIndex = 0;
      token = RE_AUTOLINK.exec(tokenSrc);
    }
    if (!token) continue;
    if (token[0].length > label.length - k) return true;
    k += token[0].length - 1;
  }
  return false;
}

// Does this text hold a link already? Used by the emphasis mask and by the
// link-nesting check. A code span or an HTML tag hides its brackets; an image
// does not count.
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  RE_BLOCK_SKIP.lastIndex = 0;
  for (const match of text.matchAll(RE_BLOCK_SKIP)) {
    RE_LINK.lastIndex = 0;
    if (RE_LINK.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  RE_REFLINK_SEARCH.lastIndex = 0;
  for (const match of text.matchAll(RE_REFLINK_SEARCH)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), links)) continue;
    return true;
  }
  return false;
}

// Parse a link (or image) label and render the link, mirroring marked's
// outputLink: the label is parsed with inLink set, a label holding a link
// makes a plain link fail (images are exempt), and raw-block state changes
// inside the label stand unless the link fails.
function finishLink(st, label, href, title, isImage, endPos) {
  const outerInLink = st.doc.inLink;
  const outerLinkEmitted = st.linkEmitted;
  const outerInRawBlock = st.inRawBlock;
  const outerTextMode = st.textMode;
  st.doc.inLink = true;
  st.linkEmitted = false;
  if (isImage) st.textMode = true;
  const inner = inlineLoop(st, label, 0, label.length);
  const labelHasLink = st.linkEmitted;
  st.linkEmitted = outerLinkEmitted;
  st.doc.inLink = outerInLink;
  st.textMode = outerTextMode;
  if (inner === null) {
    st.inRawBlock = outerInRawBlock;
    return 'BAIL';
  }
  if (!isImage) {
    if (labelHasLink) {
      st.inRawBlock = outerInRawBlock;
      return null;
    }
    st.linkEmitted = true;
    return { html: renderLinkHtml(href, title, inner.html, false, outerTextMode), end: endPos };
  }
  // Image: the label was parsed as plain text for the alt attribute. In
  // plain-text mode an image is just its label text, never an <img> tag.
  const alt = inner.html;
  if (outerTextMode) return { html: alt, end: endPos };
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: escapeHtml(alt), end: endPos };
  let out = '<img src="' + escapeHtml(cleanHref) + '" alt="' + escapeHtml(alt) + '"';
  if (title) out += ' title="' + escapeHtml(title) + '"';
  return { html: out + '>', end: endPos };
}

function tryLink(st, src, i, end) {
  if (!src.includes(')', i)) return null;
  RE_LINK.lastIndex = 0;
  const slice = src.slice(i, end);
  const cap = RE_LINK.exec(slice);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(slice, cap[1], labelStart)) return null;
  let raw = cap[0];
  let hrefPart = cap[2];
  let titlePart = cap[3] || '';
  const trimmedUrl = hrefPart.trim();
  if (trimmedUrl.startsWith('<')) {
    if (!trimmedUrl.endsWith('>')) return null;
    const rtrimSlash = trimmedUrl.slice(0, -1).replace(/\\+$/, '');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(hrefPart, '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      hrefPart = hrefPart.substring(0, lastParenIndex);
      raw = raw.substring(0, linkLen).trim();
      titlePart = '';
    }
  }
  // The ')' that ends the match is the link closer only when unescaped.
  const unescaped = raw.slice(0, -1).replace(/\\+$/, '');
  if ((raw.length - unescaped.length) % 2 === 0) return null;
  let href = hrefPart;
  let title = '';
  if (titlePart) title = titlePart.slice(1, -1);
  href = href.trim();
  if (href.startsWith('<')) href = href.slice(1, -1);
  const isImage = cap[0].charAt(0) === '!';
  const label = cap[1].replace(RE_OUTPUT_LINK_REPLACE, '$1');
  // Unescape backslash+punctuation pairs in the destination and title.
  href = href ? href.replace(/\\([\p{P}\p{S}])/gu, '$1') : href;
  title = title ? title.replace(/\\([\p{P}\p{S}])/gu, '$1') : title;
  return finishLink(st, label, href, title, isImage, i + raw.length);
}

function tryReflink(st, src, i, end) {
  const slice = src.slice(i, end);
  RE_REFLINK.lastIndex = 0;
  let cap = RE_REFLINK.exec(slice);
  if (!cap) {
    RE_NOLINK.lastIndex = 0;
    cap = RE_NOLINK.exec(slice);
  }
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(slice, cap[1], labelStart)) return null;
  const link = st.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) return { firstChar: cap[0].charAt(0) };
  const isImage = cap[0].charAt(0) === '!';
  const label = cap[1].replace(RE_OUTPUT_LINK_REPLACE, '$1');
  return finishLink(st, label, link.href, link.title || '', isImage, i + cap[0].length);
}

// A code span, matched by hand (no slice of the remainder): the opening run
// is maximal, the closer is the earliest run of exactly that many backticks
// whose neighbours are not backticks.
function tryCodespan(st, src, i, end) {
  let n = 0;
  while (i + n < end && src[i + n] === '`') n++;
  if (n === 0) return null;
  let k = i + n + 1;
  while (k < end) {
    if (src[k] !== '`') {
      k++;
      continue;
    }
    let m = 0;
    while (k + m < end && src[k + m] === '`') m++;
    if (m === n && k > i + n) {
      let text = src.slice(i + n, k).replace(/\n/g, ' ');
      const hasNonSpace = /[^ ]/.test(text);
      if (hasNonSpace && text.startsWith(' ') && text.endsWith(' ')) text = text.substring(1, text.length - 1);
      const html = st.textMode ? text : '<code>' + escapeHtml(text, true) + '</code>';
      return { html, end: k + n };
    }
    k += m;
  }
  return null;
}

function tryBr(st, src, i, end) {
  RE_BR.lastIndex = 0;
  const m = RE_BR.exec(src.slice(i, end));
  if (!m) return null;
  return { html: st.textMode ? '' : '<br>', end: i + m[0].length };
}

// Cheap pre-checks before running the extended-autolink regex: the regex can
// only match a mailto:/xmpp: address, a scheme:// or www. address, or a bare
// email, so anything else is rejected without slicing.
function urlPrecheck(st, src, i, end) {
  const c0 = src.charCodeAt(i);
  if (c0 === 109 /* m */ || c0 === 120 /* x */) {
    if (src.startsWith('mailto:', i) || src.startsWith('xmpp:', i)) return true;
  }
  if (c0 === 104 /* h */ || c0 === 72 /* H */) {
    const c1 = src.charCodeAt(i + 1) | 32, c2 = src.charCodeAt(i + 2) | 32,
          c3 = src.charCodeAt(i + 3) | 32;
    if (c1 === 116 && c2 === 116 && c3 === 112) return true; // http
  }
  if (c0 === 102 /* f */ || c0 === 70 /* F */) {
    if (src.startsWith('ftp://', i)) return true;
  }
  if (src.startsWith('www.', i)) {
    if (i === 0) return true;
    const p = src[i - 1];
    if (p === ' ' || p === '\t' || p === '\n' || p === '\f' || p === '*' || p === '_' || p === '~' || p === '(') return true;
  }
  let k = i;
  while (k < end && EMAIL_CHARS.has(src[k])) k++;
  return k > i && src[k] === '@';
}

function tryUrl(st, src, i, end) {
  if (!urlPrecheck(st, src, i, end)) return null;
  RE_URL.lastIndex = 0;
  const cap = RE_URL.exec(src.slice(i, end));
  if (!cap) return null;
  let text = cap[0];
  let prevCapZero;
  do {
    prevCapZero = text;
    RE_BACKPEDAL.lastIndex = 0;
    const bp = RE_BACKPEDAL.exec(text);
    text = bp ? bp[0] : '';
  } while (prevCapZero !== text);
  if (text === '') return null;
  let href;
  if (cap[2] === '@') {
    href = 'mailto:' + text;
  } else {
    href = cap[1] === 'www.' ? 'http://' + text : text;
  }
  const inner = st.textMode ? text : escapeHtml(text, true);
  return { html: renderLinkHtml(href, '', inner, true, st.textMode), end: i + text.length };
}

// ------------------------------------------------- emphasis / strikethrough

// Mask links, code spans, HTML and escapes in an inline run so emphasis and
// strikethrough do not see delimiters inside them. Every replacement keeps
// its length, so the masked source lines up with the real one.
function maskSrc(src, links) {
  // None of the three masking passes can match without one of these
  // characters: a reflink needs '[', a code span or escape needs '`' or
  // '\\', a skipped block needs '<' (or '['). Plain prose skips masking.
  if (!/[[`\\<]/.test(src)) return src;
  let maskedSrc = src;
  if (links && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, links)) {
          return '[' + text.replace(RE_REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(RE_REFLINK_SEARCH, maskReflink);
  }
  maskedSrc = maskedSrc.replace(RE_ANY_PUNCT_OUTSIDE_CODE, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });
  maskedSrc = maskedSrc.replace(RE_BLOCK_SKIP, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });
  return maskedSrc;
}

// One scan of the masked source for the last delimiter runs that can close
// emphasis, strong or strikethrough (a run can close only when not preceded
// by whitespace or the start of the string).
function scanClosers(src) {
  let star = -1;
  let und = -1;
  let del = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else if (ch === '*') star = i;
      else und = i;
    }
    i = j - 1;
  }
  return { star, und, del };
}

function maskedOf(cx, st, src) {
  if (cx.masked === null) {
    cx.masked = maskSrc(src.slice(cx.start, cx.end), st.links);
    const h = scanClosers(cx.masked);
    cx.lastStar = h.star;
    cx.lastUnd = h.und;
    cx.lastDel = h.del;
  }
  return cx.masked;
}

// Emphasis / strong at position i, following marked's emStrong: the opener
// run, its flanking, CommonMark rules 9-10 over the whole run, and the
// mid-run rule. Returns { html, end } or null when no emphasis starts here.
function tryEmStrong(st, cx, src, i, end, prevChar) {
  const rem = src.slice(i, end);
  RE_EM_L.lastIndex = 0;
  let match = RE_EM_L.exec(rem);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const masked = maskedOf(cx, st, src);
  const srcStart = masked.length - rem.length;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const before = masked.slice(Math.max(0, runStart - 2), runStart);
  const runPrevChar = [...before].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || isPunctOrSpaceNoStar(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : isPunctOrSpaceNoStar(prevChar);
  if (match[4] && RE_ALPHA_NUM.test(prevChar)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? RE_EM_R_AST : RE_EM_R_UND;
    const lastPossible = delimChar === '*' ? cx.lastStar : cx.lastUnd;
    const windowStart = masked.length - rem.length + lLength;
    if (lastPossible < windowStart) return null;
    // Slice the window, as marked does: the closer regexes have a ^-anchored
    // alternative (skip an orphan delimiter inside a strong run) that only
    // matches at the start of the searched string.
    const window = masked.slice(windowStart);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = rem.slice(0, lLength + match.index + lastCharLength + rLength);
      let text;
      let tag;
      if (Math.min(lLength, rLength) % 2) {
        text = raw.slice(1, -1);
        tag = 'em';
      } else {
        text = raw.slice(2, -2);
        tag = 'strong';
      }
      const inner = inlineLoop(st, text, 0, text.length);
      if (inner === null) return 'BAIL';
      const html = st.textMode ? inner.html : '<' + tag + '>' + inner.html + '</' + tag + '>';
      return { html, end: i + raw.length };
    }
  }
  return null;
}

// Strikethrough at position i, following marked's del.
function tryDel(st, cx, src, i, end, prevChar) {
  const rem = src.slice(i, end);
  RE_DEL_L.lastIndex = 0;
  let match = RE_DEL_L.exec(rem);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || isPunctOrSpaceNoStar(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim;
    let rLength;
    let delimTotal = lLength;
    const masked = maskedOf(cx, st, src);
    const endReg = RE_DEL_R;
    const lastPossible = cx.lastDel;
    const windowStart = masked.length - rem.length + lLength;
    if (lastPossible < windowStart) return null;
    const window = masked.slice(windowStart);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = rem.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      const inner = inlineLoop(st, text, 0, text.length);
      if (inner === null) return 'BAIL';
      const html = st.textMode ? inner.html : '<del>' + inner.html + '</del>';
      return { html, end: i + raw.length };
    }
  }
  return null;
}

// ---------------------------------------------------------- block rendering

function renderCheckbox(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderCode(token) {
  const langString = (token.lang || '').match(/^\S*/)?.[0];
  const code = token.text ? token.text.replace(/\n$/, '') + '\n' : '';
  const esc = token.escaped ? code : escapeHtml(code, true);
  if (!langString) return '<pre><code>' + esc + '</code></pre>\n';
  return '<pre><code class="language-' + escapeHtml(langString) + '">' + esc + '</code></pre>\n';
}

function tableCell(cell, content) {
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? '<' + type + ' align="' + cell.align + '">' : '<' + type + '>';
  return tag + content + '</' + type + '>\n';
}

function renderTable(ctx, token) {
  let header = '';
  for (const cell of token.header) {
    const r = inlineRun(cell.text, ctx.links, ctx.doc, false);
    if (r === null) return null;
    header += tableCell(cell, r.html);
  }
  let body = '';
  for (const row of token.rows) {
    let cells = '';
    for (const cell of row) {
      const r = inlineRun(cell.text, ctx.links, ctx.doc, false);
      if (r === null) return null;
      cells += tableCell(cell, r.html);
    }
    body += '<tr>\n' + cells + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';
  return '<table>\n<thead>\n<tr>\n' + header + '</tr>\n</thead>\n' + body + '</table>\n';
}

const RE_CHECKBOX_PREFIX = /^\[[ xX]\][ \t]+/;

function renderListItem(ctx, item, loose) {
  let tokens = item.tokens;
  let prefix = '';
  if (item.task && tokens.length > 0 && tokens[0].type === 'checkbox') {
    prefix = renderCheckbox(!!tokens[0].checked);
    tokens = tokens.slice(1);
  } else if (item.task && tokens.length > 0
    && (tokens[0].type === 'paragraph' || tokens[0].type === 'text')
    && RE_CHECKBOX_PREFIX.test(tokens[0].text)) {
    // A loose list carries the checkbox inside its first paragraph.
    const m = RE_CHECKBOX_PREFIX.exec(tokens[0].text);
    const cb = renderCheckbox(!!item.checked);
    const stripped = tokens[0].text.slice(m[0].length);
    const r = inlineRun(stripped, ctx.links, ctx.doc, false);
    if (r === null) return null;
    const first = tokens[0].type === 'paragraph'
      ? '<p>' + cb + r.html + '</p>\n'
      : cb + r.html;
    const rest = renderBlocks(ctx, tokens.slice(1));
    if (rest === null) return null;
    return '<li>' + first + rest + '</li>\n';
  }
  const body = renderBlocks(ctx, tokens);
  if (body === null) return null;
  return '<li>' + prefix + body + '</li>\n';
}

function renderList(ctx, token) {
  let body = '';
  for (const item of token.items) {
    const itemHtml = renderListItem(ctx, item, token.loose);
    if (itemHtml === null) return null;
    body += itemHtml;
  }
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

// Render one block token, or null when this renderer will not decide it.
function renderBlock(ctx, token) {
  switch (token.type) {
    case 'space':
    case 'def':
      return '';
    case 'hr':
      return '<hr>\n';
    case 'code':
      return renderCode(token);
    case 'html':
      return token.text;
    case 'heading': {
      const r = inlineRun(token.text, ctx.links, ctx.doc, false);
      if (r === null) return null;
      return '<h' + token.depth + '>' + r.html + '</h' + token.depth + '>\n';
    }
    case 'paragraph': {
      const r = inlineRun(token.text, ctx.links, ctx.doc, false);
      if (r === null) return null;
      return '<p>' + r.html + '</p>\n';
    }
    case 'text': {
      const r = inlineRun(token.text, ctx.links, ctx.doc, false);
      if (r === null) return null;
      return r.html;
    }
    case 'table':
      return renderTable(ctx, token);
    case 'blockquote': {
      const inner = renderBlocks(ctx, token.tokens);
      if (inner === null) return null;
      return '<blockquote>\n' + inner + '</blockquote>\n';
    }
    case 'list':
      return renderList(ctx, token);
    case 'checkbox':
      return renderCheckbox(!!token.checked);
    default:
      return null;
  }
}

function renderBlocks(ctx, tokens) {
  let out = '';
  for (const token of tokens) {
    const html = renderBlock(ctx, token);
    if (html === null) return null;
    out += html;
  }
  return out;
}

// Render one block token with marked itself, for the blocks this renderer
// declines. Every link reference definition in the document is prepended, in
// document order, so references resolve exactly as they do in the whole
// document; definitions render nothing, so the output is the block's alone.
function delegateBlock(ctx, token) {
  const prefix = ctx.defs.length > 0 ? ctx.defs.join('\n\n') + '\n\n' : '';
  return marked.parse(prefix + token.raw);
}

// All link reference definitions in the token tree, in document order.
function collectDefs(tokens, out) {
  for (const token of tokens) {
    if (token.type === 'def') {
      out.push(token.raw);
    } else if (token.type === 'blockquote' || token.type === 'list') {
      if (token.type === 'blockquote') collectDefs(token.tokens, out);
      else for (const item of token.items) collectDefs(item.tokens, out);
    }
  }
  return out;
}

// Render a list of top-level blocks, delegating per block when needed.
function renderTopBlocks(ctx, tokens) {
  let out = '';
  for (const token of tokens) {
    const html = renderBlock(ctx, token);
    out += html === null ? delegateBlock(ctx, token) : html;
  }
  return out;
}

// --------------------------------------------------------------------- entry

export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const src = markdown.replace(CR_RE, '\n');
  blockLexer.tokens = [];
  blockLexer.tokens.links = Object.create(null);
  blockLexer.inlineQueue = [];
  blockLexer.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  const tokens = blockLexer.blockTokens(src, blockLexer.tokens);
  const links = blockLexer.tokens.links;
  const ctx = { doc: newDocState(), links, defs: collectDefs(tokens, []) };
  return renderTopBlocks(ctx, tokens);
}
