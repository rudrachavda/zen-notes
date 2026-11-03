// Public: the current version of a published note, polled by the viewer page.
//   GET /api/note?id=<share id>  ->  {title, html, updatedAt}  or 404

import { getNote, json } from "../lib/store.js";

export async function GET(request) {
  const id = new URL(request.url).searchParams.get("id");
  const note = await getNote(id);
  // A 2-second CDN cache lets many viewers share one database read.
  const headers = { "cache-control": "public, max-age=0, s-maxage=2", "x-robots-tag": "noindex" };
  if (!note) return json({ error: "Not found" }, { status: 404, headers });
  return json(note, { headers });
}
