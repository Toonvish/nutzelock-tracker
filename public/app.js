// Custom Nuzlocke Tracker — dependency-free SPA.
// REST + WebSocket against the Bun server; Pokémon data from PokeAPI.

const MANUAL_STATUSES = ["caught", "boxed", "fainted", "missed"];
const STATUS_LABELS = {
  caught: "Caught",
  boxed: "Boxed",
  fainted: "Fainted",
  missed: "Missed",
  bro_failed: "Bro failed",
};
const STATUS_COLORS = {
  caught: "var(--green)",
  boxed: "var(--blue)",
  fainted: "var(--red)",
  missed: "var(--gray)",
  bro_failed: "var(--bro)",
};
const TYPE_CHART_KEY = "nuzlocke.typechart.v1";
const TYPE_NAMES = [
  "normal", "fire", "water", "electric", "grass", "ice", "fighting", "poison",
  "ground", "flying", "psychic", "bug", "rock", "ghost", "dragon", "dark",
  "steel", "fairy",
];
const GEN_ORDER = [
  "generation-i", "generation-ii", "generation-iii", "generation-iv",
  "generation-v", "generation-vi", "generation-vii", "generation-viii",
  "generation-ix",
];
const GEN_LABELS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];
const TYPE_COLORS = {
  normal: "#9fa19f", fire: "#e62829", water: "#2980ef", electric: "#fac000",
  grass: "#3fa129", ice: "#3dcef3", fighting: "#ff8000", poison: "#9141cb",
  ground: "#915121", flying: "#81b9ef", psychic: "#ef4179", bug: "#91a119",
  rock: "#afa981", ghost: "#704170", dragon: "#5060e1", dark: "#624d4e",
  steel: "#60a1b8", fairy: "#ef70ef",
};
const ACTIVE_RUN_KEY = "nuzlocke.activeRun";
const TOKENS_KEY = "nuzlocke.tokens";
const POKEDEX_KEY = "nuzlocke.pokedex.v3";
const POKEAPI = "https://pokeapi.co/api/v2";
const POKEAPI_LIST = `${POKEAPI}/pokemon?limit=100000`;
const SPRITE_BASE =
  "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";

const STAT_LABELS = {
  hp: "HP",
  attack: "Atk",
  defense: "Def",
  "special-attack": "SpA",
  "special-defense": "SpD",
  speed: "Spe",
};

// ---- DOM refs ----
const $ = (sel) => document.querySelector(sel);
const runList = $("#run-list");
const emptyState = $("#empty-state");
const runView = $("#run-view");
const runTitle = $("#run-title");
const runSubtitle = $("#run-subtitle");
const routesArea = $("#routes-area");

// ---- State ----
let runs = [];
let activeRunId = Number(localStorage.getItem(ACTIVE_RUN_KEY)) || null;
let routes = [];
let levelCaps = [];
let pokedex = new Map(); // display(lower) -> { id, apiName, display }
let pokedexList = [];
let ws = null;
let pendingRoutesRefresh = false;

let tokens = {};
try {
  tokens = JSON.parse(localStorage.getItem(TOKENS_KEY) || "{}");
} catch {
  tokens = {};
}
const saveTokens = () => localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
const tokenFor = (id) => tokens[id];
const setToken = (id, t) => {
  tokens[id] = t;
  saveTokens();
};
const runHeaders = (id = activeRunId) => {
  const t = tokenFor(id);
  return t ? { "x-run-token": t } : {};
};

// ---- Helpers ----
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

function toast(msg) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = msg;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}
function input(value, placeholder) {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value;
  i.placeholder = placeholder || "";
  i.autocomplete = "off";
  return i;
}
function iconBtn(label, title, cls) {
  const b = el("button", "icon-btn" + (cls ? ` ${cls}` : ""));
  b.textContent = label;
  b.title = title;
  b.type = "button";
  return b;
}

const REGION_NAMES = {
  alola: "Alolan",
  galar: "Galarian",
  hisui: "Hisuian",
  paldea: "Paldean",
};
const titleCase = (s) =>
  s
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** "mr-mime" -> "Mr Mime"; "rattata-alola" -> "Alolan Rattata". */
function displayName(apiName) {
  const parts = apiName.split("-");
  const idx = parts.findIndex((p) => REGION_NAMES[p]);
  if (idx <= 0) return titleCase(apiName);
  const base = parts.slice(0, idx).map((p) => titleCase(p)).join(" ");
  const region = REGION_NAMES[parts[idx]];
  const extra = parts.slice(idx + 1).map((p) => titleCase(p)).join(" ");
  return `${region} ${base}${extra ? ` (${extra})` : ""}`;
}
const spriteUrl = (id) => `${SPRITE_BASE}/${id}.png`;

function renderSprite(box, url) {
  box.innerHTML = "";
  if (url) {
    box.classList.remove("empty");
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      box.classList.add("empty");
      img.remove();
    });
    box.appendChild(img);
  } else {
    box.classList.add("empty");
  }
}

// ---- Pokédex (PokeAPI) ----
async function loadPokedex() {
  let entries = null;
  try {
    const cached = localStorage.getItem(POKEDEX_KEY);
    if (cached) entries = JSON.parse(cached);
  } catch {
    /* ignore */
  }
  if (!entries) {
    try {
      const data = await api(POKEAPI_LIST);
      entries = data.results
        .map((r) => {
          const m = r.url.match(/\/pokemon\/(\d+)\/?$/);
          const id = m ? Number(m[1]) : null;
          return id ? { id, apiName: r.name, display: displayName(r.name) } : null;
        })
        .filter(Boolean)
        // Keep base species (id <= 10000) plus regional forms (Alolan,
        // Galarian, Hisuian, Paldean); drop mega/gmax and Totem/cap cosmetics.
        .filter(
          (e) =>
            e.id <= 10000 ||
            (/-(alola|galar|hisui|paldea)(?:-|$)/.test(e.apiName) &&
              !/(totem|cap)/.test(e.apiName)),
        );
      localStorage.setItem(POKEDEX_KEY, JSON.stringify(entries));
    } catch {
      toast("Could not reach PokeAPI — you can still type names manually.");
      entries = [];
    }
  }
  pokedexList = entries;
  pokedex = new Map();
  for (const e of entries) pokedex.set(e.display.toLowerCase(), e);
}

