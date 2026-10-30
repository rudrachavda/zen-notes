// ==UserScript==
// @name           Zen Notes in ⌘T
// @description    Finds your Zen Notes from the URL bar as you type.
// @version        1.0.0
// ==/UserScript==

// Loaded once by fx-autoconfig (a .sys.mjs in chrome/JS is a background module).
// Adds a URL bar provider that matches what you type against note titles and
// text in the notes folder, and opens the picked note in the Zen Notes extension.

import { ProvidersManager } from "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs";
import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
});

const PROVIDER_NAME = "ZenNotesUrlbarProvider";
const DYNAMIC_TYPE_NAME = "zen-notes";
const EXTENSION_ID = "zen-notes@rudrachavda";
const ICON = "chrome://userchrome/content/zen-notes/note-icon.svg";
const ENABLED_PREF = "zen.urlbar.notes.enabled";
const HOME = Services.dirsvc.get("Home", Ci.nsIFile).path;
const CONFIG = PathUtils.join(HOME, "Library", "Application Support", "ZenNotes", "config.json");
const DEFAULT_FOLDER = PathUtils.join(HOME, "Zen Notes");
const MIN_CHARS = 2;
const MAX_RESULTS = 3;
const SNIPPET_CHARS = 80;
// Reuse a scan for this long so typing doesn't re-read the folder on every key.
const CACHE_MS = 3000;

// --- Reading notes (same ids as the helper and the Library section) ------------

