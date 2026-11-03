import "@fontsource/nunito/400.css";
import "@fontsource/nunito/800.css";
import "./popup.css";

const $ = (sel) => document.querySelector(sel);
const call = (cmd, args) => browser.runtime.sendMessage({ type: "call", cmd, args });

let notes = [];

function ago(seconds) {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function render() {
  const q = $("#search").value.trim().toLowerCase();
  const shown = notes.filter((n) => !q || `${n.folder}/${n.title}`.toLowerCase().includes(q));
  const list = $("#list");
  list.replaceChildren(
    ...shown.map((n) => {
      const li = document.createElement("li");
      li.tabIndex = 0;
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = n.title;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = [n.folder, ago(n.mtime)].filter(Boolean).join(" · ");
      li.append(title, meta);
      li.addEventListener("click", () => open(n.id));
      li.addEventListener("keydown", (e) => e.key === "Enter" && open(n.id));
      return li;
    })
  );
  $("#empty").hidden = shown.length > 0;
}

async function open(noteId) {
  await browser.runtime.sendMessage({ type: "open", noteId });
  window.close();
}

async function refresh() {
  try {
    const [list, config] = await Promise.all([call("list"), call("config")]);
    notes = list;
    $("#folder").textContent = config.folder.replace(/^\/Users\/[^/]+/, "~");
    render();
  } catch (err) {
    $("#error").textContent = err.message;
    $("#error").hidden = false;
  }
}

$("#search").addEventListener("input", render);
$("#search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#list li")?.click();
});
$("#new").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "new" });
  window.close();
});
$("#all").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "library" });
  window.close();
});
$("#folder").addEventListener("click", () => call("reveal", {}));
$("#change").addEventListener("click", async () => {
  const folder = window.prompt("Notes folder (for example an Obsidian vault folder)", $("#folder").textContent);
  if (!folder) return;
  await call("setFolder", { folder });
  const DEFAULT_SHARE_SERVER = "https://zen-notes-share.vercel.app";

$("#sharing").addEventListener("click", async () => {
  const current = await call("shareInfo").catch(() => ({}));
  const url = window.prompt(
    current.url ? `Web sharing is on (${current.url}). Enter a new server address to change it, or clear it to turn sharing off.` : "Share server address",
    current.url || DEFAULT_SHARE_SERVER,
  );
  if (url === null || url.trim() === current.url) return;
  try {
    if (!url.trim()) {
      await call("setShareServer", {});
      return;
    }
    const code = window.prompt("Setup code for this server (used once)");
    if (!code) return;
    await call("setupShare", { url: url.trim(), code: code.trim() });
    window.alert("Web sharing is set up. Use the share button on any note to publish it.");
  } catch (err) {
    window.alert(`Couldn't set up web sharing: ${err.message}`);
  }
});

refresh();
});

$("#sharing").addEventListener("click", async () => {
  const current = await call("shareInfo").catch(() => ({}));
  const url = window.prompt("Share server address (leave empty to turn web sharing off)", current.url || "https://");
  if (url === null) return;
  const clean = url.trim().replace(/\/+$/, "");
  if (!clean || clean === "https:") {
    await call("setShareServer", {});
    return;
  }
  const key = window.prompt("Publish key (kept only on this Mac)", current.key || "");
  if (!key) return;
  await call("setShareServer", { url: clean, key: key.trim() });
});

refresh();
