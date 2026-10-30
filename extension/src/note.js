import "@fontsource/nunito/400.css";
import "@fontsource/nunito/500.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/800.css";
import "./note.css";

import { Editor, Extension } from "@tiptap/core";
import { NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import { GapCursor } from "@tiptap/pm/gapcursor";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Node } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
import { ICONS } from "./icons.js";

const SAVE_DELAY = 500;

const $ = (sel) => document.querySelector(sel);
const titleEl = $("#title");
const toolbar = $("#toolbar");
const flyout = toolbar.querySelector(".flyout");
const statusEl = $("#status");
const banner = $("#banner");

const call = (cmd, args) => browser.runtime.sendMessage({ type: "call", cmd, args });

let noteId = new URLSearchParams(location.search).get("id");
let notePath = "";
let dirty = false;
let saveTimer = null;
let saving = Promise.resolve();
let deleting = false;
let fileTitle = ""; // the note's current file name, without .md

for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = ICONS[el.dataset.icon];

// --- Media: images, videos and YouTube embeds share markdown's image syntax
// (![](attachments/clip.mp4), ![](https://youtu.be/…)), which Obsidian embeds too.
// Local files live next to the note, so the page asks the helper for them.

const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
const isVideoFile = (file) => file.type.startsWith("video/") || VIDEO_EXT.test(file.name);
const isMediaFile = (file) => file.type.startsWith("image/") || isVideoFile(file);

function youtubeId(src) {
  const m = src.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m && m[1];
}
const isEmbedUrl = (src) => !!youtubeId(src) || /^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg|avif|mp4|m4v|mov|webm)(\?\S*)?$/i.test(src);

const mediaCache = new Map();

// The helper sends at most 1 MB per message, so files come in chunks.
async function readLocalFile(src) {
  const parts = [];
  let offset = 0;
  let mime = "";
  for (;;) {
    const r = await call("readAttachment", { noteId, src: decodeURI(src), offset });
    if (r.dataUrl) return r.dataUrl; // older helper
    mime = r.mime;
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    parts.push(bytes);
    offset += bytes.length;
    if (!bytes.length || offset >= r.size) break;
  }
  // Firefox plays H.264 .mov files when they're labelled as mp4.
  if (mime === "video/quicktime") mime = "video/mp4";
  return URL.createObjectURL(new Blob(parts, { type: mime }));
}

function resolveMedia(src) {
  if (/^(https?:|data:|blob:)/.test(src)) return Promise.resolve(src);
  if (!mediaCache.has(src)) {
    const loading = readLocalFile(src);
    loading.catch(() => mediaCache.delete(src)); // retry next time instead of caching the failure
    mediaCache.set(src, loading);
  }
  return mediaCache.get(src);
}

function youtubeView(id, src) {
  const box = document.createElement("div");
  box.className = "embed youtube";
  const thumb = document.createElement("button");
  thumb.className = "embed-thumb";
  thumb.style.backgroundImage = `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)`;
  thumb.innerHTML = `<span class="play">${ICONS.play}</span>`;
  thumb.title = "Play video";
  const caption = document.createElement("a");
  caption.className = "embed-caption";
  caption.href = src;
  caption.target = "_blank";
  caption.textContent = "YouTube";
  browser.runtime.sendMessage({ type: "preview", url: src }).then((p) => p?.title && (caption.textContent = p.title)).catch(() => {});
  thumb.addEventListener("click", (e) => {
    e.preventDefault();
    const frame = document.createElement("iframe");
    frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    thumb.replaceWith(frame);
  });
  box.append(thumb, caption);
  return box;
}

