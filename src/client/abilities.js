// Ability lookup: autocomplete over the PokeAPI ability list → effect text.
import { $, el, input, toast } from "./dom.js";
import { api } from "./api.js";
import { POKEAPI, GEN_ORDER, GEN_LABELS } from "./constants.js";
import { closeAllCombos, positionCombo } from "./combo.js";

const ABILITIES_KEY = "nuzlocke.abilities.v1";
const titleCase = (s) =>
  s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

let abilities = []; // [{ name (api), display }]
const infoCache = new Map();

async function loadAbilities() {
  if (abilities.length) return abilities;
  let entries = null;
  try {
    const cached = localStorage.getItem(ABILITIES_KEY);
    if (cached) entries = JSON.parse(cached);
  } catch {
    /* ignore */
  }
  if (!entries) {
    const data = await api(`${POKEAPI}/ability?limit=100000`);
    entries = data.results.map((r) => ({ name: r.name, display: titleCase(r.name) }));
    try {
      localStorage.setItem(ABILITIES_KEY, JSON.stringify(entries));
    } catch {
      /* quota — fine */
    }
  }
  abilities = entries;
  return abilities;
}

function filterAbilities(q, limit = 40) {
  const starts = [];
  const contains = [];
  for (const a of abilities) {
    const n = a.display.toLowerCase();
    if (n.startsWith(q)) starts.push(a);
    else if (n.includes(q)) contains.push(a);
  }
  return starts.concat(contains).slice(0, limit);
}

async function getAbilityInfo(name) {
  if (infoCache.has(name)) return infoCache.get(name);
  const a = await api(`${POKEAPI}/ability/${name}`);
  const en = a.effect_entries.find((e) => e.language.name === "en");
  const flavor = [...a.flavor_text_entries]
    .reverse()
    .find((e) => e.language.name === "en");
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const gi = a.generation?.name ? GEN_ORDER.indexOf(a.generation.name) : -1;
  const info = {
    display: titleCase(a.name),
    generation: gi >= 0 ? `Gen ${GEN_LABELS[gi]}` : "",
    effect: clean(
      en?.effect || en?.short_effect || flavor?.flavor_text || "No description available.",
    ),
  };
  infoCache.set(name, info);
  return info;
}

export function setupAbilities() {
  const details = $("#ability-section");
  const host = $("#ability-picker");
  const result = $("#ability-result");

  const wrap = el("div", "combo");
  const inp = input("", "Search an ability…");
  wrap.appendChild(inp);
  host.appendChild(wrap);

  let list = null;
  let filtered = [];
  let activeIdx = -1;

  const closeList = () => {
    if (list) list.remove();
    list = null;
    filtered = [];
    activeIdx = -1;
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
    filtered = q ? filterAbilities(q) : [];
    closeAllCombos();
    list = null;
    if (!filtered.length) return;
    list = el("ul", "combo-list");
    filtered.forEach((e, i) => {
      const li = el("li", "combo-item" + (i === 0 ? " active" : ""));
      const name = el("span");
      name.textContent = e.display;
      li.appendChild(name);
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        choose(e);
      });
      list.appendChild(li);
    });
    document.body.appendChild(list);
    activeIdx = 0;
    positionCombo(inp, list);
  };

  const showAbility = async (name) => {
    result.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const info = await getAbilityInfo(name);
      result.innerHTML = "";
      const head = el("div", "ability-head");
      const title = el("h4", "ability-title");
      title.textContent = info.display;
      head.appendChild(title);
      if (info.generation) {
        const gen = el("span", "ability-gen");
        gen.textContent = info.generation;
        head.appendChild(gen);
      }
      const desc = el("p", "ability-desc");
      desc.textContent = info.effect;
      result.append(head, desc);
    } catch {
      result.innerHTML = `<p>Couldn't load that ability.</p>`;
    }
  };

  const choose = (entry) => {
    inp.value = entry.display;
    closeList();
    showAbility(entry.name);
  };

  const ensureList = async () => {
    try {
      await loadAbilities();
    } catch {
      toast("Could not load abilities from PokeAPI.");
    }
  };

  inp.addEventListener("focus", async () => {
    await ensureList();
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

  details.addEventListener("toggle", () => {
    if (details.open) ensureList();
  });
}
