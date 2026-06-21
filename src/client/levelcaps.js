// Level caps (gym leaders, Elite Four, …) for the active run.
import { $, el, toast } from "./dom.js";
import { api } from "./api.js";
import { state, runHeaders } from "./state.js";

export async function loadCaps() {
  if (!state.activeRunId) return;
  try {
    state.levelCaps = await api(`/api/runs/${state.activeRunId}/level-caps`, {
      headers: runHeaders(),
    });
  } catch {
    state.levelCaps = [];
  }
  renderCaps();
}

export function renderCaps() {
  const list = $("#caps-list");
  list.innerHTML = "";
  if (!state.levelCaps.length) {
    const empty = el("span", "caps-empty muted");
    empty.textContent = "No level caps yet — add gym leaders, Elite Four, etc.";
    list.appendChild(empty);
    return;
  }
  for (const cap of state.levelCaps) list.appendChild(buildCapChip(cap));
}

function buildCapChip(cap) {
  const chip = el("div", "cap-chip" + (cap.cleared ? " cleared" : ""));
  const name = el("span", "cap-name");
  name.textContent = cap.name;
  const lv = el("span", "cap-lv");
  lv.textContent = cap.level != null ? `Lv ${cap.level}` : "—";
  chip.append(name, lv);
  const del = el("button", "cap-del");
  del.type = "button";
  del.textContent = "×";
  del.title = "Remove";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteCap(cap);
  });
  chip.append(del);
  chip.title = cap.cleared ? "Cleared — click to unmark" : "Click to mark cleared";
  chip.addEventListener("click", () => toggleCap(cap));
  return chip;
}

async function toggleCap(cap) {
  try {
    const updated = await api(`/api/level-caps/${cap.id}`, {
      method: "PUT",
      body: JSON.stringify({ cleared: !cap.cleared }),
      headers: runHeaders(),
    });
    Object.assign(cap, updated);
    renderCaps();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteCap(cap) {
  try {
    await api(`/api/level-caps/${cap.id}`, {
      method: "DELETE",
      headers: runHeaders(),
    });
    state.levelCaps = state.levelCaps.filter((c) => c.id !== cap.id);
    renderCaps();
  } catch (err) {
    toast(err.message);
  }
}
