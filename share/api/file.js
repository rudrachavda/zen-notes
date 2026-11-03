// Public: an image or video from a published note, at /f/<share id>/<name>.
// Cached for at most 5 minutes, so an unpublished note's files disappear soon after.

import { ID_RE, db } from "../lib/store.js";

const NAME_RE = /^[A-Za-z0-9_-]{16}\.[a-z0-9]{1,5}$/;

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const id = params.get("id") || "";
  const name = params.get("name") || "";
  if (!ID_RE.test(id) || !NAME_RE.test(name)) return new Response("Not found", { status: 404 });
  const file = await db().get(`file:${id}:${name}`);
  if (!file) return new Response("Not found", { status: 404, headers: { "cache-control": "public, s-maxage=10" } });
  return new Response(Buffer.from(file.data, "base64"), {
    headers: {
      "content-type": file.type,
      "cache-control": "public, max-age=300, s-maxage=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-robots-tag": "noindex",
    },
  });
}
