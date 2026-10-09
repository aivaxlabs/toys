export { RateLimiter } from "./rate-limiter.js";

const AIVAX_API = "https://inference.aivax.net/api/v1";
const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Every conversion or segmentation counts as one document against both windows.
const LIMITS = { perMinute: 5, perHour: 20 };

// The AIVAX Fetch API caps each item at 10 MB, so the toy cannot accept more than that.
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
      if (url.pathname === "/api/config" && request.method === "GET") return config(request, env);
      if (url.pathname === "/api/convert" && request.method === "POST") return convert(request, env);
      if (url.pathname === "/api/segment" && request.method === "POST") return segment(request, env);
    } catch (error) {
      console.error(error);
      return fail("Unexpected error. Please try again.", 500);
    }

    return url.pathname.startsWith("/api/")
      ? fail("Not found.", 404)
      : env.ASSETS.fetch(request);
  },
};

function limiterFor(request, env) {
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
}

async function config(request, env) {
  const remaining = await limiterFor(request, env).status(LIMITS);
  return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY, limits: LIMITS, maxFileBytes: MAX_FILE_BYTES, remaining });
}

/**
 * Shared gate for every billable call: a valid Turnstile token and a free rate-limit slot.
 * Returns a Response when the request must stop, or the remaining quota when it may proceed.
 */
async function gate(request, env, turnstileToken) {
  if (!env.AIVAX_API_KEY) return fail("The server is missing its AIVAX_API_KEY secret.", 500);

  if (!turnstileToken) return fail("Missing Turnstile token.", 400);

  const verification = await fetch(TURNSTILE_VERIFY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET_KEY,
      response: turnstileToken,
      remoteip: request.headers.get("cf-connecting-ip") ?? undefined,
    }),
  }).then((response) => response.json());

  if (!verification.success) return fail("Turnstile verification failed. Reload the page and try again.", 403);

  const quota = await limiterFor(request, env).consume(LIMITS);

  if (!quota.allowed) {
    return json(
      {
        error: `Rate limit reached. This toy allows ${LIMITS.perMinute} documents per minute and ${LIMITS.perHour} per hour.`,
        remaining: quota,
      },
      429,
      { "retry-after": String(quota.retryAfterSeconds) },
    );
  }

  return quota;
}

async function callAivax(env, path, body) {
  const startedAt = Date.now();
  const response = await fetch(`${AIVAX_API}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.AIVAX_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
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

async function convert(request, env) {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const link = form?.get("url");

  let url;
  let mediaType;

  if (typeof link === "string" && link.trim()) {
    try {
      url = new URL(link.trim());
    } catch {
      return fail("That link doesn't look right. Use a full address like https://example.com/page.", 400);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") return fail("Only http:// and https:// links are accepted.", 400);
    if (url.href.length > MAX_URL_CHARS) return fail(`The link exceeds ${MAX_URL_CHARS} characters.`, 413);
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

  const gateResult = await gate(request, env, form.get("turnstile"));
  if (gateResult instanceof Response) return gateResult;

  const content = url
    ? url.href
    : `data:${mediaType};base64,${bytesToBase64(new Uint8Array(await file.arrayBuffer()))}`;

  const call = await callAivax(env, "/web/fetch", { contents: [content], returnErrors: true });

  const item = call.data?.results?.[0];

  if (!call.ok || !item) return fail(call.message ?? "AIVAX could not process this content.", call.status === 429 ? 503 : 502);
  if (item.error) return fail(item.error, 422);

  return json({
    markdown: item.extractedText,
    processingUnits: item.processingUnits,
    elapsedMs: call.elapsedMs,
    requestId: call.requestId,
    remaining: gateResult,
  });
}

async function segment(request, env) {
  const body = await request.json().catch(() => null);
  const markdown = typeof body?.markdown === "string" ? body.markdown.trim() : "";

  if (!markdown) return fail("Send the Markdown to segment in the `markdown` field.", 400);
  if (markdown.length > MAX_MARKDOWN_CHARS) return fail(`The text exceeds ${MAX_MARKDOWN_CHARS.toLocaleString("en-US")} characters.`, 413);

  const gateResult = await gate(request, env, body.turnstile);
  if (gateResult instanceof Response) return gateResult;

  const call = await callAivax(env, "/generations/segment", {
    documents: [markdown],
    sanitize: body.sanitize !== false,
  });

  const result = call.data?.result?.[0];

  if (!call.ok || !result) return fail(call.message ?? "AIVAX could not segment this text.", call.status === 429 ? 503 : 502);
  if (result.error) return fail(result.error, 422);

  return json({
    segments: result.segments,
    processingUnits: call.data.usage?.processing_units ?? 0,
    cost: call.data.usage?.cost ?? 0,
    elapsedMs: call.elapsedMs,
    requestId: call.requestId,
    remaining: gateResult,
  });
}

// btoa() on a 10 MB binary string blows the call stack when spread; encode in chunks instead.
function bytesToBase64(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}
