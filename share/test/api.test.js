// Runs the API handlers against an in-memory stand-in for Upstash's REST API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";

const data = new Map();
let server;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const [cmd, key, ...rest] = JSON.parse(body);
      let result = null;
      const c = cmd.toLowerCase();
      if (c === "set") {
        if (rest.map(String).some((a) => a.toLowerCase() === "nx") && data.has(key)) result = null;
        else { data.set(key, rest[0]); result = "OK"; }
      }
      else if (c === "get") result = data.get(key) ?? null;
      else if (c === "del") result = [key, ...rest].filter((k) => data.delete(k)).length;
      else if (c === "sadd") { const s = data.get(key) || new Set(); rest.forEach((m) => s.add(m)); data.set(key, s); result = 1; }
      else if (c === "smembers") result = [...(data.get(key) || [])];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.UPSTASH_REDIS_REST_TOKEN = "test";
  process.env.ZEN_NOTES_SETUP_CODE = "setup-code-123";
});
after(() => server.close());

const ID = "abcdefghijklmnopqrstuv";
const auth = { authorization: `Bearer ${"k".repeat(40)}` };

test("claim needs the setup code and works once", async () => {
  const { POST } = await import("../api/claim.js");
  const keyHash = createHash("sha256").update("k".repeat(40)).digest("hex");
  const claim = (code) => POST(new Request("https://x/api/claim", { method: "POST", body: JSON.stringify({ code, keyHash }) }));
  assert.equal((await claim("wrong")).status, 401);
  assert.equal((await claim("setup-code-123")).status, 200);
  assert.equal((await claim("setup-code-123")).status, 409);
});

test("publish needs the key", async () => {
  const { PUT } = await import("../api/notes.js");
  const res = await PUT(new Request(`https://x/api/notes?id=${ID}`, { method: "PUT", body: "{}", headers: { authorization: "Bearer nope" } }));
  assert.equal(res.status, 401);
});

test("publish, read, view, unpublish", async () => {
  const { PUT } = await import("../api/notes.js");
  const { GET: getNote } = await import("../api/note.js");
  const { GET: view } = await import("../api/view.js");

  const res = await PUT(new Request(`https://x/api/notes?id=${ID}`, {
    method: "PUT", headers: auth,
    body: JSON.stringify({ title: "Hello <b>", markdown: "Hi **there** <script>x</script>\n\n![](attachments/a.png)", files: { "attachments/a.png": "https://blob.example/a.png" } }),
  }));
  assert.equal(res.status, 200);

  const note = await (await getNote(new Request(`https://x/api/note?id=${ID}`))).json();
  assert.equal(note.title, "Hello <b>");
  assert.match(note.html, /<strong>there<\/strong>/);
  assert.match(note.html, /&lt;script&gt;/);
  assert.match(note.html, /src="https:\/\/blob.example\/a.png"/);

  const page = await view(new Request(`https://x/api/view?id=${ID}`));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Hello &lt;b&gt;<\/title>/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/);

  const { PUT: upload } = await import("../api/upload.js");
  const { GET: file } = await import("../api/file.js");
  const { DELETE } = await import("../api/notes.js");
  const up = await upload(new Request(`https://x/api/upload?id=${ID}&name=a.png`, { method: "PUT", headers: { ...auth, "content-type": "image/png" }, body: new Uint8Array([1, 2, 3]) }));
  assert.equal(up.status, 200);
  const { url } = await up.json();
  const [, , fileId, name] = new URL(url).pathname.split("/");
  assert.equal(fileId, ID);
  const got = await file(new Request(`https://x/api/file?id=${ID}&name=${name}`));
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await got.arrayBuffer())], [1, 2, 3]);
  const svg = await upload(new Request(`https://x/api/upload?id=${ID}&name=a.svg`, { method: "PUT", headers: { ...auth, "content-type": "image/svg+xml" }, body: "<svg/>" }));
  assert.equal(svg.status, 415);

  assert.equal((await DELETE(new Request(`https://x/api/notes?id=${ID}`, { method: "DELETE", headers: auth }))).status, 200);
  assert.equal((await file(new Request(`https://x/api/file?id=${ID}&name=${name}`))).status, 404);
  assert.equal((await getNote(new Request(`https://x/api/note?id=${ID}`))).status, 404);
  assert.equal((await view(new Request(`https://x/api/view?id=${ID}`))).status, 404);
});

test("bad ids are rejected", async () => {
  const { GET } = await import("../api/note.js");
  assert.equal((await GET(new Request("https://x/api/note?id=../../etc"))).status, 404);
});
