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

browser.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "preview":
      return fetchPreview(msg.url);
    case "call":
      return call(msg.cmd, msg.args);
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
