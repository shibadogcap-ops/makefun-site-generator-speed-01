// Fast re-implementation of the makefun-site 1.0.0 build pipeline.
// Same observable behaviour as the reference, structured for speed: one slugify
// memo per build, one card per post reused everywhere, and a word count that
// scans the body directly instead of materialising every word.

import { parseFrontMatter } from './lib/frontmatter.js';
import { renderMarkdown } from './lib/markdown.js';
import { parseTemplate, renderNodes, TemplateError } from './lib/template.js';
import { escapeHtml, longDate, slugify as slugifyRaw, uniqueSlug } from './lib/text.js';

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// The exact whitespace set of JavaScript's \s (without the unicode flag).
function isSpace(code) {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

// Runs of characters other than whitespace, counted without allocating matches.
function countWords(text) {
  let count = 0;
  let inWord = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    // Every JavaScript \s is <= 32 or >= 0xa0; the common ASCII cases decide first.
    const ws = c === 32 || (c >= 9 && c <= 13) || (c >= 0xa0 && isSpace(c));
    if (!ws && !inWord) count++;
    inWord = !ws;
  }
  return count;
}

// `rel` resolved against the directory segments `base`, or null when a ".." climbs past the root.
function resolvePath(base, rel) {
  const parts = base.slice();
  const n = rel.length;
  let pos = 0;
  while (pos <= n) {
    let e = pos;
    while (e < n && rel.charCodeAt(e) !== 47) e++;
    const len = e - pos;
    if (len === 2 && rel.charCodeAt(pos) === 46 && rel.charCodeAt(pos + 1) === 46) {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (len !== 0 && !(len === 1 && rel.charCodeAt(pos) === 46)) {
      parts.push(rel.slice(pos, e));
    }
    pos = e + 1;
  }
  return parts.join('/');
}

export function run(input) {
  // ---- templates: parsed in code-unit name order; failures land in the report ----
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');

  // slugify is pure, so one memo serves titles, tag names and heading-adjacent text.
  const slugMemo = new Map();
  const dateMemo = new Map();
  const longDateOf = (d) => {
    let v = dateMemo.get(d);
    if (v === undefined) {
      v = longDate(d);
      dateMemo.set(d, v);
    }
    return v;
  };
  const slugify = (text) => {
    let s = slugMemo.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugMemo.set(text, s);
    }
    return s;
  };

  // ---- sources and statics, files in code-unit path order ----
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // ---- front matter: the checks run in order and the first failure drops the source ----
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // ---- permalinks: slugs unique per directory, in source order ----
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // ---- markdown with link resolution ----
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // ---- collections: posts newest first, ties by slug ----
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // ---- tags: grouped by slug over the posts in collection order ----
  const tagsBySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of p.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = tagsBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        tagsBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A non-post's tags point at the posts' tag of the same slug, or a stub with url "".
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const t = tagsBySlug.get(slug);
      s.tagRefs.push(t === undefined ? { name, slug, url: '', posts: [] } : t);
    }
  }
  const tags = [...tagsBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // ---- cards, computed once per post and reused ----
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDateOf(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of posts) cards.set(p, cardOf(p));

  const linkOf = (s) =>
    s === null || s === undefined
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDateOf(s.data.date) };

  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // ---- layouts ----
  const output = {};
  const ctx = { templates, escape: escapeHtml };
  const view = { title: site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: { site: view, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };

  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });

  const per = site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }

  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // ---- report ----
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount2 = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount2} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