const Media = Image.extend({
  draggable: false, // moved with the same drag as text blocks (see "Mover")
  addStorage() {
    return {
      markdown: {
        // Images are blocks here, so end the line after them. Otherwise the next
        // paragraph is glued on and the image breaks when the note is reopened.
        serialize(state, node) {
          const alt = state.esc(node.attrs.alt || "");
          const src = (node.attrs.src || "").replace(/[()\s]/g, (c) => encodeURIComponent(c));
          state.write(`![${alt}](${src})`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
  addNodeView() {
    return ({ node }) => {
      const src = node.attrs.src || "";
      const ytId = youtubeId(src);
      if (ytId) return { dom: youtubeView(ytId, src), stopEvent: (e) => !e.type.startsWith("drag") && e.type !== "mousedown" };

      const video = VIDEO_EXT.test(src.split("?")[0]);
      const el = document.createElement(video ? "video" : "img");
      if (video) {
        el.controls = true;
        el.preload = "metadata";
        el.className = "video";
      } else {
        el.alt = node.attrs.alt || "";
        el.draggable = false;
      }
      el.classList.add("loading");
      resolveMedia(src)
        .then((url) => {
          el.src = url;
          el.classList.remove("loading");
        })
        .catch((err) => {
          el.classList.replace("loading", "missing");
          el.title = err.message;
        });
      // Let the video controls work without ProseMirror grabbing the clicks.
      return { dom: el, stopEvent: video ? (e) => !e.type.startsWith("drag") : undefined };
    };
  },
});

// --- Link previews: a link on its own line shows as a card. In the markdown it
// stays a plain link on its own line (<https://…>), so Obsidian still reads it.

const bareLink = (href) => /^https?:\/\//.test(href) && !isEmbedUrl(href);

function linkCard(href) {
  const card = document.createElement("a");
  card.className = "link-card loading";
  card.href = href;
  card.target = "_blank";
    const text = document.createElement("span");
  text.className = "link-card-text";
  const title = document.createElement("strong");
  title.textContent = new URL(href).hostname.replace(/^www\./, "");
  const desc = document.createElement("span");
  desc.className = "link-card-desc";
  const site = document.createElement("span");
  site.className = "link-card-site";
  text.append(title, desc, site);
  card.append(text);
  browser.runtime
    .sendMessage({ type: "preview", url: href })
    .then((p) => {
      if (!p) throw new Error("no preview");
      card.classList.remove("loading");
      title.textContent = p.title || title.textContent;
      desc.textContent = p.description || "";
      if (p.icon) {
        const icon = document.createElement("img");
        icon.src = p.icon;
        icon.onerror = () => icon.remove();
        site.append(icon);
      }
      site.append(p.site || "");
      if (p.image) {
        const img = document.createElement("img");
        img.className = "link-card-image";
        img.src = p.image;
        img.onerror = () => img.remove();
        card.append(img);
      }
    })
    .catch(() => card.remove());
  return card;
}

const Bookmark = Node.create({
  name: "bookmark",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { href: { default: "" } };
  },
  parseHTML() {
    return [
      { tag: "div[data-bookmark]", getAttrs: (el) => ({ href: el.getAttribute("data-bookmark") }) },
      {
        // A paragraph holding nothing but one link.
        tag: "p",
        priority: 60,
        getAttrs: (el) => {
          const a = el.children.length === 1 && el.firstElementChild.tagName === "A" ? el.firstElementChild : null;
          const href = a?.getAttribute("href") || "";
          return a && el.textContent.trim() === a.textContent.trim() && bareLink(href) ? { href } : false;
        },
      },
    ];
  },
  renderHTML({ node }) {
    return ["div", { "data-bookmark": node.attrs.href }];
  },
  addNodeView() {
    return ({ node }) => {
      const card = linkCard(node.attrs.href);
      return { dom: card };
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`<${node.attrs.href}>`);
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Saves the files next to the note and inserts them at `pos` (the drop spot),
// or after the current block. Never replaces a selected image.
async function insertMediaFiles(files, pos = null) {
  const nodes = [];
  for (const file of files) {
    const { src } = await call("saveAttachment", { noteId, name: file.name, mime: file.type, data: await readBase64(file) });
    const encoded = encodeURI(src);
    mediaCache.set(encoded, Promise.resolve(URL.createObjectURL(file)));
    nodes.push({ type: "image", attrs: { src: encoded, alt: "" } });
  }
  insertMediaNodes(nodes, pos);
}

function insertMediaNodes(nodes, pos = null) {
  const dropped = pos != null; // only drops re-centre the page
  const { state } = editor;
  if (pos == null) {
    const { selection } = state;
    if (selection.node) pos = selection.to; // a selected image: go after it
    else if (selection.$from.parent.textContent === "" && selection.$from.depth === 1) {
      // On an empty line: replace the line instead of leaving it behind.
      pos = { from: selection.$from.before(), to: selection.$from.after() };
    }
    else pos = selection.$from.depth ? selection.$from.after(1) : selection.from;
  }
  if (dropped) {
    editor.chain().insertContentAt(pos, nodes).run();
    editor.view.dom.focus({ preventScroll: true });
    centerBlock(pos);
  } else {
    editor.chain().focus().insertContentAt(pos, nodes).run();
  }
}

// --- Editor

const editor = new Editor({
  element: $("#editor"),
  extensions: [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, dropcursor: false }),
    Underline,
    Link.configure({ openOnClick: false, autolink: true }),
    Media,
    Bookmark,
    // Write checklists without blank lines between items, like the other lists.
    TaskList.extend({
      addAttributes() {
        return { ...this.parent?.(), tight: { default: true, rendered: false } };
      },
    }),
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: "Start writing…" }),
    Markdown.configure({ html: true, tightLists: true, linkify: true, transformPastedText: true }),
  ],
  editorProps: {
    handlePaste(_view, event) {
      const files = [...(event.clipboardData?.files || [])].filter(isMediaFile);
      if (files.length) {
        insertMediaFiles(files).catch(showError);
        return true;
      }
      // A pasted YouTube link or media URL on its own becomes an embed.
      const text = event.clipboardData?.getData("text/plain").trim() || "";
      if (/^\S+$/.test(text) && isEmbedUrl(text)) {
        insertMediaNodes([{ type: "image", attrs: { src: text, alt: "" } }]);
        return true;
      }
      // A link pasted on an empty line becomes just the preview card.
      const { $from, empty } = editor.state.selection;
      if (/^\S+$/.test(text) && bareLink(text) && empty && $from.parent.type.name === "paragraph" && !$from.parent.textContent) {
        insertMediaNodes([{ type: "bookmark", attrs: { href: text } }]);
        return true;
      }
      return false;
    },
    handleDrop(view, event, _slice, moved) {
      if (moved) return false; // moving a block inside the note
      const files = [...(event.dataTransfer?.files || [])].filter(isMediaFile);
      if (!files.length) return false;
      event.preventDefault();
      const pos = gapPos(gapAt(event.clientY).index);
      hideFileDrop();
      insertMediaFiles(files, pos).catch(showError);
      return true;
    },
    handleClickOn(_view, _pos, node, _nodePos, event) {
      const href = event.target.closest?.("a")?.href;
      if (href && (event.metaKey || event.ctrlKey)) {
        window.open(href, "_blank");
        return true;
      }
      return false;
    },
  },
  onUpdate: scheduleSave,
  onSelectionUpdate: positionToolbar,
  onFocus: positionToolbar,
  onBlur: ({ event }) => {
    const to = event?.relatedTarget;
    if (toolbar.contains(to) || gutter.contains(to)) return;
    hideToolbar();
    positionToolbar();
  },
});

// --- Title

// The title is a plain-text contenteditable heading rather than a textarea, so
// it grows with its text and nothing below it moves while typing.
const getTitle = () => titleEl.textContent.replace(/\s+/g, " ").trim();

// New notes are saved as "Untitled.md", "Untitled 2.md", ... Those names stay
// a grey placeholder in the page instead of becoming a real title.
const isPlaceholderTitle = (title) => /^Untitled( \d+)?$/.test(title);

function setTitle(title) {
  titleEl.textContent = isPlaceholderTitle(title) ? "" : title;
  syncTitle();
}

function syncTitle() {
  // Clear stray <br>s Firefox leaves behind so the :empty placeholder shows.
  if (!getTitle() && titleEl.childNodes.length) titleEl.replaceChildren();
  document.title = getTitle() || "Untitled";
}

function caretAtEnd() {
  const sel = getSelection();
  if (!sel.rangeCount) return false;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(titleEl);
  range.setStart(sel.focusNode, sel.focusOffset);
  return !range.toString().trim();
}

titleEl.addEventListener("input", () => {
  syncTitle();
  scheduleSave();
});

titleEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || (e.key === "ArrowDown" && caretAtEnd())) {
    e.preventDefault();
    editor.commands.focus("start");
  }
});

