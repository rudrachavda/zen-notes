// ==UserScript==
// @name           Zen Tidy Tabs
// @description    Arc-style Tidy Tabs: one click sorts your unpinned tabs under named headers.
// @version        0.1.0
// ==/UserScript==

// Loaded by fx-autoconfig (or Sine) into each Zen browser window.
//
// A broom sits next to "Clear" on the divider above your unpinned tabs. Click it
// (or press ⌘⌥T) and the tab titles and addresses go to Claude, which sorts them
// into a few topics. The tabs are reordered and small grey headers are drawn
// above each topic, like Arc's Today section. New tabs land loose at the top
// until you tidy again, when they join an existing topic or start a new one.
//
// A tab belongs to the header above it, so dragging a tab under another header
// moves it to that group. Headers can be renamed (double-click), and right-click
// gives Ungroup / Close Tabs. Groups are saved with the session.
//
// Settings live in about:config under zen.tidy-tabs.* (see README).

// ---------------------------------------------------------------------------
// Pure logic (no browser globals; unit-tested in node)
// ---------------------------------------------------------------------------

export const OTHER = "Other";
const MAX_NAME = 24;

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// "news.ycombinator.com" -> "Ycombinator", "docs.google.com" -> "Google"
export function siteName(host) {
  const parts = host.split(".").filter(Boolean);
  if (!parts.length) return "";
  let core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  // co.uk, com.au, ...
  if (parts.length >= 3 && core.length <= 3 && ["co", "com", "org", "net", "ac", "gov"].includes(core)) {
    core = parts[parts.length - 3];
  }
  return core.charAt(0).toUpperCase() + core.slice(1);
}

export function cleanName(name) {
  let s = String(name ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/^["'\s]+|["'\s.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME).replace(/\s+\S*$/, "") || s.slice(0, MAX_NAME);
  if (s && s === s.toLowerCase()) s = s.replace(/\b\w/g, (c) => c.toUpperCase());
  return s;
}

const shortUrl = (url) => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return url.slice(0, 80);
    return (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/$/, "").slice(0, 100);
  } catch {
    return String(url).slice(0, 80);
  }
};

export const GROUPS_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          tabs: { type: "array", items: { type: "integer" } },
        },
        required: ["name", "tabs"],
        additionalProperties: false,
      },
    },
  },
  required: ["groups"],
  additionalProperties: false,
};

export const SYSTEM_PROMPT = `You tidy up someone's open browser tabs, like Arc browser's "Tidy Tabs".
Sort the tabs into a small number of groups by topic or task, the way a person would label piles on their desk.

Rules:
- Group names are 1 to 3 words in Title Case, plain and specific: "Cooking", "Shopping", "Trip to Lisbon", "React Docs", "Job Search". No emojis, no punctuation, no generic names like "Websites" or "Misc".
- Prefer the subject over the website: a recipe on YouTube goes with other recipes, not with other YouTube videos.
- Aim for groups of 2 or more tabs. Usually 2 to 6 groups in total; fewer is fine for few tabs.
- A tab that fits no group goes in a group named exactly "Other". Only use "Other" when needed.
- If existing groups are listed, put tabs into them when they fit, using the exact existing name. You may also make new groups.
- Every tab id must appear in exactly one group. Use only the ids given.`;

export function buildUserPrompt(tabs, existingGroups = []) {
  const lines = tabs.map((t) => JSON.stringify({ id: t.id, title: (t.title || "").slice(0, 120), url: shortUrl(t.url || "") }));
  let text = "";
  if (existingGroups.length) {
    text += `Existing groups: ${existingGroups.map((n) => JSON.stringify(n)).join(", ")}\n\n`;
  }
  text += `Tabs:\n${lines.join("\n")}`;
  return text;
}

// Turns a model reply into a clean list of {name, ids}. Every id in `ids` ends up
// in exactly one group; unknown ids are dropped, missing ones go to "Other".
// Names that match an existing group (case-insensitively) take its exact spelling.
export function normalizeGroups(reply, ids, existingNames = []) {
  const valid = new Set(ids);
  const seen = new Set();
  const byKey = new Map();
  const order = [];
  const canon = new Map(existingNames.map((n) => [n.toLowerCase(), n]));
  const add = (rawName, id) => {
    let name = cleanName(rawName) || OTHER;
    if (name.toLowerCase() === OTHER.toLowerCase()) name = OTHER;
    name = canon.get(name.toLowerCase()) ?? name;
    const key = name.toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, { name, ids: [] });
      order.push(key);
    }
    byKey.get(key).ids.push(id);
  };
  const groups = Array.isArray(reply?.groups) ? reply.groups : [];
  for (const g of groups) {
    for (const raw of Array.isArray(g?.tabs) ? g.tabs : []) {
      const id = Number(raw);
      if (!valid.has(id) || seen.has(id)) continue;
      seen.add(id);
      add(g.name, id);
    }
  }
  for (const id of ids) if (!seen.has(id)) add(OTHER, id);
  return order.map((k) => byKey.get(k)).filter((g) => g.ids.length);
}

// Offline grouping when no AI is set up: tabs from the same site go together.
export function groupBySite(tabs) {
  const bySite = new Map();
  for (const t of tabs) {
    const name = siteName(hostOf(t.url || "")) || OTHER;
    if (!bySite.has(name)) bySite.set(name, []);
    bySite.get(name).push(t.id);
  }
  const groups = [];
  const other = [];
  for (const [name, ids] of bySite) {
    if (ids.length >= 2 && name !== OTHER) groups.push({ name, ids });
    else other.push(...ids);
  }
  if (other.length) groups.push({ name: OTHER, ids: other });
  return groups;
}

