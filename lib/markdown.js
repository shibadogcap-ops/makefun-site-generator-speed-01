// makefun-site's Markdown subset, written for speed: the same blocks and inline constructs as the reference,
// but lines are classified with charCode scans instead of regexes wherever the regex semantics allow it, and
// inline() emits plain runs through escapeHtml in one call instead of character by character.

import { escapeHtml, slugify } from './text.js';

// ---------- line helpers ----------

/** Only spaces and tabs make a line blank. */
function isBlank(line) {
  for (let i = 0, n = line.length; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at both ends (the same string back when there are none). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/**
 * The language of a fence-open line (``` then [A-Za-z0-9_+-]* then only spaces/tabs), or null when the line
 * is not one. The language is '' for a bare fence.
 */
function fenceLang(line) {
  const n = line.length;
  if (n < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < n) {
    const c = line.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return null;
  }
  return line.slice(3, langEnd);
}

/** A fence-close line: exactly ``` then only spaces/tabs. */
function isFenceClose(line) {
  const n = line.length;
  if (n < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A heading line's level and text, or null. 1-6 '#' then at least one space/tab, the text running to the
 * last non-space/tab character; a line whose text would be empty is not a heading.
 */
function headingOf(line) {
  const n = line.length;
  let h = 0;
  while (h < n && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= n) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let i = h;
  while (i < n) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) break;
    i++;
  }
  let e = n;
  while (e > i) {
    const d = line.charCodeAt(e - 1);
    if (d !== 32 && d !== 9) break;
    e--;
  }
  if (e === i) return null;
  return { depth: h, text: line.slice(i, e) };
}

/** A thematic break: --- or *** then only spaces/tabs. */
function isHr(line) {
  const n = line.length;
  if (n < 3) return false;
  const c0 = line.charCodeAt(0);
  const d = c0 === 45 ? 45 : c0 === 42 ? 42 : -1;
  if (d === -1 || line.charCodeAt(1) !== d || line.charCodeAt(2) !== d) return false;
  for (let i = 3; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The text after a bullet marker ("- " or "* "), or null. */
function bulletText(line) {
  const n = line.length;
  if (n < 2) return null;
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/**
 * The text after an ordered marker (1-9 digits, ". "), or null. The digit count is capped at 9 exactly
 * like the reference's \d{1,9}: a longer run of digits is not a marker.
 */
function orderedText(line) {
  const n = line.length;
  let d = 0;
  while (d < n && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0 || d > 9 || d + 1 >= n) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return line.slice(d + 2);
}

/** The first item's number of an ordered-marker line (the caller knows the marker matched). */
function orderedNum(line) {
  let d = 0;
  while (line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  return Number(line.slice(0, d));
}

/** JavaScript's \s as a char code check (for the list-continuation rule's \S). */
function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** A list-continuation line: two or more spaces then a non-whitespace character. */
function isContinued(line) {
  const n = line.length;
  let i = 0;
  while (i < n && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < n && !isWsCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// ---------- blocks ----------

/** `src`'s block tokens, in order. */
export function lex(src) {
  const lines = src.split('\n');
  const n = lines.length;
  const tokens = [];
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      i++;
      continue;
    }
    if (isHr(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimLine(t);
        if (t !== '') kept.push(t);
        i++;
      }
      tokens.push({ type: 'blockquote', lines: kept });
      continue;
    }
    const bt = bulletText(line);
    const ot = bt === null ? orderedText(line) : null;
    if (bt !== null || ot !== null) {
      const ordered = ot !== null;
      const start = ordered ? orderedNum(line) : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        const text = ordered ? orderedText(l) : bulletText(l);
        if (text !== null) {
          items.push(trimLine(text));
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1] += '\n' + trimLine(l);
          i++;
        } else break;
      }
      tokens.push({ type: 'list', ordered, start, items });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

// ---------- inline ----------

/** The characters a backslash escapes, as a char-code lookup. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;
const isEscapable = (code) => code < 128 && ESCAPABLE[code] === 1;

const HAS_WS = /\s/;
const PLAIN_END = /[\\`*\[&<>"']/g;
const ESC = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };

// A marker char is escaped exactly when an odd run of backslashes precedes it (backslash is itself
// escapable, so pairs cancel). Every finder starts right after its opener, a non-backslash, so a run
// can never cross `from`.
function backslashesBefore(s, i) {
  let k = 0;
  while (s.charCodeAt(i - 1 - k) === 92) k++;
  return k;
}
const CLOSE_STRONG = /\*\*/g;
const CLOSE_STAR = /\*\*|\*(?!\*)/g;
const CLOSE_BRACKET = /\]/g;

/** The first '**' from `from` outside a backslash escape, or -1. */
function findCloseStrong(s, from) {
  CLOSE_STRONG.lastIndex = from;
  let m;
  while ((m = CLOSE_STRONG.exec(s)) !== null) {
    if ((backslashesBefore(s, m.index) & 1) === 0) return m.index;
    CLOSE_STRONG.lastIndex = m.index + 1;
  }
  return -1;
}

/** The first ']' from `from` outside a backslash escape, or -1. */
function findCloseBracket(s, from) {
  CLOSE_BRACKET.lastIndex = from;
  let m;
  while ((m = CLOSE_BRACKET.exec(s)) !== null) {
    if ((backslashesBefore(s, m.index) & 1) === 0) return m.index;
    CLOSE_BRACKET.lastIndex = m.index + 1;
  }
  return -1;
}

/** The first single '*' from `from` (one not part of a '**' run) outside an escape, or -1. */
function findSingleStar(s, from) {
  CLOSE_STAR.lastIndex = from;
  let m;
  while ((m = CLOSE_STAR.exec(s)) !== null) {
    if (m[0].length === 2) {
      // A '**' pair is skipped atomically only when its first star is unescaped.
      if ((backslashesBefore(s, m.index) & 1) === 0) continue;
      CLOSE_STAR.lastIndex = m.index + 1;
      continue;
    }
    if ((backslashesBefore(s, m.index) & 1) === 0) return m.index;
    CLOSE_STAR.lastIndex = m.index + 1;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
export function inline(s, env) {
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    // Plain run up to the next interesting character (\ ` * [), escaped in one call.
    PLAIN_END.lastIndex = i;
    const pm = PLAIN_END.exec(s);
    const j = pm === null ? n : pm.index;
    if (j > i) {
      out += s.slice(i, j);
      i = j;
      if (i >= n) break;
    }
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && isEscapable(s.charCodeAt(i + 1))) {
        const e = s.charCodeAt(i + 1);
        out += e === 62 ? '&gt;' : s[i + 1];
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findCloseStrong(s, i + 2);
        if (k > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) {
          out += `<em>${inline(s.slice(i + 1, k), env)}</em>`;
          i = k + 1;
        } else {
          out += '*';
          i++;
        }
      }
      continue;
    }
    if (c !== 91) {
      out += ESC[c];
      i++;
      continue;
    }
    // c === 91, '['
    const k = findCloseBracket(s, i + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !HAS_WS.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      i = m + 1;
    } else {
      out += '[';
      i++;
    }
  }
  return out;
}

/**
 * `slug` made unique against `ids` (and added to it), the same result as uniqueSlug but faster on pages
 * with many repeated headings: for one base slug the candidates slug, slug-2, slug-3 ... are tried in
 * order and once taken stay taken, so the first free suffix only ever moves forward. `next` caches, per
 * base slug, the suffix number to resume from (1 means the bare slug has not been tried yet).
 */
function pageSlug(slug, ids, next) {
  let suf = next.get(slug) ?? 1;
  let out = suf === 1 ? slug : `${slug}-${suf}`;
  while (ids.has(out)) {
    suf++;
    out = `${slug}-${suf}`;
  }
  next.set(slug, suf + 1);
  ids.add(out);
  return out;
}

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of contents (every level 2 and 3
 * heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
export function renderMarkdown(src, env) {
  const ids = new Set();
  const next = new Map();
  const parts = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = pageSlug(slugify(t.text), ids, next);
        const html = inline(t.text, env);
        parts.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`, '\n');
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        const body = t.lines.length === 0 ? '' : `${t.lines.map(escapeHtml).join('\n')}\n`;
        parts.push(`<pre><code${cls}>${body}</code></pre>`, '\n');
        break;
      }
      case 'hr':
        parts.push('<hr>', '\n');
        break;
      case 'blockquote':
        parts.push(
          t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`,
          '\n',
        );
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        parts.push(open, '\n');
        for (const item of t.items) parts.push('<li>', inline(item, env), '</li>', '\n');
        parts.push(`</${tag}>`, '\n');
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        parts.push(`<p>${html}</p>`, '\n');
        break;
      }
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}