// --- Load and save

async function load() {
  if (!noteId) {
    const note = await call("create", { title: "Untitled" });
    noteId = note.id;
    history.replaceState(null, "", `?id=${encodeURIComponent(noteId)}`);
  }
  const note = await readWithRetry();
  setNoteId(note.id);
  notePath = note.path;
  fileTitle = note.title;
  setTitle(note.title);
  editor.commands.setContent(note.body, false);
  if (!getTitle()) titleEl.focus();
  else editor.commands.focus("end");
}

// A brand-new file can take a moment to show up (iCloud-synced folders), so
// retry briefly before reporting it missing.
async function readWithRetry(attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return await call("read", { noteId });
    } catch (err) {
      if (i >= attempts || !/not found/i.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 300 * i));
    }
  }
}

function setNoteId(id) {
  if (id === noteId && location.search.includes(encodeURIComponent(id))) return;
  noteId = id;
  history.replaceState(null, "", `?id=${encodeURIComponent(id)}`);
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY);
}

function save() {
  clearTimeout(saveTimer);
  if (!dirty || deleting) return saving;
  dirty = false;
  const body = editor.storage.markdown.getMarkdown();
  // With no title typed, leave the file name ("Untitled 3.md") alone.
  // Clearing a real title renames the file back to "Untitled".
  const title = getTitle() || (isPlaceholderTitle(fileTitle) ? "" : "Untitled");
  const args = title ? { noteId, title, body } : { noteId, body };
  saving = saving
    .then(() => call("write", args))
    .then((result) => {
      setNoteId(result.id);
      notePath = result.path;
      fileTitle = result.title;
      showStatus("Saved");
    })
    .catch((err) => {
      dirty = true;
      showError(err);
    });
  return saving;
}

window.addEventListener("beforeunload", save);
document.addEventListener("visibilitychange", () => document.hidden && save());

browser.runtime.onMessage.addListener((msg) => {
  if (deleting || msg.type !== "event" || msg.event !== "changed") return;
  if (msg.notes.some((n) => n.id === noteId) && !dirty) reloadFromDisk();
  if (msg.removed.includes(noteId)) {
    // A rename from inside this tab changes the path but keeps the id, so
    // only warn if the note really can't be found any more.
    call("read", { noteId }).catch(() => showBanner("This note was deleted or moved outside the notes folder."));
  }
});