function resolvePokemon(text) {
  const key = text.trim().toLowerCase();
  if (!key) return null;
  const exact = pokedex.get(key) || pokedex.get(displayName(key).toLowerCase());
  if (exact) return exact;
  let best = null;
  for (const e of pokedex.values()) {
    if (e.display.toLowerCase().startsWith(key) && (!best || e.id < best.id))
      best = e;
  }
  return best;
}

function filterPokedex(q, limit = 40) {
  const starts = [];
  const contains = [];
  for (const e of pokedexList) {
    const name = e.display.toLowerCase();
    if (name.startsWith(q)) starts.push(e);
    else if (name.includes(q)) contains.push(e);
  }
  return starts.concat(contains).slice(0, limit);
}

function closeAllCombos() {
  for (const ul of document.querySelectorAll(".combo-list")) ul.remove();
}
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest(".combo") && !e.target.closest(".combo-list"))
    closeAllCombos();
});
window.addEventListener("scroll", closeAllCombos, true);
window.addEventListener("resize", closeAllCombos);

// ---- PokeAPI detail lookups (on-demand, cached) ----
const detailCache = new Map();
const abilityCache = new Map();
const evoCache = new Map();

async function getPokemonDetail(id) {
  if (detailCache.has(id)) return detailCache.get(id);
  const d = await api(`${POKEAPI}/pokemon/${id}`);
  const detail = {
    id: d.id,
    name: d.name,
    stats: d.stats.map((s) => ({ name: s.stat.name, value: s.base_stat })),
    bst: d.stats.reduce((sum, s) => sum + s.base_stat, 0),
    abilities: d.abilities.map((a) => ({ name: a.ability.name, hidden: a.is_hidden })),
    types: d.types.map((t) => t.type.name),
    speciesUrl: d.species.url,
  };
  detailCache.set(id, detail);
  return detail;
}

async function getAbilityEffect(name) {
  if (abilityCache.has(name)) return abilityCache.get(name);
  let text = "No description available.";
  try {
    const a = await api(`${POKEAPI}/ability/${name}`);
    const en = a.effect_entries.find((e) => e.language.name === "en");
    const flavor = a.flavor_text_entries.find((e) => e.language.name === "en");
    text = en?.short_effect || en?.effect || flavor?.flavor_text || text;
    text = text.replace(/\s+/g, " ").trim();
  } catch {
    /* keep fallback */
  }
  abilityCache.set(name, text);
  return text;
}

async function getEvolutions(detail) {
  if (evoCache.has(detail.id)) return evoCache.get(detail.id);
  const species = await api(detail.speciesUrl);
  const chain = await api(species.evolution_chain.url);
  const names = [];
  (function walk(node) {
    if (node.species.name === species.name) {
      for (const next of node.evolves_to) names.push(next.species.name);
      return true;
    }
    return node.evolves_to.some(walk);
  })(chain.chain);
  const opts = names
    .map((n) => pokedex.get(displayName(n).toLowerCase()))
    .filter(Boolean);
  evoCache.set(detail.id, opts);
  return opts;
}

// ---- Dupes clause: warn when an evolution line is already an encounter ----
const familyCache = new Map(); // pokemonId -> evolution-chain id (family key)
let dupeInfo = new Map(); // encounterId -> { routeName, slot } of the conflict

/** The evolution-chain id shared by a whole evolution family. */
async function getFamilyKey(pokemonId) {
  if (familyCache.has(pokemonId)) return familyCache.get(pokemonId);
  let key = null;
  try {
    const detail = await getPokemonDetail(pokemonId);
    const species = await api(detail.speciesUrl);
    const m = species.evolution_chain.url.match(/\/evolution-chain\/(\d+)\/?$/);
    key = m ? Number(m[1]) : null;
  } catch {
    key = null;
  }
  familyCache.set(pokemonId, key);
  return key;
}

/** Two encounters are dupes if their families match on *different* routes. */
async function recomputeDupes() {
  const items = [];
  for (const route of routes)
    for (const e of route.encounters)
      if (e.pokemon_id) items.push({ e, route });
  await Promise.all(items.map((x) => getFamilyKey(x.e.pokemon_id)));

  const byFamily = new Map();
  for (const x of items) {
    const k = familyCache.get(x.e.pokemon_id);
    if (k == null) continue;
    if (!byFamily.has(k)) byFamily.set(k, []);
    byFamily.get(k).push(x);
  }
  const next = new Map();
  for (const members of byFamily.values()) {
    if (members.length < 2) continue;
    for (const m of members) {
      const other = members.find((o) => o.route.id !== m.route.id);
      if (other) next.set(m.e.id, { routeName: other.route.name, slot: other.e.slot });
    }
  }
  dupeInfo = next;
  applyDupeBadges();
}

function playerLabel(run, slot) {
  return slot === 0 ? run?.player1 || "Player 1" : run?.player2 || "Player 2";
}

function applyDupeBadges() {
  const run = runs.find((r) => r.id === activeRunId);
  for (const box of routesArea.querySelectorAll(".sprite-box[data-enc-id]")) {
    box.querySelector(".dupe-badge")?.remove();
    box.classList.remove("has-dupe");
    const info = dupeInfo.get(Number(box.dataset.encId));
    if (!info) continue;
    box.classList.add("has-dupe");
    const badge = el("span", "dupe-badge");
    badge.textContent = "⚠";
    const who = run?.mode === "soullink" ? ` (${playerLabel(run, info.slot)})` : "";
    badge.title = `Dupe — this evolution line is already an encounter on ${info.routeName}${who}`;
    box.appendChild(badge);
  }
}

// ---- Live sync (WebSocket) ----
function setSync(on) {
  const d = $("#sync-dot");
  if (d) d.classList.toggle("on", on);
}
function watchRun(runId) {
  if (ws && ws.readyState === 1)
    ws.send(JSON.stringify({ op: "watch", runId, token: tokenFor(runId) }));
}
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    setSync(true);
    if (activeRunId) watchRun(activeRunId);
  };
  ws.onclose = () => {
    setSync(false);
    setTimeout(connectWS, 1500);
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "runs") refreshSidebar();
    else if (m.type === "routes" && m.runId === activeRunId) refreshRoutes();
    else if (m.type === "caps" && m.runId === activeRunId) loadCaps();
    else if (m.type === "denied" && m.runId === activeRunId) {
      delete tokens[activeRunId];
      saveTokens();
      loadActiveRun();
    }
  };
}

