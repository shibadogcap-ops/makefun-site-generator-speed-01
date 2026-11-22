// Template dialect: {{ path }} escaped, {{{ path }}} raw, {% for/if/else/endif/endfor/include %}.
// parseTemplate turns source into a node tree once; renderNodes walks it per page.
// Hot path notes: rendering accumulates pieces in one array joined once, lookups walk
// the scope chain directly, and a loop reuses one vars/loop cell per iteration.

export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

// Node kinds.
const TEXT = 0, VAR = 1, RAW = 2, IFN = 3, FORN = 4, INC = 5;

export class TemplateError extends Error {}

function fail(name, msg) {
  throw new TemplateError(`template "${name}": ${msg}`);
}

function pathOf(name, text) {
  if (!PATH.test(text)) fail(name, `${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Only spaces and tabs between `src[from]` and `src[to)`? */
function blank(src, from, to) {
  for (let i = from; i < to; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src` into a flat token list: {k:0 text,1 var,2 raw,3 tag}. Standalone tag lines are consumed whole. */
function tokenize(name, src) {
  const tokens = [];
  const n = src.length;
  let text = '';
  let i = 0;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      // A lone { is literal; keep scanning right after it.
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) fail(name, `a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') { tokens.push({ k: TEXT, s: text }); text = ''; }
      const inner = src.slice(open + (raw ? 3 : 2), close).trim();
      tokens.push({ k: raw ? RAW : VAR, path: pathOf(name, inner) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) fail(name, 'a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = blank(src, lineStart, open) && blank(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { tokens.push({ k: TEXT, s: text }); text = ''; }
    tokens.push({ k: 3, s: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ k: TEXT, s: text });
  return tokens;
}

/** `src` parsed into its root node list; a TemplateError when it does not parse. */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.k === TEXT) {
      body.push({ kind: TEXT, s: tok.s });
      continue;
    }
    if (tok.k === VAR || tok.k === RAW) {
      body.push({ kind: tok.k, path: tok.path });
      continue;
    }
    const tag = tok.s;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR.exec(tag)) !== null) {
      const node = { kind: FORN, name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF.exec(tag)) !== null) {
      const node = { kind: IFN, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== IFN || top.els !== null) fail(name, 'an else outside an if');
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? FORN : IFN;
      if (top.kind !== want) fail(name, `an ${tag} with no open ${tag === 'endfor' ? 'for' : 'if'}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === IFN ? (parent.els ?? parent.then) : parent.body;
    } else if ((m = INCLUDE.exec(tag)) !== null) {
      body.push({ kind: INC, name: m[1] });
    } else {
      fail(name, `{% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) fail(name, `a ${stack[stack.length - 1].kind === FORN ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope owning it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number') return String(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderInto(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case TEXT:
        out.push(n.s);
        break;
      case VAR:
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case RAW:
        out.push(textOf(lookup(scope, n.path)));
        break;
      case IFN: {
        const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.els;
        if (branch !== null) renderInto(branch, scope, ctx, depth, out);
        break;
      }
      case FORN: {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        const vars = {};
        const loop = {};
        for (let k = 0; k < len; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          loop.length = len;
          vars.loop = loop;
          renderInto(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case INC: {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/** `nodes` rendered in `scope` ({ vars, parent }); `ctx` holds `templates`, `escape`. */
export function renderNodes(nodes, scope, ctx, depth) {
  const out = [];
  renderInto(nodes, scope, ctx, depth, out);
  return out.join('');
}
