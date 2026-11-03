// Published notes live in Upstash Redis, one JSON value per share id.
// Uploaded images live in Vercel Blob under files/<share id>/.

import { Redis } from "@upstash/redis";
import { createHash, timingSafeEqual } from "node:crypto";

export const ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const KEY = (id) => `note:${id}`;

let redis;
export function db() {
  if (!redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token) throw new Error("Redis is not configured");
    redis = new Redis({ url, token, enableAutoPipelining: false });
  }
  return redis;
}

export async function getNote(id) {
  if (!ID_RE.test(id || "")) return null;
  return (await db().get(KEY(id))) || null;
}

export async function putNote(id, note) {
  await db().set(KEY(id), note);
}

export async function deleteNote(id) {
  await db().del(KEY(id));
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * True when the request carries the publish key. The server keeps only the
 * key's SHA-256 (saved by /api/claim), so the key itself exists only on the
 * author's Mac.
 */
export async function authorized(request) {
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (given.length < 32) return false;
  const expected = String((await db().get("owner")) || "").replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(sha256(given), "hex"), Buffer.from(expected, "hex"));
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}