// ---- Runs (sidebar) ----
async function loadRuns() {
  runs = await api("/api/runs");
  if (activeRunId && !runs.some((r) => r.id === activeRunId)) activeRunId = null;
  if (!activeRunId && runs.length) activeRunId = runs[0].id;
  renderRuns();
  await loadActiveRun();
}

/** Refetch runs and update the sidebar + header only (leaves routes alone). */
async function refreshSidebar() {
  runs = await api("/api/runs");
  renderRuns();
  const run = runs.find((r) => r.id === activeRunId);
  if (run) updateRunHeader(run);
}

function renderRuns() {
  runList.innerHTML = "";
  for (const run of runs) {
    const li = el("li", "run-item" + (run.id === activeRunId ? " active" : ""));
    li.dataset.id = run.id;
    const prefix =
      (run.protected ? "🔒 " : "") + (run.mode === "soullink" ? "🔗 " : "");
    const tally =
      `${run.caught} caught · ${run.fainted} fainted` +
      (run.bro_failed ? ` · ${run.bro_failed} bro` : "");
    li.innerHTML = `<div class="run-name"></div><div class="run-tally">${tally}</div>`;
    li.querySelector(".run-name").textContent = prefix + run.name;
    li.addEventListener("click", () => selectRun(run.id));
    runList.appendChild(li);
  }
}

async function selectRun(id) {
  activeRunId = id;
  localStorage.setItem(ACTIVE_RUN_KEY, String(id));
  renderRuns();
  await loadActiveRun();
}

function updateRunHeader(run) {
  runTitle.textContent = run.name;
  const parts = [];
  if (run.mode === "soullink") {
    parts.push(
      "🔗 Soullink · " + `${run.player1 || "Player 1"} & ${run.player2 || "Player 2"}`,
    );
  }
  if (run.game) parts.push(run.game);
  parts.push(`${run.routes} routes`);
  if (run.protected) parts.push("🔒 protected");
  runSubtitle.textContent = parts.join(" · ");
}

async function loadActiveRun() {
  const run = runs.find((r) => r.id === activeRunId);
  if (!run) {
    runView.hidden = true;
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;
  runView.hidden = false;
  updateRunHeader(run);

  if (run.protected && !tokenFor(run.id)) {
    $("#locked-view").hidden = false;
    $("#routes-section").hidden = true;
    $("#unlock-input").focus();
    return;
  }
  $("#locked-view").hidden = true;
  $("#routes-section").hidden = false;
  watchRun(run.id);
  await loadRoutesData();
  loadCaps();
}

// ---- Level caps ----
async function loadCaps() {
  if (!activeRunId) return;
  try {
    levelCaps = await api(`/api/runs/${activeRunId}/level-caps`, {
      headers: runHeaders(),
    });
  } catch {
    levelCaps = [];
  }
  renderCaps();
}

function renderCaps() {
  const list = $("#caps-list");
  list.innerHTML = "";
  if (!levelCaps.length) {
    const empty = el("span", "caps-empty muted");
    empty.textContent = "No level caps yet — add gym leaders, Elite Four, etc.";
    list.appendChild(empty);
    return;
  }
  for (const cap of levelCaps) list.appendChild(buildCapChip(cap));
}

function buildCapChip(cap) {
  const chip = el("div", "cap-chip" + (cap.cleared ? " cleared" : ""));
  const name = el("span", "cap-name");
  name.textContent = cap.name;
  const lv = el("span", "cap-lv");
  lv.textContent = cap.level != null ? `Lv ${cap.level}` : "—";
  const del = el("button", "cap-del");
  del.type = "button";
  del.textContent = "×";
  del.title = "Remove";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteCap(cap);
  });
  chip.append(name, lv, del);
  chip.title = cap.cleared ? "Cleared — click to unmark" : "Click to mark cleared";
  chip.addEventListener("click", () => toggleCap(cap));
  return chip;
}

