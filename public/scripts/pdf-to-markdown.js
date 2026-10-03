// Public list prices used for the session estimate. OCR is per 1k PU by plan,
// segmentation is per 1M PU. See https://docs.aivax.net/docs/pricing
const OCR_PRICE_PER_PU = { free: 0.15 / 1000, pro: 0.05 / 1000, max: 0.02 / 1000 };
const SEGMENT_PRICE_PER_PU = 0.3 / 1_000_000;

const $ = (id) => document.getElementById(id);

const ui = {
  steps: document.querySelectorAll(".steps li"),
  dropzone: $("dropzone"),
  dropzoneHint: $("dropzone-hint"),
  fileInput: $("file-input"),
  fileChip: $("file-chip"),
  fileName: $("file-name"),
  fileSize: $("file-size"),
  fileClear: $("file-clear"),
  convert: $("convert"),
  convertStatus: $("convert-status"),
  error: $("error"),
  markdownResult: $("markdown-result"),
  markdownStats: $("markdown-stats"),
  markdownPreview: $("markdown-preview"),
  markdownRaw: $("markdown-raw"),
  markdownCopy: $("markdown-copy"),
  markdownDownload: $("markdown-download"),
  segmentActions: $("segment-actions"),
  segment: $("segment"),
  segmentStatus: $("segment-status"),
  sanitize: $("sanitize"),
  segmentsResult: $("segments-result"),
  segmentsStats: $("segments-stats"),
  segments: $("segments"),
  segmentsCopy: $("segments-copy"),
  segmentsDownload: $("segments-download"),
  plan: $("plan"),
  calls: $("calls"),
  mCalls: $("m-calls"),
  mCost: $("m-cost"),
  mPus: $("m-pus"),
  mTime: $("m-time"),
  qMinute: $("q-minute"),
  qHour: $("q-hour"),
};

const state = {
  config: null,
  file: null,
  markdown: "",
  segments: [],
  calls: [],
};

// ---------------------------------------------------------------------------
// Turnstile: one invisible widget, executed on demand so every request carries
// a fresh single-use token.
// ---------------------------------------------------------------------------

let widgetId;
let tokenWaiter;

const turnstileReady = new Promise((resolve, reject) => {
  const startedAt = Date.now();
  const poll = () => {
    if (window.turnstile) return resolve();
    if (Date.now() - startedAt > 15_000) return reject(new Error("Turnstile did not load. Disable blockers and reload."));
    setTimeout(poll, 50);
  };
  poll();
});

async function getTurnstileToken() {
  await turnstileReady;

  if (widgetId === undefined) {
    widgetId = turnstile.render("#turnstile", {
      sitekey: state.config.turnstileSiteKey,
      execution: "execute",
      appearance: "interaction-only",
      callback: (token) => tokenWaiter?.resolve(token),
      "error-callback": () => tokenWaiter?.reject(new Error("Turnstile could not verify this browser.")),
      "expired-callback": () => tokenWaiter?.reject(new Error("Turnstile token expired. Try again.")),
    });
  }

  return new Promise((resolve, reject) => {
    tokenWaiter = { resolve, reject };
    turnstile.reset(widgetId);
    turnstile.execute(widgetId);
  });
}

// ---------------------------------------------------------------------------
// Session panel
// ---------------------------------------------------------------------------

const money = (value) => `$${value.toFixed(4)}`;
const number = (value) => value.toLocaleString("en-US");
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** Marks steps before `index` as done and `index` as the current one. */
function setStep(index) {
  ui.steps.forEach((step, i) => {
    step.classList.toggle("is-done", i < index);
    step.classList.toggle("is-active", i === index);
  });
}

function costOf(call) {
  if (call.status !== "ok") return 0;
  return call.route === "web/fetch"
    ? call.pus * OCR_PRICE_PER_PU[ui.plan.value]
    : call.pus * SEGMENT_PRICE_PER_PU;
}

