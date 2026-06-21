// Bun HTTP + WebSocket server: JSON API, static frontend, and live sync.
// Binds to 0.0.0.0 so two players on the same network can play together.
import {
  STATUSES,
  MODES,
  type Status,
  type Mode,
  type RunRow,
  listRuns,
  getRun,
  createRun,
  updateRun,
  deleteRun,
  cloneRun,
  listRoutes,
  createRoute,
  updateRouteName,
  deleteRoute,
  reorderRoutes,
  getRouteRunId,
  getEncounterRunId,
  updateEncounter,
  listLevelCaps,
  createLevelCap,
  updateLevelCap,
  deleteLevelCap,
  getLevelCapRunId,
} from "./db.ts";
import type { Server, ServerWebSocket } from "bun";
// Embed the frontend so `bun build --compile` yields a single executable.
import indexHtml from "../public/index.html" with { type: "file" };
import appJs from "../public/app.js" with { type: "file" };
import stylesCss from "../public/styles.css" with { type: "file" };
import faviconSvg from "../public/favicon.svg" with { type: "file" };

const PORT = Number(process.env.PORT ?? 3001);

const ASSETS: Record<string, { path: string; type: string }> = {
  "/": { path: indexHtml, type: "text/html; charset=utf-8" },
  "/index.html": { path: indexHtml, type: "text/html; charset=utf-8" },
  "/app.js": { path: appJs, type: "text/javascript; charset=utf-8" },
  "/styles.css": { path: stylesCss, type: "text/css; charset=utf-8" },
  "/favicon.svg": { path: faviconSvg, type: "image/svg+xml" },
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const bad = (msg: string, status = 400) => json({ error: msg }, status);

function isStatus(v: unknown): v is Status {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}
function isMode(v: unknown): v is Mode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}
function optStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/** Parse a level-cap value to an int in 1..100, or null. */
function capLevel(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.round(n)) : null;
}

