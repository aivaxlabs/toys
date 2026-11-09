# AIVAX Toys agent guide

## Project overview
- Public demos ("toys") of AIVAX API features. Each toy is one static page that runs the feature for visitors, shows an estimated cost, and ships the code that makes it work.
- Every toy requires signing in with AIVAX OAuth (https://docs.aivax.net/docs/oauth). Usage is billed to the visitor's own account through the application key they approve. The Worker holds no AIVAX key.
- One Cloudflare Worker serves the static site and a small `/api/*` proxy that forwards calls with the visitor's key.
- Stack: vanilla HTML/CSS/JS (no build step, no framework), Cloudflare Workers + Static Assets, `wrangler` 4, `bun` as package manager.
- AIVAX docs: https://docs.aivax.net/docs (note: `aivax.net/docs` 404s). API reference: https://inference.aivax.net/apidocs.

## Repository map
- `wrangler.jsonc` — Worker config: entry `src/worker.js`, assets from `./public` with `run_worker_first: ["/api/*"]`, custom domain, and migrations `v1` (created `RateLimiter`) and `v2` (deleted it). Keep both tags.
- `src/worker.js` — `/api/config`, `/api/auth/start|callback|logout`, `/api/convert`, `/api/segment`, `/api/images/generate`, `/api/images/file`; `OAUTH_REQUEST` (client name, reason, permissions), `callAivax(token, ...)` and `upstreamError()`.
- `public/index.html` — home page with the toy grid.
- `public/<toy>/index.html` — one folder per toy: `media-to-markdown/` (reads links, images and PDFs) and `image-playground/` (image generation with collections in IndexedDB). `public/_redirects` keeps the old `/pdf-to-markdown/` URL working.
- `public/styles/base.css` — design tokens, reset, header/footer. `components/` holds shared controls (`controls.css`) and animated toy icons (`toy-art.css`); `pages/` holds one stylesheet per page.
- `public/scripts/site.js` — shared theme switch (`.theme-switch`, saved as `toys.theme` in `localStorage`), code tabs (`#code-tabs`) and code-block copy buttons. `public/scripts/<toy>.js` — page logic.

## Architecture and flow
- Sign-in: page → `POST /api/auth/start` (returns the OAuth body and sets a single-use `toys_oauth_state` cookie) → the **browser** sends it to `POST https://inference.aivax.net/api/v1/auth/oauth` (rate limited per remote address, so it must not come from the Worker) → console approval → `GET /api/auth/callback` checks `state` and stores `access_token` in the `toys_session` cookie (`HttpOnly`, `SameSite=Lax`, path `/api`, `Max-Age` = `expires_in`). No refresh token.
- Toy call: browser → `POST /api/<route>` with the cookie → `callAivax()` calls `https://direct.inference.aivax.net/api/v1/...` (the long-inference host, which skips the Cloudflare proxy timeout; use it for every new route it exposes) with the visitor's key → JSON with the result, `processingUnits`, `elapsedMs`, `requestId`. AIVAX `401` clears the cookie; `402`/`403`/`429` pass through.
- `/api/config` returns `maxFileBytes` and `account` (`name`, `email`, `plan` from `X-Authenticated-Account-Plan`) via `GET https://inference.aivax.net/api/v1/accounts`; the direct host doesn't serve it.
- Non-`/api/` paths fall through to `env.ASSETS`.
- `MAX_FILE_BYTES` is 10 MB: the Fetch API accepts 50 MB, but Workers cut outbound fetches at ~125 s (HTTP 524) and a 45 MB PDF exceeded that even on the direct host. Don't raise it without moving conversion off the synchronous Worker call.
- `/api/convert` takes either a `file` (PDF or PNG/JPEG/WebP/TIFF/BMP image, sent as a data URI) or a `url` (`http(s)` only, sent as is) and calls the Fetch API once.
- `/api/images/generate` validates prompt, model, `count` (1–4), optional `size` (`<width>x<height>`, 64–4096 px per side; the page sends the long side 1024/2048/4096 for 1K/2K/4K and also appends `Aspect ratio: <w:h> (<shape>).` to the prompt, since some models ignore `size`; "Auto" resolution omits `size`, "Auto" aspect ratio omits both `size` and the prompt line) and up to 16 references (`http(s)` links or `data:image/(png|jpeg|webp|gif);base64` URIs, which the page downsizes to 1536 px WebP) and calls `/generations/images` once. AIVAX `400` becomes `422`. The model list and price estimate come from the public, CORS-enabled `GET https://inference.aivax.net/api/v1/information/image-models.json` (deprecated models hidden, references only for `AllowReferenceImage`). The model picker groups models by the provider in the model id (`PROVIDERS` in `public/scripts/image-playground.js`, icons in `public/images/providers/`) and the style picker shows `public/images/styles/<style>.webp` (one shared prompt, a red fox by a lighthouse, generated once per style and cropped to 360×450; regenerate all of them together if a style changes). The model picker shows the sample image the console hosts at `https://console.aivax.net/assets/imggenmodels/<model id without provider>.webp`; the charged cost comes from `outputs[].cost`. Collections live in IndexedDB (`aivax-image-playground`: `collections`, `generations`) and store image links only.
- `/api/images/file` proxies generated images for download and copy, because Backblaze B2 sends no CORS headers. It requires the session cookie and only fetches PNG, JPEG, WebP or GIF from `https://aivax-objects.s3.us-west-002.backblazeb2.com/PublicObjects/ImageGeneration/...` without following redirects, served as an attachment; keep that restriction so it can't become an open proxy.
- Cost shown in the Media → Markdown UI is a client-side estimate, priced at the signed-in account's plan, from the price constants at the top of `public/scripts/media-to-markdown.js` (`OCR_PRICE_PER_PU`, `SEGMENT_PRICE_PER_PU`). Keep them aligned with https://docs.aivax.net/docs/pricing.

## Commands
- `bun install` — install `wrangler`.
- `bun run dev` — `wrangler dev` on http://127.0.0.1:8787. No secrets needed; sign in from the page (AIVAX accepts the local callback).
- `bun run check` — `node --check` syntax check for every Worker and page script. Add new script files to this list.
- `bun run deploy` — `wrangler deploy`. Only run when the user explicitly asks. Production normally deploys through Cloudflare Workers Builds on every push to `main`, so pushing is equivalent to deploying.

## Secrets and safety
- Visitor keys (`sk-aiv-apk...`) only live in the `toys_session` cookie. Never return them in a response body, log them, or make the cookie readable by scripts: the page renders untrusted Markdown.
- Every `/api/` route that calls AIVAX must require the session cookie and return `401` without it. Validate input before calling AIVAX.
- Request only the OAuth permissions the toys use (`OAUTH_REQUEST.permissions`, currently `WebUtilities` and `InferenceGenerations`). Adding one forces visitors to sign in again.
- Real API calls charge the signed-in account. Use a test account, prefer `curl` against `wrangler dev` with `-b "toys_session=<key>"`, and keep browser end-to-end runs to a minimum.

## Conventions
- Site copy is in English, plain language, task-first. The feature comes first; API calls, processing units and code samples go inside the collapsed "For developers" `<details class="drawer">`. Cost stays in a small meter.
- Themes: System, Light and Dark. Color tokens in `base.css` use `light-dark()` and follow `color-scheme`, which `[data-theme]` on `<html>` overrides; an inline `<head>` script sets it before first paint. Use tokens instead of fixed colors so both themes work; `--white` is the text color on `--ink` surfaces, not literal white.
- Visual language: tokens in `public/styles/base.css`; General Sans for text, Sentient serif only for the single page `<h1>`, mono for code; pill buttons; underlined text links; Remix Icons via jsDelivr. Avoid generic "AI-looking" designs.
- `[hidden]` is forced to `display: none !important` in `base.css`; toggle visibility with the `hidden` property.
- Page scripts are ES modules that cache elements in a `ui` object built with `$(id)`. Every `$()` id must exist in the page HTML.
- Grid children that contain `<pre>` need `minmax(0, 1fr)` columns, or they overflow on mobile.
- No build step: reference CSS/JS with absolute paths (`/styles/...`, `/scripts/...`). Third-party code is loaded from CDNs (marked + DOMPurify on the Media → Markdown page).
- Toy pages start signed out: show the `#sign-in` panel, hide the tool until `/api/config` returns an `account`, and show the account and "Sign out" in the header.

## Adding a toy
1. Create `public/<toy>/index.html`, `public/styles/pages/<toy>.css` and `public/scripts/<toy>.js`, reusing `base.css`, `components/controls.css` and `site.js`.
2. Add the routes under `/api/` in `src/worker.js`, reading the session cookie and reusing `callAivax()` and `upstreamError()`.
3. Add a card to the `.toy-grid` in `public/index.html` (with an icon in `components/toy-art.css`), add a row to the README "Toys" table, and add the script to `bun run check`.

## Validation
1. `bun run check`.
2. `bun run dev`, then `curl` the changed routes, including the error paths (no cookie → 401, invalid key → 401 that clears the cookie, oversize → 413). Check the callback rejects a mismatched `state`.
3. Load the page in a browser at desktop width and at 390 px; check there's no horizontal overflow and no console errors.
4. Before finishing, run `rg "sk-aiv-" --hidden --glob '!node_modules' --glob '!.dev.vars'`; only the `sk-aiv-apk` prefix check in `src/worker.js` and the mentions in this file should match.
