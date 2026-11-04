// The direct host bypasses the Cloudflare proxy timeout, so large documents don't end in HTTP 524.
const AIVAX_API = "https://direct.inference.aivax.net/api/v1";

// Account identity is only served by the main host; the direct host only exposes inference routes.
const AIVAX_ACCOUNT_API = "https://inference.aivax.net/api/v1/accounts";

// HttpOnly, so the page (which renders untrusted Markdown) can never read the visitor's AIVAX token.
const SESSION_COOKIE = "toys_session";
const STATE_COOKIE = "toys_oauth_state";

// The browser posts this to POST /api/v1/auth/oauth itself: that endpoint is rate limited per remote
// address, and requests sent from the Worker would all share the Worker's address.
const OAUTH_REQUEST = {
  clientName: "AIVAX Toys",
  reason: "Run the toys on toys.aivax.net: read links, images and PDFs as text, and split text into chunks. Usage is charged to this account.",
  permissions: ["WebUtilities", "InferenceGenerations"],
};

// The Fetch API accepts 50 MB per item, but Workers cut outbound fetches at ~125 s (HTTP 524) and large
// scanned PDFs take longer than that. 10 MB keeps processing inside the window.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_URL_CHARS = 2048;
const MAX_MARKDOWN_CHARS = 400_000;

// File types the Fetch API reads, keyed by extension for uploads that arrive without a MIME type.
const MEDIA_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const fail = (message, status) => json({ error: message }, status);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/config" && request.method === "GET") return await config(request, url);
      if (url.pathname === "/api/auth/start" && request.method === "POST") return await startSignIn(request, url);
      if (url.pathname === "/api/auth/callback" && request.method === "GET") return finishSignIn(request, url);
      if (url.pathname === "/api/auth/logout" && request.method === "POST") return signOut(url);
      if (url.pathname === "/api/convert" && request.method === "POST") return await convert(request, url);
      if (url.pathname === "/api/segment" && request.method === "POST") return await segment(request, url);
    } catch (error) {
      console.error(error);
      return fail("Unexpected error. Please try again.", 500);
    }

    return url.pathname.startsWith("/api/")
      ? fail("Not found.", 404)
      : env.ASSETS.fetch(request);
  },
};

function readCookie(request, name) {
  const pair = (request.headers.get("cookie") ?? "").split(/;\s*/).find((item) => item.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : null;
}

function cookie(url, name, value, path, maxAge) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

const clearSession = (url) => ({ "set-cookie": cookie(url, SESSION_COOKIE, "", "/api", 0) });

async function config(request, url) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return json({ maxFileBytes: MAX_FILE_BYTES, account: null });

  const response = await fetch(AIVAX_ACCOUNT_API, { headers: { authorization: `Bearer ${token}` } });

  if (response.status === 401) return json({ maxFileBytes: MAX_FILE_BYTES, account: null }, 200, clearSession(url));
  if (!response.ok) return fail("Could not reach your AIVAX account. Reload the page.", 502);

  const { data } = await response.json();

  return json({
    maxFileBytes: MAX_FILE_BYTES,
    account: { name: data.name, email: data.email, plan: response.headers.get("x-authenticated-account-plan") },
  });
}

/** Returns the OAuth request for the browser to send, bound to a single-use state kept in a cookie. */
async function startSignIn(request, url) {
  const body = await request.json().catch(() => null);
  const next = typeof body?.next === "string" && body.next.length <= 512 ? body.next : "/";
  const state = crypto.randomUUID();

  // Relative on purpose: `wrangler dev` reports the custom-domain route as the request origin, so the page
  // resolves it against its own address.
  return json(
    { ...OAUTH_REQUEST, returnUrl: `/api/auth/callback?state=${state}` },
    200,
    { "set-cookie": cookie(url, STATE_COOKIE, `${state}|${encodeURIComponent(next)}`, "/api/auth", 3600) },
  );
}

