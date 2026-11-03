// Keeps one connection to the local helper and relays requests from note tabs
// and the popup. File changes reported by the helper are broadcast to every
// extension page so open notes can reload.

const HOST = "zen_notes";
const NOTE_PAGE = browser.runtime.getURL("note.html");

let port = null;
let nextId = 1;
const pending = new Map();

function connect() {
  port = browser.runtime.connectNative(HOST);
  port.onMessage.addListener((msg) => {
    if (msg.event) {
      browser.runtime.sendMessage({ type: "event", ...msg }).catch(() => {});
      if (msg.event === "changed") onNotesChanged(msg);
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    msg.ok ? waiter.resolve(msg.result) : waiter.reject(new Error(msg.error));
  });
  port.onDisconnect.addListener((p) => {
    const reason = p.error?.message || "Helper stopped";
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`${reason}. Is the Zen Notes helper installed?`));
    }
    pending.clear();
    port = null;
  });
}

function call(cmd, args = {}) {
  if (!port) connect();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ id, cmd, ...args });
  });
}

async function openNote(noteId, { newTab = true } = {}) {
  const url = `${NOTE_PAGE}?id=${encodeURIComponent(noteId)}`;
  const tabs = await browser.tabs.query({});
  const existing = tabs.find(
    (t) => t.url?.startsWith(NOTE_PAGE) && new URL(t.url).searchParams.get("id") === noteId
  );
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
    return existing;
  }
  if (!newTab) {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    return browser.tabs.update(active.id, { url });
  }
  return browser.tabs.create({ url });
}

async function openLibrary() {
  const url = browser.runtime.getURL("library.html");
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((t) => t.url?.startsWith(url));
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    return browser.windows.update(existing.windowId, { focused: true });
  }
  return browser.tabs.create({ url });
}

async function newNote(source) {
  const note = await call("create", { title: "Untitled", source });
  return openNote(note.id);
}

// --- Link previews: title, description, image and icon for a pasted link.

const previews = new Map();

function fetchPreview(url) {
  if (!previews.has(url)) {
    const loading = loadPreview(url);
    loading.catch(() => previews.delete(url));
    previews.set(url, loading);
  }
  return previews.get(url);
}

async function loadPreview(url) {
  const key = `preview:${url}`;
  const stored = (await browser.storage.local.get(key))[key];
  if (stored && Date.now() - stored.at < 7 * 86400e3) return stored;

  let preview;
  if (/^https?:\/\/((www|m)\.)?(youtube\.com|youtu\.be)\//.test(url)) {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    const data = await res.json();
    preview = { title: data.title, site: data.author_name ? `YouTube · ${data.author_name}` : "YouTube", image: data.thumbnail_url };
  } else {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal, credentials: "omit" });
    if (!(res.headers.get("content-type") || "").includes("html")) throw new Error("Not a web page");
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const meta = (...names) => {
      for (const name of names) {
        const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
        if (el?.content) return el.content.trim();
      }
      return "";
    };
    const abs = (href) => { try { return href ? new URL(href, res.url).href : ""; } catch { return ""; } };
    const icon = doc.querySelector('link[rel~="icon"]')?.getAttribute("href");
    preview = {
      title: meta("og:title", "twitter:title") || doc.title.trim() || new URL(url).hostname,
      description: meta("og:description", "twitter:description", "description").slice(0, 300),
      image: abs(meta("og:image", "twitter:image")),
      icon: abs(icon) || new URL("/favicon.ico", res.url).href,
      site: meta("og:site_name") || new URL(res.url).hostname.replace(/^www\./, ""),
    };
  }
  preview.at = Date.now();
  await browser.storage.local.set({ [key]: preview });
  return preview;
}

// --- Web sharing: a published note gets a read-only page on the share server
// (see share/ in the repo). The page is updated after every save and removed
// when the note is unpublished or deleted.

const SYNC_DELAY = 1500;
const MAX_UPLOAD = 4 * 1024 * 1024; // Vercel functions accept bodies up to 4.5 MB
let shareState = null; // {url, key, shared: {noteId: {id, files, pendingDelete?}}}
const syncTimers = new Map();
const syncErrors = new Map();
let shareQueue = Promise.resolve(); // one share request at a time keeps config.json writes ordered

