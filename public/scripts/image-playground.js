const MODELS_API = "https://inference.aivax.net/api/v1/information/image-models.json";
const OAUTH_API = "https://inference.aivax.net/api/v1/auth/oauth";

const MAX_REFERENCES = 4;
const REFERENCE_MAX_SIDE = 1536;
const REFERENCE_MAX_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MODEL = "@black-forest-labs/flux-3-image-klein";

// The API has no style field, so a style becomes a short description at the end of the prompt.
const STYLES = {
  auto: { label: "Auto", suffix: null },
  realism: { label: "Realism", suffix: "photorealistic photograph, natural lighting, realistic textures, sharp detail" },
  anime: { label: "Anime", suffix: "anime illustration, cel shading, clean line art, vibrant colors" },
  "vintage-cartoon": { label: "Vintage Cartoon", suffix: "1930s rubber hose cartoon, hand-inked lines, grainy film, muted vintage colors" },
  "cute-3d": { label: "Cute 3D", suffix: "cute 3D render, soft rounded shapes, pastel colors, studio lighting, toy-like" },
};

const $ = (id) => document.getElementById(id);

const ui = {
  account: $("account"),
  accountName: $("account-name"),
  signOut: $("sign-out"),
  signIn: $("sign-in"),
  signInButton: $("sign-in-button"),
  error: $("error"),
  collectionsView: $("collections-view"),
  collections: $("collections"),
  newCollection: $("new-collection"),
  collectionView: $("collection-view"),
  collectionName: $("collection-name"),
  collectionStats: $("collection-stats"),
  deleteCollection: $("delete-collection"),
  composer: $("composer"),
  references: $("references"),
  prompt: $("prompt"),
  linkRow: $("link-row"),
  linkInput: $("link-input"),
  linkAdd: $("link-add"),
  attachFile: $("attach-file"),
  attachLink: $("attach-link"),
  fileInput: $("file-input"),
  model: $("model"),
  style: $("style"),
  count: $("count"),
  estimate: $("estimate"),
  generate: $("generate"),
  composerNote: $("composer-note"),
  feed: $("feed"),
  feedEmpty: $("feed-empty"),
  viewer: $("viewer"),
  viewerImage: $("viewer-image"),
  viewerClose: $("viewer-close"),
  viewerPrompt: $("viewer-prompt"),
  viewerMeta: $("viewer-meta"),
  viewerActions: $("viewer-actions"),
  calls: $("calls"),
  mCalls: $("m-calls"),
  mImages: $("m-images"),
  mCost: $("m-cost"),
};

const state = {
  account: null,
  models: [],
  collection: null,
  generations: [],
  references: [],
  count: Number(localStorage.getItem("playground.count")) || 1,
  busy: false,
  calls: [],
};

