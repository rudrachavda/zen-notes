// Owner-only: publish, update or unpublish a note.
//   PUT    /api/notes?id=<share id>   {title, markdown, files}
//   DELETE /api/notes?id=<share id>
// Both need "Authorization: Bearer <ZEN_NOTES_KEY>".

import { renderNote } from "../lib/render.js";
import { ID_RE, authorized, db, deleteNote, json, putNote } from "../lib/store.js";

const MAX_MARKDOWN = 400_000;

function shareId(request) {
  const id = new URL(request.url).searchParams.get("id") || "";
  return ID_RE.test(id) ? id : null;
}

export async function PUT(request) {
  if (!(await authorized(request))) return json({ error: "Unauthorized" }, { status: 401 });
  const id = shareId(request);
  if (!id) return json({ error: "Bad id" }, { status: 400 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body.markdown !== "string") return json({ error: "Bad body" }, { status: 400 });
  if (body.markdown.length > MAX_MARKDOWN) return json({ error: "Note is too large to share" }, { status: 413 });

  const files = {};
  for (const [src, url] of Object.entries(body.files || {})) {
    if (typeof url === "string" && /^https?:\/\//.test(url)) files[src] = url;
  }
  const title = String(body.title || "").slice(0, 200);
  const updatedAt = Date.now();
  await putNote(id, { title, html: renderNote(body.markdown, files), updatedAt });
  return json({ ok: true, updatedAt });
}

export async function DELETE(request) {
  if (!(await authorized(request))) return json({ error: "Unauthorized" }, { status: 401 });
  const id = shareId(request);
  if (!id) return json({ error: "Bad id" }, { status: 400 });

  await deleteNote(id);
  // Remove the note's uploaded images and videos too.
  const names = (await db().smembers(`files:${id}`)) || [];
  if (names.length) await db().del(...names.map((n) => `file:${id}:${n}`));
  await db().del(`files:${id}`);
  return json({ ok: true });
}
