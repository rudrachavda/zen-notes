// Run with: node --test tidy-tabs/test
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGroups, groupBySite, orderGroups, settleRuns, cleanName, siteName, hostOf,
  buildUserPrompt, askClaude, askOllama, OTHER,
} from "../zen-tidy-tabs.uc.mjs";

test("cleanName trims, title-cases lowercase and caps length", () => {
  assert.equal(cleanName('  "cooking." '), "Cooking");
  assert.equal(cleanName("trip to lisbon"), "Trip To Lisbon");
  assert.equal(cleanName("React Docs"), "React Docs");
  assert.ok(cleanName("A very long group name that keeps going on").length <= 24);
});

test("siteName handles subdomains and country TLDs", () => {
  assert.equal(siteName(hostOf("https://www.youtube.com/watch?v=1")), "Youtube");
  assert.equal(siteName(hostOf("https://docs.google.com/x")), "Google");
  assert.equal(siteName("bbc.co.uk"), "Bbc");
});

test("normalizeGroups puts every id in exactly one group", () => {
  const reply = { groups: [
    { name: "cooking", tabs: [1, 2, 99] },
    { name: "Shopping", tabs: [3, 2] },
    { name: "Cooking", tabs: [4] },
  ] };
  const out = normalizeGroups(reply, [1, 2, 3, 4, 5]);
  assert.deepEqual(out, [
    { name: "Cooking", ids: [1, 2, 4] },
    { name: "Shopping", ids: [3] },
    { name: OTHER, ids: [5] },
  ]);
});

test("normalizeGroups keeps existing names' spelling and survives junk", () => {
  const out = normalizeGroups({ groups: [{ name: "job search", tabs: ["1"] }, { name: "other", tabs: [2] }] }, [1, 2], ["Job Search"]);
  assert.deepEqual(out, [{ name: "Job Search", ids: [1] }, { name: OTHER, ids: [2] }]);
  assert.deepEqual(normalizeGroups(null, [1]), [{ name: OTHER, ids: [1] }]);
});

test("groupBySite groups repeated sites and sends singles to Other", () => {
  const tabs = [
    { id: 1, url: "https://github.com/a" }, { id: 2, url: "https://news.ycombinator.com" },
    { id: 3, url: "https://github.com/b" }, { id: 4, url: "about:blank" },
  ];
  assert.deepEqual(groupBySite(tabs), [{ name: "Github", ids: [1, 3] }, { name: OTHER, ids: [2, 4] }]);
});

test("orderGroups follows first appearance with Other last", () => {
  const out = orderGroups([{ name: OTHER, ids: [1] }, { name: "B", ids: [4, 3] }, { name: "A", ids: [2] }], [1, 2, 3, 4]);
  assert.deepEqual(out.map((g) => g.name), ["A", "B", OTHER]);
  assert.deepEqual(out[1].ids, [3, 4]);
});

test("settleRuns keeps groups contiguous under their header", () => {
  const u = (...g) => g.map((gid) => ({ gid }));
  assert.deepEqual(settleRuns(u(null, null, "a", "a", "b")), [null, null, "a", "a", "b"]);
  assert.deepEqual(settleRuns(u("a", null, "b")), ["a", "a", "b"]);   // loose below a header joins it
  assert.deepEqual(settleRuns(u("a", "b", "a")), ["a", "b", "b"]);   // split group: stray joins header above
  assert.deepEqual(settleRuns(u("a", "a", "b", "b")), ["a", "a", "b", "b"]);
});

test("prompt lists existing groups and short urls", () => {
  const p = buildUserPrompt([{ id: 1, title: "Recipe", url: "https://www.example.com/food/?x=1" }], ["Cooking"]);
  assert.match(p, /Existing groups: "Cooking"/);
  assert.match(p, /"url":"example.com\/food"/);
});

test("askClaude sends a structured-output request and parses the reply", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"groups":[{"name":"Cooking","tabs":[1]}]}' }] }) };
  };
  const out = await askClaude({ apiKey: "k", model: "claude-haiku-5-5", tabs: [{ id: 1, title: "t", url: "https://a.com" }], existing: [], fetchImpl });
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent.init.headers["x-api-key"], "k");
  assert.equal(sent.body.model, "claude-haiku-5-5");
  assert.equal(sent.body.output_config.format.type, "json_schema");
  assert.deepEqual(out, { groups: [{ name: "Cooking", tabs: [1] }] });
});

test("askClaude explains a bad key", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "invalid x-api-key" } }) });
  await assert.rejects(askClaude({ apiKey: "bad", model: "m", tabs: [], existing: [], fetchImpl }), /API key/);
});

test("askOllama posts to /api/chat with the schema", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ message: { content: '{"groups":[]}' } }) };
  };
  await askOllama({ endpoint: "http://localhost:11434/", model: "llama3.1", tabs: [], existing: [], fetchImpl });
  assert.equal(sent.url, "http://localhost:11434/api/chat");
  assert.equal(sent.body.format.type, "object");
});

test("withTimeout rejects at the deadline even if the request ignores abort", async () => {
  const { withTimeout } = await import("../zen-tidy-tabs.uc.mjs");
  const start = Date.now();
  await assert.rejects(withTimeout(() => new Promise(() => {}), 50), (e) => e.name === "AbortError");
  assert.ok(Date.now() - start < 1000);
  let aborted = false;
  await assert.rejects(withTimeout((signal) => new Promise(() => signal.addEventListener("abort", () => { aborted = true; })), 20));
  assert.ok(aborted);
  assert.equal(await withTimeout(async () => "ok", 1000), "ok");
});

test("waveHold keeps the wave for a minimum and ends on a whole period", async () => {
  const { waveHold } = await import("../zen-tidy-tabs.uc.mjs");
  assert.equal(waveHold(100, 1400, 700), 1300);   // fast answer: hold to the minimum
  assert.equal(waveHold(1500, 1400, 700), 600);   // finish the current ripple (2100)
  assert.equal(waveHold(2100, 1400, 700), 0);
});
