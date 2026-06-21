// Routes view: the encounter table (normal) / cards (soullink), the Pokémon
// picker, status/nickname editing, drag-to-reorder, and encounter persistence.
import {
  el,
  input,
  iconBtn,
  toast,
  renderSprite,
  routesArea,
} from "./dom.js";
import { state, runHeaders } from "./state.js";
import { api } from "./api.js";
import {
  displayName,
  spriteUrl,
  resolvePokemon,
  filterPokedex,
} from "./pokedex.js";
import { closeAllCombos, positionCombo } from "./combo.js";
import { recomputeDupes, applyDupeBadges, playerLabel, getDupe } from "./dupes.js";
import { MANUAL_STATUSES, STATUS_LABELS, STATUS_COLORS } from "./constants.js";
import { showInfo, evolve } from "./info.js";

let dragEl = null;
let pendingRoutesRefresh = false;

export async function loadRoutesData() {
  pendingRoutesRefresh = false;
  if (!state.activeRunId) {
    state.routes = [];
    renderRoutes();
    return;
  }
  try {
    state.routes = await api(`/api/runs/${state.activeRunId}/routes`, {
      headers: runHeaders(),
    });
  } catch (err) {
    toast(err.message);
    state.routes = [];
  }
  renderRoutes();
}

/** WS told us routes changed — refetch, but never clobber an in-progress edit. */
export function refreshRoutes() {
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

export function renderRoutes() {
  routesArea.innerHTML = "";
  if (!state.session) return;
  if (state.session.mode === "soullink") {
    const cards = el("div", "cards");
    for (const route of state.routes) cards.appendChild(buildSoullinkCard(route));
    routesArea.appendChild(cards);
    enableDrag(cards, ".route-card");
  } else {
    const wrap = el("div", "table-wrap");
    const table = el("table", "routes-table");
    table.innerHTML = `<thead><tr>
      <th class="col-route">Route</th><th class="col-sprite"></th>
      <th class="col-pokemon">Pokémon</th><th class="col-nick">Nickname</th>
      <th class="col-status">Status</th><th class="col-actions"></th></tr></thead>`;
    const tbody = el("tbody");
    for (const route of state.routes) tbody.appendChild(buildNormalRow(route));
    table.appendChild(tbody);
    wrap.appendChild(table);
    routesArea.appendChild(wrap);
    enableDrag(tbody, "tr");
  }
  recomputeDupes();
}

// ---- Drag-to-reorder ----
function dragHandle() {
  const h = el("span", "drag-handle");
  h.textContent = "⠿";
  h.title = "Drag to reorder";
  h.draggable = true;
  h.addEventListener("dragstart", (e) => {
    dragEl = h.closest("[data-route-id]");
    if (!dragEl) return;
    dragEl.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragEl.dataset.routeId);
    try {
      e.dataTransfer.setDragImage(dragEl, 12, 12);
    } catch {
      /* ignore */
    }
  });
  h.addEventListener("dragend", () => {
    if (dragEl) dragEl.classList.remove("dragging");
    dragEl = null;
    persistOrder();
  });
  return h;
}

function enableDrag(container, itemSelector) {
  container.addEventListener("dragover", (e) => {
    if (!dragEl || !container.contains(dragEl)) return;
    e.preventDefault();
    const after = dragAfter(container, itemSelector, e.clientY);
    if (after == null) container.appendChild(dragEl);
    else if (after !== dragEl) container.insertBefore(dragEl, after);
  });
}

function dragAfter(container, itemSelector, y) {
  const items = [...container.querySelectorAll(`${itemSelector}:not(.dragging)`)];
  let closest = { offset: -Infinity, el: null };
  for (const child of items) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
  }
  return closest.el;
}

async function persistOrder() {
  const ids = [...routesArea.querySelectorAll("[data-route-id]")].map((node) =>
    Number(node.dataset.routeId),
  );
  if (!ids.length) return;
  const order = new Map(ids.map((id, i) => [id, i]));
  state.routes.sort((a, b) => order.get(a.id) - order.get(b.id));
  try {
    await api(`/api/runs/${state.activeRunId}/reorder`, {
      method: "PUT",
      body: JSON.stringify({ order: ids }),
      headers: runHeaders(),
    });
  } catch (err) {
    toast(err.message);
    loadRoutesData();
  }
}

function rerenderRoute(routeId) {
  const route = state.routes.find((r) => r.id === routeId);
  const old = routesArea.querySelector(`[data-route-id="${routeId}"]`);
  if (!route || !old) return;
  old.replaceWith(
    state.session.mode === "soullink"
      ? buildSoullinkCard(route)
      : buildNormalRow(route),
  );
  applyDupeBadges();
}

function buildNormalRow(route) {
  const enc = route.encounters[0];
  const tr = el("tr");
  tr.dataset.routeId = route.id;
  if (enc?.status) tr.dataset.status = enc.status;

  const nameTd = el("td", "route-name-cell");
  const nameWrap = el("div", "route-name-wrap");
  nameWrap.appendChild(dragHandle());
  nameWrap.appendChild(routeNameInput(route));
  nameTd.appendChild(nameWrap);

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

function buildSoullinkCard(route) {
  const card = el("div", "route-card");
  card.dataset.routeId = route.id;

  const head = el("div", "card-head");
  head.appendChild(dragHandle());
  head.appendChild(routeNameInput(route));
  head.appendChild(deleteRouteBtn(route));
  card.appendChild(head);

  const body = el("div", "card-body");
  for (const slot of [0, 1]) {
    const enc = route.encounters.find((e) => e.slot === slot);
    const panel = el("div", "enc-panel");
    if (enc?.status) panel.dataset.status = enc.status;

    const label = el("div", "enc-player");
    label.textContent = playerLabel(slot);

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
      state.routes = state.routes.filter((r) => r.id !== route.id);
      routesArea.querySelector(`[data-route-id="${route.id}"]`)?.remove();
    } catch (err) {
      toast(err.message);
    }
  });
  return b;
}

export async function patchEncounter(enc, fields) {
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
    await recomputeDupes();
  } catch (err) {
    toast(err.message);
  }
}

function applyEncounter(e) {
  const route = state.routes.find((r) => r.id === e.route_id);
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
    if (list) positionCombo(inp, list);
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
    await patchEncounter(enc, fields);
    if (entry) {
      const info = getDupe(enc.id);
      if (info) {
        const who = state.session?.mode === "soullink" ? ` (${playerLabel(info.slot)})` : "";
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
