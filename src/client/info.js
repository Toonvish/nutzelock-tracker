// Info modal (base stats + abilities) and the Evolve flow.
import { el, toast, renderSprite, openModal, closeModal } from "./dom.js";
import { STAT_LABELS } from "./constants.js";
import {
  displayName,
  spriteUrl,
  getPokemonDetail,
  getAbilityEffect,
  getEvolutions,
} from "./pokedex.js";
import { patchEncounter } from "./routes.js";

// ---- Info: base stats + abilities ----
export async function showInfo(enc) {
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
export async function evolve(enc) {
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
