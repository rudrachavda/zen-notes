import "@fontsource/nunito/400.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/800.css";
import "./library.css";
import { ICONS } from "./icons.js";

// One place to see every note, like Arc's "Easels & Notes" view.

const $ = (sel) => document.querySelector(sel);
const call = (cmd, args) => browser.runtime.sendMessage({ type: "call", cmd, args });
const isPlaceholderTitle = (title) => /^Untitled( \d+)?$/.test(title);

for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = ICONS[el.dataset.icon];

let notes = [];
let pendingDelete = null;

function ago(seconds) {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function card(note) {
  const el = document.createElement("article");
  el.className = "card";
  el.tabIndex = 0;

  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("h3");
  title.textContent = isPlaceholderTitle(note.title) ? "Untitled" : note.title;
  title.classList.toggle("placeholder", isPlaceholderTitle(note.title));
  const preview = document.createElement("p");
  preview.textContent = note.preview || "";
  body.append(title, preview);

  const meta = document.createElement("footer");
  const icon = document.createElement("span");
  icon.className = "card-icon";
  icon.innerHTML = ICONS.note;
  const when = document.createElement("span");
  when.textContent = [note.folder, ago(note.mtime)].filter(Boolean).join(" · ");
  meta.append(icon, when);

  const del = document.createElement("button");
  del.className = "card-delete";
  del.title = "Delete note";
  del.innerHTML = ICONS.trash;
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    askDelete(note);
  });

  el.append(body, meta, del);
  const open = () => browser.runtime.sendMessage({ type: "open", noteId: note.id });
  el.addEventListener("click", open);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") open();
    if (e.key === "Backspace" || e.key === "Delete") askDelete(note);
  });
  return el;
}

function render() {
  const q = $("#search").value.trim().toLowerCase();
  const shown = notes.filter((n) => !q || `${n.title} ${n.folder} ${n.preview || ""}`.toLowerCase().includes(q));
  $("#grid").replaceChildren(...shown.map(card));
  const empty = $("#empty");
  empty.hidden = shown.length > 0 || !$("#error").hidden;
  empty.textContent = q ? `No notes match “${$("#search").value.trim()}”.` : "No notes yet. Press ⌘/ to write one.";
}

async function refresh() {
  try {
    notes = await call("list");
    $("#error").hidden = true;
  } catch (err) {
    $("#error").textContent = err.message;
    $("#error").hidden = false;
  }
  render();
}

// --- Delete, with a confirm dialog

function askDelete(note) {
  pendingDelete = note;
  $("#confirm").hidden = false;
  $("#confirm-delete").focus();
}

function closeConfirm() {
  pendingDelete = null;
  $("#confirm").hidden = true;
}

async function confirmDelete() {
  const note = pendingDelete;
  closeConfirm();
  if (!note) return;
  try {
    await call("delete", { noteId: note.id });
    notes = notes.filter((n) => n.id !== note.id);
    render();
  } catch (err) {
    $("#error").textContent = err.message;
    $("#error").hidden = false;
  }
}

$("#confirm-cancel").addEventListener("click", closeConfirm);
$("#confirm-delete").addEventListener("click", confirmDelete);
$("#confirm").addEventListener("click", (e) => e.target === e.currentTarget && closeConfirm());
document.addEventListener("keydown", (e) => {
  if ($("#confirm").hidden) {
    if (e.key === "/" && !e.metaKey && document.activeElement !== $("#search")) {
      e.preventDefault();
      $("#search").focus();
    }
    return;
  }
  if (e.key === "Escape") closeConfirm();
  if (e.key === "Enter") {
    e.preventDefault();
    confirmDelete();
  }
});

$("#search").addEventListener("input", render);
$("#new").addEventListener("click", () => browser.runtime.sendMessage({ type: "new" }));

// Stay current when notes change in other tabs or in Obsidian.
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "event" && msg.event === "changed") refresh();
});
document.addEventListener("visibilitychange", () => !document.hidden && refresh());

// Same Appearance setting as the notes (⋮ menu in a note).
function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
browser.storage.local.get("theme").then(({ theme }) => applyTheme(theme));
browser.storage.onChanged.addListener((changes) => changes.theme && applyTheme(changes.theme.newValue));

refresh();