async function toggleCap(cap) {
  try {
    const updated = await api(`/api/level-caps/${cap.id}`, {
      method: "PUT",
      body: JSON.stringify({ cleared: !cap.cleared }),
      headers: runHeaders(),
    });
    Object.assign(cap, updated);
    renderCaps();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteCap(cap) {
  try {
    await api(`/api/level-caps/${cap.id}`, {
      method: "DELETE",
      headers: runHeaders(),
    });
    levelCaps = levelCaps.filter((c) => c.id !== cap.id);
    renderCaps();
  } catch (err) {
    toast(err.message);
  }
}

async function loadRoutesData() {
  pendingRoutesRefresh = false;
  if (!activeRunId) return;
  try {
    routes = await api(`/api/runs/${activeRunId}/routes`, {
      headers: runHeaders(),
    });
  } catch (err) {
    if (String(err.message).includes("locked")) {
      delete tokens[activeRunId];
      saveTokens();
      return loadActiveRun();
    }
    throw err;
  }
  renderRoutes(runs.find((r) => r.id === activeRunId));
}

/** WS told us routes changed — refetch, but never clobber an in-progress edit. */
function refreshRoutes() {
  const ae = document.activeElement;
  if (ae && ae.closest && ae.closest("#routes-area")) {
    pendingRoutesRefresh = true;
    return;
  }
  loadRoutesData();
}
routesArea.addEventListener("focusout", () => {
  setTimeout(() => {
    const ae = document.activeElement;
    if (pendingRoutesRefresh && !(ae && ae.closest && ae.closest("#routes-area")))
      loadRoutesData();
  }, 120);
});

// ---- Routes rendering ----
function renderRoutes(run) {
  routesArea.innerHTML = "";
  if (!run) return;
  if (run.mode === "soullink") {
    const cards = el("div", "cards");
    for (const route of routes) cards.appendChild(buildSoullinkCard(route, run));
    routesArea.appendChild(cards);
  } else {
    const wrap = el("div", "table-wrap");
    const table = el("table", "routes-table");
    table.innerHTML = `<thead><tr>
      <th class="col-route">Route</th><th class="col-sprite"></th>
      <th class="col-pokemon">Pokémon</th><th class="col-nick">Nickname</th>
      <th class="col-status">Status</th><th class="col-actions"></th></tr></thead>`;
    const tbody = el("tbody");
    for (const route of routes) tbody.appendChild(buildNormalRow(route, run));
    table.appendChild(tbody);
    wrap.appendChild(table);
    routesArea.appendChild(wrap);
  }
  recomputeDupes();
}

function rerenderRoute(routeId) {
  const run = runs.find((r) => r.id === activeRunId);
  const route = routes.find((r) => r.id === routeId);
  const old = routesArea.querySelector(`[data-route-id="${routeId}"]`);
  if (!run || !route || !old) return;
  old.replaceWith(
    run.mode === "soullink"
      ? buildSoullinkCard(route, run)
      : buildNormalRow(route, run),
  );
  applyDupeBadges(); // re-add badges to the rebuilt element from current state
}

function buildNormalRow(route, run) {
  const enc = route.encounters[0];
  const tr = el("tr");
  tr.dataset.routeId = route.id;
  if (enc?.status) tr.dataset.status = enc.status;

  const nameTd = el("td", "route-name-cell");
  nameTd.appendChild(routeNameInput(route));

  const spriteTd = el("td", "col-sprite");
  const box = el("div", "sprite-box");
  if (enc) box.dataset.encId = enc.id;
  renderSprite(box, enc?.sprite_url);
  spriteTd.appendChild(box);

  const pokeTd = el("td", "pokemon-cell");
  pokeTd.appendChild(buildEncounterPicker(enc, box));

  const nickTd = el("td", "nick-cell");
  nickTd.appendChild(nickInput(enc));

  const statusTd = el("td", "col-status");
  statusTd.appendChild(statusSelect(enc));

  const actionsTd = el("td", "col-actions");
  actionsTd.append(...encActions(enc), deleteRouteBtn(route));

  tr.append(nameTd, spriteTd, pokeTd, nickTd, statusTd, actionsTd);
  return tr;
}

function buildSoullinkCard(route, run) {
  const card = el("div", "route-card");
  card.dataset.routeId = route.id;

  const head = el("div", "card-head");
  head.appendChild(routeNameInput(route));
  head.appendChild(deleteRouteBtn(route));
  card.appendChild(head);

  const body = el("div", "card-body");
  for (const slot of [0, 1]) {
    const enc = route.encounters.find((e) => e.slot === slot);
    const panel = el("div", "enc-panel");
    if (enc?.status) panel.dataset.status = enc.status;

    const label = el("div", "enc-player");
    label.textContent = slot === 0 ? run.player1 || "Player 1" : run.player2 || "Player 2";

    const top = el("div", "enc-top");
    const box = el("div", "sprite-box");
    if (enc) box.dataset.encId = enc.id;
    renderSprite(box, enc?.sprite_url);
    top.append(box, buildEncounterPicker(enc, box));

    const statusRow = el("div", "enc-status-row");
    statusRow.append(statusSelect(enc), ...encActions(enc));

    panel.append(label, top, nickInput(enc), statusRow);
    body.appendChild(panel);
  }
  card.appendChild(body);
  return card;
}

function routeNameInput(route) {
  const i = input(route.name, "Route name");
  i.classList.add("route-name");
  i.addEventListener("change", async () => {
    const name = i.value.trim() || route.name;
    i.value = name;
    try {
      await api(`/api/routes/${route.id}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
        headers: runHeaders(),
      });
      route.name = name;
    } catch (err) {
      toast(err.message);
    }
  });
  return i;
}

function nickInput(enc) {
  const i = input(enc?.nickname || "", "Nickname");
  i.classList.add("nick");
  i.disabled = !enc;
  i.addEventListener("change", () =>
    patchEncounter(enc, { nickname: i.value.trim() || null }),
  );
  return i;
}

function statusSelect(enc) {
  const sel = el("select", "status");
  sel.disabled = !enc;
  const opts = [["", "—"], ...MANUAL_STATUSES.map((s) => [s, STATUS_LABELS[s]])];
  if (enc?.status === "bro_failed") opts.push(["bro_failed", STATUS_LABELS.bro_failed]);
  for (const [v, l] of opts) {
    const o = el("option");
    o.value = v;
    o.textContent = l;
    // Color each option by its own status (not the selected one).
    o.style.color = STATUS_COLORS[v] || "var(--muted)";
    o.style.backgroundColor = "var(--panel-2)";
    sel.appendChild(o);
  }
  sel.value = enc?.status || "";
  sel.dataset.status = enc?.status || "";
  sel.addEventListener("change", () =>
    patchEncounter(enc, { status: sel.value || null }),
  );
  return sel;
}

function encActions(enc) {
  const has = !!enc?.pokemon_id;
  const infoBtn = iconBtn("ℹ️", "Base stats & abilities");
  infoBtn.disabled = !has;
  infoBtn.addEventListener("click", () => showInfo(enc));
  const evolveBtn = iconBtn("🧬", "Evolve");
  evolveBtn.disabled = !has;
  evolveBtn.addEventListener("click", () => evolve(enc));
  return [infoBtn, evolveBtn];
}

function deleteRouteBtn(route) {
  const b = iconBtn("✕", "Delete route", "del");
  b.addEventListener("click", async () => {
    try {
      await api(`/api/routes/${route.id}`, {
        method: "DELETE",
        headers: runHeaders(),
      });
      routes = routes.filter((r) => r.id !== route.id);
      routesArea.querySelector(`[data-route-id="${route.id}"]`)?.remove();
      refreshSidebar();
    } catch (err) {
      toast(err.message);
    }
  });
  return b;
}

/** PUT an encounter change, apply the result (incl. soullink partner), re-render. */
async function patchEncounter(enc, fields) {
  if (!enc) return;
  try {
    const res = await api(`/api/encounters/${enc.id}`, {
      method: "PUT",
      body: JSON.stringify(fields),
      headers: runHeaders(),
    });
    applyEncounter(res.encounter);
    if (res.partner) applyEncounter(res.partner);
    rerenderRoute(enc.route_id);
    refreshSidebar();
    await recomputeDupes();
  } catch (err) {
    toast(err.message);
  }
}

function applyEncounter(e) {
  const route = routes.find((r) => r.id === e.route_id);
  if (!route) return;
  const i = route.encounters.findIndex((x) => x.id === e.id);
  if (i >= 0) route.encounters[i] = e;
  else route.encounters.push(e);
}

// ---- Pokémon picker (custom dropdown with sprite thumbnails) ----
function buildEncounterPicker(enc, spriteBox) {
  const wrap = el("div", "combo");
  const inp = input(enc?.pokemon_name ? displayName(enc.pokemon_name) : "", "Pick or type…");
  inp.disabled = !enc;
  wrap.appendChild(inp);

  let list = null;
  let filtered = [];
  let activeIdx = -1;
  let committed = enc?.pokemon_name ? displayName(enc.pokemon_name) : "";

  const closeList = () => {
    if (list) list.remove();
    list = null;
    filtered = [];
    activeIdx = -1;
  };
  const positionList = () => {
    if (!list) return;
    const r = inp.getBoundingClientRect();
    list.style.left = `${r.left}px`;
    list.style.top = `${r.bottom + 2}px`;
    list.style.width = `${Math.max(r.width, 200)}px`;
  };
  const commit = async (entry, rawText) => {
    let fields;
    if (entry) {
      committed = entry.display;
      inp.value = entry.display;
      renderSprite(spriteBox, spriteUrl(entry.id));
      fields = {
        pokemon_id: entry.id,
        pokemon_name: entry.apiName,
        sprite_url: spriteUrl(entry.id),
      };
    } else if (rawText) {
      committed = rawText;
      renderSprite(spriteBox, null);
      fields = { pokemon_id: null, pokemon_name: rawText, sprite_url: null };
    } else {
      committed = "";
      renderSprite(spriteBox, null);
      fields = { pokemon_id: null, pokemon_name: null, sprite_url: null };
    }
    if ((entry || rawText) && !enc.status) fields.status = "caught";
    closeList();
    await patchEncounter(enc, fields); // refreshes dupeInfo
    // Dupes clause: warn if this entry's evolution line is already an encounter.
    if (entry) {
      const info = dupeInfo.get(enc.id);
      if (info) {
        const run = runs.find((r) => r.id === activeRunId);
        const who = run?.mode === "soullink" ? ` (${playerLabel(run, info.slot)})` : "";
        toast(
          `⚠️ Dupe! ${entry.display}'s evolution line is already an encounter on ${info.routeName}${who}.`,
        );
      }
    }
  };
  const setActive = (idx) => {
    if (!list) return;
    const items = [...list.children];
    if (!items.length) return;
    activeIdx = (idx + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle("active", i === activeIdx));
    items[activeIdx].scrollIntoView({ block: "nearest" });
  };
  const renderList = () => {
    const q = inp.value.trim().toLowerCase();
    filtered = q ? filterPokedex(q) : [];
    closeAllCombos();
    list = null;
    if (!filtered.length) return;
    list = el("ul", "combo-list");
    filtered.forEach((e, i) => {
      const li = el("li", "combo-item" + (i === 0 ? " active" : ""));
      const img = document.createElement("img");
      img.className = "combo-sprite";
      img.src = spriteUrl(e.id);
      img.alt = "";
      img.loading = "lazy";
      const name = el("span");
      name.textContent = e.display;
      const idTag = el("span", "combo-id");
      idTag.textContent = `#${e.id}`;
      li.append(img, name, idTag);
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        commit(e);
      });
      list.appendChild(li);
    });
    document.body.appendChild(list);
    activeIdx = 0;
    positionList();
  };

  inp.addEventListener("focus", () => {
    if (inp.value.trim()) renderList();
  });
  inp.addEventListener("input", renderList);
  inp.addEventListener("keydown", (ev) => {
    if (!list) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActive(activeIdx + 1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive(activeIdx - 1);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (filtered[activeIdx]) commit(filtered[activeIdx]);
    } else if (ev.key === "Escape") {
      closeList();
    }
  });
  inp.addEventListener("blur", () => {
    setTimeout(() => {
      closeList();
      const text = inp.value.trim();
      if (text === committed) return;
      if (!text) return commit(null, "");
      const hit = resolvePokemon(text);
      commit(hit, hit ? null : text);
    }, 120);
  });

  return wrap;
}