const money = (value) => `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const modelOf = (name) => state.models.find((model) => model.name === name);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child != null));
  return node;
}

function showError(message) {
  ui.error.hidden = !message;
  ui.error.querySelector("span").textContent = message ?? "";
  clearTimeout(showError.timer);
  if (message) showError.timer = setTimeout(() => (ui.error.hidden = true), 8000);
}

ui.error.addEventListener("click", () => showError(null));

// ---------------------------------------------------------------------------
// IndexedDB: collections, and one record per generation with its image links
// and costs. Images themselves stay at the links AIVAX returns.
// ---------------------------------------------------------------------------

const database = new Promise((resolve, reject) => {
  const request = indexedDB.open("aivax-image-playground", 1);

  request.onupgradeneeded = () => {
    request.result.createObjectStore("collections", { keyPath: "id" });
    request.result.createObjectStore("generations", { keyPath: "id" }).createIndex("collectionId", "collectionId");
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function store(name, mode, action) {
  const transaction = (await database).transaction(name, mode);
  const request = action(transaction.objectStore(name));

  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

const generationsOf = (collectionId) =>
  store("generations", "readonly", (generations) => generations.index("collectionId").getAll(collectionId))
    .then((list) => list.sort((a, b) => b.createdAt - a.createdAt));

const imagesOf = (generations) => generations.flatMap((generation) => generation.outputs.filter((output) => output.url));
const costOf = (generations) => generations.reduce((sum, generation) => sum + (generation.cost ?? 0), 0);

// ---------------------------------------------------------------------------
// Sign-in. The Worker keeps the application key in an HttpOnly cookie; the
// page only learns which account is connected.
// ---------------------------------------------------------------------------

function renderAccount(account) {
  state.account = account;
  ui.account.hidden = !account;
  ui.signIn.hidden = Boolean(account);

  if (account) {
    ui.accountName.textContent = account.name || account.email;
    ui.account.title = account.email;
  }

  route();
}

ui.signInButton.addEventListener("click", async () => {
  showError(null);
  ui.signInButton.disabled = true;

  try {
    const request = await fetch("/api/auth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ next: location.pathname + location.hash }),
    }).then((response) => response.json());

    request.returnUrl = new URL(request.returnUrl, location.origin).href;

    const response = await fetch(OAUTH_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(payload.error ?? "AIVAX could not start the sign-in. Try again.");
    location.assign(payload.data.authorizationUrl);
  } catch (error) {
    showError(error.message);
    ui.signInButton.disabled = false;
  }
});

ui.signOut.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  renderAccount(null);
});

// ---------------------------------------------------------------------------
// Session panel
// ---------------------------------------------------------------------------

function renderSession() {
  const done = state.calls.filter((call) => call.status === "ok");

  ui.mCalls.textContent = state.calls.length;
  ui.mImages.textContent = done.reduce((sum, call) => sum + call.images, 0);
  ui.mCost.textContent = money(done.reduce((sum, call) => sum + call.cost, 0));

  ui.calls.replaceChildren(...(state.calls.length
    ? [...state.calls].reverse().map((call) => {
      const meta = [
        call.model,
        call.status === "pending" ? "running..." : null,
        call.elapsedMs != null ? `${call.elapsedMs.toLocaleString("en-US")} ms` : null,
        call.status === "ok" ? `${plural(call.images, "image")} · ${money(call.cost)}` : null,
        call.requestId ? `id ${call.requestId.slice(0, 8)}` : null,
        call.error,
      ].filter(Boolean);

      return el("div", { className: `call ${call.status}` },
        el("div", { className: "route" },
          el("span", {}, "POST ", el("b", { textContent: "/api/v1/generations/images" })),
          el("span", { textContent: call.httpStatus ?? "" })),
        el("div", { className: "meta" }, ...meta.map((item) => el("span", { textContent: item }))));
    })
    : [el("span", { className: "empty", textContent: "Nothing yet. Generate an image to see the requests." })]));
}

// ---------------------------------------------------------------------------
// Routing: #/ lists collections, #/c/<id> opens one.
// ---------------------------------------------------------------------------

let routeId = 0;

async function route() {
  const id = location.hash.match(/^#\/c\/([\w-]+)$/)?.[1];
  const current = ++routeId;

  ui.collectionsView.hidden = true;
  ui.collectionView.hidden = true;
  if (!state.account) return;

  const collection = id && await store("collections", "readonly", (collections) => collections.get(id));
  if (current !== routeId) return;

  if (!collection) {
    state.collection = null;
    if (id) history.replaceState(null, "", "#/");
    await renderCollections();
    if (current === routeId) ui.collectionsView.hidden = false;
    return;
  }

  if (state.collection?.id !== collection.id) {
    state.references = [];
    renderReferences();
  }

  const generations = await generationsOf(collection.id);
  if (current !== routeId) return;

  state.collection = collection;
  state.generations = generations;
  ui.collectionName.value = collection.name;
  renderFeed();
  ui.collectionView.hidden = false;
}

window.addEventListener("hashchange", route);

async function renderCollections() {
  const collections = await store("collections", "readonly", (collections) => collections.getAll());
  collections.sort((a, b) => b.updatedAt - a.updatedAt);

  const cards = await Promise.all(collections.map(async (collection) => {
    const generations = await generationsOf(collection.id);
    const covers = imagesOf(generations).slice(0, 4);

    return el("a", { className: "collection-card", href: `#/c/${collection.id}` },
      el("div", { className: `covers covers-${covers.length}` },
        ...(covers.length
          ? covers.map((cover) => el("img", { src: cover.url, alt: "", loading: "lazy", onerror: (event) => event.target.classList.add("is-broken") }))
          : [el("i", { className: "ri-image-2-line" })])),
      el("div", { className: "collection-meta" },
        el("strong", { textContent: collection.name }),
        el("span", { className: "muted", textContent: `${plural(imagesOf(generations).length, "image")} · ${money(costOf(generations))}` })));
  }));

  ui.collections.replaceChildren(
    ...cards,
    el("button", { type: "button", className: "collection-card new", onclick: () => ui.newCollection.click() },
      el("div", { className: "covers" }, el("i", { className: "ri-add-line" })),
      el("div", { className: "collection-meta" },
        el("strong", { textContent: "New collection" }),
        el("span", { className: "muted", textContent: "Start a fresh set of images" }))));
}

