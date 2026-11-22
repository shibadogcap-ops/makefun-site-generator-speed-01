// Text helpers: HTML escaping, slugging, unique slugs and long dates.
// Written for speed: escapeHtml returns the input untouched when nothing needs escaping, slugify scans ASCII
// directly (NFKD is the identity on ASCII) and only pays for normalization on non-ASCII input.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** True when `text` holds no character that escaping would change. */
const NEEDS_ESCAPE = /[&<>"']/;

/** `text` split into plain runs and the single special characters between them. */
const ESCAPE_PARTS = /([&<>"'])/g;

/** `text` with & < > " and ' escaped; the same string back when there is nothing to escape. */
export function escapeHtml(text) {
  if (!NEEDS_ESCAPE.test(text)) return text;
  return text.split(ESCAPE_PARTS).map((part) => ESCAPES[part] ?? part).join('');
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

/** The character a slug keeps for `ch`, or null when `ch` opens a gap. */
function keepChar(ch) {
  if (ch >= 'A' && ch <= 'Z') return ch.toLowerCase();
  if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) return ch;
  return null;
}

/**
 * Runs the gap rule over `source` (an iterable of one-character strings): kept characters are collected, a "-"
 * stands between kept runs separated by anything else, and never leads or trails. Returns the joined slug text,
 * already cut to SLUG_MAX with any dashes the cut exposed removed.
 */
function scanSlug(source) {
  const out = [];
  let pendingGap = false;
  let emitted = false;
  for (const ch of source) {
    const keep = keepChar(ch);
    if (keep === null) {
      if (emitted) pendingGap = true;
      continue;
    }
    if (pendingGap) {
      out.push('-');
      pendingGap = false;
    }
    out.push(keep);
    emitted = true;
  }
  let slug = out.join('');
  if (slug.length > SLUG_MAX) slug = slug.slice(0, SLUG_MAX);
  let end = slug.length;
  while (end > 0 && slug.charCodeAt(end - 1) === 45) end--;
  return end === slug.length ? slug : slug.slice(0, end);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9
 * one "-", none at either end, at most SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when
 * nothing is left.
 */
export function slugify(text) {
  // ASCII fast path: NFKD changes no ASCII character and ASCII holds no combining marks, so the normalized text is
  // the input itself. One charCodeAt scan decides which path runs.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  const slug = ascii ? scanSlug(text) : scanSlug(text.normalize('NFKD').replace(/\p{M}/gu, ''));
  return slug === '' ? 'untitled' : slug;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}