// ---- Modal ----
function escClose(e) {
  if (e.key === "Escape") closeModal();
}
function closeModal() {
  document.querySelector(".modal-overlay")?.remove();
  document.removeEventListener("keydown", escClose);
}
function openModal(contentNode) {
  closeModal();
  const overlay = el("div", "modal-overlay");
  const modal = el("div", "modal");
  const close = iconBtn("✕", "Close", "del");
  close.classList.add("modal-close");
  close.addEventListener("click", closeModal);
  modal.append(close, contentNode);
  overlay.appendChild(modal);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeModal();
  });
  document.body.appendChild(overlay);
  document.addEventListener("keydown", escClose);
  return modal;
}

// ---- Info: base stats + abilities ----
async function showInfo(enc) {
  if (!enc?.pokemon_id) return;
  const content = el("div", "info");
  content.innerHTML = `<p class="muted">Loading…</p>`;
  openModal(content);
  try {
    const detail = await getPokemonDetail(enc.pokemon_id);
    const abilities = await Promise.all(
      detail.abilities.map(async (a) => ({
        ...a,
        effect: await getAbilityEffect(a.name),
      })),
    );

    const head = el("div", "info-head");
    const box = el("div", "sprite-box");
    renderSprite(box, spriteUrl(detail.id));
    const titleWrap = el("div");
    const title = el("h3");
    title.textContent =
      displayName(detail.name) + (enc.nickname ? ` "${enc.nickname}"` : "");
    const dex = el("p", "muted");
    dex.textContent = `#${detail.id} · Base stat total ${detail.bst}`;
    titleWrap.append(title, dex);
    head.append(box, titleWrap);

    const statsWrap = el("div", "stats");
    for (const s of detail.stats) {
      const row = el("div", "stat-row");
      const label = el("span", "stat-label");
      label.textContent = STAT_LABELS[s.name] || s.name;
      const val = el("span", "stat-val");
      val.textContent = s.value;
      const bar = el("div", "stat-bar");
      const fill = el("div", "stat-fill");
      fill.style.width = `${Math.min(100, (s.value / 200) * 100)}%`;
      bar.appendChild(fill);
      row.append(label, val, bar);
      statsWrap.appendChild(row);
    }

    const abHead = el("h4");
    abHead.textContent = "Abilities";
    const abList = el("div", "abilities");
    for (const a of abilities) {
      const item = el("div", "ability");
      const name = el("div", "ability-name");
      name.textContent = displayName(a.name) + (a.hidden ? " (Hidden)" : "");
      const eff = el("div", "ability-effect");
      eff.textContent = a.effect;
      item.append(name, eff);
      abList.appendChild(item);
    }

    content.innerHTML = "";
    content.append(head, statsWrap, abHead, abList);
  } catch (err) {
    content.innerHTML = `<p>Couldn't load data: ${err.message}</p>`;
  }
}