ui.newCollection.addEventListener("click", async () => {
  const collection = { id: crypto.randomUUID(), name: "Untitled collection", createdAt: Date.now(), updatedAt: Date.now() };
  await store("collections", "readwrite", (collections) => collections.put(collection));
  location.hash = `#/c/${collection.id}`;
  requestAnimationFrame(() => ui.collectionName.select());
});

ui.collectionName.addEventListener("change", async () => {
  state.collection.name = ui.collectionName.value.trim() || "Untitled collection";
  state.collection.updatedAt = Date.now();
  ui.collectionName.value = state.collection.name;
  await store("collections", "readwrite", (collections) => collections.put(state.collection));
});

ui.collectionName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") ui.prompt.focus();
});

ui.deleteCollection.addEventListener("click", async () => {
  const images = imagesOf(state.generations).length;
  if (!confirm(`Delete "${state.collection.name}" and its ${plural(images, "image")} from this browser? This can't be undone.`)) return;

  const id = state.collection.id;
  await store("generations", "readwrite", (generations) => state.generations.forEach((generation) => generations.delete(generation.id)));
  await store("collections", "readwrite", (collections) => collections.delete(id));
  location.hash = "#/";
});

// ---------------------------------------------------------------------------
// Models and composer settings
// ---------------------------------------------------------------------------

function renderComposer() {
  const model = modelOf(ui.model.value);
  const unsupported = state.references.length > 0 && model && !model.references;

  ui.composerNote.hidden = !unsupported;
  ui.composerNote.textContent = unsupported ? `${model.label} doesn't take reference images. Remove them or pick another model.` : "";

  ui.count.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.value) === state.count)));

  if (model?.outputPrice != null) {
    const each = model.outputPrice + (model.references ? state.references.length * model.referencePrice : 0);
    ui.estimate.textContent = `about ${money(each * state.count)}`;
  } else {
    ui.estimate.textContent = "";
  }

  ui.generate.disabled = state.busy || !model || unsupported || !ui.prompt.value.trim();
  ui.generate.innerHTML = state.busy ? '<span class="spinner"></span> Generating' : '<i class="ri-magic-line"></i> Generate';
}

ui.style.append(...Object.entries(STYLES).map(([value, style]) => el("option", { value, textContent: style.label })));
ui.style.value = STYLES[localStorage.getItem("playground.style")] ? localStorage.getItem("playground.style") : "auto";

ui.style.addEventListener("change", () => localStorage.setItem("playground.style", ui.style.value));

ui.model.addEventListener("change", () => {
  localStorage.setItem("playground.model", ui.model.value);
  renderComposer();
});

ui.count.addEventListener("click", (event) => {
  if (!event.target.value) return;
  state.count = Number(event.target.value);
  localStorage.setItem("playground.count", state.count);
  renderComposer();
});

ui.prompt.addEventListener("input", renderComposer);

ui.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) ui.composer.requestSubmit();
});

