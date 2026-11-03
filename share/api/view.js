// Public: the read-only page for a published note, at /n/<share id>.
// It shows the note as it is now, then checks for changes every few seconds
// while the tab is visible, so readers see edits without reloading.

import { randomBytes } from "node:crypto";
import { escapeHtml } from "../lib/render.js";
import { getNote } from "../lib/store.js";

const POLL_MS = 3000;

export async function GET(request) {
  const id = new URL(request.url).searchParams.get("id") || "";
  const note = await getNote(id);
  const nonce = randomBytes(16).toString("base64");
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self' https: data:",
      "media-src 'self' https:",
      "frame-src https://www.youtube-nocookie.com",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
  return new Response(page(id, note, nonce), { status: note ? 200 : 404, headers });
}

function page(id, note, nonce) {
  const title = note ? note.title || "Untitled" : "Note not found";
  const body = note
    ? note.html
    : `<p class="gone">This note isn't shared any more, or the link is wrong.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;500;600;800&display=swap">
<style>${CSS}</style>
</head>
<body>
<main class="page">
  <h1 id="title">${escapeHtml(note ? note.title || "" : title)}</h1>
  <article id="body">${body}</article>
</main>
<footer><span id="live" ${note ? "" : "hidden"}><i></i>Live</span> Shared from Zen Notes</footer>
<script nonce="${nonce}">
(() => {
  const id = ${JSON.stringify(id)};
  let version = ${note ? Number(note.updatedAt) || 0 : -1};
  if (version < 0) return;
  const titleEl = document.getElementById("title");
  const bodyEl = document.getElementById("body");
  const live = document.getElementById("live");
  let timer;
  async function check() {
    clearTimeout(timer);
    if (document.hidden) return;
    try {
      const res = await fetch("/api/note?id=" + encodeURIComponent(id), { cache: "no-store" });
      if (res.status === 404) {
        titleEl.textContent = "Note not found";
        bodyEl.innerHTML = '<p class="gone">This note isn\\u2019t shared any more.</p>';
        document.title = "Note not found";
        live.hidden = true;
        return;
      }
      const note = await res.json();
      if (note.updatedAt !== version) {
        version = note.updatedAt;
        titleEl.textContent = note.title || "";
        document.title = note.title || "Untitled";
        bodyEl.innerHTML = note.html;
      }
      live.classList.remove("offline");
    } catch {
      live.classList.add("offline");
    }
    timer = setTimeout(check, ${POLL_MS});
  }
  document.addEventListener("visibilitychange", check);
  timer = setTimeout(check, ${POLL_MS});
})();
</script>
</body>
</html>`;
}

const CSS = `
:root {
  --paper: #fdf8ee; --ink: #2a2733; --title: #23206b; --muted: #8d8578;
  --selection: #cbcdfb; --rule: rgba(42, 39, 51, 0.1); --link: #3d3ab8;
  --code-bg: rgba(42, 39, 51, 0.07); --live: #2f9e5b;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #1f1d24; --ink: #e8e4dc; --title: #c9c6ff; --muted: #8b8697;
    --selection: #3d3a7a; --rule: rgba(255, 255, 255, 0.1); --link: #a9a6ff;
    --code-bg: rgba(255, 255, 255, 0.08); --live: #5fd08a;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--paper); color: var(--ink);
  font-family: "Nunito", -apple-system, BlinkMacSystemFont, sans-serif; -webkit-font-smoothing: antialiased; }
::selection { background: var(--selection); }
.page { max-width: 700px; margin: 0 auto; padding: 88px 32px 120px; }
#title { margin: 0 0 24px; color: var(--title); font-size: 2.6rem; font-weight: 800; line-height: 1.15; letter-spacing: -0.01em; overflow-wrap: anywhere; }
#body { font-size: 1.06rem; line-height: 1.65; overflow-wrap: anywhere; }
#body h1, #body h2, #body h3 { color: var(--title); font-weight: 800; line-height: 1.25; margin: 1.4em 0 0.4em; }
#body h1 { font-size: 1.75rem; } #body h2 { font-size: 1.4rem; } #body h3 { font-size: 1.15rem; }
#body p { margin: 0 0 0.8em; }
#body a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 2px; }
#body ul, #body ol { padding-left: 1.5em; margin: 0 0 0.8em; }
#body li > p { margin: 0; }
#body li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.4em; }
#body input[type="checkbox"] { margin: 0 0.5em 0 0; accent-color: var(--title); }
#body blockquote { margin: 0 0 0.8em; padding-left: 14px; border-left: 3px solid var(--rule); color: var(--muted); }
#body code { background: var(--code-bg); border-radius: 5px; padding: 0.1em 0.35em; font: 0.9em ui-monospace, Menlo, monospace; }
#body pre { background: var(--code-bg); border-radius: 10px; padding: 14px 16px; overflow-x: auto; }
#body pre code { background: none; padding: 0; }
#body hr { border: 0; border-top: 1px solid var(--rule); margin: 1.6em 0; }
#body img, #body video { display: block; max-width: 100%; height: auto; border-radius: 10px; margin: 0.6em 0; }
#body .embed { display: block; position: relative; aspect-ratio: 16 / 9; margin: 0.6em 0; }
#body .embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; border-radius: 10px; }
#body .missing { display: inline-block; padding: 6px 10px; border-radius: 8px; background: var(--code-bg); color: var(--muted); font-size: 0.85rem; }
#body table { border-collapse: collapse; margin: 0 0 0.8em; }
#body th, #body td { border: 1px solid var(--rule); padding: 6px 10px; }
.gone { color: var(--muted); }
footer { position: fixed; right: 20px; bottom: 16px; display: flex; gap: 10px; align-items: center; font-size: 0.78rem; color: var(--muted); }
#live { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--live); }
#live[hidden] { display: none; }
#live i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: pulse 2s ease-in-out infinite; }
#live.offline { color: var(--muted); }
#live.offline i { animation: none; }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (max-width: 600px) { .page { padding: 48px 16px 96px; } #title { font-size: 2rem; } footer { position: static; justify-content: center; padding: 0 16px 24px; } }
`;
