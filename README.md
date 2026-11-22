# makefun-site-generator-speed-01 — a faster make.fun site generator

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/shibadogcap-ops/makefun-site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/shibadogcap-ops/makefun-site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

An entry for the make.fun bounty **"Build a static site faster"**: a dependency-free ES module
whose `run(input)` reproduces the makefun-site 1.0.0 build output byte-for-byte, written from the
ground up for CPU speed.

## Layout

- `solve.js` — the `run(input)` pipeline: template parsing and error reporting, front-matter
  filtering, unique slug and permalink assignment, Markdown rendering with link resolution,
  post/tag collections, card reuse, layout rendering, statics and the sorted `build-report.txt`.
- `lib/text.js` — HTML escaping, slugify/uniqueSlug, long dates.
- `lib/frontmatter.js` — the strict block-mapping front-matter parser.
- `lib/markdown.js` — the Markdown subset: block lexer plus inline rendering.
- `lib/template.js` — the `{{ }}`/`{% %}` template dialect: tokenizer, parser, renderer.
- `main.ts` — the harness driver; reads `cases.json`, calls `run` per case, writes `answers.json`.

## Speed ideas

- `slugify`, `longDate` and the card objects are memoized per build; one `cards` map is computed
  per post and reused by every index, pager, tag and tag-list page.
- Markdown block classification uses `charCodeAt` scans (`isBlank`, `headingOf`, `fenceLang`,
  `isHr`, `bulletText`, `orderedText`) instead of regexes; inline output emits plain runs through
  one `escapeHtml` call per run rather than per character.
- `slugify` has an ASCII fast path — NFKD is the identity on ASCII, so normalization only runs
  when a non-ASCII character appears.
- `escapeHtml` tests once and returns the input untouched when nothing needs escaping.
- `frontmatter` scans lines via `indexOf('\n')` over offsets and slices the body once — no
  `split` into a lines array — and `resolvePath`/`countWords` scan characters without allocating
  match objects.
- Templates are parsed once into node trees; rendering accumulates into a single array joined
  once, reuses one `vars`/`loop` cell per `for` iteration, and looks up scope chains directly.
- Per-page heading IDs reuse a resume-point map so repeated slugs don't restart their suffix scan.

## Run it

```
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

Reads `$MAKEFUN_INPUT_DIR/cases.json` and writes `$MAKEFUN_OUTPUT_DIR/answers.json`.

## License

MIT — see [LICENSE](LICENSE).