async function reloadFromDisk() {
  const note = await call("read", { noteId });
  if (dirty) return;
  const { from, to } = editor.state.selection;
  fileTitle = note.title;
  const shown = getTitle();
  const changed = shown ? note.title !== shown : !isPlaceholderTitle(note.title);
  if (changed && document.activeElement !== titleEl) {
    setTitle(note.title);
  }
  if (note.body !== editor.storage.markdown.getMarkdown()) {
    editor.commands.setContent(note.body, false);
    const max = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
  }
  notePath = note.path;
  showStatus("Updated from disk");
}

// --- Floating toolbar (sits to the left of the block being edited, like Arc)

const COMMANDS = {
  h1: (c) => c.toggleHeading({ level: 1 }),
  h2: (c) => c.toggleHeading({ level: 2 }),
  h3: (c) => c.toggleHeading({ level: 3 }),
  paragraph: (c) => c.setParagraph(),
  bulletList: (c) => c.toggleBulletList(),
  orderedList: (c) => c.toggleOrderedList(),
  taskList: (c) => c.toggleTaskList(),
  bold: (c) => c.toggleBold(),
  italic: (c) => c.toggleItalic(),
  underline: (c) => c.toggleUnderline(),
  strike: (c) => c.toggleStrike(),
  code: (c) => c.toggleCode(),
};

const ACTIVE = {
  h1: () => editor.isActive("heading", { level: 1 }),
  h2: () => editor.isActive("heading", { level: 2 }),
  h3: () => editor.isActive("heading", { level: 3 }),
  paragraph: () => editor.isActive("paragraph") && !editor.isActive("bulletList") && !editor.isActive("orderedList") && !editor.isActive("taskList"),
  bulletList: () => editor.isActive("bulletList"),
  orderedList: () => editor.isActive("orderedList"),
  taskList: () => editor.isActive("taskList"),
  marks: () => ["bold", "italic", "underline", "strike", "code"].some((m) => editor.isActive(m)),
  bold: () => editor.isActive("bold"),
  italic: () => editor.isActive("italic"),
  underline: () => editor.isActive("underline"),
  strike: () => editor.isActive("strike"),
  code: () => editor.isActive("code"),
  link: () => editor.isActive("link"),
};

const gutter = $("#gutter");
const chip = $("#block-chip");
const mover = $("#block-mover");
const chipLabel = chip.querySelector(".chip-label");
const dropLine = $("#drop-line");
let expanded = false; // toolbar opened from the chip
let expandedBlock = -1; // which block the chip was opened on
let hoverIndex = null; // top-level block under the mouse
let drag = null; // { index, dom, gap } while moving a block

// Top-level blocks as { index, pos, node, dom }.
function blocks() {
  const list = [];
  editor.state.doc.forEach((node, pos, index) => {
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) list.push({ index, pos, node, dom });
  });
  return list;
}

function caretBlockIndex() {
  return editor.state.selection.$from.index(0);
}

function blockLabel(node) {
  if (node.type.name === "heading") return `H${node.attrs.level}`;
  if (node.type.name === "bulletList") return ICONS.bullets;
  if (node.type.name === "orderedList") return ICONS.numbers;
  if (node.type.name === "taskList") return ICONS.checklist;
  return "Aa";
}

// Left edge of the text column; the picker and toolbar sit just outside it.
const textLeft = () => editor.view.dom.getBoundingClientRect().left;

function hideToolbar() {
  toolbar.hidden = true;
  flyout.hidden = true;
  expanded = false;
}

function placeGutter(block) {
  if (!block) {
    gutter.hidden = true;
    return;
  }
  chipLabel.innerHTML = blockLabel(block.node);
  gutter.hidden = false;
  const first = block.dom.matches("ul, ol") ? block.dom.querySelector("li") || block.dom : block.dom;
  const lineHeight = parseFloat(getComputedStyle(first).lineHeight) || first.offsetHeight;
  const top = first.getBoundingClientRect().top + Math.min(lineHeight, first.offsetHeight) / 2 - gutter.offsetHeight / 2;
  gutter.style.top = `${top + window.scrollY}px`;
  gutter.style.left = `${Math.max(4, textLeft() - gutter.offsetWidth - 6)}px`;
  gutter.dataset.index = block.index;
}

// Arc-style: the "Aa ▾" picker (with a Notion-style mover to its left) sits
// beside the line you're on or pointing at; selecting text opens the toolbar.
function positionToolbar() {
  if (drag) return;
  const { state, view } = editor;
  const { selection } = state;
  const focused = view.hasFocus();
  const list = blocks();
  const caret = caretBlockIndex();
  if (expanded && caret !== expandedBlock) expanded = false;

  const showToolbar = focused && (!selection.empty || expanded);
  if (!showToolbar) {
    toolbar.hidden = true;
    flyout.hidden = true;
    const index = hoverIndex ?? (focused ? caret : null);
    placeGutter(list.find((b) => b.index === index));
    return;
  }

  gutter.hidden = true;
  for (const btn of toolbar.querySelectorAll("button[data-cmd]")) {
    btn.classList.toggle("active", ACTIVE[btn.dataset.cmd]?.() ?? false);
  }
  toolbar.hidden = false;
  let top;
  if (expanded && selection.empty) {
    // Open downward from where the picker was, like a dropdown.
    top = parseFloat(gutter.style.top) - 4;
  } else {
    const start = view.coordsAtPos(selection.from);
    const end = view.coordsAtPos(selection.to);
    top = (start.top + end.bottom) / 2 + window.scrollY - toolbar.offsetHeight / 2;
  }
  toolbar.style.top = `${Math.max(window.scrollY + 12, top)}px`;
  toolbar.style.left = `${Math.max(4, textLeft() - toolbar.offsetWidth - 6)}px`;
}