// Groups appear in the order their first tab appeared, with "Other" last.
export function orderGroups(groups, idOrder) {
  const pos = new Map(idOrder.map((id, i) => [id, i]));
  const first = (g) => Math.min(...g.ids.map((id) => pos.get(id) ?? Infinity));
  return groups
    .map((g) => ({ ...g, ids: [...g.ids].sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0)) }))
    .sort((a, b) => (a.name === OTHER) - (b.name === OTHER) || first(a) - first(b));
}

// Given units in sidebar order as [{key, gid}], returns the gid each unit should
// have so that every group is one contiguous run under its header: a unit
// whose group already ended above it, or a loose unit below a group, joins the
// group of the unit just above it. Loose units at the very top stay loose.
export function settleRuns(units) {
  const done = new Set();
  const out = [];
  let prev = null;
  for (const u of units) {
    let gid = u.gid || null;
    if (gid && gid !== prev && done.has(gid)) gid = prev;
    if (!gid && prev) gid = prev;
    if (prev && gid !== prev) done.add(prev);
    out.push(gid);
    prev = gid;
  }
  return out;
}

// ---------------------------------------------------------------------------
// AI providers
// ---------------------------------------------------------------------------

export async function askClaude({ apiKey, model, tabs, existing, signal, fetchImpl = fetch }) {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      output_config: { effort: "low", format: { type: "json_schema", schema: GROUPS_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(tabs, existing) }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(res.status === 401 ? "Claude didn't accept the API key." : `Claude: ${msg}`);
  }
  if (body.stop_reason === "refusal") throw new Error("Claude declined to sort these tabs.");
  const text = (body.content || []).find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`Claude returned no groups (${body.stop_reason || "empty"}).`);
  return JSON.parse(text);
}

export async function askOllama({ endpoint, model, tabs, existing, signal, fetchImpl = fetch }) {
  const res = await fetchImpl(`${endpoint.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: GROUPS_SCHEMA,
      options: { temperature: 0.2 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(tabs, existing) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama: HTTP ${res.status}. Is it running with "${model}" pulled?`);
  const body = await res.json();
  return JSON.parse(body?.message?.content || "{}");
}

// ---------------------------------------------------------------------------
// Browser side
// ---------------------------------------------------------------------------

const PREF = "zen.tidy-tabs.";
const TAB_KEY = "zenTidyGroup";
const WIN_KEY = "zenTidyGroups";
const RESOURCE_DIR = ["chrome", "resources", "zen-tidy-tabs"];
const XHTML = "http://www.w3.org/1999/xhtml";

// The broom icon. install.sh puts default-broom.svg in
// <profile>/chrome/resources/zen-tidy-tabs/, loaded through chrome:// because
// Firefox only applies context-fill (the sidebar's text colour) to chrome://
// images. This inline copy, in a fixed grey, is only a fallback.
const BROOM_FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" fill="#8e8e93">
<path d="M19.9132 21.3765C19.8875 21.0162 19.6455 20.7069 19.3007 20.5993L7.21755 16.8291C6.87269 16.7215 6.49768 16.8384 6.27165 17.1202C5.73893 17.7845 4.72031 19.025 3.78544 19.9965C2.4425 21.392 3.01177 22.4772 4.66526 22.9931C4.82548 23.0431 5.78822 21.7398 6.20045 21.7398C6.51906 21.8392 6.8758 23.6828 7.26122 23.8031C7.87402 23.9943 8.55929 24.2081 9.27891 24.4326C9.59033 24.5298 10.2101 23.0557 10.5313 23.1559C10.7774 23.2327 10.7236 24.8834 10.9723 24.961C11.8322 25.2293 12.699 25.4997 13.5152 25.7544C13.868 25.8645 14.8344 24.3299 15.1637 24.4326C15.496 24.5363 15.191 26.2773 15.4898 26.3705C16.7587 26.7664 17.6824 27.0546 17.895 27.1209C19.5487 27.6369 20.6333 27.068 20.3226 25.1563C20.1063 23.8255 19.9737 22.2258 19.9132 21.3765Z"/>
<path d="M16.719 1.7134C17.4929 -0.767192 20.7999 0.264626 20.026 2.74523C19.2521 5.22583 18.1514 8.75696 17.9629 9.36C17.7045 10.1867 16.1569 15.1482 15.899 15.9749L19.2063 17.0068C20.8597 17.5227 20.205 19.974 18.4514 19.4268L8.52918 16.331C6.87208 15.8139 7.62682 13.3938 9.28426 13.911L12.5916 14.9429C12.8495 14.1163 14.3976 9.15491 14.6555 8.32807C14.9135 7.50122 15.9451 4.19399 16.719 1.7134Z"/>
</svg>`;

// Pre-computed keyframes for Arc's CASpringAnimation(mass: 1.5, stiffness: 150, damping: 15, initialVelocity: 8).
function broomSpringKeyframes(fromDeg, toDeg) {
  const mass = 1.5, stiffness = 150, damping = 15, initialVelocity = 8;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  const duration = 0.9;
  const steps = 45;
  const frames = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * duration;
    const env = Math.exp(-zeta * w0 * t);
    const progress = 1 - env * (Math.cos(wd * t) + ((zeta * w0 - initialVelocity) / wd) * Math.sin(wd * t));
    const angle = fromDeg + (toDeg - fromDeg) * progress;
    frames.push({ transform: `rotate(${angle.toFixed(2)}deg)` });
  }
  return frames;
}
const BROOM_SWEEP_OUT = broomSpringKeyframes(0, 25);
const BROOM_SWEEP_BACK = broomSpringKeyframes(25, 0);
const BROOM_SPRING_MS = 900;
const BROOM_RETURN_DELAY_MS = 400;

// One period of the "thinking" wave on the divider.
const WAVE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 6"><path d="M0 3 C2 0.6 4 0.6 6 3 S10 5.4 12 3" fill="none" stroke="black" stroke-width="1.3"/></svg>`;

const svgUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

function css(broomUrl) {
  return `
.zen-tidy-broom {
  list-style-image: ${broomUrl};
  -moz-context-properties: fill, fill-opacity;
  fill: currentColor;
  width: 20px;
  height: 20px;
  padding: 4px !important;
  border-radius: 4px;
  align-items: center;
  justify-content: center;
  background-size: 100% 1px;
  transition: background-color 0.12s, transform 0.12s;
  & .toolbarbutton-icon {
    width: 12px;
    height: 12px;
    transform-origin: 60% 0%;
    transform: none;
    transition: opacity 0.15s !important;
  }
  &:active:hover .toolbarbutton-icon {
    transform: none;
  }
  & .toolbarbutton-text { display: none !important; }
  &:hover:not([disabled]) {
    background-color: light-dark(rgba(0,0,0,.07), rgba(255,255,255,.1)) !important;
  }
  &:hover:active:not([disabled]) {
    background-color: light-dark(rgba(0,0,0,.11), rgba(255,255,255,.15)) !important;
    transform: scale(0.96);
  }
  &[disabled] {
    opacity: 0.4;
    pointer-events: none !important;
  }
}
.pinned-tabs-container-separator:has(.zen-tidy-broom) {
  gap: 0;
  #navigator-toolbox[zen-has-implicit-hover="true"] & toolbarseparator {
    margin-inline-end: 4px;
  }
  & .zen-workspace-close-unpinned-tabs-button {
    padding-inline-start: 4px;
  }
}
/* Arc shows the divider whenever there are tabs to tidy, even with no pins. */
.zen-workspace-pinned-tabs-section[hide-separator][zen-tidy-ready] .pinned-tabs-container-separator {
  height: 22px !important;
  opacity: 1 !important;
}
.zen-workspace-pinned-tabs-section:not([zen-tidy-ready]):not([zen-tidy-busy]) .zen-tidy-broom {
  display: none;
}
/* While Claude is thinking the divider line turns into a moving wave. */
.zen-workspace-pinned-tabs-section[zen-tidy-busy] .pinned-tabs-container-separator {
  & toolbarseparator {
    height: 6px !important;
    background: light-dark(rgba(0,0,0,.35), rgba(255,255,255,.4)) !important;
    mask: ${svgUrl(WAVE_SVG)} 0 50% / 12px 6px repeat-x;
    animation: zen-tidy-wave 0.7s linear infinite;
  }
  & toolbarbutton { background-image: none !important; }
  & .zen-tidy-broom,
  & .zen-tidy-broom .toolbarbutton-icon { opacity: 1 !important; }
}
@keyframes zen-tidy-wave { to { mask-position: -12px 50%; } }
@media (prefers-reduced-motion: reduce) {
  .zen-workspace-pinned-tabs-section[zen-tidy-busy] .pinned-tabs-container-separator toolbarseparator { animation-duration: 3s; }
}

.zen-tidy-header {
  display: flex;
  align-items: center;
  min-height: 26px;
  padding: 8px 6px 2px 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: light-dark(rgba(0,0,0,.42), rgba(255,255,255,.45));
  user-select: none;
  -moz-user-focus: ignore;
  animation: zen-tidy-in 0.18s ease-out;
  :root:not([zen-sidebar-expanded="true"]) & { display: none; }
  & .zen-tidy-label {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  & .zen-tidy-rename {
    flex: 1;
    min-width: 0;
    font: inherit;
    color: light-dark(rgba(0,0,0,.8), rgba(255,255,255,.85));
    background: light-dark(rgba(0,0,0,.06), rgba(255,255,255,.08));
    border: none;
    border-radius: 4px;
    padding: 1px 4px;
    margin-inline-start: -4px;
    outline: none;
  }
  & .zen-tidy-btn {
    appearance: none;
    border: none;
    background: transparent;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    padding: 3px;
    margin-inline-start: 2px;
    opacity: 0;
    cursor: default;
    transition: opacity 0.12s, background-color 0.12s;
    color: var(--zen-tidy-icon-color, var(--toolbox-textcolor, light-dark(#1a1a1a, #ffffff)));
    & .zen-tidy-btn-icon {
      display: block;
      width: 14px;
      height: 14px;
      background-color: currentColor;
      mask: var(--zen-tidy-btn-icon) center / 14px 14px no-repeat;
      pointer-events: none;
    }
    &:hover {
      opacity: 1 !important;
      background-color: color-mix(in srgb, currentColor 14%, transparent);
    }
  }
  &:hover .zen-tidy-btn { opacity: 0.85; }
}
.zen-tidy-note {
  margin: 4px 8px 6px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.35;
  color: light-dark(rgba(0,0,0,.7), rgba(255,255,255,.8));
  background: light-dark(rgba(0,0,0,.05), rgba(255,255,255,.07));
  animation: zen-tidy-in 0.18s ease-out;
}
@keyframes zen-tidy-in { from { opacity: 0; transform: translateY(-3px); } }
`;
}

class TidyTabs {
  groups = new Map(); // gid -> { name, ws }
  #undo = null; // { ws, order: [{tab, gid}], groups: Map }
  #moving = 0;
  #pending = false;
  #busy = new Set(); // workspace ids
  #fresh = new WeakSet();
  #moved = new WeakSet();
  #observed = new WeakSet();
  #observer = null;
  #menuTarget = null;

  // --- prefs ---------------------------------------------------------------
  pref(name, fallback) {
    const key = PREF + name;
    try {
      switch (Services.prefs.getPrefType(key)) {
        case Services.prefs.PREF_STRING: return Services.prefs.getStringPref(key);
        case Services.prefs.PREF_INT: return Services.prefs.getIntPref(key);
        case Services.prefs.PREF_BOOL: return Services.prefs.getBoolPref(key);
      }
    } catch {}
    return fallback;
  }

