// One-time setup: Zen Notes on the author's Mac makes a random publish key and
// sends its SHA-256 here together with the setup code from ZEN_NOTES_SETUP_CODE.
// The first valid claim wins; after that the setup code is useless.
//   POST /api/claim  {code, keyHash}

import { timingSafeEqual } from "node:crypto";
import { db, json, sha256 } from "../lib/store.js";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const setup = process.env.ZEN_NOTES_SETUP_CODE || "";
  const code = String(body.code || "").trim();
  const keyHash = String(body.keyHash || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(keyHash)) return json({ error: "Bad key" }, { status: 400 });
  const ok = setup.length >= 8 && timingSafeEqual(Buffer.from(sha256(code), "hex"), Buffer.from(sha256(setup), "hex"));
  if (!ok) return json({ error: "Wrong setup code" }, { status: 401 });
  // NX: only set if nobody has claimed this server yet.
  const set = await db().set("owner", `sha256:${keyHash}`, { nx: true });
  if (set !== "OK") return json({ error: "This share server is already set up" }, { status: 409 });
  return json({ ok: true });
}
