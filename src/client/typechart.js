// Type-effectiveness chart (per generation). The 18 compact type infos come
// from our own cached /api/typechart endpoint (one request, not 18 to PokeAPI).
import { $, el, capitalize } from "./dom.js";
import { api } from "./api.js";
import { GEN_ORDER, GEN_LABELS, TYPE_COLORS } from "./constants.js";

const MULT_TEXT = { 2: "2×", 1: "1×", 0.5: "½×", 0: "0×" };
const MULT_CLASS = { 2: "eff-super", 1: "eff-normal", 0.5: "eff-weak", 0: "eff-none" };

let typeInfos = null;

export async function loadTypeInfos() {
  if (typeInfos) return typeInfos;
  typeInfos = await api("/api/typechart");
  return typeInfos;
}

export function buildTypeChart(genNum) {
  const gIdx = genNum - 1;
  const gi = (name) => GEN_ORDER.indexOf(name);
  const types = typeInfos.filter((i) => gi(i.gen) <= gIdx).map((i) => i.name);
  const present = new Set(types);
  const chart = {};
  for (const info of typeInfos) {
    if (!present.has(info.name)) continue;
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

function renderTypeGrid(container, genNum) {
  const { types, chart } = buildTypeChart(genNum);
  const table = el("table", "type-chart");

  const thead = el("thead");
  const htr = el("tr");
  const corner = el("th", "tc-corner");
  corner.innerHTML =
    `<span class="tc-corner-def">Defender →</span>` +
    `<span class="tc-corner-atk">Attacker ↓</span>`;
  htr.appendChild(corner);
  for (const d of types) {
    const th = el("th", "tc-head");
    th.textContent = capitalize(d);
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
    rh.textContent = capitalize(a);
    rh.style.background = TYPE_COLORS[a];
    rh.title = capitalize(a);
    tr.appendChild(rh);
    for (const d of types) {
      const m = chart[a][d];
      const td = el("td", `tc-cell ${MULT_CLASS[m] || "eff-normal"}`);
      td.textContent = MULT_TEXT[m] ?? `${m}×`;
      td.title = `${capitalize(a)} → ${capitalize(d)}: ${MULT_TEXT[m] ?? `${m}×`}`;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.innerHTML = "";
  container.appendChild(table);
  enableTypeHover(table);
}

/** Highlight the hovered cell's whole row + column (incl. their headers). */
function enableTypeHover(table) {
  let marked = [];
  const clear = () => {
    for (const c of marked) c.classList.remove("tc-hl", "tc-hl-cell");
    marked = [];
  };
  table.addEventListener("mouseover", (e) => {
    const cell = e.target.closest("th, td");
    if (!cell || !table.contains(cell)) return;
    clear();
    const col = cell.cellIndex;
    for (const tr of table.rows) {
      const c = tr.cells[col];
      if (c) {
        c.classList.add("tc-hl");
        marked.push(c);
      }
    }
    for (const c of cell.parentElement.cells) {
      c.classList.add("tc-hl");
      marked.push(c);
    }
    cell.classList.add("tc-hl-cell");
    marked.push(cell);
  });
  table.addEventListener("mouseleave", clear);
}

export function setupTypeChart() {
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
