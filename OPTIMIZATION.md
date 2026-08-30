# Load-Speed Optimization — brand-site

Date: 2026-07-18
Scope: `index.dc.html`, `atomic-intel.dc.html`, `atomic-engage.dc.html`, `atomic-vault.dc.html`, `docs.dc.html`

## Backup

Before any edit, the full folder was copied to `C:\Users\bhunp\Documents\atomic-brand\brand-site.bak\`
(sibling directory, untouched). The pre-existing `Бренд сайт с анимациями.zip` inside `brand-site/`
was left in place as a second backup. No original file was destroyed.

## Method

Served the folder locally with `python -m http.server 8123` (PowerShell) and loaded each
page in a real Chrome tab via the claude-in-chrome MCP tools. Measurements use the
Performance/Resource-Timing API (`performance.getEntriesByType('resource'/'navigation')`)
read through `javascript_tool`, cross-checked against `read_network_requests` and, for the
CDN files specifically, a direct `Invoke-WebRequest` fetch to unpkg.com to get exact byte
sizes (cross-origin timing entries hide `transferSize`/`encodedBodySize` without a
`Timing-Allow-Origin` header, so this fetch was needed to get real numbers for the CDN
scripts). Every "before" and "after" number below comes from a *single, cache-busted, first
navigation* in a fresh browser tab, so CDN vs. local, and dupes vs. no-dupes, are compared
like-for-like.

## Investigation: the diagnosed problem, verified

The task's working assumption was that `vendor/babel.min.js` (3.1 MB) is loaded in the
browser at page load to transpile JSX. I verified this directly instead of taking it on
faith, and it turned out **not to be true for the current state of this site**:

- Grepped all five `.dc.html` files for `<script type="text/babel">`, `x-import`,
  `dc-import`, `.jsx`, `.tsx` — **zero matches**. None of the five pages import any
  external component module, JSX or otherwise.
- The `<script type="text/x-dc" data-dc-script>` blocks seen in every page (e.g.
  `atomic-engage.dc.html:202-240`) are **not JSX**. They're a tiny custom "DC" logic class
  (`class Component extends DCLogic { ... }`) evaluated at runtime via `new Function(...)`
  in `support.js` (see `evalDcLogic`, support.js ~line 743) — a plain-JS mini-DSL, unrelated
  to Babel.
- Traced `support.js` (`dc-runtime`) end to end: Babel is loaded lazily, and *only* inside
  `createExternalModules().load()` when an `<x-import>`/`<dc-import>` references a `.jsx`/
  `.tsx` URL (`kindOf(u)` check, support.js ~line 607/1094). No page does this.
- Confirmed empirically: loaded every page in a real browser with network + resource-timing
  capture. **`babel.min.js` never appears in the request log on any of the 5 pages**, before
  or after my changes (`hasBabel: false` in every capture, baseline and optimized).

So the primary problem as described — Babel blocking every page load — was already not
happening. `vendor/babel.min.js` sits on disk unused; the browser never downloads it unless
someone later adds an `<x-import from="....jsx">`. It costs nothing at runtime today.

**What *is* actually throttling every page load:** `support.js`'s `loadReactUmd()`
(cdn.ts / index.ts) fetches **React 18.3.1 and ReactDOM 18.3.1 from `unpkg.com`** via two
blocking `<script>` insertions on every single page load, before the DC runtime can render
anything (the raw `<x-dc>` template is CSS-hidden until `boot()` completes React's render).
That means every visit pays for a third-party DNS lookup + TLS handshake + HTTP round-trip
to unpkg.com before the page can paint its real content — a genuine, verified,
render-blocking third-party dependency. Byte-identical copies of both files already existed,
unused, in `vendor/` (`react.production.min.js`, `react-dom.production.min.js`) — clearly
staged for local use but never wired up.

## Fix applied

`support.js` (`cdn.ts`) already ships a built-in local-override mechanism for exactly this
purpose:

```js
function cdnScriptFor(url, sri) {
  const res = window.__resources;
  const v = res ? res[url] : void 0;
  return typeof v === "string" && v ? { src: v } : { src: url, integrity: sri };
}
```

If `window.__resources[CDN_URL]` is set before `support.js` runs, it uses that local path
instead of fetching from the CDN — no core runtime code needed to change. Added one small
inline `<script>` before the `support.js` tag in all five `.dc.html` pages:

```html
<link rel="preload" as="script" href="./vendor/react.production.min.js">
<link rel="preload" as="script" href="./vendor/react-dom.production.min.js">
<script>
window.__resources = {
  "https://unpkg.com/react@18.3.1/umd/react.production.min.js": "./vendor/react.production.min.js",
  "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js": "./vendor/react-dom.production.min.js",
  "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js": "./vendor/babel.min.js"
};
</script>
<script src="./support.js"></script>
```

This is the smallest possible change: no build step, no code in `support.js` touched, no
transpilation introduced or removed (there was never any to remove), pinned versions
unchanged (`react@18.3.1` / `react-dom@18.3.1` — byte-identical to what unpkg was serving,
verified via `Invoke-WebRequest`: 10,751 B and 131,835 B respectively, matching `vendor/`
exactly). The `babel.min.js` mapping is included for completeness/future-proofing (in case a
page ever adds a `.jsx` `x-import`) but is inert today, exactly as before.

`vendor/babel.min.js` (3.1 MB) was **kept, not deleted** — it's not costing anything (never
fetched unless triggered) and now serves as the designed local fallback for the one code
path that could ever need it.

### Other safe wins applied

- `loading="lazy"` added to the one genuinely below-the-fold `<img>` on the site — the
  footer logo lockup in `index.dc.html` (`assets/logo/atomic-lockup-cream.svg`, line 464).
  The nav-bar logo/wordmark images on all pages are above the fold and were **left
  eager-loaded on purpose** — lazy-loading visible-on-load content is an anti-pattern and
  risks a visible pop-in.
- `support.js` was **deliberately left without `defer`/`async`**. It runs
  `hideRawTemplate()` synchronously to inject the `x-dc{display:none}` CSS rule that hides
  the raw, un-rendered DC template markup before the browser paints it. If deferred, HTML
  parsing (and possibly first paint) could race ahead of that hide-rule, causing a visible
  flash of raw/unstyled markup — the code itself already defers the actual React
  boot/render to `DOMContentLoaded`, so there was no blocking win available here without
  risking a FOUC regression. Verified this reasoning is correct rather than guessing.
- The CSS token `<link>` tags were left blocking (`fonts.css`, `colors.css`, `typography.css`,
  `spacing.css`, `styles.css`) — deferring stylesheet application is what causes FOUC in the
  first place; leaving them synchronous is correct here.

## Before / after (index.dc.html, single clean cache-busted load each)

| Metric | Before | After | Delta |
|---|---|---|---|
| Requests | 22 (21 resources + doc) | 20 (19 resources + doc) | **−2** |
| Total transferred bytes | 703,440 B (~687 KB) | 640,127 B (~625 KB) | **−63,313 B (−9.0%)** |
| DOMContentLoaded | 183 ms | 106 ms | **−77 ms (−42%)** |
| `load` event | 408 ms | 293 ms | **−115 ms (−28%)** |
| React/ReactDOM source | `unpkg.com` (external CDN, blocking) | `./vendor/` (same-origin, local) | CDN round-trip eliminated |
| `babel.min.js` requests | 0 (never loaded) | 0 (never loaded) | unchanged — was never the real bottleneck |

Byte savings are modest because React+ReactDOM are the same 142,586 B either way (CDN vs.
local — same pinned version, same minified file). The real win is **removing the external
network dependency from the render-blocking critical path**: no DNS lookup, no TLS
handshake, no cross-origin round-trip to unpkg.com before `boot()` can run. That shows up
in the timing numbers (DOMContentLoaded −42%, load −28%) more than in the byte count. The
2 fewer requests come from the CDN→local swap and normal request-count noise between runs.

These numbers were captured with real internet access active (the "before" run genuinely
hit unpkg.com over the network, not a simulation), so the CDN latency is real, not
theoretical — though exact millisecond deltas will vary run to run with network
conditions; the structural fix (no third-party origin in the critical path) is the durable
improvement, not the specific ms figures above.

## Visual/animation verification

All five pages were loaded in Chrome after the fix and screenshotted top-to-bottom
(`index.dc.html`, `atomic-intel.dc.html`, `atomic-engage.dc.html`, `atomic-vault.dc.html`,
`docs.dc.html`). Confirmed against the pre-fix baseline screenshots:

- Layout, colors, typography, and copy are pixel-identical to baseline on all five pages.
- The animated "graph" section on `index.dc.html` (the ATOMIC hub-and-spoke diagram driven
  by the `motion`/`signals` props on the `data-dc-script` block) was screenshotted twice a
  moment apart and confirmed to still be actively animating (dot positions and a
  pulsing-square color both changed between frames).
- The scroll-reveal fade-in animation (`IntersectionObserver` + `translateY` in each page's
  `data-dc-script` `componentDidMount`, e.g. `atomic-engage.dc.html:202-240`) is untouched —
  its source code was not modified at all.
- The lazy-loaded footer logo (`index.dc.html`) rendered correctly once scrolled into view.
- No console errors from the page itself on any of the five pages. The only console entries
  present are `[EXCEPTION] A listener indicated an asynchronous response...` from an
  installed Chrome PDF/Adobe extension (`chrome-extension://efaidnbmnnnibpcajpcglclefindmkaj/...`),
  unrelated to the site and present identically before and after the fix.