// Follow the mouse over blocks, and keep the gutter while the mouse is on it.
document.addEventListener("mousemove", (e) => {
  if (drag || !toolbar.hidden) return;
  if (gutter.contains(e.target)) return;
  const rect = editor.view.dom.getBoundingClientRect();
  let index = null;
  if (e.clientY >= rect.top && e.clientY <= rect.bottom && e.clientX >= rect.left - 80 && e.clientX <= rect.right + 40) {
    index = blocks().find((b) => {
      const r = b.dom.getBoundingClientRect();
      return e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8;
    })?.index ?? null;
  }
  if (index !== hoverIndex) {
    hoverIndex = index;
    positionToolbar();
  }
});

gutter.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret
// Ticking a checklist item draws its checkmark in from left to right.
function drawCheck(li) {
  const span = li.querySelector(":scope > label > span");
  span?.animate([{ width: "0" }, { width: "0.6em" }], {
    duration: 350,
    easing: "cubic-bezier(0.4, 0, 0.2, 1)",
    pseudoElement: "::after",
  });
}
let checkClick = null;
editor.view.dom.addEventListener(
  "click",
  (e) => {
    if (e.target.type === "checkbox") checkClick = Date.now();
  },
  true
);

// Ticking or unticking an item does the same to the items nested under it.
editor.on("transaction", ({ transaction }) => {
  if (!transaction.docChanged || transaction.getMeta("cascadeChecks")) return;
  const before = transaction.before;
  const tr = editor.state.tr;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "taskItem") return;
    const mapped = transaction.mapping.invert().map(pos);
    const old = before.nodeAt(mapped);
    if (!old || old.type.name !== "taskItem" || old.attrs.checked === node.attrs.checked) return;
    node.descendants((child, offset) => {
      if (child.type.name === "taskItem" && child.attrs.checked !== node.attrs.checked) {
        tr.setNodeMarkup(pos + 1 + offset, undefined, { ...child.attrs, checked: node.attrs.checked });
      }
    });
  });
  if (tr.docChanged) editor.view.dispatch(tr.setMeta("cascadeChecks", true).setMeta("addToHistory", true));
});

// After a checkbox click, animate every item that just became ticked.
let checkedBefore = new Set();
const checkedItems = () =>
  new Set([...editor.view.dom.querySelectorAll('ul[data-type="taskList"] li[data-checked="true"]')]);
editor.on("transaction", () => {
  requestAnimationFrame(() => {
    const now = checkedItems();
    if (checkClick && Date.now() - checkClick < 500) {
      for (const li of now) if (!checkedBefore.has(li)) drawCheck(li);
    }
    checkedBefore = now;
  });
});
requestAnimationFrame(() => (checkedBefore = checkedItems()));

// A click in the text moves the picker to the clicked line right away.
editor.view.dom.addEventListener("mousedown", () => (hoverIndex = null));
chip.addEventListener("click", (e) => {
  const index = Number(gutter.dataset.index);
  if (index !== caretBlockIndex() || !editor.view.hasFocus()) caretToLineStart(e.clientY, index);
  hoverIndex = null;
  expanded = true;
  expandedBlock = caretBlockIndex();
  positionToolbar();
});

// --- Mover: drag a block up or down

function moveBlock(from, to, { scroll = false, dropY = null } = {}) {
  // `to` is the gap index (0 = before the first block, n = after the last).
  if (to === from || to === from + 1) return;
  const { state } = editor;
  const list = [];
  state.doc.forEach((node, pos) => list.push({ node, pos }));
  const { node, pos } = list[from];
  const gapPos = to < list.length ? list[to].pos : state.doc.content.size;
  const tr = state.tr.delete(pos, pos + node.nodeSize);
  const insertAt = tr.mapping.map(gapPos);
  tr.insert(insertAt, node);
  // Select the moved block in the same step, and focus without scrolling, so the
  // page stays where the block was dropped instead of jumping back to the old caret.
  tr.setSelection(
    node.isTextblock ? TextSelection.create(tr.doc, insertAt + node.nodeSize - 1) : NodeSelection.create(tr.doc, insertAt)
  );
  editor.view.dispatch(scroll ? tr.scrollIntoView() : tr);
  editor.view.dom.focus({ preventScroll: true });
  if (dropY != null) centerBlock(insertAt);
}