try {
  const { data } = await fetch(MODELS_API).then((response) => response.json());

  state.models = data
    .filter((model) => !model.flags.includes("Deprecated"))
    .map((model) => {
      const [, output, reference] = model.pricingDescription?.match(/\$([\d.]+) per output image(?: \+ \$([\d.]+) per reference image)?/) ?? [];
      const [vendor, label] = model.displayName?.includes(":")
        ? model.displayName.split(/:\s*/, 2)
        : [model.name.split("/")[0].slice(1), model.displayName ?? model.name.split("/")[1]];

      return {
        name: model.name,
        label,
        vendor,
        references: model.flags.includes("AllowReferenceImage"),
        outputPrice: output ? Number(output) : null,
        referencePrice: reference ? Number(reference) : 0,
      };
    })
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label));

  const vendors = Map.groupBy(state.models, (model) => model.vendor);

  ui.model.replaceChildren(...[...vendors].map(([vendor, models]) =>
    el("optgroup", { label: vendor }, ...models.map((model) =>
      el("option", {
        value: model.name,
        textContent: `${model.label}${model.outputPrice != null ? ` · ${money(model.outputPrice)}` : ""}${model.references ? " · refs" : ""}`,
      })))));

  const saved = localStorage.getItem("playground.model");
  ui.model.value = modelOf(saved) ? saved : modelOf(DEFAULT_MODEL) ? DEFAULT_MODEL : state.models[0]?.name;
} catch {
  ui.model.replaceChildren(el("option", { textContent: "Models unavailable" }));
  showError("Could not load the list of models. Reload the page.");
}

// ---------------------------------------------------------------------------
// References: links, uploads, pasted or dropped pictures, and images from
// the collection. Files are shrunk and sent inline as data URIs.
// ---------------------------------------------------------------------------

function renderReferences() {
  ui.references.hidden = state.references.length === 0;
  ui.references.replaceChildren(...state.references.map((reference, index) =>
    el("figure", { className: "reference" },
      el("img", { src: reference, alt: `Reference ${index + 1}`, onerror: (event) => event.target.classList.add("is-broken") }),
      el("button", {
        type: "button",
        className: "reference-remove",
        title: "Remove reference",
        ariaLabel: "Remove reference",
        innerHTML: '<i class="ri-close-line"></i>',
        onclick: () => {
          state.references.splice(index, 1);
          renderReferences();
        },
      }))));

  const full = state.references.length >= MAX_REFERENCES;
  ui.attachFile.disabled = full;
  ui.attachLink.disabled = full;
  renderComposer();
}

function addReference(source) {
  if (state.references.includes(source)) return;
  if (state.references.length >= MAX_REFERENCES) return showError(`Use up to ${MAX_REFERENCES} reference images.`);

  state.references.push(source);
  renderReferences();
}

async function addFiles(files) {
  for (const file of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      showError(`${file.name || "That file"} isn't a PNG, JPEG, WebP or GIF image.`);
      continue;
    }

    if (file.size > REFERENCE_MAX_FILE_BYTES) {
      showError(`${file.name || "That image"} is over ${REFERENCE_MAX_FILE_BYTES / 1024 / 1024} MB.`);
      continue;
    }

    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, REFERENCE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const canvas = el("canvas", { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });

      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      addReference(canvas.toDataURL("image/webp", 0.9));
    } catch {
      showError(`Could not read ${file.name || "that image"}.`);
    }
  }
}

ui.attachFile.addEventListener("click", () => ui.fileInput.click());

ui.fileInput.addEventListener("change", async () => {
  await addFiles([...ui.fileInput.files]);
  ui.fileInput.value = "";
});

ui.attachLink.addEventListener("click", () => {
  ui.linkRow.hidden = !ui.linkRow.hidden;
  if (!ui.linkRow.hidden) ui.linkInput.focus();
});

function addLink() {
  const value = ui.linkInput.value.trim();

  try {
    const link = new URL(value);
    if (link.protocol !== "http:" && link.protocol !== "https:") throw new Error();
    addReference(link.href);
    ui.linkInput.value = "";
    ui.linkRow.hidden = true;
    ui.prompt.focus();
  } catch {
    showError("Use a full image link, like https://example.com/picture.jpg.");
  }
}

