// Session-wide generation selector, shared by the type chart and the type
// matchup calculator. One control in the run header drives both.
import { $, el } from "./dom.js";
import { GEN_LABELS } from "./constants.js";

let current = 9;
const listeners = new Set();

export const getGen = () => current;

/** Subscribe to generation changes; returns an unsubscribe function. */
export const onGenChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function setupGenSelect() {
  const sel = $("#gen-select");
  for (let g = 1; g <= 9; g++) {
    const o = el("option");
    o.value = String(g);
    o.textContent = `Gen ${GEN_LABELS[g - 1]}`;
    sel.appendChild(o);
  }
  sel.value = String(current);
  sel.addEventListener("change", () => {
    current = Number(sel.value);
    for (const fn of listeners) fn(current);
  });
}