// After a drop, scroll so the dropped block sits in the middle of the window.
// Firefox may also scroll to the new caret a moment later, so set it again
// over the next frames to win over that.
function centerBlock(pos) {
  const apply = () => {
    const dom = editor.view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const r = dom.getBoundingClientRect();
    const top = window.scrollY + r.top + r.height / 2 - window.innerHeight / 2;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  };
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
  setTimeout(apply, 60);
}

// The gap under the pointer, with its y centred in the space between blocks.
function gapAt(y) {
  const rects = blocks().map((b) => ({ index: b.index, r: b.dom.getBoundingClientRect() }));
  const mid = (i) => {
    const above = rects[i - 1]?.r;
    const below = rects[i]?.r;
    if (above && below) return (above.bottom + below.top) / 2;
    if (below) return below.top - 6;
    return above ? above.bottom + 6 : 0;
  };
  for (let i = 0; i < rects.length; i++) {
    if (y < rects[i].r.top + rects[i].r.height / 2) return { index: rects[i].index, y: mid(i) };
  }
  return { index: rects.length, y: mid(rects.length) };
}

function startDrag(index, e) {
  const block = blocks().find((b) => b.index === index);
  if (!block) return false;
  document.body.classList.add("is-moving");
  block.dom.classList.add("dragging");
  gutter.classList.add("is-dragging");
  // No floating copy of the block: it's dimmed in place and the drop line shows where it lands.
  drag = { index, dom: block.dom, gap: null, y: e.clientY, startY: e.clientY, moved: false };
  hideToolbar();
  onDrag(e);
  requestAnimationFrame(autoScroll);
  return true;
}

mover.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (startDrag(Number(gutter.dataset.index), e)) mover.setPointerCapture(e.pointerId);
});

function showDropLine(y) {
  dropLine.hidden = false;
  dropLine.style.top = `${y + window.scrollY - 1}px`;
  dropLine.style.left = `${textLeft()}px`;
  dropLine.style.width = `${editor.view.dom.offsetWidth}px`;
}

function onDrag(e) {
  if (!drag) return;
  drag.y = e.clientY;
  if (Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
  drag.gap = gapAt(e.clientY);
  showDropLine(drag.gap.y);
}

// Scroll the page while dragging near the top or bottom edge.
const EDGE = 70;
function edgeSpeed(y) {
  if (y < EDGE) return -Math.ceil(((EDGE - y) / EDGE) * 18);
  if (y > innerHeight - EDGE) return Math.ceil(((y - (innerHeight - EDGE)) / EDGE) * 18);
  return 0;
}
function autoScroll() {
  if (!drag) return;
  const speed = edgeSpeed(drag.y);
  if (speed) {
    window.scrollBy(0, speed);
    drag.gap = gapAt(drag.y);
    showDropLine(drag.gap.y);
  }
  requestAnimationFrame(autoScroll);
}

window.addEventListener("pointermove", onDrag);

// Images move by dragging the image itself, once the pointer has moved a few
// pixels. The browser's own image drag is turned off so it can't take over, and
// a plain click still selects the image.
let pendingImageDrag = null;
editor.view.dom.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button !== 0 || e.target.tagName !== "IMG") return;
    const block = blocks().find((b) => b.dom === e.target || b.dom.contains(e.target));
    if (!block) return;
    e.preventDefault();
    e.stopPropagation();
    e.target.setPointerCapture(e.pointerId);
    pendingImageDrag = { index: block.index, x: e.clientX, y: e.clientY };
  },
  true
);
editor.view.dom.addEventListener("dragstart", (e) => {
  if (e.target.tagName === "IMG") e.preventDefault();
});
window.addEventListener("pointermove", (e) => {
  if (!pendingImageDrag || drag) return;
  if (Math.hypot(e.clientX - pendingImageDrag.x, e.clientY - pendingImageDrag.y) < 5) return;
  const { index } = pendingImageDrag;
  pendingImageDrag = null;
  getSelection().removeAllRanges();
  startDrag(index, e);
});
window.addEventListener(
  "pointerup",
  () => {
    if (!pendingImageDrag) return;
    // No movement: treat it as a click and select the image.
    const block = blocks().find((b) => b.index === pendingImageDrag.index);
    pendingImageDrag = null;
    if (!block) return;
    editor.view.dom.focus({ preventScroll: true });
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, block.pos)));
  },
  true
);

// Files dragged in from Finder get the same drop line, and scroll the page too.
function gapPos(index) {
  const block = blocks().find((b) => b.index === index);
  return block ? block.pos : editor.state.doc.content.size;
}
function hideFileDrop() {
  if (!drag) dropLine.hidden = true;
}
document.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  showDropLine(gapAt(e.clientY).y);
  const speed = edgeSpeed(e.clientY);
  if (speed) window.scrollBy(0, speed * 2);
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) hideFileDrop();
});
document.addEventListener("drop", (e) => {
  hideFileDrop();
  if (!editor.view.dom.contains(e.target) && [...(e.dataTransfer?.types || [])].includes("Files")) {
    // Dropped in the margin: still goes into the note at the line.
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter(isMediaFile);
    if (files.length) insertMediaFiles(files, gapPos(gapAt(e.clientY).index)).catch(showError);
  }
});