ui.linkAdd.addEventListener("click", addLink);

ui.linkInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addLink();
});

ui.composer.addEventListener("paste", (event) => {
  const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;

  event.preventDefault();
  addFiles(files);
});

ui.composer.addEventListener("dragover", (event) => {
  if (![...event.dataTransfer.types].includes("Files")) return;
  event.preventDefault();
  ui.composer.classList.add("is-over");
});

ui.composer.addEventListener("dragleave", (event) => {
  if (!ui.composer.contains(event.relatedTarget)) ui.composer.classList.remove("is-over");
});

ui.composer.addEventListener("drop", (event) => {
  ui.composer.classList.remove("is-over");
  if (!event.dataTransfer.files.length) return;

  event.preventDefault();
  addFiles([...event.dataTransfer.files]);
});

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

function renderFeed() {
  const images = imagesOf(state.generations);

  ui.collectionStats.textContent = `${plural(images.length, "image")} · ${money(costOf(state.generations))} spent`;
  ui.feedEmpty.hidden = state.generations.length > 0 || state.busy;

  ui.feed.replaceChildren(...state.generations.map((generation) => {
    const model = modelOf(generation.model);
    const details = [
      model?.label ?? generation.model,
      generation.style !== "auto" ? STYLES[generation.style]?.label : null,
      generation.references ? plural(generation.references, "reference") : null,
      generation.pending ? "generating..." : money(generation.cost),
      new Date(generation.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
    ].filter(Boolean);

    return el("article", { className: `generation${generation.pending ? " is-pending" : ""}` },
      el("header", {},
        el("p", { className: "generation-prompt", textContent: generation.prompt }),
        el("p", { className: "generation-meta muted" }, ...details.map((detail) => el("span", { textContent: detail })))),
      el("div", { className: "tiles" }, ...(generation.pending
        ? Array.from({ length: generation.count }, () => el("div", { className: "tile skeleton" }))
        : generation.outputs.map((output) => output.url
          ? el("button", { type: "button", className: "tile", onclick: () => openViewer(generation, output) },
            el("img", {
              src: output.url,
              alt: generation.prompt,
              loading: "lazy",
              onerror: (event) => event.target.parentElement.classList.add("is-broken"),
            }),
            el("span", { className: "tile-cost", textContent: money(output.cost) }))
          : el("div", { className: "tile failed" },
            el("i", { className: "ri-error-warning-line" }),
            el("span", { textContent: output.error ?? "This image could not be generated." }),
            el("small", { className: "muted", textContent: "Not charged" }))))));
  }));
}

ui.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (ui.generate.disabled) return;

  showError(null);

  const prompt = ui.prompt.value.trim();
  const style = ui.style.value;
  const model = ui.model.value;
  const references = [...state.references];
  const input = STYLES[style].suffix ? `${prompt}\n\nStyle: ${STYLES[style].suffix}` : prompt;

  const collectionId = state.collection.id;
  const isCurrent = () => state.collection?.id === collectionId;

  const pending = {
    id: crypto.randomUUID(),
    pending: true,
    collectionId,
    prompt,
    style,
    model,
    count: state.count,
    references: references.length,
    outputs: [],
    cost: 0,
    createdAt: Date.now(),
  };
  const call = { status: "pending", model };

  state.busy = true;
  state.generations.unshift(pending);
  state.calls.push(call);
  renderComposer();
  renderFeed();
  renderSession();

  try {
    const response = await fetch("/api/images/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: input, model, count: state.count, references }),
    });
    const payload = await response.json().catch(() => ({}));

    call.httpStatus = response.status;
    call.elapsedMs = payload.elapsedMs;
    call.requestId = payload.requestId;

    if (response.status === 401) renderAccount(null);
    if (!response.ok) throw new Error(payload.error ?? `Something went wrong (HTTP ${response.status}). Try again.`);

    const generation = { ...pending, outputs: payload.outputs, cost: payload.cost };
    delete generation.pending;

    call.status = "ok";
    call.images = payload.outputs.filter((output) => output.url).length;
    call.cost = payload.cost;

    // The collection may have been left or deleted while the images were generating; charged results
    // still belong to the collection that asked for them, if it exists.
    const collection = await store("collections", "readonly", (collections) => collections.get(collectionId));
    if (collection) {
      collection.updatedAt = Date.now();
      await store("generations", "readwrite", (generations) => generations.put(generation));
      await store("collections", "readwrite", (collections) => collections.put(collection));
    }

    if (isCurrent()) {
      state.collection.updatedAt = Date.now();
      state.generations[state.generations.indexOf(pending)] = generation;
      ui.prompt.value = "";
      state.references = [];
      renderReferences();
    }
  } catch (error) {
    call.status = "error";
    call.error = error.message;
    if (isCurrent()) state.generations.splice(state.generations.indexOf(pending), 1);
    showError(error.message);
  } finally {
    state.busy = false;
    renderComposer();
    renderFeed();
    renderSession();
  }
});