function renderSession() {
  const done = state.calls.filter((call) => call.status !== "pending");

  ui.mCalls.textContent = number(state.calls.length);
  ui.mCost.textContent = money(done.reduce((sum, call) => sum + costOf(call), 0));
  ui.mPus.textContent = number(done.reduce((sum, call) => sum + (call.pus ?? 0), 0));
  ui.mTime.textContent = seconds(done.reduce((sum, call) => sum + (call.elapsedMs ?? 0), 0));

  ui.calls.innerHTML = state.calls.length
    ? ""
    : '<span class="empty">Nothing yet. Read a PDF to see the requests.</span>';

  for (const call of [...state.calls].reverse()) {
    const row = document.createElement("div");
    row.className = `call ${call.status}`;

    const meta = [];
    if (call.status === "pending") meta.push("running...");
    if (call.elapsedMs != null) meta.push(`${number(call.elapsedMs)} ms`);
    if (call.pus != null) meta.push(`${number(call.pus)} PU`);
    if (call.status === "ok") meta.push(money(costOf(call)));
    if (call.requestId) meta.push(`id ${call.requestId.slice(0, 8)}`);
    if (call.status === "error") meta.push(call.error);

    row.innerHTML = `
      <div class="route"><span>POST <b>/api/v1/${call.route}</b></span><span>${call.httpStatus ?? ""}</span></div>
      <div class="meta">${meta.map((item) => `<span>${item}</span>`).join("")}</div>
    `;
    ui.calls.append(row);
  }
}

function renderQuota(remaining) {
  if (!remaining) return;
  ui.qMinute.textContent = `${remaining.minuteRemaining} / ${state.config.limits.perMinute}`;
  ui.qHour.textContent = remaining.hourRemaining;
}

function showError(message) {
  ui.error.hidden = !message;
  ui.error.querySelector("span").textContent = message ?? "";
}

/** Runs one Worker call while tracking it in the session panel. */
async function trackedCall(route, request) {
  const call = { route, status: "pending" };
  state.calls.push(call);
  renderSession();

  const startedAt = performance.now();

  try {
    const response = await fetch(request.url, request);
    const payload = await response.json().catch(() => ({}));

    call.httpStatus = response.status;
    renderQuota(payload.remaining);

    if (!response.ok) {
      call.status = "error";
      call.error = payload.error ?? `HTTP ${response.status}`;
      call.elapsedMs = Math.round(performance.now() - startedAt);
      throw new Error(call.error);
    }

    call.status = "ok";
    call.elapsedMs = payload.elapsedMs;
    call.pus = payload.processingUnits;
    call.requestId = payload.requestId;
    return payload;
  } catch (error) {
    if (call.status === "pending") {
      call.status = "error";
      call.error = error.message;
    }
    throw error;
  } finally {
    renderSession();
  }
}

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------

