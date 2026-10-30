// ==UserScript==
// @name           Zen Notes Library section
// @description    Adds a "Notes" section to Zen's Library listing your Zen Notes.
// @version        1.0.0
// ==/UserScript==

// Loaded by fx-autoconfig (or Sine) into Zen's browser window. It reads the
// notes folder directly, the same folder the Zen Notes helper uses, and opens
// notes in the Zen Notes extension.

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibrarySearchSection } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";

const EXTENSION_ID = "zen-notes@rudrachavda";
const HOME = Services.dirsvc.get("Home", Ci.nsIFile).path;
const CONFIG = PathUtils.join(HOME, "Library", "Application Support", "ZenNotes", "config.json");
const DEFAULT_FOLDER = PathUtils.join(HOME, "Zen Notes");
const REFRESH_MS = 2000;
const PREVIEW_CHARS = 140;

// --- Reading notes ------------------------------------------------------------

async function notesFolder() {
  try {
    const { folder } = JSON.parse(await IOUtils.readUTF8(CONFIG));
    if (folder) return folder.replace(/^~(?=\/|$)/, HOME);
  } catch {}
  return DEFAULT_FOLDER;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function preview(body) {
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+|>\s?)/gm, "")
    .replace(/[*_`~]/g, "")
    .split(/\s+/)
    .join(" ")
    .trim()
    .slice(0, PREVIEW_CHARS);
}

// Same ids as the helper: the zen-id in the frontmatter, or "path:<relative path>".
async function readNote(root, path) {
  const { lastModified } = await IOUtils.stat(path);
  const text = await IOUtils.readUTF8(path);
  const match = text.match(FRONTMATTER_RE);
  const zenId = match?.[1].match(/^zen-id:\s*(\S+)/m)?.[1];
  const rel = path.slice(root.length + 1);
  const name = PathUtils.filename(path).replace(/\.md$/i, "");
  return {
    id: zenId || `path:${rel}`,
    path,
    title: name,
    folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
    mtime: lastModified,
    preview: preview(match ? text.slice(match[0].length) : text),
  };
}

async function listNotes() {
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
  return { root, notes: notes.sort((a, b) => b.mtime - a.mtime) };
}

const isPlaceholder = (title) => /^Untitled( \d+)?$/.test(title);

function ago(ms) {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// --- Opening, creating and deleting -------------------------------------------

function extensionUrl(path) {
  return WebExtensionPolicy.getByID(EXTENSION_ID)?.getURL(path) ?? null;
}

function openInTab(url) {
  const existing = gBrowser.tabs.find((tab) => tab.linkedBrowser.currentURI?.spec === url);
  gBrowser.selectedTab = existing ?? gBrowser.addTrustedTab(url, { inBackground: false });
}

function closeLibrary() {
  customElements.get("zen-library")?.close?.();
}

function openNote(note) {
  const url = extensionUrl(`note.html?id=${encodeURIComponent(note.id)}`);
  if (!url) return false;
  openInTab(url);
  closeLibrary();
  return true;
}

async function newNote() {
  const root = await notesFolder();
  await IOUtils.makeDirectory(root, { ignoreExisting: true });
  let path = PathUtils.join(root, "Untitled.md");
  for (let n = 2; await IOUtils.exists(path); n++) path = PathUtils.join(root, `Untitled ${n}.md`);
  const id = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
  const created = new Date().toISOString().slice(0, 19);
  await IOUtils.writeUTF8(path, `---\nzen-id: ${id}\ncreated: ${created}\n---\n`);
  openNote({ id });
}

// Moves the file to the macOS Trash, like the delete button in a note.
async function trashNote(note) {
  const trash = PathUtils.join(HOME, ".Trash");
  let dest = PathUtils.join(trash, PathUtils.filename(note.path));
  for (let n = 2; await IOUtils.exists(dest); n++) {
    dest = PathUtils.join(trash, PathUtils.filename(note.path).replace(/\.md$/i, ` ${n}.md`));
  }
  await IOUtils.move(note.path, dest);
}

// --- The section --------------------------------------------------------------

class ZenNotesLibrarySection extends ZenLibrarySearchSection {
  static id = "notes";
  static label = "zen-notes-library-title"; // not a real Fluent id; the label is set below

  static render(library) {
    return html`
      <zen-notes-library-section
        class="zen-library-section"
        data-section="notes"
        .library=${library}
      ></zen-notes-library-section>
    `;
  }

  #notes = [];
  #error = "";
  #timer = null;
  #loading = null;

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this.#timer);
  }

  onShown() {
    super.onShown?.();
    this.refresh();
    clearInterval(this.#timer);
    this.#timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  onHidden() {
    clearInterval(this.#timer);
  }

  // Zen picks a text colour per space from how bright its background is (white on
  // dark spaces, dark on light ones). Use the same colour for the note icons.
  async #applyIconColor() {
    try {
      const ws = await (window.gZenWorkspaces?.getActiveWorkspace?.() ??
        window.gZenWorkspaces?.getActiveWorkspaceFromCache?.());
      const theme = ws && window.gZenThemePicker?.getGradientForWorkspace(ws);
      const color = theme?.toolbarColor && `rgba(${theme.toolbarColor.join(",")})`;
      if (color) this.style.setProperty("--zen-notes-icon-color", color);
      else this.style.removeProperty("--zen-notes-icon-color");
    } catch (e) {
      this.style.removeProperty("--zen-notes-icon-color");
    }
  }

  onSearchChanged() {
    this.requestUpdate();
  }

  updated(changed) {
    super.updated?.(changed);
    const input = this.querySelector(".zen-library-search-box input");
    if (input && !input.placeholder) input.placeholder = "Search notes";
  }

  async refresh() {
    this.#applyIconColor();
    if (this.#loading) return this.#loading;
    this.#loading = listNotes()
      .then(({ notes }) => {
        const key = (list) => list.map((n) => `${n.id}|${n.mtime}`).join();
        const changed = key(notes) !== key(this.#notes) || this.#error;
        this.#notes = notes;
        this.#error = "";
        if (changed) this.requestUpdate();
      })
      .catch((err) => {
        this.#error = String(err.message || err);
        this.requestUpdate();
      })
      .finally(() => (this.#loading = null));
    return this.#loading;
  }

  #open(note) {
    if (!openNote(note)) {
      this.#error = "Zen Notes isn't installed or is turned off, so notes can't open.";
      this.requestUpdate();
    }
  }

  async #delete(note) {
    const title = isPlaceholder(note.title) ? "this note" : `“${note.title}”`;
    if (!Services.prompt.confirm(window, "Delete note", `Move ${title} to the Trash?`)) return;
    await trashNote(note).catch((err) => (this.#error = String(err.message || err)));
    this.refresh();
  }

  #renderNote(note) {
    const subtitle = note.preview || [note.folder, ago(note.mtime)].filter(Boolean).join(" · ");
    return html`
      <div
        class="zen-library-row zen-notes-row"
        title=${`${note.title}\n${[note.folder, ago(note.mtime)].filter(Boolean).join(" · ")}`}
        @click=${() => this.#open(note)}
      >
        <div class="zen-notes-row-icon"></div>
        <div class="zen-library-row-text">
          <span class="zen-library-row-title" ?placeholder=${isPlaceholder(note.title)}>
            ${isPlaceholder(note.title) ? "Untitled" : note.title}
          </span>
          <span class="zen-library-row-subtitle">${subtitle}</span>
        </div>
        <div class="zen-library-row-actions">
          <toolbarbutton
            class="toolbarbutton-1"
            tooltiptext="Move to Trash"
            @click=${(event) => {
              event.stopPropagation();
              this.#delete(note);
            }}
          >
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/trash.svg" alt="" />
          </toolbarbutton>
        </div>
      </div>
    `;
  }

  renderItems() {
    if (this.#error) {
      return html`<div class="zen-library-empty">${this.#error}</div>`;
    }
    const query = this.searchQuery.toLowerCase();
    const notes = this.#notes.filter(
      (n) => !query || `${n.title} ${n.folder} ${n.preview}`.toLowerCase().includes(query)
    );
    if (!notes.length) {
      return html`<div class="zen-library-empty">
        ${query ? `No notes match “${this.searchQuery}”.` : "No notes yet. Press ⌘/ on any page to write one."}
      </div>`;
    }
    return html`<div class="zen-library-group">${repeat(notes, (n) => n.id, (n) => this.#renderNote(n))}</div>`;
  }

  // Sits next to the search box, where other sections put their Filter button.
  renderTopButton() {
    return html`
      <button
        class="zen-library-filter-button zen-notes-new"
        title="New note"
        aria-label="New note"
        @click=${() => newNote()}
      >
        <img src="chrome://browser/skin/zen-icons/plus.svg" alt="" />
      </button>
    `;
  }

  // No filter panel to go with the button.
  renderPanel() {
    return "";
  }
}