function shareTask(fn) {
  const run = shareQueue.then(fn);
  shareQueue = run.catch(() => {});
  return run;
}

async function getShareState() {
  if (!shareState) {
    try {
      shareState = await call("shareInfo");
    } catch (err) {
      if (/Unknown command/.test(err.message)) {
        throw new Error("Update the Zen Notes helper to publish notes. In Terminal run: cd ~/Downloads/zen-notes/helper && ./install.sh");
      }
      throw err;
    }
    shareState.shared ||= {};
  }
  return shareState;
}

function newShareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function shareApi(path, init = {}) {
  const { url, key } = await getShareState();
  const res = await fetch(url + path, {
    ...init,
    credentials: "omit",
    headers: { authorization: `Bearer ${key}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const detail = await res.json().then((d) => d.error).catch(() => res.statusText);
    throw new Error(`Share server: ${detail || res.status}`);
  }
  return res.json();
}

async function saveEntry(noteId, entry) {
  await call("shareSet", { noteId, entry });
  const state = await getShareState();
  if (entry) state.shared[noteId] = entry;
  else delete state.shared[noteId];
}

function shareLink(state, entry) {
  return entry && !entry.pendingDelete ? `${state.url}/n/${entry.id}` : null;
}

async function readAttachmentBlob(noteId, src) {
  const parts = [];
  let offset = 0;
  let size = 0;
  let mime = "";
  do {
    const r = await call("readAttachment", { noteId, src, offset });
    ({ size, mime } = r);
    if (size > MAX_UPLOAD) return null;
    const bin = atob(r.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!bytes.length) break;
    parts.push(bytes);
    offset += bytes.length;
  } while (offset < size);
  return new Blob(parts, { type: mime });
}

async function publishNote(noteId) {
  const state = await getShareState();
  if (!state.url || !state.key) throw new Error("Web sharing isn't set up yet. Add the share server in the Zen Notes toolbar popup.");
  if (noteId.startsWith("path:")) throw new Error("Save the note once before publishing it.");
  const note = await call("read", { noteId });
  const old = state.shared[noteId];
  const entry = old && !old.pendingDelete ? { ...old, files: { ...old.files } } : { id: newShareId(), files: {} };

  // Upload images and videos the web copy doesn't have yet.
  const srcs = [...note.body.matchAll(/!\[[^\]]*\]\(<?([^)\s>]+)/g)].map((m) => m[1]);
  for (const raw of srcs) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // web images are linked as they are
    let src = raw;
    try { src = decodeURI(raw); } catch {}
    if (entry.files[src]) continue;
    try {
      const blob = await readAttachmentBlob(noteId, src);
      if (!blob) continue; // too large; the page shows a placeholder
      const name = src.split("/").pop();
      const { url } = await shareApi(`/api/upload?id=${entry.id}&name=${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "content-type": blob.type },
        body: blob,
      });
      entry.files[src] = url;
    } catch (err) {
      console.warn("Couldn't upload", src, err);
    }
  }

  await shareApi(`/api/notes?id=${entry.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: /^Untitled( \d+)?$/.test(note.title) ? "" : note.title, markdown: note.body, files: entry.files }),
  });
  entry.updatedAt = Date.now();
  await saveEntry(noteId, entry);
  syncErrors.delete(noteId);
  return shareLink(state, entry);
}

async function unpublishNote(noteId) {
  const state = await getShareState();
  const entry = state.shared[noteId];
  if (!entry) return;
  clearTimeout(syncTimers.get(noteId));
  try {
    await shareApi(`/api/notes?id=${entry.id}`, { method: "DELETE" });
    await saveEntry(noteId, null);
  } catch (err) {
    // Offline or server down: remember it and try again later, so the page
    // never stays up after the note is gone.
    await saveEntry(noteId, { ...entry, pendingDelete: true });
    throw err;
  }
}

function broadcastShare(noteId) {
  getShareState().then((state) => {
    browser.runtime.sendMessage({
      type: "share-status",
      noteId,
      url: shareLink(state, state.shared[noteId]),
      error: syncErrors.get(noteId) || null,
    }).catch(() => {});
  }).catch(() => {});
}

function scheduleSync(noteId) {
  clearTimeout(syncTimers.get(noteId));
  syncTimers.set(noteId, setTimeout(() => {
    syncTimers.delete(noteId);
    shareTask(async () => {
      const state = await getShareState();
      const entry = state.shared[noteId];
      if (!entry || entry.pendingDelete) return;
      try {
        await publishNote(noteId);
      } catch (err) {
        syncErrors.set(noteId, err.message);
      }
      broadcastShare(noteId);
    });
  }, SYNC_DELAY));
}

async function retryPendingDeletes() {
  const state = await getShareState();
  for (const [noteId, entry] of Object.entries(state.shared)) {
    if (entry.pendingDelete) await shareTask(() => unpublishNote(noteId)).catch(() => {});
  }
}

// Edits from Obsidian update the page too; notes deleted outside Zen are unpublished.
function onNotesChanged(msg) {
  if (!shareState) return;
  for (const note of msg.notes || []) {
    if (shareState.shared[note.id]) scheduleSync(note.id);
  }
  for (const noteId of msg.removed || []) {
    if (!shareState.shared[noteId]) continue;
    // A rename keeps the id; only unpublish if the note is really gone.
    call("read", { noteId }).catch((err) => {
      if (/not found/i.test(err.message)) shareTask(() => unpublishNote(noteId)).catch(() => {});
    });
  }
}

async function shareStatus(noteId) {
  const state = await getShareState();
  return {
    configured: Boolean(state.url && state.key),
    url: shareLink(state, state.shared[noteId]),
    error: syncErrors.get(noteId) || null,
  };
}

async function callWithShare(cmd, args) {
  if (cmd === "delete" && args?.noteId) {
    const state = await getShareState().catch(() => null);
    if (state?.shared[args.noteId]) await shareTask(() => unpublishNote(args.noteId)).catch(() => {});
  }
  if (cmd === "setShareServer") {
    shareState = null;
    return call("shareServer", args);
  }
  if (cmd === "setupShare") return setupShare(args.url, args.code);
  return call(cmd, args);
}

// Connects this Mac to a new share server: makes a random publish key, registers
// its hash with the server's one-time setup code, and keeps the key in the helper.
async function setupShare(url, code) {
  url = url.trim().replace(/\/+$/, "");
  const key = newShareId() + newShareId();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const keyHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await fetch(`${url}/api/claim`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, keyHash }),
  });
  if (!res.ok) {
    const detail = await res.json().then((d) => d.error).catch(() => res.statusText);
    throw new Error(detail || `Setup failed (${res.status})`);
  }
  shareState = null;
  await call("shareServer", { url, key });
  return true;
}

setTimeout(() => retryPendingDeletes().catch(() => {}), 5000);

browser.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "share-get":
      return shareStatus(msg.noteId);
    case "share-publish":
      return shareTask(() => publishNote(msg.noteId)).then((url) => ({ url }));
    case "share-unpublish":
      return shareTask(() => unpublishNote(msg.noteId)).then(() => true);
    case "share-sync":
      getShareState().then((s) => s.shared[msg.noteId] && scheduleSync(msg.noteId)).catch(() => {});
      return;
    case "preview":
      return fetchPreview(msg.url);
    case "call":
      return callWithShare(msg.cmd, msg.args);
    case "open":
      return openNote(msg.noteId, msg.options).then(() => true);
    case "new":
      return newNote(msg.source).then(() => true);
    case "library":
      return openLibrary().then(() => true);
  }
});

browser.commands.onCommand.addListener((command) => {
  if (command === "new-note") newNote();
  if (command === "open-library") openLibrary();
});

browser.menus.create({
  id: "new-note-from-page",
  title: "New note about this page",
  contexts: ["page", "tab"],
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "new-note-from-page") newNote(tab?.url || info.pageUrl);
});

// Content scripts only load into tabs opened after the extension starts, so
// after an install or reload ⌘/ would do nothing in tabs that were already open.
browser.tabs.query({}).then((tabs) => {
  for (const tab of tabs) {
    if (!/^(https?|file):/.test(tab.url || "")) continue;
    browser.tabs.executeScript(tab.id, { file: "shortcut.js" }).catch(() => {});
  }
});
