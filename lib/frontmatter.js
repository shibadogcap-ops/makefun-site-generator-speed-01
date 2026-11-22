// Front matter parsing: a strict subset of YAML's block mappings. A source opens on a line "---" and its front
// matter runs to the next line "---"; every line between is blank, a comment ("#" first) or "key: value" with one
// space after the colon. Seven keys are known, each with its own value grammar, and anything else refuses the
// file with the first reason met, line by line.
//
// Speed: the text is scanned line by line with indexOf("\n") over offsets — never split into a lines array — and
// the body is one slice of the original text, which reproduces split/join exactly, trailing newline included.

/** The keys a source's front matter may give, mapped to their value parsers by name below. */
const KNOWN = { title: 1, date: 1, tags: 1, draft: 1, layout: 1, slug: 1, summary: 1 };

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_SHAPE = /^[a-z0-9-]+$/;
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_SHAPE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/**
 * A string value: `"..."` with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or
 * [). Returns { value } or { error } with the reason, unprefixed.
 */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    const len = raw.length;
    if (len < 2 || raw.charCodeAt(len - 1) !== 34) return { error: 'a quoted string is not closed' };
    const inner = raw.slice(1, -1);
    // Fast path: no quote or backslash inside means the inner text is the value as written.
    if (!inner.includes('"') && !inner.includes('\\')) return { value: inner };
    let out = '';
    for (let i = 1; i < len - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === len - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused; errors carry the `key "<k>": ` prefix the reference uses. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (!DATE_SHAPE.test(raw)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      const len = raw.length;
      if (len < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(len - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || !TAG_SHAPE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_SHAPE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_SHAPE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends.
 */
export function parseFrontMatter(text) {
  const len = text.length;
  // The first line must be exactly "---"; it ends at the first "\n" or at the end of the text.
  let nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? len : nl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };

  // Pass 1: find the closing line, which must be exactly "---". Content is only validated once the block is
  // known to be closed — an unclosed block refuses with "the front matter is not closed" whatever it holds.
  let pos = firstEnd + 1; // one past the opening line's newline (or past the end when there is none)
  let closeStart = -1;
  let bodyStart = -1;
  while (pos < len) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      bodyStart = nl === -1 ? len : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };

  // Pass 2: validate the lines between the opening and closing "---".
  const data = {};
  pos = firstEnd + 1;
  let lineNo = 2; // n counts from 1 at the opening "---", so the first content line is 2
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;

    // Skip blank lines (spaces/tabs only) and comments ("#" first).
    let skip = end === pos;
    if (!skip) {
      const c0 = text.charCodeAt(pos);
      if (c0 === 35) skip = true; // '#'
      else if (c0 === 32 || c0 === 9) {
        skip = true;
        for (let i = pos + 1; i < end; i++) {
          const c = text.charCodeAt(i);
          if (c !== 32 && c !== 9) {
            skip = false;
            break;
          }
        }
      }
    }

    if (!skip) {
      // "key: value": a key of a-z and _, a colon, then end-of-line or one space and the value.
      let k = pos;
      while (k < end) {
        const c = text.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      let rawStart = -1;
      let rawEnd = end;
      if (k > pos && k < end && text.charCodeAt(k) === 58) {
        if (k + 1 === end) rawStart = end; // "key:" — the value group is absent, value is ""
        else if (text.charCodeAt(k + 1) === 32) {
          rawStart = k + 2;
          while (rawEnd > rawStart) {
            const c = text.charCodeAt(rawEnd - 1);
            if (c !== 32 && c !== 9) break;
            rawEnd--;
          }
        }
      }
      if (rawStart === -1) return { error: `line ${lineNo} is not "key: value"` };
      const key = text.slice(pos, k);
      if (!Object.hasOwn(KNOWN, key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      const raw = text.slice(rawStart, rawEnd);
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }

    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }

  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}
