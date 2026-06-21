// History router, the three views (login / sessions / session), the session
// header + attempt switcher, the new-session modal, and the live-sync socket.
import { $, el, toast, closeModal, openModal } from "./dom.js";
import { api } from "./api.js";
import { state, runHeaders } from "./state.js";
import { loadRoutesData, refreshRoutes } from "./routes.js";
import { loadCaps } from "./levelcaps.js";

let ws = null;
let attempts = []; // RunSummary[] of the current session

// ---- Live sync (WebSocket) ----
function setSync(on) {
  const d = $("#sync-dot");
  if (d) d.classList.toggle("on", on);
}
export function watchSession() {
  if (ws && ws.readyState === 1 && state.shareId)
    ws.send(JSON.stringify({ op: "watch", shareId: state.shareId }));
}
export function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    setSync(true);
    watchSession();
  };
  ws.onclose = () => {
    setSync(false);
    setTimeout(connectWS, 1500);
  };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.type === "routes" && m.runId === state.activeRunId) refreshRoutes();
    else if (m.type === "caps" && m.runId === state.activeRunId) loadCaps();
    else if (m.type === "session") reloadAttempts();
  };
}

// ---- Router & pages ----
function showView(id) {
  for (const v of document.querySelectorAll(".page")) v.hidden = v.id !== id;
}
export function nav(path) {
  history.pushState({}, "", path);
  route();
}

export function route() {
  const path = location.pathname;
  if (path.startsWith("/s/")) return openSession(decodeURIComponent(path.slice(3)));
  if (path === "/sessions") return showSessions();
  if (path === "/login") return showLogin();
  return nav(state.me ? "/sessions" : "/login");
}

function showLogin() {
  state.shareId = null;
  showView("login-view");
  const err = new URLSearchParams(location.search).get("error");
  const e = $("#login-error");
  e.hidden = !err;
  if (err) e.textContent = "Login failed — please try again.";
}

async function showSessions() {
  if (!state.me) return nav("/login");
  state.shareId = null;
  showView("sessions-view");
  const chip = $("#user-chip");
  chip.innerHTML = "";
  if (state.me.avatar_url) {
    const img = el("img", "user-avatar");
    img.src = state.me.avatar_url;
    img.alt = "";
    chip.appendChild(img);
  }
  const nm = el("span");
  nm.textContent = state.me.name || "You";
  chip.appendChild(nm);
  try {
    const list = await api("/api/sessions");
    renderSessions(list);
  } catch (err) {
    toast(err.message);
  }
}

function renderSessions(list) {
  const ul = $("#sessions-list");
  ul.innerHTML = "";
  $("#sessions-empty").hidden = list.length > 0;
  for (const s of list) {
    const li = el("li", "session-item");
    const name = el("div", "s-name");
    name.textContent = (s.mode === "soullink" ? "🔗 " : "") + s.name;
    const meta = el("div", "s-meta muted");
    meta.textContent =
      `${s.run_count} run${s.run_count === 1 ? "" : "s"}` +
      (s.game ? ` · ${s.game}` : "");
    li.append(name, meta);
    li.addEventListener("click", () => nav(`/s/${s.share_id}`));
    ul.appendChild(li);
  }
}

async function openSession(sid) {
  state.shareId = sid;
  let data;
  try {
    data = await api(`/api/sessions/${sid}`);
  } catch {
    toast("That run could not be found.");
    return nav(state.me ? "/sessions" : "/login");
  }
  state.session = data.session;
  attempts = data.runs;
  state.activeRunId = attempts.length
    ? attempts[attempts.length - 1].id // latest attempt
    : null;
  showView("session-view");
  renderSessionHeader();
  watchSession();
  await loadRoutesData();
  loadCaps();
}

/** Refetch the session meta + attempts (after a new run or rename). */
export async function reloadAttempts() {
  if (!state.shareId) return;
  try {
    const data = await api(`/api/sessions/${state.shareId}`);
    state.session = data.session;
    attempts = data.runs;
    if (!attempts.some((a) => a.id === state.activeRunId))
      state.activeRunId = attempts.length ? attempts[attempts.length - 1].id : null;
    renderSessionHeader();
  } catch {
    /* ignore */
  }
}

export function renderSessionHeader() {
  $("#run-title").textContent = state.session.name;
  const parts = [];
  if (state.session.mode === "soullink")
    parts.push(
      `🔗 Soullink · ${state.session.player1 || "Player 1"} & ${state.session.player2 || "Player 2"}`,
    );
  if (state.session.game) parts.push(state.session.game);
  $("#run-subtitle").textContent = parts.join(" · ");

  const sel = $("#attempt-select");
  sel.innerHTML = "";
  for (const a of attempts) {
    const o = el("option");
    o.value = String(a.id);
    o.textContent = `Run #${a.run_number}`;
    sel.appendChild(o);
  }
  if (state.activeRunId != null) sel.value = String(state.activeRunId);
}

// ---- New session modal (also used by guest "Continue") ----
export function openNewSessionModal() {
  const form = el("form", "run-form");
  form.innerHTML = `
    <h3>New session</h3>
    <label>Name<input name="name" autocomplete="off" required></label>
    <label>Game <span class="muted">(optional)</span><input name="game" autocomplete="off"></label>
    <fieldset class="mode-field">
      <legend>Mode</legend>
      <label class="radio"><input type="radio" name="mode" value="normal" checked> Normal (solo)</label>
      <label class="radio"><input type="radio" name="mode" value="soullink"> 🔗 Soullink (2 players, linked)</label>
    </fieldset>
    <div class="soullink-fields" hidden>
      <label>Player 1<input name="player1" placeholder="Player 1" autocomplete="off"></label>
      <label>Player 2<input name="player2" placeholder="Player 2" autocomplete="off"></label>
    </div>
    <button type="submit" class="btn primary">Create session</button>
  `;
  form.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      form.querySelector(".soullink-fields").hidden =
        form.querySelector('input[name="mode"]:checked').value !== "soullink";
    }),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get("name") || "").trim();
    if (!name) return;
    try {
      const s = await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          name,
          game: String(fd.get("game") || "").trim(),
          mode: fd.get("mode") || "normal",
          player1: String(fd.get("player1") || "").trim(),
          player2: String(fd.get("player2") || "").trim(),
        }),
      });
      closeModal();
      nav(`/s/${s.share_id}`);
    } catch (err) {
      toast(err.message);
    }
  });
  openModal(form);
  form.querySelector('input[name="name"]').focus();
}
