// Custom Nuzlocke Tracker — dependency-free SPA.
// Talks to the Bun JSON API and pulls Pokémon names/sprites from PokeAPI.

const STATUSES = ["caught", "boxed", "fainted", "missed"];
const ACTIVE_RUN_KEY = "nuzlocke.activeRun";
const POKEDEX_KEY = "nuzlocke.pokedex.v1";
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
const routesBody = $("#routes-body");

// ---- State ----
let runs = [];
let activeRunId = Number(localStorage.getItem(ACTIVE_RUN_KEY)) || null;
let routes = [];
/** Map: display-name (lowercase) -> { id, apiName, display } */
let pokedex = new Map();
/** Same entries as a flat array, for prefix/substring filtering in the picker. */
let pokedexList = [];

// ---- Helpers ----
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/** "mr-mime" -> "Mr Mime" */
function displayName(apiName) {
  return apiName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function spriteUrl(id) {
  return `${SPRITE_BASE}/${id}.png`;
}

// ---- Pokédex (PokeAPI) ----
async function loadPokedex() {
  let entries = null;
  try {
    const cached = localStorage.getItem(POKEDEX_KEY);
    if (cached) entries = JSON.parse(cached);
  } catch {
    /* ignore corrupt cache */
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
        // Drop alternate/mega forms with huge ids that lack default sprites.
        .filter((e) => e.id <= 10000);
      localStorage.setItem(POKEDEX_KEY, JSON.stringify(entries));
    } catch (err) {
      toast("Could not reach PokeAPI — you can still type names manually.");
      entries = [];
    }
  }

  pokedexList = entries;
  pokedex = new Map();
  for (const e of entries) pokedex.set(e.display.toLowerCase(), e);
}

/** Resolve typed text to a pokédex entry: exact match first, else a prefix match. */
function resolvePokemon(text) {
  const key = text.trim().toLowerCase();
  if (!key) return null;
  const exact = pokedex.get(key) || pokedex.get(displayName(key).toLowerCase());
  if (exact) return exact;
  // Forgiving fallback: first entry whose name starts with the typed text
  // (so "pika" → Pikachu even without picking from the dropdown).
  let best = null;
  for (const e of pokedex.values()) {
    if (e.display.toLowerCase().startsWith(key)) {
      if (!best || e.id < best.id) best = e;
    }
  }
  return best;
}

/** Up to `limit` entries matching `q`: prefix matches first, then substring. */
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

/** Close every open picker dropdown (only one should be open at a time). */
function closeAllCombos() {
  for (const ul of document.querySelectorAll(".combo-list")) ul.remove();
}

// Clicking anywhere outside an open picker closes it.
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest(".combo") && !e.target.closest(".combo-list"))
    closeAllCombos();
});
// The dropdown is fixed-positioned, so scrolling would detach it — just close.
window.addEventListener("scroll", closeAllCombos, true);
window.addEventListener("resize", closeAllCombos);

// ---- PokeAPI detail lookups (on-demand, cached) ----
const detailCache = new Map(); // id -> { id, name, bst, stats, abilities, speciesUrl }
const abilityCache = new Map(); // name -> effect text
const evoCache = new Map(); // id -> [pokedex entries]

/** Base stats (BST), abilities and species link for a Pokémon id. */
async function getPokemonDetail(id) {
  if (detailCache.has(id)) return detailCache.get(id);
  const d = await api(`${POKEAPI}/pokemon/${id}`);
  const detail = {
    id: d.id,
    name: d.name,
    stats: d.stats.map((s) => ({ name: s.stat.name, value: s.base_stat })),
    bst: d.stats.reduce((sum, s) => sum + s.base_stat, 0),
    abilities: d.abilities.map((a) => ({
      name: a.ability.name,
      hidden: a.is_hidden,
    })),
    speciesUrl: d.species.url,
  };
  detailCache.set(id, detail);
  return detail;
}

/** Short English effect text for an ability. */
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

