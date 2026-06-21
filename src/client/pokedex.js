// Pokédex list (PokéAPI, cached in localStorage) + on-demand detail lookups.
import { POKEDEX_KEY, POKEAPI, POKEAPI_LIST, SPRITE_BASE } from "./constants.js";
import { api } from "./api.js";
import { toast } from "./dom.js";

const REGION_NAMES = { alola: "Alolan", galar: "Galarian", hisui: "Hisuian", paldea: "Paldean" };
const titleCase = (s) =>
  s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** "mr-mime" -> "Mr Mime"; "rattata-alola" -> "Alolan Rattata". */
export function displayName(apiName) {
  const parts = apiName.split("-");
  const idx = parts.findIndex((p) => REGION_NAMES[p]);
  if (idx <= 0) return titleCase(apiName);
  const base = parts.slice(0, idx).map((p) => titleCase(p)).join(" ");
  const region = REGION_NAMES[parts[idx]];
  const extra = parts.slice(idx + 1).map((p) => titleCase(p)).join(" ");
  return `${region} ${base}${extra ? ` (${extra})` : ""}`;
}

export const spriteUrl = (id) => `${SPRITE_BASE}/${id}.png`;

let pokedex = new Map(); // display(lower) -> { id, apiName, display }
let pokedexList = [];

export async function loadPokedex() {
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

export function resolvePokemon(text) {
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

export function filterPokedex(q, limit = 40) {
  const starts = [];
  const contains = [];
  for (const e of pokedexList) {
    const name = e.display.toLowerCase();
    if (name.startsWith(q)) starts.push(e);
    else if (name.includes(q)) contains.push(e);
  }
  return starts.concat(contains).slice(0, limit);
}

// ---- on-demand detail lookups (cached) ----
const detailCache = new Map();
const abilityCache = new Map();
const evoCache = new Map();

export async function getPokemonDetail(id) {
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

export async function getAbilityEffect(name) {
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

export async function getEvolutions(detail) {
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

const familyCache = new Map(); // pokemonId -> evolution-chain id (family key)

export async function getFamilyKey(pokemonId) {
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