/** AIVAX redirects here with `access_token` and `expires_in`, or with `error=access_denied`. */
function finishSignIn(request, url) {
  const [state, next = "%2F"] = (readCookie(request, STATE_COOKIE) ?? "").split("|");

  let target = new URL(decodeURIComponent(next), url.origin);
  if (target.origin !== url.origin) target = new URL("/", url.origin);

  const headers = new Headers({ location: target.href, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  headers.append("set-cookie", cookie(url, STATE_COOKIE, "", "/api/auth", 0));

  const token = url.searchParams.get("access_token");
  const expiresIn = Math.floor(Number(url.searchParams.get("expires_in")));

  if (state && state === url.searchParams.get("state") && /^sk-aiv-apk[\w-]{1,64}$/.test(token ?? "") && expiresIn > 0) {
    headers.append("set-cookie", cookie(url, SESSION_COOKIE, token, "/api", expiresIn));
  }

  return new Response(null, { status: 302, headers });
}

function signOut(url) {
  return json({ signedOut: true }, 200, clearSession(url));
}

async function callAivax(token, path, body) {
  const startedAt = Date.now();
  const response = await fetch(`${AIVAX_API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });

  const payload = await response.json().catch(() => ({}));
  const requestId = response.headers.get("x-request-id");

  // AIVAX reports failures as `{ error, details }`; successful envelopes carry `{ message, data }`.
  const message = payload.error ?? payload.message;

  if (!response.ok) console.error(`AIVAX ${path} failed`, { status: response.status, requestId, message });

  return {
    ok: response.ok,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    requestId,
    data: payload.data,
    message,
  };
}

/**
 * Failures caused by the visitor's account (no balance, missing permission, rate limit) keep their status
 * so the page can explain them. An expired or revoked token also ends the session.
 */
function upstreamError(call, url, fallback) {
  if (call.status === 401) return json({ error: "Your AIVAX sign-in expired. Sign in again." }, 401, clearSession(url));
  return fail(call.message ?? fallback, [402, 403, 429].includes(call.status) ? call.status : 502);
}

async function convert(request, url) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return fail("Sign in with AIVAX to use this toy.", 401);

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const link = form?.get("url");

  let source;
  let mediaType;

  if (typeof link === "string" && link.trim()) {
    try {
      source = new URL(link.trim());
    } catch {
      return fail("That link doesn't look right. Use a full address like https://example.com/page.", 400);
    }

    if (source.protocol !== "http:" && source.protocol !== "https:") return fail("Only http:// and https:// links are accepted.", 400);
    if (source.href.length > MAX_URL_CHARS) return fail(`The link exceeds ${MAX_URL_CHARS} characters.`, 413);
  } else if (file instanceof File) {
    mediaType = Object.values(MEDIA_TYPES).includes(file.type)
      ? file.type
      : MEDIA_TYPES[file.name.split(".").pop().toLowerCase()];

    if (!mediaType) return fail("Only PDFs and PNG, JPEG, WebP, TIFF or BMP images are accepted.", 400);
    if (file.size === 0) return fail("The file is empty.", 400);
    if (file.size > MAX_FILE_BYTES) return fail(`The file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB.`, 413);
  } else {
    return fail("Attach a PDF or image in the `file` field, or send a link in the `url` field.", 400);
  }

  const body = source
    ? JSON.stringify({ contents: [source.href], returnErrors: true })
    : fileFetchBody(file, mediaType);

  const call = await callAivax(token, "/web/fetch", body);

  const item = call.data?.results?.[0];

  if (!call.ok || !item) return upstreamError(call, url, "AIVAX could not process this content.");
  if (item.error) return fail(item.error, 422);

  return json({
    markdown: item.extractedText,
    processingUnits: item.processingUnits,
    elapsedMs: call.elapsedMs,
    requestId: call.requestId,
  });
}

async function segment(request, url) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return fail("Sign in with AIVAX to use this toy.", 401);

  const body = await request.json().catch(() => null);
  const markdown = typeof body?.markdown === "string" ? body.markdown.trim() : "";

  if (!markdown) return fail("Send the Markdown to segment in the `markdown` field.", 400);
  if (markdown.length > MAX_MARKDOWN_CHARS) return fail(`The text exceeds ${MAX_MARKDOWN_CHARS.toLocaleString("en-US")} characters.`, 413);

  const call = await callAivax(token, "/generations/segment", JSON.stringify({
    documents: [markdown],
    sanitize: body.sanitize !== false,
  }));

  const result = call.data?.result?.[0];

  if (!call.ok || !result) return upstreamError(call, url, "AIVAX could not segment this text.");
  if (result.error) return fail(result.error, 422);

  return json({
    segments: result.segments,
    processingUnits: call.data.usage?.processing_units ?? 0,
    cost: call.data.usage?.cost ?? 0,
    elapsedMs: call.elapsedMs,
    requestId: call.requestId,
  });
}

/**
 * Streams `{ contents: [dataUri], returnErrors: true }` with a known length. Building the base64 data URI
 * and its JSON as strings would hold several copies of a large file and exceed the Worker's 128 MB memory.
 */
function fileFetchBody(file, mediaType) {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`{"contents":["data:${mediaType};base64,`);
  const suffix = encoder.encode(`"],"returnErrors":true}`);
  const { readable, writable } = new FixedLengthStream(prefix.length + Math.ceil(file.size / 3) * 4 + suffix.length);
  const writer = writable.getWriter();

  (async () => {
    await writer.write(prefix);

    // Base64 maps 3 bytes to 4 characters, so only whole 3-byte groups are encoded per chunk.
    let carry = new Uint8Array(0);

    for await (const chunk of file.stream()) {
      const bytes = new Uint8Array(carry.length + chunk.length);
      bytes.set(carry);
      bytes.set(chunk, carry.length);

      const whole = bytes.length - (bytes.length % 3);
      carry = bytes.slice(whole);
      await writer.write(encoder.encode(bytesToBase64(bytes.subarray(0, whole))));
    }

    await writer.write(encoder.encode(bytesToBase64(carry)));
    await writer.write(suffix);
    await writer.close();
  })().catch((error) => writer.abort(error));

  return readable;
}

// btoa() on a large binary string blows the call stack when spread; encode in chunks instead.
function bytesToBase64(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}