function setFile(file) {
  showError(null);

  if (file && file.size > state.config.maxFileBytes) {
    showError(`That PDF is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${state.config.maxFileBytes / 1024 / 1024} MB.`);
    file = null;
  }

  state.file = file;
  state.markdown = "";
  state.segments = [];
  ui.fileChip.hidden = !file;
  ui.dropzone.hidden = Boolean(file);
  ui.convert.disabled = !file;
  ui.convert.hidden = false;
  ui.markdownResult.hidden = true;
  ui.segmentActions.hidden = true;
  ui.segmentsResult.hidden = true;
  setStep(file ? 1 : 0);

  if (file) {
    ui.fileName.textContent = file.name;
    ui.fileSize.textContent = file.size > 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(file.size / 1024)} KB`;
  }
}

ui.fileInput.addEventListener("change", () => setFile(ui.fileInput.files[0] ?? null));
ui.fileClear.addEventListener("click", () => {
  ui.fileInput.value = "";
  setFile(null);
});

["dragenter", "dragover"].forEach((type) =>
  ui.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    ui.dropzone.classList.add("is-over");
  }),
);

["dragleave", "drop"].forEach((type) =>
  ui.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    ui.dropzone.classList.remove("is-over");
    if (type === "drop") setFile(event.dataTransfer.files[0] ?? null);
  }),
);

// ---------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------

function setBusy(button, statusEl, label) {
  button.disabled = Boolean(label);
  ui.fileClear.disabled = Boolean(label);
  statusEl.hidden = !label;
  statusEl.innerHTML = label ? `<span class="spinner"></span> ${label}` : "";
}

async function renderMarkdown(markdown) {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/marked@15/lib/marked.esm.js"),
    import("https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.es.mjs"),
  ]);

  ui.markdownPreview.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
  ui.markdownRaw.querySelector("pre").textContent = markdown;
}

ui.convert.addEventListener("click", async () => {
  if (!state.file) return;

  showError(null);
  ui.markdownResult.hidden = true;
  ui.segmentActions.hidden = true;
  ui.segmentsResult.hidden = true;
  state.segments = [];
  setStep(1);

  try {
    setBusy(ui.convert, ui.convertStatus, "Getting ready...");
    const turnstileToken = await getTurnstileToken();

    const form = new FormData();
    form.append("file", state.file);
    form.append("turnstile", turnstileToken);

    setBusy(ui.convert, ui.convertStatus, "Reading your PDF... scanned pages take a little longer");
    const result = await trackedCall("web/fetch", { url: "/api/convert", method: "POST", body: form });

    state.markdown = result.markdown;
    const words = state.markdown.split(/\s+/).filter(Boolean).length;
    ui.markdownStats.textContent = `${number(words)} words, read in ${seconds(result.elapsedMs)}`;

    await renderMarkdown(state.markdown);
    ui.markdownResult.hidden = false;
    ui.segmentActions.hidden = false;
    ui.convert.hidden = true;
    setStep(2);
    ui.markdownResult.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(ui.convert, ui.convertStatus, null);
  }
});

ui.markdownResult.querySelectorAll("[role=tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    const view = tab.dataset.view;
    tab.parentElement.querySelectorAll("[role=tab]").forEach((other) => other.setAttribute("aria-selected", String(other === tab)));
    ui.markdownPreview.hidden = view !== "preview";
    ui.markdownRaw.hidden = view !== "raw";
  });
});

function baseName() {
  return state.file.name.replace(/\.pdf$/i, "");
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  URL.revokeObjectURL(url);
}

async function copyWithFeedback(button, text) {
  await navigator.clipboard.writeText(text);
  const original = button.innerHTML;
  button.innerHTML = button.classList.contains("icon-button") ? '<i class="ri-check-line"></i>' : '<i class="ri-check-line"></i> Copied';
  setTimeout(() => (button.innerHTML = original), 1500);
}

ui.markdownCopy.addEventListener("click", () => copyWithFeedback(ui.markdownCopy, state.markdown));
ui.markdownDownload.addEventListener("click", () => download(`${baseName()}.md`, state.markdown, "text/markdown"));

// ---------------------------------------------------------------------------
// Segment
// ---------------------------------------------------------------------------

function toJsonl() {
  const source = state.file.name;
  return state.segments
    .map((text, index) =>
      JSON.stringify({
        docid: `${source}#${index + 1}`,
        text,
        __ref: source.slice(0, 64),
        __tags: ["pdf", "aivax-toys"],
        __meta: { source, index },
      }),
    )
    .join("\n");
}

ui.segment.addEventListener("click", async () => {
  showError(null);
  ui.segmentsResult.hidden = true;

  try {
    setBusy(ui.segment, ui.segmentStatus, "Getting ready...");
    const turnstileToken = await getTurnstileToken();

    setBusy(ui.segment, ui.segmentStatus, "Finding where each topic starts and ends...");
    const result = await trackedCall("generations/segment", {
      url: "/api/segment",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: state.markdown, sanitize: ui.sanitize.checked, turnstile: turnstileToken }),
    });

    state.segments = result.segments;

    const sizes = state.segments.map((segment) => segment.length);
    const average = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
    ui.segmentsStats.textContent = `${state.segments.length} chunks, about ${number(average)} characters each, split in ${seconds(result.elapsedMs)}`;

    ui.segments.innerHTML = "";
    state.segments.forEach((segment, index) => {
      const card = document.createElement("article");
      card.className = "segment";
      card.style.animationDelay = `${Math.min(index, 10) * 40}ms`;
      card.append(Object.assign(document.createElement("p"), { textContent: segment }));
      ui.segments.append(card);
    });

    ui.segmentsResult.hidden = false;
    setStep(3);
    ui.segmentsResult.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(ui.segment, ui.segmentStatus, null);
  }
});

ui.segmentsCopy.addEventListener("click", () => copyWithFeedback(ui.segmentsCopy, toJsonl()));
ui.segmentsDownload.addEventListener("click", () => download(`${baseName()}.jsonl`, toJsonl(), "application/jsonl"));

ui.plan.addEventListener("change", renderSession);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

try {
  state.config = await fetch("/api/config").then((response) => response.json());
  renderQuota(state.config.remaining);
  ui.dropzoneHint.textContent = `Up to ${state.config.maxFileBytes / 1024 / 1024} MB · text or scanned · never stored`;
} catch {
  showError("Could not reach the toy backend. Reload the page.");
  ui.dropzone.hidden = true;
}
