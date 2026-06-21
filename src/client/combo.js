// Shared sprite-thumbnail dropdown used by the encounter and matchup pickers.
import { el } from "./dom.js";
import { spriteUrl } from "./pokedex.js";

export function closeAllCombos() {
  for (const ul of document.querySelectorAll(".combo-list")) ul.remove();
}

/** Position a (fixed) combo dropdown under its input, flipping above when the
 *  page is filled and there's more room up top. Caps height to the space. */
export function positionCombo(inp, list) {
  const r = inp.getBoundingClientRect();
  const margin = 8;
  const spaceBelow = window.innerHeight - r.bottom - margin;
  const spaceAbove = r.top - margin;
  const natural = Math.min(list.scrollHeight, 280);
  const openUp = natural > spaceBelow && spaceAbove > spaceBelow;
  const h = Math.min(natural, openUp ? spaceAbove : spaceBelow);
  list.style.maxHeight = `${h}px`;
  list.style.left = `${r.left}px`;
  list.style.width = `${Math.max(r.width, 200)}px`;
  list.style.top = `${openUp ? r.top - h - 2 : r.bottom + 2}px`;
}

/** Build + show the dropdown of filtered entries; calls onPick(entry) on click. */
export function openComboList(inp, filtered, onPick) {
  closeAllCombos();
  if (!filtered.length) return null;
  const list = el("ul", "combo-list");
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
      onPick(e);
    });
    list.appendChild(li);
  });
  document.body.appendChild(list);
  positionCombo(inp, list);
  return list;
}

/** Move the highlighted item; returns the normalised index. */
export function comboSetActive(list, idx) {
  const items = [...list.children];
  if (!items.length) return idx;
  const n = (idx + items.length) % items.length;
  items.forEach((li, i) => li.classList.toggle("active", i === n));
  items[n].scrollIntoView({ block: "nearest" });
  return n;
}

document.addEventListener("mousedown", (e) => {
  if (!e.target.closest(".combo") && !e.target.closest(".combo-list"))
    closeAllCombos();
});
window.addEventListener("scroll", closeAllCombos, true);
window.addEventListener("resize", closeAllCombos);