customElements.define("zen-notes-library-section", ZenNotesLibrarySection);

// --- Adding the section to the Library -----------------------------------------

const STYLE = `
[data-section="notes"] :is(.zen-library-tab-icon-image, .empty-state-icon-image) {
  background-image: url("__SPRITE__");
}
.zen-notes-row-icon {
  flex: none;
  width: 20px;
  height: 20px;
  margin-inline: 0 2px;
  /* Light or dark to suit the space's background, not the system theme. */
  background-color: var(--zen-notes-icon-color, currentColor);
  mask: url("__NOTE_ICON__") center / contain no-repeat;
  opacity: 0.85;
}
.zen-notes-row .zen-library-row-title[placeholder] { opacity: 0.5; }
.zen-notes-new { width: 36px; padding: 0; justify-content: center; }
.zen-notes-row .zen-library-row-subtitle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

// Icons are installed to <profile>/chrome/resources/zen-notes/ by install.sh and
// loaded through chrome:// because Firefox only applies context-fill/stroke
// (the accent colours) to chrome:// and resource:// images.
const ICON_DIR = PathUtils.join(Services.dirsvc.get("UChrm", Ci.nsIFile).path, "resources", "zen-notes");
// Single note icon for the rows, used as a mask so it takes any colour.
const NOTE_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-2.256 0 20.9372 20.9372'%3E%3Cpath d='M0 17.8696C0 19.916 1.00683 20.9332 3.02218 20.9332L13.3924 20.9332C15.4099 20.9332 16.4249 19.916 16.4249 17.8696L16.4249 3.06359C16.4249 1.02753 15.4099 0 13.3924 0L3.02218 0C1.00683 0 0 1.02753 0 3.06359ZM1.57069 17.8447L1.57069 3.08851C1.57069 2.11324 2.09254 1.57069 3.10921 1.57069L13.3157 1.57069C14.322 1.57069 14.846 2.11324 14.846 3.08851L14.846 17.8447C14.846 18.8199 14.322 19.3625 13.3157 19.3625L3.10921 19.3625C2.09254 19.3625 1.57069 18.8199 1.57069 17.8447Z'/%3E%3Cpath d='M4.5165 5.65306L11.9188 5.65306C12.265 5.65306 12.5199 5.38565 12.5199 5.04156C12.5199 4.70994 12.265 4.45288 11.9188 4.45288L4.5165 4.45288C4.16206 4.45288 3.905 4.70994 3.905 5.04156C3.905 5.38565 4.16206 5.65306 4.5165 5.65306Z'/%3E%3Cpath d='M4.5165 9.06545L11.9188 9.06545C12.265 9.06545 12.5199 8.78769 12.5199 8.44571C12.5199 8.12233 12.265 7.85492 11.9188 7.85492L4.5165 7.85492C4.16206 7.85492 3.905 8.12233 3.905 8.44571C3.905 8.78769 4.16206 9.06545 4.5165 9.06545Z'/%3E%3Cpath d='M4.5165 12.4675L8.02193 12.4675C8.36813 12.4675 8.62519 12.2104 8.62519 11.8788C8.62519 11.5347 8.36813 11.2673 8.02193 11.2673L4.5165 11.2673C4.16206 11.2673 3.905 11.5347 3.905 11.8788C3.905 12.2104 4.16206 12.4675 4.5165 12.4675Z'/%3E%3C/svg%3E";

let sprite = "chrome://userchrome/content/zen-notes/note-plain-sprite.svg";
// Arc's animated Notes icon (36 frames, like Zen's own Library icons), if installed.
const spriteReady = IOUtils.exists(PathUtils.join(ICON_DIR, "notes-sprite.svg")).then(
  (found) => found && (sprite = "chrome://userchrome/content/zen-notes/notes-sprite.svg"),
  () => {}
);

function setLabel(library) {
  const label = library.renderRoot?.querySelector('.zen-library-tab[data-section="notes"] label');
  if (label && label.textContent !== "Notes") label.textContent = "Notes";
}

function addSection(library) {
  if (!library.zenLibrarySections || library.zenLibrarySections.notes) return;
  // The rail follows the object's key order: put Notes just above Boosts.
  const sections = {};
  for (const [id, Section] of Object.entries(library.zenLibrarySections)) {
    if (id === "boosts") sections.notes = ZenNotesLibrarySection;
    sections[id] = Section;
  }
  sections.notes ??= ZenNotesLibrarySection;
  library.zenLibrarySections = sections;
  library.requestUpdate();
  Promise.all([library.updateComplete, spriteReady]).then(() => {
    const root = library.renderRoot;
    if (root && !root.querySelector("style[data-zen-notes]")) {
      const style = document.createElement("style");
      style.dataset.zenNotes = "";
      style.textContent = STYLE.replaceAll("__SPRITE__", sprite).replaceAll("__NOTE_ICON__", NOTE_ICON);
      root.append(style);
    }
    setLabel(library);
    // Lit re-renders the rail on every change; keep the label filled in.
    new MutationObserver(() => setLabel(library)).observe(root, { childList: true, subtree: true });
  });
}

function watchForLibrary() {
  const found = document.querySelector("zen-library");
  if (found) {
    addSection(found);
    return;
  }
  const observer = new MutationObserver(() => {
    const library = document.querySelector("zen-library");
    if (library) {
      observer.disconnect();
      customElements.whenDefined("zen-library").then(() => addSection(library));
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

customElements.whenDefined("zen-library").then(watchForLibrary);

// --- Note tabs in the sidebar ---------------------------------------------------

// A web page can't know the colour of the space it sits in, so the note page's own
// favicon follows the system theme and can vanish on a dark space. Swap it for a
// chrome:// icon drawn in the tab's text colour, which Zen sets per space.
function styleNoteTabIcons() {
  const host = WebExtensionPolicy.getByID(EXTENSION_ID)?.mozExtensionHostname;
  if (!host) return false;
  const css = `
    .tabbrowser-tab[zen-note] .tab-icon-image,
    .tab-icon-image[src^="moz-extension://${host}/icons/note"] {
      content: url("chrome://userchrome/content/zen-notes/note-icon.svg") !important;
      -moz-context-properties: fill, fill-opacity;
      fill: currentColor !important;
      fill-opacity: 0.85;
    }`;
  windowUtils.loadSheetUsingURIString("data:text/css," + encodeURIComponent(css), windowUtils.AUTHOR_SHEET);
  return true;
}

// Mark note tabs too, in case Zen hands the tab a cached copy of the favicon.
function markNoteTab(tab) {
  const host = WebExtensionPolicy.getByID(EXTENSION_ID)?.mozExtensionHostname;
  const uri = tab.linkedBrowser?.currentURI;
  const isNote = !!host && uri?.scheme === "moz-extension" && uri.host === host && uri.filePath === "/note.html";
  if (tab.hasAttribute("zen-note") !== isNote) tab.toggleAttribute("zen-note", isNote);
}
function watchNoteTabs() {
  for (const event of ["TabAttrModified", "TabOpen"]) {
    gBrowser.tabContainer.addEventListener(event, (e) => markNoteTab(e.target));
  }
  gBrowser.addTabsProgressListener({
    onLocationChange(browser) {
      const tab = gBrowser.getTabForBrowser(browser);
      if (tab) markNoteTab(tab);
    },
  });

  if (!styleNoteTabIcons()) {
    // The extension may start after this window; try again once it's up.
    try {
      const { Management } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
      const onReady = (_, ext) => {
        if (ext?.id === EXTENSION_ID && styleNoteTabIcons()) {
          Management.off("ready", onReady);
          for (const tab of gBrowser.tabs) markNoteTab(tab);
        }
      };
      Management.on("ready", onReady);
    } catch (e) {
      console.error("Zen Notes: couldn't watch for the extension", e);
    }
  }
  for (const tab of gBrowser.tabs) markNoteTab(tab);
}

if (gBrowserInit.delayedStartupFinished) {
  watchNoteTabs();
} else {
  const observer = (subject) => {
    if (subject !== window) return;
    Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
    watchNoteTabs();
  };
  Services.obs.addObserver(observer, "browser-delayed-startup-finished");
}
