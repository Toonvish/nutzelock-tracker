// Nuzlocke Tracker — entry point.
// Wires the static DOM controls (they exist from page load), starts the live
// socket, and boots the router. Feature logic lives in the sibling modules.
import { $, toast } from "./dom.js";
import { api } from "./api.js";
import { state, runHeaders } from "./state.js";
import { loadPokedex } from "./pokedex.js";
import { loadRoutesData, renderRoutes } from "./routes.js";
import { loadCaps, renderCaps } from "./levelcaps.js";
import { setupTypeChart } from "./typechart.js";
import { setupMatchup } from "./matchup.js";
import {
  route,
  nav,
  connectWS,
  reloadAttempts,
  renderSessionHeader,
  openNewSessionModal,
} from "./router.js";

window.addEventListener("popstate", route);
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (a) {
    e.preventDefault();
    nav(a.getAttribute("href"));
  }
});

// ---- Static event wiring (elements exist in the DOM from the start) ----
$("#guest-btn").addEventListener("click", openNewSessionModal);
$("#new-session-btn").addEventListener("click", openNewSessionModal);
$("#logout-btn").addEventListener("click", async () => {
  try {
    await fetch("/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  state.me = null;
  nav("/login");
});
$("#back-link").addEventListener("click", (e) => {
  e.preventDefault();
  nav("/sessions");
});

$("#attempt-select").addEventListener("change", async (e) => {
  state.activeRunId = Number(e.target.value);
  await loadRoutesData();
  loadCaps();
});

$("#new-run-btn").addEventListener("click", async () => {
  if (
    !confirm(
      "Start a new run? Routes and level caps are copied; encounters start empty.",
    )
  )
    return;
  try {
    const run = await api(`/api/sessions/${state.shareId}/runs`, {
      method: "POST",
      headers: runHeaders(),
    });
    await reloadAttempts();
    state.activeRunId = run.id;
    renderSessionHeader();
    await loadRoutesData();
    loadCaps();
    toast(`Started run #${run.run_number}.`);
  } catch (err) {
    toast(err.message);
  }
});

$("#share-btn").addEventListener("click", async () => {
  const link = `${location.origin}/s/${state.shareId}`;
  try {
    await navigator.clipboard.writeText(link);
    toast("Share link copied to clipboard.");
  } catch {
    toast(link);
  }
});

$("#delete-session-btn").addEventListener("click", async () => {
  if (!state.session) return;
  if (!confirm(`Delete "${state.session.name}" and all its runs? This cannot be undone.`))
    return;
  try {
    await api(`/api/sessions/${state.shareId}`, {
      method: "DELETE",
      headers: runHeaders(),
    });
    nav(state.me ? "/sessions" : "/login");
  } catch (err) {
    toast(err.message);
  }
});

$("#add-cap-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameEl = $("#cap-name-input");
  const lvEl = $("#cap-level-input");
  const name = nameEl.value.trim();
  if (!name || !state.activeRunId) return;
  try {
    const cap = await api(`/api/runs/${state.activeRunId}/level-caps`, {
      method: "POST",
      body: JSON.stringify({
        name,
        level: lvEl.value === "" ? null : Number(lvEl.value),
      }),
      headers: runHeaders(),
    });
    state.levelCaps.push(cap);
    renderCaps();
    nameEl.value = "";
    lvEl.value = "";
    nameEl.focus();
  } catch (err) {
    toast(err.message);
  }
});

$("#add-route-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inp = $("#route-name-input");
  const name = inp.value.trim();
  if (!name || !state.activeRunId) return;
  try {
    const route = await api(`/api/runs/${state.activeRunId}/routes`, {
      method: "POST",
      body: JSON.stringify({ name }),
      headers: runHeaders(),
    });
    state.routes.push(route);
    renderRoutes();
    inp.value = "";
    inp.focus();
  } catch (err) {
    toast(err.message);
  }
});

setupTypeChart();
setupMatchup();

// ---- Boot ----
(async () => {
  await loadPokedex();
  try {
    state.me = (await api("/api/me")).user;
  } catch {
    state.me = null;
  }
  connectWS();
  route();
})();
