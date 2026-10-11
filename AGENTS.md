# AIVAX Toys agent guide

## Project overview
- Free, public demos ("toys") of AIVAX API features. Each toy is one static page that runs the feature for visitors, shows an estimated cost, and ships the code that makes it work.
- One Cloudflare Worker serves the static site and a small `/api/*` proxy that holds the AIVAX API key. Visitors are never billed.
- Stack: vanilla HTML/CSS/JS (no build step, no framework), Cloudflare Workers + Static Assets + a SQLite-backed Durable Object, `wrangler` 4, `bun` as package manager.
- AIVAX docs: https://docs.aivax.net/docs (note: `aivax.net/docs` 404s). API reference: https://inference.aivax.net/apidocs.

## Repository map
- `wrangler.jsonc` — Worker config: entry `src/worker.js`, assets from `./public` with `run_worker_first: ["/api/*"]`, `RATE_LIMITER` Durable Object, `TURNSTILE_SITE_KEY` var.
- `src/worker.js` — `/api/config`, `/api/convert`, `/api/segment`; `gate()` (Turnstile + rate limit) and `callAivax()` (upstream call with timing and `x-request-id`).
- `src/rate-limiter.js` — `RateLimiter` Durable Object, one instance per visitor IP, sliding window with `status(limits)` and `consume(limits)`.
- `public/index.html` — home page with the toy grid.
- `public/<toy>/index.html` — one folder per toy (currently `media-to-markdown/`, which reads links, images and PDFs). `public/_redirects` keeps the old `/pdf-to-markdown/` URL working.
- `public/styles/base.css` — design tokens, reset, header/footer. `components/` holds shared controls (`controls.css`) and animated toy icons (`toy-art.css`); `pages/` holds one stylesheet per page.
- `public/scripts/site.js` — shared code tabs (`#code-tabs`) and code-block copy buttons. `public/scripts/<toy>.js` — page logic.

## Architecture and flow
- Browser → `POST /api/<route>` with a Turnstile token → `gate()` verifies the token, then consumes one slot in the visitor's Durable Object → `callAivax()` calls `https://inference.aivax.net/api/v1/...` with the secret key → JSON with the result, `processingUnits`, `elapsedMs`, `requestId` and `remaining` quota.
- Non-`/api/` paths fall through to `env.ASSETS`.
- Limits live in `LIMITS` in `src/worker.js` (5 documents/minute, 20/hour). `MAX_FILE_BYTES` is 50 MB because the AIVAX Fetch API rejects larger items; do not raise it.
- `/api/convert` takes either a `file` (PDF or PNG/JPEG/WebP/TIFF/BMP image, sent as a data URI) or a `url` (`http(s)` only, sent as is) and calls the Fetch API once.
- Cost shown in the UI is a client-side estimate from the price constants at the top of `public/scripts/media-to-markdown.js` (`OCR_PRICE_PER_PU`, `SEGMENT_PRICE_PER_PU`). Keep them aligned with https://docs.aivax.net/docs/pricing.

## Commands
- `bun install` — install `wrangler`.
- `bun run dev` — `wrangler dev` on http://127.0.0.1:8787. Requires `.dev.vars` (copy `.dev.vars.example`).
- `bun run check` — `node --check` syntax check for every Worker and page script. Add new script files to this list.
- `bun run deploy` — `wrangler deploy`. Only run when the user explicitly asks. Production normally deploys through Cloudflare Workers Builds on every push to `main`, so pushing is equivalent to deploying.

## Secrets and safety
- `AIVAX_API_KEY` and `TURNSTILE_SECRET_KEY` come from `.dev.vars` locally (gitignored) and `wrangler secret put` in production. Never print, commit, or hardcode them, and never send the key to the browser.
- `wrangler.jsonc` holds the production Turnstile site key (valid only on `toys.aivax.net`) and the custom-domain route. `.dev.vars` overrides the site key with Cloudflare's "always passes" test key for local work.
- Every `/api/` route that calls AIVAX must go through `gate()`. Validate input size before calling `gate()` so rejected requests don't consume quota.
- Real API calls cost money. Prefer `curl` against `wrangler dev` with a dummy Turnstile token (test keys accept any value) and keep browser end-to-end runs to a minimum.

## Conventions
- Site copy is in English, plain language, task-first. The feature comes first; API calls, processing units and code samples go inside the collapsed "For developers" `<details class="drawer">`. Cost stays in a small meter.
- Visual language: tokens in `public/styles/base.css`; General Sans for text, Sentient serif only for the single page `<h1>`, mono for code; pill buttons; underlined text links; Remix Icons via jsDelivr. Avoid generic "AI-looking" designs.
- `[hidden]` is forced to `display: none !important` in `base.css`; toggle visibility with the `hidden` property.
- Page scripts are ES modules that cache elements in a `ui` object built with `$(id)`. Every `$()` id must exist in the page HTML.
- Grid children that contain `<pre>` need `minmax(0, 1fr)` columns, or they overflow on mobile.
- No build step: reference CSS/JS with absolute paths (`/styles/...`, `/scripts/...`). Third-party code is loaded from CDNs (Turnstile; marked + DOMPurify on the Media → Markdown page).

## Adding a toy
1. Create `public/<toy>/index.html`, `public/styles/pages/<toy>.css` and `public/scripts/<toy>.js`, reusing `base.css`, `components/controls.css` and `site.js`.
2. Add the routes under `/api/` in `src/worker.js`, reusing `gate()` and `callAivax()`.
3. Add a card to the `.toy-grid` in `public/index.html` (with an icon in `components/toy-art.css`), add a row to the README "Toys" table, and add the script to `bun run check`.

## Validation
1. `bun run check`.
2. `bun run dev`, then `curl` the changed routes, including the error paths (missing token → 400, oversize → 413, sixth call in a minute → 429 with `Retry-After`).
3. Load the page in a browser at desktop width and at 390 px; check there's no horizontal overflow and no console errors.
4. Before finishing, run `rg "sk-aiv-" --hidden --glob '!node_modules' --glob '!.dev.vars'`; only the literal `sk-aiv-...` placeholder (in `.dev.vars.example`, `README.md` and this file) should match.