/** Pokédex entries this Pokémon evolves directly into (0, 1, or several). */
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
  // Map species names back to our cached pokédex entries (id + display).
  const opts = names
    .map((n) => pokedex.get(displayName(n).toLowerCase()))
    .filter(Boolean);
  evoCache.set(detail.id, opts);
  return opts;
}

// ---- Runs (sidebar) ----
async function loadRuns() {
  runs = await api("/api/runs");
  if (activeRunId && !runs.some((r) => r.id === activeRunId)) activeRunId = null;
  if (!activeRunId && runs.length) activeRunId = runs[0].id;
  renderRuns();
  await loadActiveRun();
}

function renderRuns() {
  runList.innerHTML = "";
  for (const run of runs) {
    const li = document.createElement("li");
    li.className = "run-item" + (run.id === activeRunId ? " active" : "");
    li.dataset.id = run.id;
    const tally = `${run.caught} caught · ${run.boxed} boxed · ${run.fainted} fainted`;
    li.innerHTML = `<div class="run-name"></div><div class="run-tally">${tally}</div>`;
    li.querySelector(".run-name").textContent = run.name;
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

async function loadActiveRun() {
  if (!activeRunId) {
    runView.hidden = true;
    emptyState.hidden = false;
    return;
  }
  const run = runs.find((r) => r.id === activeRunId);
  emptyState.hidden = true;
  runView.hidden = false;
  runTitle.textContent = run.name;
  runSubtitle.textContent =
    (run.game ? `${run.game} · ` : "") + `${run.routes} routes`;
  routes = await api(`/api/runs/${activeRunId}/routes`);
  renderRoutes();
}

// ---- Routes table ----
function renderRoutes() {
  routesBody.innerHTML = "";
  for (const route of routes) routesBody.appendChild(routeRow(route));
}

/**
 * A searchable Pokémon picker: a text input plus a sprite-thumbnail dropdown.
 * The dropdown is appended to <body> as a fixed-position element so it is never
 * clipped by the table's overflow containers. Returns the wrapper element.
 */
function buildPokemonPicker(route, spriteBox) {
  const wrap = el("div", "combo");
  const inp = input(
    route.pokemon_name ? displayName(route.pokemon_name) : "",
    "Pick or type…",
  );
  wrap.appendChild(inp);

  let list = null; // the live dropdown <ul>, when open
  let filtered = [];
  let activeIdx = -1;
  // Display string we last committed — lets blur skip redundant re-commits.
  let committed = route.pokemon_name ? displayName(route.pokemon_name) : "";

  const closeList = () => {
    if (list) {
      list.remove();
      list = null;
    }
    filtered = [];
    activeIdx = -1;
  };

  const positionList = () => {
    if (!list) return;
    const r = inp.getBoundingClientRect();
    list.style.left = `${r.left}px`;
    list.style.top = `${r.bottom + 2}px`;
    list.style.width = `${r.width}px`;
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
    // First time a Pokémon is set on an empty route, default status to "caught".
    if ((entry || rawText) && !route.status) fields.status = "caught";
    closeList();
    await patchRoute(route, fields);
    // Rebuild the row so the info/evolve buttons reflect the new Pokémon.
    replaceRow(route);
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
      const name = document.createElement("span");
      name.textContent = e.display;
      const idTag = el("span", "combo-id");
      idTag.textContent = `#${e.id}`;
      li.append(img, name, idTag);
      // mousedown fires before the input's blur, so selection isn't lost.
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
  // Commit on blur if the text changed and wasn't already chosen from the list.
  inp.addEventListener("blur", () => {
    setTimeout(() => {
      closeList();
      const text = inp.value.trim();
      if (text === committed) return; // unchanged (covers click/Enter selection)
      if (!text) return commit(null, "");
      const hit = resolvePokemon(text);
      commit(hit, hit ? null : text);
    }, 120);
  });

  return wrap;
}

function routeRow(route) {
  const tr = document.createElement("tr");
  tr.dataset.id = route.id;
  if (route.status) tr.dataset.status = route.status;

  // Route name (editable)
  const nameTd = el("td", "route-name-cell");
  const nameInput = input(route.name, "Route name");
  nameInput.addEventListener("change", () =>
    patchRoute(route, { name: nameInput.value.trim() || route.name }),
  );
  nameTd.appendChild(nameInput);

  // Sprite
  const spriteTd = el("td", "col-sprite");
  const spriteBox = el("div", "sprite-box");
  renderSprite(spriteBox, route.sprite_url);
  spriteTd.appendChild(spriteBox);

  // Pokémon picker (custom dropdown with sprite thumbnails)
  const pokeTd = el("td", "pokemon-cell");
  pokeTd.appendChild(buildPokemonPicker(route, spriteBox));

  // Nickname
  const nickTd = el("td", "nick-cell");
  const nickInput = input(route.nickname || "", "Nickname");
  nickInput.addEventListener("change", () =>
    patchRoute(route, { nickname: nickInput.value.trim() || null }),
  );
  nickTd.appendChild(nickInput);

  // Status
  const statusTd = el("td", "col-status");
  const sel = document.createElement("select");
  sel.className = "status";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "—";
  sel.appendChild(blank);
  for (const s of STATUSES) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s.charAt(0).toUpperCase() + s.slice(1);
    sel.appendChild(o);
  }
  sel.value = route.status || "";
  sel.dataset.status = route.status || "";
  sel.addEventListener("change", () =>
    patchRoute(route, { status: sel.value || null }),
  );
  statusTd.appendChild(sel);

  // Actions: info, evolve, delete
  const actionsTd = el("td", "col-actions");
  const hasMon = !!route.pokemon_id;

  const infoBtn = iconBtn("ℹ️", "Base stats & abilities");
  infoBtn.disabled = !hasMon;
  infoBtn.addEventListener("click", () => showInfo(route));

  const evolveBtn = iconBtn("🧬", "Evolve");
  evolveBtn.disabled = !hasMon;
  evolveBtn.addEventListener("click", () => evolve(route));

  const delBtn = iconBtn("✕", "Delete route", "del");
  delBtn.addEventListener("click", async () => {
    await api(`/api/routes/${route.id}`, { method: "DELETE" });
    routes = routes.filter((r) => r.id !== route.id);
    tr.remove();
    refreshTally();
  });

  actionsTd.append(infoBtn, evolveBtn, delBtn);

  tr.append(nameTd, spriteTd, pokeTd, nickTd, statusTd, actionsTd);
  return tr;
}

function iconBtn(label, title, cls) {
  const b = el("button", "icon-btn" + (cls ? ` ${cls}` : ""));
  b.textContent = label;
  b.title = title;
  return b;
}

/** Rebuild a single route row in place (e.g. after its Pokémon changes). */
function replaceRow(route) {
  const old = routesBody.querySelector(`tr[data-id="${route.id}"]`);
  if (old) old.replaceWith(routeRow(route));
}

// ---- Modal ----
function escClose(e) {
  if (e.key === "Escape") closeModal();
}
function closeModal() {
  const o = document.querySelector(".modal-overlay");
  if (o) o.remove();
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
async function showInfo(route) {
  if (!route.pokemon_id) return;
  const content = el("div", "info");
  content.innerHTML = `<p class="muted">Loading…</p>`;
  openModal(content);
  try {
    const detail = await getPokemonDetail(route.pokemon_id);
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
      displayName(detail.name) +
      (route.nickname ? ` "${route.nickname}"` : "");
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
      name.textContent =
        displayName(a.name) + (a.hidden ? " (Hidden)" : "");
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
async function evolve(route) {
  if (!route.pokemon_id) return;
  try {
    const detail = await getPokemonDetail(route.pokemon_id);
    const opts = await getEvolutions(detail);
    if (!opts.length) {
      toast(`${displayName(route.pokemon_name)} has no further evolution.`);
      return;
    }
    if (opts.length === 1) {
      await applyEvolution(route, opts[0]);
      return;
    }
    // Branching evolution (e.g. Eevee) — let the user choose.
    const content = el("div", "evolve");
    const h = el("h3");
    h.textContent = `Evolve ${displayName(route.pokemon_name)} into…`;
    const grid = el("div", "evolve-options");
    for (const o of opts) {
      const btn = el("button", "evolve-option");
      const box = el("div", "sprite-box");
      renderSprite(box, spriteUrl(o.id));
      const name = el("span");
      name.textContent = o.display;
      btn.append(box, name);
      btn.addEventListener("click", async () => {
        closeModal();
        await applyEvolution(route, o);
      });
      grid.appendChild(btn);
    }
    content.append(h, grid);
    openModal(content);
  } catch (err) {
    toast("Couldn't load evolution data.");
  }
}

async function applyEvolution(route, entry) {
  await patchRoute(route, {
    pokemon_id: entry.id,
    pokemon_name: entry.apiName,
    sprite_url: spriteUrl(entry.id),
  });
  replaceRow(route);
  toast(`Evolved into ${entry.display}!`);
}

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

/** PUT a partial update, refresh local state + row styling + sidebar tally. */
async function patchRoute(route, fields) {
  try {
    const updated = await api(`/api/routes/${route.id}`, {
      method: "PUT",
      body: JSON.stringify(fields),
    });
    Object.assign(route, updated);
    const tr = routesBody.querySelector(`tr[data-id="${route.id}"]`);
    if (tr) {
      if (route.status) tr.dataset.status = route.status;
      else delete tr.dataset.status;
      const sel = tr.querySelector("select.status");
      if (sel) {
        sel.value = route.status || "";
        sel.dataset.status = route.status || "";
      }
    }
    refreshTally();
  } catch (err) {
    toast(err.message);
  }
}

/** Recompute the active run's tallies from local routes, update the sidebar. */
function refreshTally() {
  const run = runs.find((r) => r.id === activeRunId);
  if (!run) return;
  run.routes = routes.length;
  run.caught = routes.filter((r) => r.status === "caught").length;
  run.boxed = routes.filter((r) => r.status === "boxed").length;
  run.fainted = routes.filter((r) => r.status === "fainted").length;
  run.missed = routes.filter((r) => r.status === "missed").length;
  renderRuns();
  runSubtitle.textContent =
    (run.game ? `${run.game} · ` : "") + `${run.routes} routes`;
}

// ---- Small element helpers ----
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

// ---- Top-level actions ----
$("#new-run-btn").addEventListener("click", async () => {
  const name = prompt("Name this run (e.g. FireRed Nuzlocke #1):");
  if (!name || !name.trim()) return;
  const game = prompt("Game? (optional, e.g. FireRed) — leave blank to skip:") || "";
  const run = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({ name: name.trim(), game: game.trim() }),
  });
  await loadRuns();
  await selectRun(run.id);
});

$("#delete-run-btn").addEventListener("click", async () => {
  const run = runs.find((r) => r.id === activeRunId);
  if (!run) return;
  if (!confirm(`Delete "${run.name}" and all its routes? This cannot be undone.`))
    return;
  await api(`/api/runs/${run.id}`, { method: "DELETE" });
  activeRunId = null;
  localStorage.removeItem(ACTIVE_RUN_KEY);
  await loadRuns();
});

$("#add-route-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inputEl = $("#route-name-input");
  const name = inputEl.value.trim();
  if (!name || !activeRunId) return;
  const route = await api(`/api/runs/${activeRunId}/routes`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  routes.push(route);
  routesBody.appendChild(routeRow(route));
  inputEl.value = "";
  inputEl.focus();
  refreshTally();
});

// ---- Boot ----
(async () => {
  await loadPokedex();
  await loadRuns();
})();
