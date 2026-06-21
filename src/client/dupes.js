// Dupes clause: warn when an evolution line is already an encounter elsewhere.
import { el, routesArea } from "./dom.js";
import { getFamilyKey } from "./pokedex.js";
import { state } from "./state.js";

let dupeInfo = new Map(); // encounterId -> { routeName, slot } of the conflict

export const getDupe = (encId) => dupeInfo.get(encId);

export function playerLabel(slot) {
  return slot === 0
    ? state.session?.player1 || "Player 1"
    : state.session?.player2 || "Player 2";
}

/** Two encounters are dupes if their families match on *different* routes. */
export async function recomputeDupes() {
  const items = [];
  for (const route of state.routes)
    for (const e of route.encounters) if (e.pokemon_id) items.push({ e, route });
  await Promise.all(items.map((x) => getFamilyKey(x.e.pokemon_id)));

  const byFamily = new Map();
  for (const x of items) {
    const k = await getFamilyKey(x.e.pokemon_id);
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

export function applyDupeBadges() {
  for (const box of routesArea.querySelectorAll(".sprite-box[data-enc-id]")) {
    box.querySelector(".dupe-badge")?.remove();
    box.classList.remove("has-dupe");
    const info = dupeInfo.get(Number(box.dataset.encId));
    if (!info) continue;
    box.classList.add("has-dupe");
    const badge = el("span", "dupe-badge");
    badge.textContent = "⚠";
    const who = state.session?.mode === "soullink" ? ` (${playerLabel(info.slot)})` : "";
    badge.title = `Dupe — this evolution line is already an encounter on ${info.routeName}${who}`;
    box.appendChild(badge);
  }
}