// ---- Evolve ----
async function evolve(enc) {
  if (!enc?.pokemon_id) return;
  try {
    const detail = await getPokemonDetail(enc.pokemon_id);
    const opts = await getEvolutions(detail);
    if (!opts.length) {
      toast(`${displayName(enc.pokemon_name)} has no further evolution.`);
      return;
    }
    if (opts.length === 1) return applyEvolution(enc, opts[0]);

    const content = el("div", "evolve");
    const h = el("h3");
    h.textContent = `Evolve ${displayName(enc.pokemon_name)} into…`;
    const grid = el("div", "evolve-options");
    for (const o of opts) {
      const btn = el("button", "evolve-option");
      btn.type = "button";
      const box = el("div", "sprite-box");
      renderSprite(box, spriteUrl(o.id));
      const name = el("span");
      name.textContent = o.display;
      btn.append(box, name);
      btn.addEventListener("click", () => {
        closeModal();
        applyEvolution(enc, o);
      });
      grid.appendChild(btn);
    }
    content.append(h, grid);
    openModal(content);
  } catch {
    toast("Couldn't load evolution data.");
  }
}

async function applyEvolution(enc, entry) {
  await patchEncounter(enc, {
    pokemon_id: entry.id,
    pokemon_name: entry.apiName,
    sprite_url: spriteUrl(entry.id),
  });
  toast(`Evolved into ${entry.display}!`);
}

// ---- Type effectiveness chart (per generation, from PokeAPI) ----
let typeInfos = null;

/** Fetch the 18 types once, reduced to a compact per-gen-aware form (cached). */
async function loadTypeInfos() {
  if (typeInfos) return typeInfos;
  try {
    const cached = localStorage.getItem(TYPE_CHART_KEY);
    if (cached) {
      typeInfos = JSON.parse(cached);
      return typeInfos;
    }
  } catch {
    /* ignore */
  }
  const compact = (r) => ({
    to2: r.double_damage_to.map((t) => t.name),
    to05: r.half_damage_to.map((t) => t.name),
    to0: r.no_damage_to.map((t) => t.name),
  });
  typeInfos = await Promise.all(
    TYPE_NAMES.map(async (name) => {
      const d = await api(`${POKEAPI}/type/${name}`);
      return {
        name,
        gen: d.generation.name,
        rel: compact(d.damage_relations),
        past: (d.past_damage_relations || []).map((p) => ({
          gen: p.generation.name,
          ...compact(p.damage_relations),
        })),
      };
    }),
  );
  try {
    localStorage.setItem(TYPE_CHART_KEY, JSON.stringify(typeInfos));
  } catch {
    /* quota — fine, memory cache stands */
  }
  return typeInfos;
}