async function notesFolder() {
  try {
    const { folder } = JSON.parse(await IOUtils.readUTF8(CONFIG));
    if (folder) return folder.replace(/^~(?=\/|$)/, HOME);
  } catch {}
  return DEFAULT_FOLDER;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function plainText(body) {
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+|>\s?)/gm, "")
    .replace(/[*_`~]/g, "")
    .split(/\s+/)
    .join(" ")
    .trim();
}

async function readNote(root, path) {
  const { lastModified } = await IOUtils.stat(path);
  const text = await IOUtils.readUTF8(path);
  const match = text.match(FRONTMATTER_RE);
  const zenId = match?.[1].match(/^zen-id:\s*(\S+)/m)?.[1];
  const rel = path.slice(root.length + 1);
  return {
    id: zenId || `path:${rel}`,
    title: PathUtils.filename(path).replace(/\.md$/i, ""),
    folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
    mtime: lastModified,
    text: plainText(match ? text.slice(match[0].length) : text),
  };
}

let cache = { at: 0, notes: [] };

async function listNotes() {
  if (Date.now() - cache.at < CACHE_MS) return cache.notes;
  const root = await notesFolder();
  const notes = [];
  async function walk(dir, depth) {
    let children = [];
    try {
      children = await IOUtils.getChildren(dir);
    } catch {
      return;
    }
    for (const child of children) {
      const name = PathUtils.filename(child);
      if (name.startsWith(".") || name === "attachments") continue;
      if (name.toLowerCase().endsWith(".md")) {
        try {
          notes.push(await readNote(root, child));
        } catch {}
      } else if (depth < 4) {
        const { type } = await IOUtils.stat(child).catch(() => ({}));
        if (type === "directory") await walk(child, depth + 1);
      }
    }
  }
  await walk(root, 0);
  cache = { at: Date.now(), notes };
  return notes;
}

// Every word must appear in the title or text. Title hits rank first, then the
// most recently edited.
function search(notes, tokens) {
  const matches = [];
  for (const note of notes) {
    const title = note.title.toLowerCase();
    const text = note.text.toLowerCase();
    if (!tokens.every((t) => title.includes(t) || text.includes(t))) continue;
    const inTitle = tokens.every((t) => title.includes(t));
    const at = inTitle ? -1 : text.indexOf(tokens.find((t) => !title.includes(t)));
    matches.push({ note, inTitle, at });
  }
  matches.sort((a, b) => b.inTitle - a.inTitle || b.note.mtime - a.note.mtime);
  return matches.slice(0, MAX_RESULTS);
}

function snippet({ note, at }) {
  if (at < 0) return note.folder;
  const start = Math.max(0, at - 20);
  const text = note.text.slice(start, start + SNIPPET_CHARS);
  return `${start ? "…" : ""}${text}${start + SNIPPET_CHARS < note.text.length ? "…" : ""}`;
}

// --- Provider -------------------------------------------------------------------

class ZenNotesUrlbarProvider extends UrlbarProvider {
  get name() {
    return PROVIDER_NAME;
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  async isActive(queryContext) {
    return (
      queryContext.sapName == "urlbar" &&
      !queryContext.searchMode &&
      queryContext.trimmedSearchString.length >= MIN_CHARS &&
      !!WebExtensionPolicy.getByID(EXTENSION_ID) &&
      Services.prefs.getBoolPref(ENABLED_PREF, true)
    );
  }

  async startQuery(queryContext, addCallback) {
    const instance = this.queryInstance;
    const notes = await listNotes();
    if (instance != this.queryInstance) return;
    const tokens = queryContext.trimmedSearchString.toLowerCase().split(/\s+/);
    search(notes, tokens).forEach((match, i) => {
      addCallback(
        this,
        new lazy.UrlbarResult({
          type: UrlbarShared.RESULT_TYPE.DYNAMIC,
          source: UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
          // Right under the top result, ahead of history.
          suggestedIndex: 1 + i,
          payload: {
            dynamicType: DYNAMIC_TYPE_NAME,
            zenNoteId: match.note.id,
            title: match.note.title,
            detail: snippet(match),
          },
        })
      );
    });
  }

  getViewUpdate(result) {
    return {
      icon: { attributes: { src: ICON } },
      title: { textContent: result.payload.title, attributes: { dir: "auto" } },
      detail: {
        textContent: result.payload.detail,
        attributes: { dir: "auto", hidden: !result.payload.detail },
      },
      action: { textContent: "Open Note" },
    };
  }

  getViewTemplate() {
    return {
      attributes: {
        selectable: true,
      },
      children: [
        {
          name: "icon",
          tag: "img",
          classList: ["urlbarView-favicon"],
          attributes: { style: "-moz-context-properties: fill; fill: currentColor;" },
        },
        {
          name: "title",
          tag: "span",
          classList: ["urlbarView-title"],
        },
        {
          name: "detail",
          tag: "span",
          classList: ["urlbarView-prettyName"],
        },
        {
          name: "action",
          tag: "span",
          classList: ["urlbarView-action"],
        },
      ],
    };
  }

  onEngagement(queryContext, controller, details) {
    const id = details.result?.payload.zenNoteId;
    const url = WebExtensionPolicy.getByID(EXTENSION_ID)?.getURL(
      `note.html?id=${encodeURIComponent(id)}`
    );
    const win =
      details.element?.documentGlobal ??
      details.element?.ownerGlobal ??
      lazy.BrowserWindowTracker.getTopWindow();
    if (!id || !url || !win) return;
    const { gBrowser } = win;
    const existing = gBrowser.tabs.find((tab) => tab.linkedBrowser.currentURI?.spec === url);
    gBrowser.selectedTab =
      existing ??
      gBrowser.addTrustedTab(url, {
        inBackground: false,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
  }
}

// --- Registration ---------------------------------------------------------------

function register() {
  const instance = ProvidersManager.getInstanceForSap("urlbar");
  if (!instance.getProvider(PROVIDER_NAME)) {
    instance.registerProvider(new ZenNotesUrlbarProvider());
  }
}

const onWindow = () => {
  Services.obs.removeObserver(onWindow, "browser-delayed-startup-finished");
  try {
    register();
  } catch (e) {
    console.error("Zen Notes in ⌘T: couldn't register", e);
  }
};
if (lazy.BrowserWindowTracker.getTopWindow()?.gBrowserInit?.delayedStartupFinished) {
  register();
} else {
  Services.obs.addObserver(onWindow, "browser-delayed-startup-finished");
}