/** Derive a unique "<base> #N" name for a cloned run. */
async function cloneName(baseName: string): Promise<string> {
  const stem = baseName.replace(/\s+#\d+$/, "").trim();
  const re = new RegExp(
    `^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+#(\\d+))?$`,
  );
  let max = 1;
  for (const r of await listRuns()) {
    const m = r.name.match(re);
    if (m) max = Math.max(max, m[1] ? Number(m[1]) : 1);
  }
  return `${stem} #${max + 1}`;
}

// ---- Access tokens for password-protected runs (in-memory) ----
const runTokens = new Map<number, Set<string>>();

function issueToken(runId: number): string {
  const token = crypto.randomUUID();
  if (!runTokens.has(runId)) runTokens.set(runId, new Set());
  runTokens.get(runId)!.add(token);
  return token;
}
function hasAccess(run: RunRow, token: string | null): boolean {
  if (!run.password_hash) return true; // open run
  return !!token && !!runTokens.get(run.id)?.has(token);
}

// `null` = authorized; otherwise a 401 response to return.
function authGuard(run: RunRow | null, token: string | null): Response | null {
  if (!run) return bad("not found", 404);
  if (!hasAccess(run, token)) return bad("locked", 401);
  return null;
}

// ---- Live sync ----
let server: Server;
function broadcastRoutes(runId: number) {
  server?.publish(`run:${runId}`, JSON.stringify({ type: "routes", runId }));
}
function broadcastRuns() {
  server?.publish("runs", JSON.stringify({ type: "runs" }));
}
function broadcastCaps(runId: number) {
  server?.publish(`run:${runId}`, JSON.stringify({ type: "caps", runId }));
}

interface WsData {
  runId: number | null;
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const token = req.headers.get("x-run-token");
  const body = async () => {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  };
  const idFromPath = (prefix: string) =>
    Number(path.slice(prefix.length).split("/")[0]);

  // --- Runs ---
  if (path === "/api/runs" && method === "GET") {
    return json(await listRuns());
  }
  if (path === "/api/runs" && method === "POST") {
    const b = await body();
    const name = String(b.name ?? "").trim();
    if (!name) return bad("name required");
    const mode = isMode(b.mode) ? b.mode : "normal";
    const password = optStr(b.password);
    const passwordHash = password ? Bun.password.hashSync(password) : null;
    const run = await createRun({
      name,
      game: optStr(b.game),
      mode,
      player1: mode === "soullink" ? optStr(b.player1) ?? "Player 1" : null,
      player2: mode === "soullink" ? optStr(b.player2) ?? "Player 2" : null,
      passwordHash,
    });
    broadcastRuns();
    // Give the creator an access token so they don't have to re-enter it.
    const out: Record<string, unknown> = { ...run, password_hash: undefined };
    if (passwordHash) out.token = issueToken(run.id);
    return json(out, 201);
  }

  // --- Unlock a protected run ---
  if (path.startsWith("/api/runs/") && path.endsWith("/unlock") && method === "POST") {
    const id = idFromPath("/api/runs/");
    const run = await getRun(id);
    if (!run) return bad("not found", 404);
    if (!run.password_hash) return json({ token: null }); // not protected
    const b = await body();
    const password = String(b.password ?? "");
    if (!Bun.password.verifySync(password, run.password_hash))
      return bad("wrong password", 401);
    return json({ token: issueToken(id) });
  }

  // --- Clone a run: same routes + settings, empty encounters ---
  if (path.startsWith("/api/runs/") && path.endsWith("/clone") && method === "POST") {
    const id = idFromPath("/api/runs/");
    const run = await getRun(id);
    const denied = authGuard(run, token);
    if (denied) return denied;
    const newRun = await cloneRun(id, await cloneName(run!.name));
    if (!newRun) return bad("not found", 404);
    broadcastRuns();
    const out: Record<string, unknown> = { ...newRun, password_hash: undefined };
    if (newRun.password_hash) out.token = issueToken(newRun.id);
    return json(out, 201);
  }

  // --- Routes of a run (viewing is open; creating requires the password) ---
  if (path.startsWith("/api/runs/") && path.endsWith("/routes")) {
    const id = idFromPath("/api/runs/");
    const run = await getRun(id);
    if (!run) return bad("not found", 404);
    if (method === "GET") return json(await listRoutes(id));
    if (method === "POST") {
      const denied = authGuard(run, token);
      if (denied) return denied;
      const b = await body();
      const name = String(b.name ?? "").trim();
      if (!name) return bad("route name required");
      const route = await createRoute(id, name);
      broadcastRoutes(id);
      broadcastRuns();
      return json(route, 201);
    }
  }

  // --- Level caps of a run (viewing open; adding requires the password) ---
  if (path.startsWith("/api/runs/") && path.endsWith("/level-caps")) {
    const id = idFromPath("/api/runs/");
    const run = await getRun(id);
    if (!run) return bad("not found", 404);
    if (method === "GET") return json(await listLevelCaps(id));
    if (method === "POST") {
      const denied = authGuard(run, token);
      if (denied) return denied;
      const b = await body();
      const name = String(b.name ?? "").trim();
      if (!name) return bad("name required");
      const cap = await createLevelCap(id, name, capLevel(b.level));
      broadcastCaps(id);
      return json(cap, 201);
    }
  }

  // --- Level cap update / delete ---
  if (path.startsWith("/api/level-caps/") && (method === "PUT" || method === "DELETE")) {
    const id = idFromPath("/api/level-caps/");
    const runId = await getLevelCapRunId(id);
    const denied = authGuard(runId ? await getRun(runId) : null, token);
    if (denied) return denied;
    if (method === "PUT") {
      const b = await body();
      const fields: Parameters<typeof updateLevelCap>[1] = {};
      if ("name" in b) {
        const name = String(b.name ?? "").trim();
        if (!name) return bad("name cannot be empty");
        fields.name = name;
      }
      if ("level" in b) fields.level = capLevel(b.level);
      if ("cleared" in b) fields.cleared = b.cleared ? 1 : 0;
      const row = await updateLevelCap(id, fields);
      if (runId) broadcastCaps(runId);
      return row ? json(row) : bad("not found", 404);
    }
    await deleteLevelCap(id);
    if (runId) broadcastCaps(runId);
    return json({ ok: true });
  }

  // --- Reorder a run's routes ---
  if (path.startsWith("/api/runs/") && path.endsWith("/reorder") && method === "PUT") {
    const id = idFromPath("/api/runs/");
    const run = await getRun(id);
    const denied = authGuard(run, token);
    if (denied) return denied;
    const b = await body();
    const order = Array.isArray(b.order)
      ? b.order.filter((x): x is number => typeof x === "number")
      : [];
    await reorderRoutes(id, order);
    broadcastRoutes(id);
    return json({ ok: true });
  }

  // --- Run rename / delete ---
  if (path.startsWith("/api/runs/") && (method === "PUT" || method === "DELETE")) {
    const id = idFromPath("/api/runs/");
    const run = await getRun(id);
    const denied = authGuard(run, token);
    if (denied) return denied;
    if (method === "PUT") {
      const b = await body();
      const fields: { name?: string; game?: string | null } = {};
      if ("name" in b) {
        const name = String(b.name ?? "").trim();
        if (!name) return bad("name cannot be empty");
        fields.name = name;
      }
      if ("game" in b) fields.game = optStr(b.game);
      const updated = await updateRun(id, fields);
      broadcastRuns();
      return updated ? json(updated) : bad("not found", 404);
    }
    await deleteRun(id);
    runTokens.delete(id);
    broadcastRuns();
    return json({ ok: true });
  }

  // --- Route rename / delete ---
  if (path.startsWith("/api/routes/") && (method === "PUT" || method === "DELETE")) {
    const id = idFromPath("/api/routes/");
    const runId = await getRouteRunId(id);
    const denied = authGuard(runId ? await getRun(runId) : null, token);
    if (denied) return denied;
    if (method === "PUT") {
      const b = await body();
      const name = String(b.name ?? "").trim();
      if (!name) return bad("route name cannot be empty");
      const row = await updateRouteName(id, name);
      if (runId) broadcastRoutes(runId);
      return row ? json(row) : bad("not found", 404);
    }
    await deleteRoute(id);
    if (runId) {
      broadcastRoutes(runId);
      broadcastRuns();
    }
    return json({ ok: true });
  }

  // --- Encounter update (the live-synced, soullink-aware edit) ---
  if (path.startsWith("/api/encounters/") && method === "PUT") {
    const id = idFromPath("/api/encounters/");
    const runId = await getEncounterRunId(id);
    const denied = authGuard(runId ? await getRun(runId) : null, token);
    if (denied) return denied;
    const b = await body();
    const fields: Parameters<typeof updateEncounter>[1] = {};
    if ("pokemon_id" in b)
      fields.pokemon_id =
        typeof b.pokemon_id === "number" && Number.isFinite(b.pokemon_id)
          ? b.pokemon_id
          : null;
    if ("pokemon_name" in b) fields.pokemon_name = optStr(b.pokemon_name);
    if ("sprite_url" in b) fields.sprite_url = optStr(b.sprite_url);
    if ("nickname" in b) fields.nickname = optStr(b.nickname);
    if ("status" in b) {
      if (b.status === null || b.status === "") fields.status = null;
      else if (isStatus(b.status)) fields.status = b.status;
      else return bad("invalid status");
    }
    const res = await updateEncounter(id, fields);
    if (!res) return bad("not found", 404);
    if (runId) {
      broadcastRoutes(runId);
      broadcastRuns();
    }
    return json(res);
  }

  return bad("not found", 404);
}

function serveStatic(url: URL): Response {
  const asset = ASSETS[url.pathname] ?? ASSETS["/"]; // SPA fallback
  return new Response(Bun.file(asset.path), {
    headers: { "content-type": asset.type },
  });
}

server = Bun.serve<WsData>({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return srv.upgrade(req, { data: { runId: null } })
        ? undefined
        : new Response("websocket upgrade failed", { status: 400 });
    }
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, url);
      return serveStatic(url);
    } catch (err) {
      console.error(err);
      return json({ error: "internal error" }, 500);
    }
  },
  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      ws.subscribe("runs"); // sidebar/run-list changes
    },
    async message(ws: ServerWebSocket<WsData>, raw) {
      let msg: { op?: string; runId?: number; token?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.op === "watch" && typeof msg.runId === "number") {
        if (!(await getRun(msg.runId))) return; // viewing is open — no token needed
        if (ws.data.runId) ws.unsubscribe(`run:${ws.data.runId}`);
        ws.data.runId = msg.runId;
        ws.subscribe(`run:${msg.runId}`);
      }
    },
    close() {},
  },
});

console.log(`\n🎮  Custom Nuzlocke Tracker running`);
console.log(`    Local:   http://localhost:${server.port}`);
console.log(
  `    Network: http://<your-LAN-ip>:${server.port}  (share with your soullink partner)\n`,
);