function endDrag() {
  if (!drag) return;
  const { index, gap, dom, moved, y: drag_y } = drag;
  document.body.classList.remove("is-moving");
  dom.classList.remove("dragging");
  dropLine.hidden = true;
  gutter.classList.remove("is-dragging");
  drag = null;
  hoverIndex = null;
  if (gap && moved) {
    swallowMouseUp = true;
    setTimeout(() => (swallowMouseUp = false), 100); // image drags send no mouseup
    moveBlock(index, gap.index, { dropY: gap.y });
  }
  else {
    // A click on the mover without dragging puts the caret at the start of the line.
    caretToLineStart(drag_y, index);
  }
  positionToolbar();
}

// After a drag, keep ProseMirror from handling the mouseup as a click on the
// block's old spot, which would select it there and scroll back.
let swallowMouseUp = false;
window.addEventListener(
  "mouseup",
  (e) => {
    if (!swallowMouseUp) return;
    swallowMouseUp = false;
    e.stopPropagation();
  },
  true
);

// Puts the caret at the start of the visual line at height `y`: the line of a
// wrapped paragraph, a list item, or a heading. Images and videos get selected.
function caretToLineStart(y, index = null) {
  // An image or video on this line: put the caret just before it. Typing there
  // starts a new line above it.
  const atom = blocks().find((b) => {
    if (!b.node.isAtom) return false;
    if (index != null) return b.index === index;
    const r = b.dom.getBoundingClientRect();
    return y >= r.top - 4 && y <= r.bottom + 4;
  });
  if (atom) {
    editor.view.dom.focus({ preventScroll: true });
    editor.view.dispatch(editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(atom.pos))));
    return;
  }
  const lines = [...editor.view.dom.querySelectorAll("p, h1, h2, h3, pre")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.height > 0);
  let best = null;
  let bestDist = Infinity;
  for (const line of lines) {
    const dist = y < line.r.top ? line.r.top - y : y > line.r.bottom ? y - line.r.bottom : 0;
    if (dist < bestDist) [best, bestDist] = [line, dist];
  }
  if (!best) return;
  const top = Math.min(Math.max(y, best.r.top + 2), best.r.bottom - 2);
  const hit = editor.view.posAtCoords({ left: best.r.left + 1, top });
  if (!hit) return;
  editor.view.dom.focus({ preventScroll: true });
  const { doc } = editor.state;
  const $pos = doc.resolve(hit.pos);
  const atWrap = $pos.parent.isTextblock && hit.pos > $pos.start() && hit.pos < $pos.end();
  // The start of a wrapped line is the same position as the end of the line
  // above, and browsers draw a caret placed there in code at the end of the line
  // above. Put it one character in and step back, the way the arrow key does,
  // so it shows at the start of the clicked line.
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, atWrap ? hit.pos + 1 : hit.pos)));
  if (atWrap) getSelection().modify("move", "backward", "character");
}

// Firefox can drop pointer capture mid-drag, so end the drag on any of these.
mover.addEventListener("pointerup", endDrag);
mover.addEventListener("pointercancel", endDrag);
mover.addEventListener("lostpointercapture", endDrag);
window.addEventListener("pointerup", endDrag);
window.addEventListener("blur", endDrag);
mover.addEventListener("dragstart", (e) => e.preventDefault());

// Clicking anywhere beside the text (either margin) puts the caret at the start
// of that line.
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || drag) return;
  if (e.target.closest(".ProseMirror, #title, button, a, input, .toolbar, .gutter, #gutter, .menu, .card, .more, .share, #banner")) return;
  const rect = editor.view.dom.getBoundingClientRect();
  if (e.clientY < rect.top - 4 || e.clientY > rect.bottom + 4) return;
  e.preventDefault();
  caretToLineStart(e.clientY);
});

// ⌘B / ⌘I / ⌘U format text here instead of reaching Zen's own shortcuts,
// including when the caret is in the title.
const MARK_KEYS = { KeyB: "toggleBold", KeyI: "toggleItalic", KeyU: "toggleUnderline" };
window.addEventListener(
  "keydown",
  (e) => {
    const command = MARK_KEYS[e.code];
    if (!command || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (editor.view.hasFocus()) editor.chain().focus()[command]().run();
  },
  true
);

// Keyboard: ⌥⇧↑ / ⌥⇧↓ moves the current block.
editor.view.dom.addEventListener(
  "keydown",
  (e) => {
    if (!e.altKey || !e.shiftKey || (e.code !== "ArrowUp" && e.code !== "ArrowDown")) return;
    e.preventDefault();
    e.stopPropagation();
    const index = caretBlockIndex();
    moveBlock(index, e.code === "ArrowUp" ? index - 1 : index + 2, { scroll: true });
  },
  true
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (expanded || !flyout.hidden)) {
    expanded = false;
    flyout.hidden = true;
    positionToolbar();
  }
});

const BLOCK_COMMANDS = new Set(["h1", "h2", "h3", "paragraph", "bulletList", "orderedList", "taskList"]);