// ---------------------------------------------------------------------------
// Image viewer and actions
// ---------------------------------------------------------------------------

async function fetchImage(url) {
  const response = await fetch(`/api/images/file?url=${encodeURIComponent(url)}`);

  if (response.status === 401) renderAccount(null);
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Could not load this image.");

  return response.blob();
}

async function withFeedback(button, done, action) {
  const original = button.innerHTML;
  button.disabled = true;

  try {
    await action();
    button.innerHTML = `<i class="ri-check-line"></i> ${done}`;
  } catch (error) {
    showError(error.message);
  } finally {
    setTimeout(() => {
      button.innerHTML = original;
      button.disabled = false;
    }, 1500);
  }
}

function openViewer(generation, output) {
  const name = `${generation.prompt.slice(0, 48).replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "image"}`;
  const actionButton = (icon, label, onclick) =>
    el("button", { type: "button", className: "button secondary small", innerHTML: `<i class="${icon}"></i> ${label}`, onclick });

  ui.viewerImage.src = output.url;
  ui.viewerImage.alt = generation.prompt;
  ui.viewerPrompt.textContent = generation.prompt;
  ui.viewerMeta.textContent = `${modelOf(generation.model)?.label ?? generation.model} · ${money(output.cost)}`;

  const download = actionButton("ri-download-2-line", "Download", () => withFeedback(download, "Saved", async () => {
    const blob = await fetchImage(output.url);
    const link = el("a", { href: URL.createObjectURL(blob), download: `${name}.${blob.type.split("/")[1] || "png"}` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }));

  // Clipboards only take PNG reliably, so other formats are converted first.
  const copy = actionButton("ri-file-copy-line", "Copy", () => withFeedback(copy, "Copied", async () => {
    const png = fetchImage(output.url).then(async (blob) => {
      if (blob.type === "image/png") return blob;

      const bitmap = await createImageBitmap(blob);
      const canvas = el("canvas", { width: bitmap.width, height: bitmap.height });
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    });

    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  }));

  ui.viewerActions.replaceChildren(
    download,
    copy,
    actionButton("ri-edit-2-line", "Prompt on this image", () => {
      if (!modelOf(ui.model.value)?.references) {
        const capable = modelOf(generation.model)?.references ? generation.model : state.models.find((model) => model.references)?.name;
        if (capable) ui.model.value = capable;
      }

      state.references = [output.url];
      renderReferences();
      ui.prompt.value = "";
      ui.prompt.placeholder = "Describe what to change in this image.";
      ui.viewer.close();
      ui.prompt.focus();
    }),
    actionButton("ri-image-add-line", "Use as reference", () => {
      addReference(output.url);
      ui.viewer.close();
      ui.prompt.focus();
    }),
  );

  ui.viewer.showModal();
}

ui.viewerClose.addEventListener("click", () => ui.viewer.close());

ui.viewer.addEventListener("click", (event) => {
  if (event.target === ui.viewer) ui.viewer.close();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

renderComposer();

try {
  const response = await fetch("/api/config");
  const config = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(config.error);

  renderAccount(config.account);
} catch (error) {
  showError(error.message || "Could not reach the toy backend. Reload the page.");
}
