// Owner-only: upload one image or video used by a published note.
//   PUT /api/upload?id=<share id>&name=<file name>   (raw bytes, Content-Type set)
// Returns {url}. Each file gets a random name so its URL can't be guessed, and
// is kept in Redis next to the note so unpublishing removes it too.

import { randomBytes } from "node:crypto";
import { ID_RE, authorized, db, json } from "../lib/store.js";

const ALLOWED = /^(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|quicktime|webm))$/;
const MAX_BYTES = 4 * 1024 * 1024;

export async function PUT(request) {
  if (!(await authorized(request))) return json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const id = params.get("id") || "";
  if (!ID_RE.test(id)) return json({ error: "Bad id" }, { status: 400 });

  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED.test(type)) return json({ error: "Unsupported file type" }, { status: 415 });
  const bytes = Buffer.from(await request.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) return json({ error: "File too large" }, { status: 413 });

  const ext = (params.get("name") || "").match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toLowerCase() || "bin";
  const name = `${randomBytes(12).toString("base64url")}.${ext}`;
  await db().set(`file:${id}:${name}`, { type, data: bytes.toString("base64") });
  await db().sadd(`files:${id}`, name);
  return json({ url: `${new URL(request.url).origin}/f/${id}/${name}` });
}