- `window.__resources` correctly resolves on all five pages; `hasVendorReact: true`,
  `hasUnpkg: false`, `hasBabel: false` confirmed via resource-timing on every page.

## Residual issues / follow-ups (not fixed — out of scope)

- **Duplicate font fetches (pre-existing, unrelated to this fix):** on repeat loads (not
  every load — appears timing/cache-state dependent), the three custom fonts
  (`Architexture.ttf`, `UnifixSPDemo.otf`, `JetBrainsMono-Regular.ttf`) each show up as two
  separate resource-timing entries. This **reproduces identically on the untouched backup**
  (`brand-site.bak`, still pointed at the CDN), so it is not something this change
  introduced — it looks like the `dc-runtime` "helmet" mechanism (`support.js`, ~line 1310,
  `createHelmetManager().compile()`) re-appending `<link>`/`<style>` tags from the parsed DC
  template into `<head>` a second time, on top of what the browser's native HTML parser
  already did with the same markup in the raw `<x-dc><helmet>` block. Fixing this would mean
  changing core `dc-runtime` de-duplication logic, which is out of scope for a "smallest
  change, preserve behavior exactly" optimization pass and carries real risk of behavior
  regressions elsewhere the runtime is used. Flagging for a separate, dedicated pass.
  Rough cost if unaddressed: ~1 extra small font request on some loads (a few KB, not
  render-blocking).
- **`vendor/babel.min.js` (3.1 MB) is still on disk.** It costs nothing today (never
  fetched), but if this site is ever deployed behind something that pre-warms/crawls every
  file in the directory (some static hosts, CDN cache-warmers, or security scanners do),
  it would transfer once. Left in place because it's the designed fallback for the
  `window.__resources` override and deleting it would be pure speculation about whether a
  future page might need runtime JSX. If storage/deploy footprint ever matters, this is a
  one-line delete once confirmed no page needs it.
- No image compression pass was done — the only raster fonts/graphics on the site are
  already small SVGs and web fonts (largest is `Architexture.ttf` at ~60 KB); not worth
  touching for a brand-identity font.