/** Build { types, chart[atk][def] = multiplier } for a generation number. */
function buildTypeChart(genNum) {
  const gIdx = genNum - 1;
  const gi = (name) => GEN_ORDER.indexOf(name);
  const types = typeInfos.filter((i) => gi(i.gen) <= gIdx).map((i) => i.name);
  const present = new Set(types);
  const chart = {};
  for (const info of typeInfos) {
    if (!present.has(info.name)) continue;
    // Pick the damage relations in effect for this gen: the earliest "past"
    // entry whose generation is >= the target gen, else the current relations.
    let rel = info.rel;
    const past = info.past
      .map((p) => ({ gi: gi(p.gen), p }))
      .filter((x) => x.gi >= 0)
      .sort((a, b) => a.gi - b.gi);
    for (const x of past) {
      if (gIdx <= x.gi) {
        rel = x.p;
        break;
      }
    }
    const row = {};
    for (const d of types) row[d] = 1;
    for (const t of rel.to2) if (present.has(t)) row[t] = 2;
    for (const t of rel.to05) if (present.has(t)) row[t] = 0.5;
    for (const t of rel.to0) if (present.has(t)) row[t] = 0;
    chart[info.name] = row;
  }
  return { types, chart };
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function renderTypeGrid(container, genNum) {
  const { types, chart } = buildTypeChart(genNum);
  const abbr = (t) => t.slice(0, 3).toUpperCase();
  const table = el("table", "type-chart");

  const thead = el("thead");
  const htr = el("tr");
  const corner = el("th", "tc-corner");
  corner.textContent = "ATK ＼ DEF";
  htr.appendChild(corner);
  for (const d of types) {
    const th = el("th", "tc-head");
    th.textContent = abbr(d);
    th.style.background = TYPE_COLORS[d];
    th.title = capitalize(d);
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const a of types) {
    const tr = el("tr");
    const rh = el("th", "tc-row");
    rh.textContent = abbr(a);
    rh.style.background = TYPE_COLORS[a];
    rh.title = capitalize(a);
    tr.appendChild(rh);
    for (const d of types) {
      const m = chart[a][d];
      const td = el("td", "tc-cell");
      if (m === 2) {
        td.classList.add("eff-super");
        td.textContent = "2×";
      } else if (m === 0.5) {
        td.classList.add("eff-weak");
        td.textContent = "½";
      } else if (m === 0) {
        td.classList.add("eff-none");
        td.textContent = "0";
      }
      td.title = `${capitalize(a)} → ${capitalize(d)}: ${m}×`;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.innerHTML = "";
  container.appendChild(table);
}

/** Wire the run-page "Type chart" accordion; loads PokeAPI data on first open. */
function setupTypeChart() {
  const details = $("#type-chart-section");
  const sel = $("#type-gen-select");
  const grid = $("#type-grid");
  for (let g = 1; g <= 9; g++) {
    const o = el("option");
    o.value = String(g);
    o.textContent = `Gen ${GEN_LABELS[g - 1]}`;
    sel.appendChild(o);
  }
  sel.value = "9";

  let loaded = false;
  const draw = () => renderTypeGrid(grid, Number(sel.value));
  const ensure = async () => {
    if (loaded) return draw();
    grid.innerHTML = `<p class="muted">Loading type data…</p>`;
    try {
      await loadTypeInfos();
      loaded = true;
      draw();
    } catch {
      grid.innerHTML = `<p>Couldn't load type data from PokeAPI.</p>`;
    }
  };
  details.addEventListener("toggle", () => {
    if (details.open) ensure();
  });
  sel.addEventListener("change", () => {
    if (loaded) draw();
  });
}

// ---- Type matchup calculator (defensive coverage of a type duo) ----

/** A lightweight Pokémon search box; calls onPick(entry) on selection. */
function buildMatchupPicker(onPick) {
  const wrap = el("div", "combo");
  const inp = input("", "Search a Pokémon…");
  wrap.appendChild(inp);
  let list = null;
  let filtered = [];
  let activeIdx = -1;
  const closeList = () => {
    if (list) list.remove();
    list = null;
    filtered = [];
    activeIdx = -1;
  };
  const position = () => {
    if (!list) return;
    const r = inp.getBoundingClientRect();
    list.style.left = `${r.left}px`;
    list.style.top = `${r.bottom + 2}px`;
    list.style.width = `${Math.max(r.width, 200)}px`;
  };
  const choose = (entry) => {
    inp.value = entry.display;
    closeList();
    onPick(entry);
  };
  const setActive = (idx) => {
    if (!list) return;
    const items = [...list.children];
    if (!items.length) return;
    activeIdx = (idx + items.length) % items.length;
    items.forEach((li, i) => li.classList.toggle("active", i === activeIdx));
    items[activeIdx].scrollIntoView({ block: "nearest" });
  };
  const renderList = () => {
    const q = inp.value.trim().toLowerCase();
    filtered = q ? filterPokedex(q) : [];
    closeAllCombos();
    list = null;
    if (!filtered.length) return;
    list = el("ul", "combo-list");
    filtered.forEach((e, i) => {
      const li = el("li", "combo-item" + (i === 0 ? " active" : ""));
      const img = document.createElement("img");
      img.className = "combo-sprite";
      img.src = spriteUrl(e.id);
      img.alt = "";
      img.loading = "lazy";
      const name = el("span");
      name.textContent = e.display;
      const idTag = el("span", "combo-id");
      idTag.textContent = `#${e.id}`;
      li.append(img, name, idTag);
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        choose(e);
      });
      list.appendChild(li);
    });
    document.body.appendChild(list);
    activeIdx = 0;
    position();
  };
  inp.addEventListener("focus", () => {
    if (inp.value.trim()) renderList();
  });
  inp.addEventListener("input", renderList);
  inp.addEventListener("keydown", (ev) => {
    if (!list) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActive(activeIdx + 1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive(activeIdx - 1);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (filtered[activeIdx]) choose(filtered[activeIdx]);
    } else if (ev.key === "Escape") {
      closeList();
    }
  });
  inp.addEventListener("blur", () => setTimeout(closeList, 150));
  return wrap;
}

const MULT_LABEL = { 4: "×4", 2: "×2", 1: "×1", 0.5: "×½", 0.25: "×¼", 0: "×0" };

function renderMatchup(container, chart, t1, t2) {
  const rows = [];
  for (const atk of TYPE_NAMES) {
    if (!chart[atk]) continue; // attacker not in this chart
    let m = t1 in chart[atk] ? chart[atk][t1] : 1;
    if (t2 && t2 !== t1) m *= t2 in chart[atk] ? chart[atk][t2] : 1;
    rows.push({ atk, m });
  }
  const buckets = [
    { ms: [4], title: "Doubly weak (×4)" },
    { ms: [2], title: "Weak (×2)" },
    { ms: [0.5], title: "Resists (×½)" },
    { ms: [0.25], title: "Doubly resists (×¼)" },
    { ms: [0], title: "Immune (×0)" },
    { ms: [1], title: "Normal damage (×1)" },
  ];
  container.innerHTML = "";
  const groups = el("div", "matchup-groups");
  for (const b of buckets) {
    const matches = rows.filter((r) => b.ms.includes(r.m));
    if (!matches.length) continue;
    const section = el("div", "mu-group");
    const h = el("div", "mu-group-title");
    h.textContent = b.title;
    const chips = el("div", "mu-chips");
    for (const r of matches) {
      const chip = el("span", "mu-chip");
      chip.textContent = capitalize(r.atk);
      chip.style.background = TYPE_COLORS[r.atk];
      chip.title = `${capitalize(r.atk)}: ${MULT_LABEL[r.m]}`;
      chips.appendChild(chip);
    }
    section.append(h, chips);
    groups.appendChild(section);
  }
  container.appendChild(groups);
}

function colorTypeSelect(sel) {
  sel.style.color = sel.value ? TYPE_COLORS[sel.value] : "var(--muted)";
  sel.style.fontWeight = "600";
}

/** Wire the run-page "Type matchup" accordion. */
function setupMatchup() {
  const details = $("#matchup-section");
  const host = $("#matchup-picker");
  const t1 = $("#mu-type1");
  const t2 = $("#mu-type2");
  const result = $("#matchup-result");

  for (const t of TYPE_NAMES) {
    const o = el("option");
    o.value = t;
    o.textContent = capitalize(t);
    t1.appendChild(o);
  }
  const none = el("option");
  none.value = "";
  none.textContent = "(none)";
  t2.appendChild(none);
  for (const t of TYPE_NAMES) {
    const o = el("option");
    o.value = t;
    o.textContent = capitalize(t);
    t2.appendChild(o.cloneNode(true));
  }
  t1.value = "normal";
  t2.value = "";
  colorTypeSelect(t1);
  colorTypeSelect(t2);

  let chart = null;
  const render = async () => {
    colorTypeSelect(t1);
    colorTypeSelect(t2);
    if (!t1.value) return;
    if (!chart) {
      result.innerHTML = `<p class="muted">Loading type data…</p>`;
      try {
        await loadTypeInfos();
        chart = buildTypeChart(9).chart; // latest chart (all 18 types)
      } catch {
        result.innerHTML = `<p>Couldn't load type data from PokeAPI.</p>`;
        return;
      }
    }
    renderMatchup(result, chart, t1.value, t2.value);
  };

  host.appendChild(
    buildMatchupPicker(async (entry) => {
      try {
        const detail = await getPokemonDetail(entry.id);
        t1.value = detail.types[0] || "normal";
        t2.value = detail.types[1] || "";
      } catch {
        /* keep current selects */
      }
      render();
    }),
  );

  t1.addEventListener("change", render);
  t2.addEventListener("change", render);
  details.addEventListener("toggle", () => {
    if (details.open) render();
  });
}

// ---- New run modal ----
function openNewRunModal() {
  const form = el("form", "run-form");
  form.innerHTML = `
    <h3>New run</h3>
    <label>Name<input name="name" autocomplete="off" required></label>
    <label>Game <span class="muted">(optional)</span><input name="game" autocomplete="off"></label>
    <fieldset class="mode-field">
      <legend>Mode</legend>
      <label class="radio"><input type="radio" name="mode" value="normal" checked> Normal (solo)</label>
      <label class="radio"><input type="radio" name="mode" value="soullink"> 🔗 Soullink (2 players, linked)</label>
    </fieldset>
    <div class="soullink-fields" hidden>
      <label>Player 1<input name="player1" placeholder="Player 1" autocomplete="off"></label>
      <label>Player 2<input name="player2" placeholder="Player 2" autocomplete="off"></label>
    </div>
    <label>Password <span class="muted">(optional — protects the session)</span>
      <input name="password" type="password" autocomplete="new-password"></label>
    <button type="submit" class="btn primary">Create run</button>
  `;
  form.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      form.querySelector(".soullink-fields").hidden =
        form.querySelector('input[name="mode"]:checked').value !== "soullink";
    }),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get("name") || "").trim();
    if (!name) return;
    try {
      const run = await api("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          name,
          game: String(fd.get("game") || "").trim(),
          mode: fd.get("mode") || "normal",
          player1: String(fd.get("player1") || "").trim(),
          player2: String(fd.get("player2") || "").trim(),
          password: String(fd.get("password") || ""),
        }),
      });
      if (run.token) setToken(run.id, run.token);
      closeModal();
      await loadRuns();
      await selectRun(run.id);
    } catch (err) {
      toast(err.message);
    }
  });
  openModal(form);
  form.querySelector('input[name="name"]').focus();
}