toolbar.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
toolbar.addEventListener("click", (e) => {
  const cmd = e.target.closest("button")?.dataset.cmd;
  if (!cmd) return;
  if (cmd === "marks") {
    flyout.hidden = !flyout.hidden;
    return;
  }
  if (cmd === "image") return $("#file-input").click();
  if (cmd === "link") return editLink();
  COMMANDS[cmd](editor.chain().focus()).run();
  if (BLOCK_COMMANDS.has(cmd)) expanded = false;
  positionToolbar();
});

$("#file-input").addEventListener("change", (e) => {
  const files = [...e.target.files].filter(isMediaFile);
  if (files.length) insertMediaFiles(files).catch(showError);
  e.target.value = "";
});

function editLink() {
  const current = editor.getAttributes("link").href || "";
  const href = window.prompt("Link URL (leave empty to remove)", current);
  if (href === null) return;
  const chain = editor.chain().focus().extendMarkRange("link");
  if (!href.trim()) chain.unsetLink().run();
  else chain.setLink({ href: /^[a-z]+:/i.test(href) ? href : `https://${href}` }).run();
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && editor.isFocused) {
    e.preventDefault();
    editLink();
  }
  // ⌘S saves now but isn't swallowed, so Zen's sidebar toggle still works.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
    dirty = true;
    save();
  }
});

window.addEventListener("resize", positionToolbar);

// --- Share card (bottom right) and ⋮ menu (top right)

const shareCard = $("#share-card");
const moreMenu = $("#more-menu");

function togglePopup(popup) {
  const open = popup.hidden;
  shareCard.hidden = true;
  moreMenu.hidden = true;
  popup.hidden = !open;
  if (open && popup === shareCard) {
    $("#share-path").textContent = notePath.replace(/^\/Users\/[^/]+/, "~");
  }
}

$("#share-button").addEventListener("click", (e) => {
  e.stopPropagation();
  togglePopup(shareCard);
});
$("#more-button").addEventListener("click", (e) => {
  e.stopPropagation();
  togglePopup(moreMenu);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".card, .menu")) shareCard.hidden = moreMenu.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") shareCard.hidden = moreMenu.hidden = true;
});

async function runAction(action) {
  shareCard.hidden = moreMenu.hidden = true;
  await save();
  try {
    if (action === "copy") {
      const title = getTitle();
      const md = editor.storage.markdown.getMarkdown();
      await navigator.clipboard.writeText(title ? `# ${title}\n\n${md}` : md);
      showStatus("Copied");
    } else if (action === "obsidian") {
      window.open(`obsidian://open?path=${encodeURIComponent(notePath)}`, "_self");
    } else if (action === "library") {
      await browser.runtime.sendMessage({ type: "library" });
    } else if (action === "reveal") {
      await call("reveal", { noteId });
    } else if (action === "delete") {
      if (!window.confirm("Move this note to the Trash?")) return;
      deleting = true;
      await call("delete", { noteId });
      const tab = await browser.tabs.getCurrent();
      browser.tabs.remove(tab.id);
    }
  } catch (err) {
    deleting = false;
    showError(err);
  }
}

// --- Appearance: Auto follows macOS; Light/Dark override it for all notes.

const appearance = $("#appearance");

const themePill = appearance.querySelector(".theme-pill");

function applyTheme(theme) {
  theme = theme === "light" || theme === "dark" ? theme : "system";
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const buttons = [...appearance.querySelectorAll("button")];
  buttons.forEach((btn, i) => {
    const on = btn.dataset.theme === theme;
    btn.setAttribute("aria-checked", on);
    if (on) themePill.style.transform = `translateX(${i * 28}px)`;
  });
  requestAnimationFrame(() => appearance.classList.add("ready"));
}

browser.storage.local.get("theme").then(({ theme }) => applyTheme(theme));
browser.storage.onChanged.addListener((changes) => {
  if (changes.theme) applyTheme(changes.theme.newValue);
});

appearance.addEventListener("click", (e) => {
  e.stopPropagation();
  const theme = e.target.closest("button")?.dataset.theme;
  if (!theme) return;
  applyTheme(theme);
  browser.storage.local.set({ theme });
});

for (const popup of [shareCard, moreMenu]) {
  popup.addEventListener("click", (e) => {
    const action = e.target.closest("button")?.dataset.action;
    if (action) runAction(action);
  });
}

// --- Status

let statusTimer;
function showStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.add("visible");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove("visible"), 1200);
}

function showBanner(text) {
  banner.textContent = text;
  banner.hidden = false;
}

function showError(err) {
  console.error(err);
  showBanner(err.message || String(err));
}

load().catch(showError);

// Large images and videos need the chunked reads added in helper version 3.
const HELPER_VERSION = 3;
call("config")
  .then((c) => {
    if ((c.version || 0) < HELPER_VERSION) {
      showBanner("The Zen Notes helper is out of date, so large images won't load. In Terminal run: cd ~/Downloads/zen-notes/helper && ./install.sh");
    }
  })
  .catch(() => {});