  // --- startup -------------------------------------------------------------
  async init() {
    await gZenWorkspaces.promiseInitialized;
    try {
      await SessionStore.promiseAllWindowsRestored;
    } catch {}
    await this.#loadStyles();
    this.#loadGroups();
    this.#buildMenus();

    this.#observer = new MutationObserver((records) => {
      const relevant = records.some((r) =>
        [...r.addedNodes, ...r.removedNodes].some((n) => !n.classList?.contains("zen-tidy-header") && !n.classList?.contains("zen-tidy-note"))
      );
      if (relevant) this.schedule();
    });
    const strip = document.getElementById("tabbrowser-arrowscrollbox");
    if (strip) {
      new MutationObserver(() => {
        this.#attachAll();
        this.schedule();
      }).observe(strip, { childList: true });
    }
    this.#attachAll();

    const tc = gBrowser.tabContainer;
    tc.addEventListener("TabOpen", (e) => {
      if (!this.#moving) this.#fresh.add(e.target);
      this.schedule();
    });
    tc.addEventListener("TabMove", (e) => {
      if (!this.#moving) this.#moved.add(e.target);
      this.schedule();
    });
    for (const ev of ["TabClose", "TabPinned", "TabUnpinned", "TabSelect", "TabShow", "TabHide"]) {
      tc.addEventListener(ev, () => this.schedule());
    }
    tc.addEventListener("SSTabRestoring", (e) => {
      const gid = SessionStore.getCustomTabValue(e.target, TAB_KEY);
      if (gid && this.groups.has(gid) && !e.target.getAttribute("zen-tidy-group")) {
        e.target.setAttribute("zen-tidy-group", gid);
        this.schedule();
      }
    });
    window.addEventListener("ZenWorkspacesUIUpdate", () => this.schedule());
    window.addEventListener("keydown", (e) => this.#onKey(e), true);
    this.schedule();
  }

  async #loadStyles() {
    let broom = svgUrl(BROOM_FALLBACK_SVG);
    // Your own icon (broom.svg / broom.png) wins over the bundled one.
    for (const name of ["broom.svg", "broom.png", "default-broom.svg"]) {
      try {
        const path = PathUtils.join(PathUtils.profileDir, ...RESOURCE_DIR, name);
        if (await IOUtils.exists(path)) {
          broom = `url("chrome://userchrome/content/zen-tidy-tabs/${name}")`;
          break;
        }
      } catch {}
    }
    const uri = Services.io.newURI(`data:text/css;charset=utf-8,${encodeURIComponent(css(broom))}`);
    window.windowUtils.loadSheet(uri, window.windowUtils.AUTHOR_SHEET);
  }

  #loadGroups() {
    try {
      const saved = JSON.parse(SessionStore.getCustomWindowValue(window, WIN_KEY) || "{}");
      for (const [gid, g] of Object.entries(saved)) this.groups.set(gid, { name: g.name, ws: g.ws });
    } catch {}
    for (const tab of gBrowser.tabs) {
      const gid = SessionStore.getCustomTabValue(tab, TAB_KEY);
      if (gid && this.groups.has(gid)) tab.setAttribute("zen-tidy-group", gid);
    }
  }

  #saveGroups() {
    const out = {};
    for (const [gid, g] of this.groups) out[gid] = { name: g.name, ws: g.ws };
    try {
      SessionStore.setCustomWindowValue(window, WIN_KEY, JSON.stringify(out));
    } catch (e) {
      console.warn("Tidy Tabs: couldn't save groups", e);
    }
  }

  #setGid(tab, gid) {
    const unit = this.#tabsOf(tab);
    for (const t of unit) {
      if ((t.getAttribute("zen-tidy-group") || null) === (gid || null)) continue;
      if (gid) {
        t.setAttribute("zen-tidy-group", gid);
        try { SessionStore.setCustomTabValue(t, TAB_KEY, gid); } catch {}
      } else {
        t.removeAttribute("zen-tidy-group");
        try { SessionStore.deleteCustomTabValue(t, TAB_KEY); } catch {}
      }
    }
  }

  // --- sidebar structure ---------------------------------------------------
  #workspaces() {
    return [...document.querySelectorAll("zen-workspace")].filter((ws) => ws.tabsContainer);
  }

  #attachAll() {
    for (const ws of this.#workspaces()) {
      if (!this.#observed.has(ws.tabsContainer)) {
        this.#observed.add(ws.tabsContainer);
        this.#observer.observe(ws.tabsContainer, { childList: true });
      }
      const sep = ws.pinnedTabsContainer?.separatorElement ??
        ws.pinnedTabsContainer?.querySelector(".pinned-tabs-container-separator");
      if (sep && !sep.querySelector(".zen-tidy-broom")) {
        const btn = document.createXULElement("toolbarbutton");
        btn.className = "zen-tidy-broom";
        btn.setAttribute("label", "Tidy");
        btn.setAttribute("tooltiptext", `Tidy tabs (${AppConstants.platform === "macosx" ? "⌘⌥T" : "Ctrl+Alt+T"})`);
        btn.setAttribute("context", "zen-tidy-broom-menu");
        for (const ev of ["mousedown", "click", "dblclick", "command"]) {
          btn.addEventListener(
            ev,
            (e) => {
              if (this.#busy.has(ws.id) || btn.hasAttribute("disabled") || btn._sweeping) {
                e.preventDefault();
                e.stopImmediatePropagation();
              }
            },
            true
          );
        }
        btn.addEventListener("command", () => this.tidy(ws));
        const clear = sep.querySelector(".zen-workspace-close-unpinned-tabs-button");
        if (clear) clear.before(btn);
        else sep.append(btn);
      }
    }
  }

  // Runs once when a tidy starts — never on hover, and never re-triggered while tidying.
  #sweepBroom(btn, ws) {
    if (!btn || btn._sweeping || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const icon = btn.querySelector(".toolbarbutton-icon") ?? btn.icon;
    if (!icon?.animate) return;
    btn._sweeping = true;
    icon.animate(BROOM_SWEEP_OUT, { duration: BROOM_SPRING_MS, fill: "forwards" });
    btn._sweepTimer = setTimeout(() => {
      const back = icon.animate(BROOM_SWEEP_BACK, { duration: BROOM_SPRING_MS, fill: "forwards" });
      btn._sweepTimer = setTimeout(() => {
        btn._sweepTimer = null;
        btn._sweeping = false;
        back?.cancel?.();
        icon.getAnimations?.().forEach((a) => a.cancel());
        if (ws && !this.#busy.has(ws.id)) btn.removeAttribute("disabled");
      }, BROOM_SPRING_MS);
    }, BROOM_RETURN_DELAY_MS);
  }

  // A sidebar "unit" is a plain tab or a split view (moved and grouped as one).
  #isUnit(el) {
    if (gBrowser.isTab(el)) return !el.pinned && !el.hasAttribute("zen-empty-tab") && !el.hasAttribute("zen-essential") && !el.closing;
    return el.tagName === "tab-split-view-wrapper" || (gBrowser.isTabGroup?.(el) && el.hasAttribute("split-view-group"));
  }

  #tabsOf(unit) {
    return gBrowser.isTab(unit) ? [unit] : [...(unit.tabs ?? [])];
  }

  #unitOf(tab) {
    const parent = tab.parentElement;
    if (parent?.tagName === "tab-split-view-wrapper") return parent;
    const group = tab.group;
    if (group?.hasAttribute?.("split-view-group")) return group;
    return tab;
  }

  #units(container) {
    return [...container.children].filter((el) => this.#isUnit(el));
  }

  #gidOf(unit) {
    const t = this.#tabsOf(unit)[0];
    const gid = t?.getAttribute("zen-tidy-group");
    return gid && this.groups.has(gid) ? gid : null;
  }

  // --- rendering -----------------------------------------------------------
  schedule() {
    if (this.#pending) return;
    this.#pending = true;
    requestAnimationFrame(() => {
      this.#pending = false;
      try {
        this.#render();
      } catch (e) {
        console.error("Tidy Tabs:", e);
      }
    });
  }

  #render() {
    this.#attachAll();
    const minTabs = this.pref("min-tabs", 4);
    const live = new Set();
    for (const ws of this.#workspaces()) {
      const container = ws.tabsContainer;
      let units = this.#units(container);
      const hasGroups = units.some((u) => this.#gidOf(u));

      if (hasGroups) {
        // Tabs the user dragged join the header above where they were dropped.
        for (const u of units) {
          const tab = this.#tabsOf(u)[0];
          if (!tab || !this.#moved.has(tab)) continue;
          this.#moved.delete(tab);
          if (this.#fresh.has(tab)) continue;
          this.#setGid(u, this.#gidAbove(u));
        }
        // New tabs: join the opener's group if opened right below it,
        // otherwise go loose at the top, like Arc.
        const moves = [];
        for (const u of units) {
          const tab = this.#tabsOf(u)[0];
          if (!tab || !this.#fresh.has(tab)) continue;
          this.#fresh.delete(tab);
          const restored = SessionStore.getCustomTabValue(tab, TAB_KEY);
          if (restored && this.groups.has(restored)) {
            this.#setGid(u, restored);
            continue;
          }
          const i = units.indexOf(u);
          const prevGid = i > 0 ? this.#gidOf(units[i - 1]) : null;
          const nextGid = i < units.length - 1 ? this.#gidOf(units[i + 1]) : null;
          const openerGid = tab.openerTab ? this.#gidOf(this.#unitOf(tab.openerTab)) : null;
          if (prevGid && (prevGid === nextGid || prevGid === openerGid)) {
            this.#setGid(u, prevGid);
          } else {
            this.#setGid(u, null);
            // Loose tabs live above the first header; only move it if it landed below one.
            if (prevGid) moves.push(u);
          }
        }
        if (moves.length) {
          this.#moveToTop(container, moves);
          units = this.#units(container);
        }
        // Keep each group in one run under its header.
        const settled = settleRuns(units.map((u) => ({ gid: this.#gidOf(u) })));
        units.forEach((u, i) => this.#setGid(u, settled[i]));
      } else {
        for (const u of units) {
          const tab = this.#tabsOf(u)[0];
          this.#fresh.delete(tab);
          this.#moved.delete(tab);
        }
      }

      // Draw headers.
      const existing = new Map();
      for (const h of container.querySelectorAll(":scope > .zen-tidy-header")) existing.set(h.getAttribute("gid"), h);
      let prev = null;
      for (const u of units) {
        const gid = this.#gidOf(u);
        if (gid && gid !== prev) {
          live.add(gid);
          let h = existing.get(gid);
          existing.delete(gid);
          if (!h) h = this.#makeHeader(gid);
          const label = h.querySelector(".zen-tidy-label");
          if (label && label.textContent !== this.groups.get(gid).name) label.textContent = this.groups.get(gid).name;
          if (u.previousElementSibling !== h) u.before(h);
        }
        prev = gid;
      }
      for (const h of existing.values()) h.remove();

      // Show the broom when there's enough to tidy.
      const pinned = ws.pinnedTabsContainer;
      const loose = units.filter((u) => !this.#gidOf(u)).length;
      const ready = units.length >= minTabs && (loose > 0 || hasGroups);
      if (pinned) {
        if (ready) pinned.setAttribute("zen-tidy-ready", "true");
        else pinned.removeAttribute("zen-tidy-ready");
      }
      this.#syncSpaceColor(ws);
    }

    // Forget groups whose tabs are all gone.
    let changed = false;
    for (const gid of this.groups.keys()) {
      if (!live.has(gid) && !gBrowser.tabs.some((t) => t.getAttribute("zen-tidy-group") === gid)) {
        this.groups.delete(gid);
        changed = true;
      }
    }
    if (changed) this.#saveGroups();
  }

  #gidAbove(unit) {
    for (let el = unit.previousElementSibling; el; el = el.previousElementSibling) {
      if (el.classList?.contains("zen-tidy-header")) return el.getAttribute("gid");
      if (this.#isUnit(el)) return this.#gidOf(el);
    }
    return null;
  }

  #moveToTop(container, moves) {
    this.#moving++;
    try {
      for (const u of moves.reverse()) {
        const first = this.#units(container)[0];
        if (!first || first === u) continue;
        const target = this.#tabsOf(first)[0];
        gBrowser.moveTabTo(u, { tabIndex: gBrowser.tabs.indexOf(target), forceUngrouped: true });
      }
    } finally {
      this.#moving--;
    }
  }

  // Puts `ordered` units in this order, starting where the first unit is now.
  #reorder(container, ordered) {
    this.#moving++;
    try {
      for (let i = 0; i < ordered.length; i++) {
        const current = this.#units(container);
        if (current[i] === ordered[i]) continue;
        const target = this.#tabsOf(current[i])[0];
        if (!target) continue;
        gBrowser.moveTabTo(ordered[i], { tabIndex: gBrowser.tabs.indexOf(target), forceUngrouped: true });
      }
    } finally {
      this.#moving--;
    }
  }

  #syncSpaceColor(ws) {
    try {
      const wsObj =
        window.gZenWorkspaces?.getWorkspaceFromId?.(ws.id) ??
        window.gZenWorkspaces?.getActiveWorkspaceFromCache?.();
      const theme = wsObj && window.gZenThemePicker?.getGradientForWorkspace?.(wsObj);
      const c = theme?.toolbarColor;
      if (Array.isArray(c) && c.length >= 3) {
        ws.style.setProperty("--zen-tidy-icon-color", `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
      } else {
        ws.style.removeProperty("--zen-tidy-icon-color");
      }
    } catch {
      ws.style.removeProperty("--zen-tidy-icon-color");
    }
  }

  #makeHeader(gid) {
    const h = document.createElementNS(XHTML, "div");
    h.className = "zen-tidy-header";
    h.setAttribute("gid", gid);
    h.setAttribute("context", "zen-tidy-header-menu");
    const label = document.createElementNS(XHTML, "span");
    label.className = "zen-tidy-label";
    // Hover buttons, like Arc's: turn the group into a Zen folder, or close its tabs.
    const button = (icon, title, fn) => {
      const b = document.createElementNS(XHTML, "button");
      b.className = "zen-tidy-btn";
      b.title = title;
      const span = document.createElementNS(XHTML, "span");
      span.className = "zen-tidy-btn-icon";
      span.style.setProperty("--zen-tidy-btn-icon", `url("chrome://browser/skin/zen-icons/${icon}.svg")`);
      b.append(span);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    const folder = button("folder", "Move to a Zen folder", () => this.makeFolder(gid));
    const close = button("close", "Close tabs in this group", () => this.closeGroup(gid));
    for (const ev of ["mousedown", "dragstart"]) h.addEventListener(ev, (e) => e.stopPropagation());
    label.addEventListener("dblclick", () => this.rename(gid));
    h.append(label, folder, close);
    return h;
  }

  // --- actions -------------------------------------------------------------
  #wsOf(container) {
    return container.closest("zen-workspace");
  }

  #describe(unit, id) {
    const tab = this.#tabsOf(unit)[0];
    let url = "";
    try {
      url = tab.linkedBrowser?.currentURI?.spec || "";
    } catch {}
    if (!url || url === "about:blank") {
      try {
        url = SessionStore.getLazyTabValue(tab, "url") || url;
      } catch {}
    }
    const titles = this.#tabsOf(unit).map((t) => t.label).filter(Boolean);
    return { id, title: titles.join(" | "), url };
  }

  async tidy(ws = gZenWorkspaces.activeWorkspaceElement) {
    const btn = ws?.pinnedTabsContainer?.querySelector(".zen-tidy-broom");
    if (!ws?.tabsContainer || this.#busy.has(ws.id) || btn?._sweeping) return;
    const container = ws.tabsContainer;
    let units = this.#units(container);
    if (units.length < 2) return;

    const looseUnits = units.filter((u) => !this.#gidOf(u));
    // With loose tabs, place just those (existing groups stay). Otherwise re-sort everything.
    const partial = looseUnits.length > 0 && looseUnits.length < units.length;
    const toPlace = partial ? looseUnits : units;
    const existingGids = partial ? [...new Set(units.map((u) => this.#gidOf(u)).filter(Boolean))] : [];
    const existingNames = existingGids.map((g) => this.groups.get(g).name);

    const described = toPlace.map((u, i) => this.#describe(u, i + 1));
    const ids = described.map((d) => d.id);

    this.#setBusy(ws, true);
    try {
      let result;
      try {
        result = await this.#ask(described, existingNames);
      } catch (e) {
        console.error("Tidy Tabs:", e);
        this.#note(ws, e.name === "AbortError" ? "Tidying took too long, so I stopped." : `Couldn't tidy: ${e.message}`);
        return;
      }

      // Tabs may have changed while we waited.
      units = this.#units(container);
      const unitById = new Map();
      toPlace.forEach((u, i) => {
        if (units.includes(u)) unitById.set(i + 1, u);
      });
      const groups = orderGroups(
        normalizeGroups(result, ids, existingNames).map((g) => ({ ...g, ids: g.ids.filter((id) => unitById.has(id)) })).filter((g) => g.ids.length),
        ids
      );

      this.#undo = {
        ws: ws.id,
        order: units.map((u) => ({ unit: u, gid: this.#gidOf(u) })),
        groups: new Map(this.groups),
      };

      // Map names to group ids (reusing existing ones in partial mode).
      const gidByName = new Map(existingGids.map((g) => [this.groups.get(g).name.toLowerCase(), g]));
      if (!partial) {
        for (const g of this.groups.keys()) if (this.groups.get(g).ws === ws.id) this.groups.delete(g);
      }
      const assignment = new Map(); // unit -> gid
      for (const g of groups) {
        let gid = gidByName.get(g.name.toLowerCase());
        if (!gid) {
          gid = `tidy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
          this.groups.set(gid, { name: g.name, ws: ws.id });
          gidByName.set(g.name.toLowerCase(), gid);
        }
        for (const id of g.ids) assignment.set(unitById.get(id), gid);
      }
      for (const u of units) {
        if (assignment.has(u)) continue;
        if (partial && this.#gidOf(u)) assignment.set(u, this.#gidOf(u));
      }

      // Final order: groups in order (existing groups first, keeping their tabs'
      // order, then new ones, Other last); anything unassigned stays on top.
      const gidOrder = [];
      const seenGid = new Set();
      const push = (gid) => !seenGid.has(gid) && seenGid.add(gid) && gidOrder.push(gid);
      if (partial) existingGids.filter((g) => this.groups.get(g).name !== OTHER).forEach(push);
      groups.filter((g) => g.name !== OTHER).forEach((g) => push(gidByName.get(g.name.toLowerCase())));
      const otherGid = gidByName.get(OTHER.toLowerCase());
      if (otherGid) push(otherGid);

      const ordered = units.filter((u) => !assignment.has(u));
      for (const gid of gidOrder) ordered.push(...units.filter((u) => assignment.get(u) === gid));

      for (const u of units) this.#setGid(u, assignment.get(u) || null);
      this.#reorder(container, ordered);
      this.#saveGroups();
      this.#render();
    } finally {
      this.#setBusy(ws, false);
    }
  }

  async #ask(tabs, existing) {
    const provider = this.pref("provider", "claude");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.pref("timeout-seconds", 45) * 1000);
    try {
      if (provider === "ollama") {
        return await askOllama({
          endpoint: this.pref("ollama-endpoint", "http://localhost:11434"),
          model: this.pref("ollama-model", "llama3.1"),
          tabs, existing, signal: controller.signal,
        });
      }
      if (provider === "site") {
        return { groups: groupBySite(tabs).map((g) => ({ name: g.name, tabs: g.ids })) };
      }
      let apiKey = this.pref("claude-api-key", "");
      if (!apiKey) apiKey = this.promptForKey();
      if (!apiKey) {
        // No key: fall back to grouping by website so the broom still does something.
        return { groups: groupBySite(tabs).map((g) => ({ name: g.name, tabs: g.ids })) };
      }
      return await askClaude({
        apiKey,
        model: this.pref("claude-model", "claude-haiku-5-5"),
        tabs, existing, signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  promptForKey() {
    const input = { value: this.pref("claude-api-key", "") };
    const ok = Services.prompt.prompt(
      window,
      "Tidy Tabs",
      "Paste a Claude API key to name groups with AI (get one at console.anthropic.com).\n\nIt's kept in Zen's preferences on this Mac. Leave it empty to group tabs by website instead.",
      input,
      null,
      { value: false }
    );
    if (!ok) return "";
    const key = input.value.trim();
    Services.prefs.setStringPref(PREF + "claude-api-key", key);
    return key;
  }

  undo() {
    const u = this.#undo;
    if (!u) return;
    this.#undo = null;
    const ws = gZenWorkspaces.workspaceElement(u.ws);
    if (!ws?.tabsContainer) return;
    this.groups = new Map(u.groups);
    const units = this.#units(ws.tabsContainer);
    const order = u.order.map((o) => o.unit).filter((x) => units.includes(x));
    for (const o of u.order) if (units.includes(o.unit)) this.#setGid(o.unit, o.gid && this.groups.has(o.gid) ? o.gid : null);
    const rest = units.filter((x) => !order.includes(x));
    this.#reorder(ws.tabsContainer, [...rest, ...order]);
    this.#saveGroups();
    this.#render();
  }

  ungroup(gid) {
    const ws = gZenWorkspaces.workspaceElement(this.groups.get(gid)?.ws) ?? gZenWorkspaces.activeWorkspaceElement;
    const members = gBrowser.tabs.filter((t) => t.getAttribute("zen-tidy-group") === gid);
    for (const t of members) this.#setGid(t, null);
    this.groups.delete(gid);
    // Loose tabs live at the top, so move them there.
    if (ws?.tabsContainer) {
      const units = [...new Set(members.map((t) => this.#unitOf(t)))].filter((x) => x.parentElement === ws.tabsContainer);
      this.#moveToTop(ws.tabsContainer, units);
    }
    this.#saveGroups();
    this.#render();
  }

  ungroupAll(ws = gZenWorkspaces.activeWorkspaceElement) {
    for (const [gid, g] of [...this.groups]) {
      if (g.ws === ws?.id) {
        for (const t of gBrowser.tabs) if (t.getAttribute("zen-tidy-group") === gid) this.#setGid(t, null);
        this.groups.delete(gid);
      }
    }
    this.#saveGroups();
    this.#render();
  }

  // Arc's "convert to folder": the group's tabs become a pinned Zen folder named
  // after the header, at the bottom of the space's pinned section.
  makeFolder(gid) {
    const group = this.groups.get(gid);
    if (!group || !window.gZenFolders?.createFolder) return;
    const tabs = gBrowser.tabs.filter((t) => t.getAttribute("zen-tidy-group") === gid && !t.pinned);
    if (!tabs.length) return;
    for (const t of tabs) this.#setGid(t, null);
    this.groups.delete(gid);
    this.#saveGroups();
    try {
      gZenFolders.createFolder(tabs, { label: group.name, workspaceId: group.ws });
    } catch (e) {
      console.error("Tidy Tabs: couldn't make a folder", e);
    }
    this.schedule();
  }

  makeAllFolders(ws = gZenWorkspaces.activeWorkspaceElement) {
    const container = ws?.tabsContainer;
    if (!container) return;
    const gids = [...new Set(this.#units(container).map((u) => this.#gidOf(u)).filter(Boolean))];
    for (const gid of gids) this.makeFolder(gid);
  }

  closeGroup(gid) {
    const tabs = gBrowser.tabs.filter((t) => t.getAttribute("zen-tidy-group") === gid && !t.pinned);
    if (tabs.length) gBrowser.removeTabs(tabs);
  }

  rename(gid) {
    const h = document.querySelector(`.zen-tidy-header[gid="${CSS.escape(gid)}"]`);
    const label = h?.querySelector(".zen-tidy-label");
    if (!label || h.querySelector(".zen-tidy-rename")) return;
    const input = document.createElementNS(XHTML, "input");
    input.className = "zen-tidy-rename";
    input.value = this.groups.get(gid)?.name ?? "";
    label.hidden = true;
    label.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const name = cleanName(input.value);
      if (save && name && this.groups.has(gid)) {
        this.groups.get(gid).name = name;
        label.textContent = name;
        this.#saveGroups();
      }
      input.remove();
      label.hidden = false;
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    for (const ev of ["mousedown", "click", "dblclick"]) input.addEventListener(ev, (e) => e.stopPropagation());
  }

  // --- UI bits -------------------------------------------------------------
  #setBusy(ws, busy) {
    const pinned = ws.pinnedTabsContainer;
    const btn = pinned?.querySelector(".zen-tidy-broom");
    if (busy) {
      this.#busy.add(ws.id);
      pinned?.setAttribute("zen-tidy-busy", "true");
      btn?.setAttribute("disabled", "true");
      this.#sweepBroom(btn, ws);
    } else {
      this.#busy.delete(ws.id);
      pinned?.removeAttribute("zen-tidy-busy");
      if (!btn?._sweeping) btn?.removeAttribute("disabled");
    }
  }

  #note(ws, text) {
    const container = ws.tabsContainer;
    container.querySelector(":scope > .zen-tidy-note")?.remove();
    const note = document.createElementNS(XHTML, "div");
    note.className = "zen-tidy-note";
    note.textContent = text;
    container.prepend(note);
    setTimeout(() => note.remove(), 7000);
  }

  #onKey(e) {
    if (e.repeat || e.code !== "KeyT" || !e.altKey || e.shiftKey) return;
    const accel = AppConstants.platform === "macosx" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!accel || !this.pref("shortcut", true)) return;
    e.preventDefault();
    e.stopPropagation();
    this.tidy();
  }

  #buildMenus() {
    const popupSet = document.getElementById("mainPopupSet");
    const item = (label, fn) => {
      const mi = document.createXULElement("menuitem");
      mi.setAttribute("label", label);
      mi.addEventListener("command", fn);
      return mi;
    };

    const header = document.createXULElement("menupopup");
    header.id = "zen-tidy-header-menu";
    header.addEventListener("popupshowing", (e) => {
      this.#menuTarget = e.target.triggerNode?.closest?.(".zen-tidy-header")?.getAttribute("gid") ?? null;
    });
    header.append(
      item("Rename Group…", () => this.#menuTarget && this.rename(this.#menuTarget)),
      item("Move to Folder", () => this.#menuTarget && this.makeFolder(this.#menuTarget)),
      item("Ungroup Tabs", () => this.#menuTarget && this.ungroup(this.#menuTarget)),
      document.createXULElement("menuseparator"),
      item("Close Tabs in Group", () => this.#menuTarget && this.closeGroup(this.#menuTarget))
    );

    const broom = document.createXULElement("menupopup");
    broom.id = "zen-tidy-broom-menu";
    const tidyItem = item("Tidy Tabs", () => this.tidy(menuWs));
    const undoItem = item("Undo Tidy", () => this.undo());
    const wsOf = (e) => e.target.triggerNode?.closest?.("zen-workspace") ?? gZenWorkspaces.activeWorkspaceElement;
    let menuWs = null;
    broom.addEventListener("popupshowing", (e) => {
      menuWs = wsOf(e);
      const isBusy = Boolean(menuWs && this.#busy.has(menuWs.id));
      tidyItem.disabled = isBusy;
      undoItem.disabled = isBusy || !this.#undo || this.#undo.ws !== menuWs?.id;
    });
    broom.append(
      tidyItem,
      undoItem,
      item("Move All Groups to Folders", () => this.makeAllFolders(menuWs)),
      item("Remove All Headers", () => this.ungroupAll(menuWs)),
      document.createXULElement("menuseparator"),
      item("Set Claude API Key…", () => this.promptForKey())
    );
    popupSet.append(header, broom);
  }
}

// ---------------------------------------------------------------------------

function start() {
  if (window.gZenTidyTabs) return;
  window.gZenTidyTabs = new TidyTabs();
  window.gZenTidyTabs.init().catch((e) => console.error("Tidy Tabs failed to start", e));
}

if (typeof window !== "undefined" && window.location?.href === "chrome://browser/content/browser.xhtml") {
  if (gBrowserInit.delayedStartupFinished) {
    start();
  } else {
    const observer = (subject) => {
      if (subject !== window) return;
      Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
      start();
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  }
}