// ---- Top-level actions ----
$("#new-run-btn").addEventListener("click", openNewRunModal);
setupTypeChart();
setupMatchup();

$("#add-cap-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameEl = $("#cap-name-input");
  const lvEl = $("#cap-level-input");
  const name = nameEl.value.trim();
  if (!name || !activeRunId) return;
  try {
    const cap = await api(`/api/runs/${activeRunId}/level-caps`, {
      method: "POST",
      body: JSON.stringify({
        name,
        level: lvEl.value === "" ? null : Number(lvEl.value),
      }),
      headers: runHeaders(),
    });
    levelCaps.push(cap);
    renderCaps();
    nameEl.value = "";
    lvEl.value = "";
    nameEl.focus();
  } catch (err) {
    toast(err.message);
  }
});

$("#clone-run-btn").addEventListener("click", async () => {
  const run = runs.find((r) => r.id === activeRunId);
  if (!run) return;
  const extras =
    run.mode === "soullink"
      ? ` Player names${run.protected ? " and password" : ""} are kept.`
      : run.protected
        ? " The password is kept."
        : "";
  if (
    !confirm(
      `Start a new run with the same routes as "${run.name}"? ` +
        `All encounters will be empty.${extras}`,
    )
  )
    return;
  try {
    const newRun = await api(`/api/runs/${run.id}/clone`, {
      method: "POST",
      headers: runHeaders(),
    });
    if (newRun.token) setToken(newRun.id, newRun.token);
    await loadRuns();
    await selectRun(newRun.id);
    toast(`Started "${newRun.name}".`);
  } catch (err) {
    toast(err.message);
  }
});

$("#delete-run-btn").addEventListener("click", async () => {
  const run = runs.find((r) => r.id === activeRunId);
  if (!run) return;
  if (!confirm(`Delete "${run.name}" and all its routes? This cannot be undone.`))
    return;
  try {
    await api(`/api/runs/${run.id}`, { method: "DELETE", headers: runHeaders() });
    activeRunId = null;
    localStorage.removeItem(ACTIVE_RUN_KEY);
    await loadRuns();
  } catch (err) {
    toast(err.message);
  }
});

$("#add-route-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inp = $("#route-name-input");
  const name = inp.value.trim();
  if (!name || !activeRunId) return;
  try {
    const route = await api(`/api/runs/${activeRunId}/routes`, {
      method: "POST",
      body: JSON.stringify({ name }),
      headers: runHeaders(),
    });
    routes.push(route);
    renderRoutes(runs.find((r) => r.id === activeRunId));
    inp.value = "";
    inp.focus();
    refreshSidebar();
  } catch (err) {
    toast(err.message);
  }
});

$("#unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $("#unlock-input").value;
  try {
    const res = await api(`/api/runs/${activeRunId}/unlock`, {
      method: "POST",
      body: JSON.stringify({ password: pw }),
    });
    if (res.token) setToken(activeRunId, res.token);
    $("#unlock-input").value = "";
    await loadActiveRun();
  } catch {
    toast("Wrong password");
  }
});

// ---- Boot ----
(async () => {
  await loadPokedex();
  await loadRuns();
  connectWS();
})();
