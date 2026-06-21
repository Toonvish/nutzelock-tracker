// Static tables and configuration shared across the client modules.

export const MANUAL_STATUSES = ["caught", "boxed", "fainted", "missed"];
export const STATUS_LABELS = {
  caught: "Alive",
  boxed: "Boxed",
  fainted: "Fainted",
  missed: "Missed",
  bro_failed: "Bro failed",
};
export const STATUS_COLORS = {
  caught: "var(--green)",
  boxed: "var(--blue)",
  fainted: "var(--red)",
  missed: "var(--gray)",
  bro_failed: "var(--bro)",
};
export const TYPE_NAMES = [
  "normal", "fire", "water", "electric", "grass", "ice", "fighting", "poison",
  "ground", "flying", "psychic", "bug", "rock", "ghost", "dragon", "dark",
  "steel", "fairy",
];
export const GEN_ORDER = [
  "generation-i", "generation-ii", "generation-iii", "generation-iv",
  "generation-v", "generation-vi", "generation-vii", "generation-viii",
  "generation-ix",
];
export const GEN_LABELS = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX"];
export const TYPE_COLORS = {
  normal: "#9fa19f", fire: "#e62829", water: "#2980ef", electric: "#fac000",
  grass: "#3fa129", ice: "#3dcef3", fighting: "#ff8000", poison: "#9141cb",
  ground: "#915121", flying: "#81b9ef", psychic: "#ef4179", bug: "#91a119",
  rock: "#afa981", ghost: "#704170", dragon: "#5060e1", dark: "#624d4e",
  steel: "#60a1b8", fairy: "#ef70ef",
};
export const POKEDEX_KEY = "nuzlocke.pokedex.v3";
export const POKEAPI = "https://pokeapi.co/api/v2";
export const POKEAPI_LIST = `${POKEAPI}/pokemon?limit=100000`;
export const SPRITE_BASE =
  "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon";
export const STAT_LABELS = {
  hp: "HP", attack: "Atk", defense: "Def",
  "special-attack": "SpA", "special-defense": "SpD", speed: "Spe",
};
export const MULT_LABEL = { 4: "×4", 2: "×2", 1: "×1", 0.5: "×½", 0.25: "×¼", 0: "×0" };
