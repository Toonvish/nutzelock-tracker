// Type matchup calculator: pick a Pokémon (or two types) → effectiveness chips.
import { $, el, capitalize } from "./dom.js";
import { TYPE_NAMES, TYPE_COLORS, MULT_LABEL } from "./constants.js";
import { input } from "./dom.js";
import { spriteUrl, filterPokedex, getPokemonDetail } from "./pokedex.js";
import { closeAllCombos, positionCombo } from "./combo.js";
import { loadTypeInfos, buildTypeChart } from "./typechart.js";
import { getGen, onGenChange } from "./gen.js";

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
    if (list) positionCombo(inp, list);
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

function renderMatchup(container, chart, t1, t2) {
  const rows = [];
  for (const atk of TYPE_NAMES) {
    if (!chart[atk]) continue;
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
    const sec = el("div", "mu-group");
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
    sec.append(h, chips);
    groups.appendChild(sec);
  }
  container.appendChild(groups);
}

function colorTypeSelect(sel) {
  sel.style.color = sel.value ? TYPE_COLORS[sel.value] : "var(--muted)";
  sel.style.fontWeight = "600";
}

export function setupMatchup() {
  const details = $("#matchup-section");
  const host = $("#matchup-picker");
  const t1 = $("#mu-type1");
  const t2 = $("#mu-type2");
  const result = $("#matchup-result");

  const typeOption = (value, label) => {
    const o = el("option");
    o.value = value;
    o.textContent = label;
    o.style.color = value ? TYPE_COLORS[value] : "var(--muted)";
    o.style.backgroundColor = "var(--panel-2)";
    return o;
  };

  // Fill the type selects with the types that exist in the chosen generation,
  // keeping the current pick when it's still valid there.
  const fillTypeSelects = (types) => {
    const prev1 = t1.value;
    const prev2 = t2.value;
    t1.innerHTML = "";
    t2.innerHTML = "";
    for (const t of types) t1.appendChild(typeOption(t, capitalize(t)));
    t2.appendChild(typeOption("", "(none)"));
    for (const t of types) t2.appendChild(typeOption(t, capitalize(t)));
    t1.value = types.includes(prev1) ? prev1 : types[0];
    t2.value = types.includes(prev2) ? prev2 : "";
    colorTypeSelect(t1);
    colorTypeSelect(t2);
  };
  fillTypeSelects(TYPE_NAMES); // before load: all 18 types (Gen IX default)

  let loaded = false;
  const ensureLoaded = async () => {
    if (loaded) return true;
    result.innerHTML = `<p class="muted">Loading type data…</p>`;
    try {
      await loadTypeInfos();
      loaded = true;
      return true;
    } catch {
      result.innerHTML = `<p>Couldn't load type data from PokeAPI.</p>`;
      return false;
    }
  };

  // Sync the type selects to the current generation (equal type count ⇒ same
  // type set, so length is a safe "needs refill" check), then render.
  const refresh = async () => {
    if (!(await ensureLoaded())) return;
    const { types, chart } = buildTypeChart(getGen());
    if (t1.options.length !== types.length) fillTypeSelects(types);
    colorTypeSelect(t1);
    colorTypeSelect(t2);
    if (!t1.value) return;
    renderMatchup(result, chart, t1.value, t2.value);
  };

  host.appendChild(
    buildMatchupPicker(async (entry) => {
      try {
        const detail = await getPokemonDetail(entry.id);
        t1.value = detail.types[0] || "normal";
        t2.value = detail.types[1] || "";
      } catch {
        /* keep current */
      }
      refresh();
    }),
  );

  t1.addEventListener("change", refresh);
  t2.addEventListener("change", refresh);
  onGenChange(refresh);
  details.addEventListener("toggle", () => {
    if (details.open) refresh();
  });
}
