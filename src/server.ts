// Bun HTTP + WebSocket server.
//  - Discord OAuth login (stateless signed cookie).
//  - Sessions (owned by a user or guest) reached by owner or by share_id.
//  - A session has runs (attempts); each run owns routes/encounters/level caps.
//  - Live sync over WebSocket per session.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import {
  STATUSES,
  MODES,
  type Status,
  type Mode,
  type SessionRow,
  upsertUser,
  getUser,
  listSessionsForUser,
  getSessionByShareId,
  getSessionById,
  createSession,
  updateSession,
  deleteSession,
  touchSession,
  cleanupGuestSessions,
  listRuns,
  createNextRun,
  getRunSessionId,
  listRoutes,
  createRoute,
  updateRouteName,
  deleteRoute,
  reorderRoutes,
  getRouteRunId,
  getRouteSessionId,
  getEncounterRunId,
  getEncounterSessionId,
  updateEncounter,
  listLevelCaps,
  createLevelCap,
  updateLevelCap,
  deleteLevelCap,
  getLevelCapRunId,
  getLevelCapSessionId,
} from "./db.ts";
// Embed the frontend so `bun build --compile` yields a single executable.
import indexHtml from "../public/index.html" with { type: "file" };
import appJs from "../public/app.js" with { type: "file" };
import stylesCss from "../public/styles.css" with { type: "file" };
import faviconSvg from "../public/favicon.svg" with { type: "file" };

const PORT = Number(process.env.PORT ?? 3001);
const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-insecure-secret-change-me";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const COOKIE_DAYS = 60;

const ASSETS: Record<string, { path: string; type: string }> = {
  "/": { path: indexHtml, type: "text/html; charset=utf-8" },
  "/index.html": { path: indexHtml, type: "text/html; charset=utf-8" },
  "/app.js": { path: appJs, type: "text/javascript; charset=utf-8" },
  "/styles.css": { path: stylesCss, type: "text/css; charset=utf-8" },
  "/favicon.svg": { path: faviconSvg, type: "image/svg+xml" },
};

// ---- response helpers ----
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const bad = (msg: string, status = 400) => json({ error: msg }, status);
const redirect = (location: string, setCookie?: string) =>
  new Response(null, {
    status: 302,
    headers: setCookie
      ? { location, "set-cookie": setCookie }
      : { location },
  });

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
function capLevel(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.round(n)) : null;
}

// ---- cookies + signed auth ----
function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.get("cookie");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sign(body: string): string {
  return createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
}
function signPayload(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}
function verifyPayload(value: string | undefined): any | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
function cookieStr(
  name: string,
  value: string,
  opts: { secure?: boolean; maxAge?: number; clear?: boolean } = {},
): string {
  let s = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax`;
  if (opts.secure) s += "; Secure";
  if (opts.clear) s += "; Max-Age=0";
  else if (opts.maxAge) s += `; Max-Age=${opts.maxAge}`;
  return s;
}

async function currentUser(req: Request) {
  const payload = verifyPayload(parseCookies(req).nuzlocke_auth);
  if (!payload?.uid) return null;
  return getUser(payload.uid);
}

function originOf(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

// ---- session access (capability = share_id, or ownership) ----
async function sessionAccess(
  req: Request,
  sessionId: number | null,
): Promise<SessionRow | null> {
  if (sessionId == null) return null;
  const session = await getSessionById(sessionId);
  if (!session) return null;
  const shareId = req.headers.get("x-share-id");
  if (shareId && shareId === session.share_id) return session;
  const user = await currentUser(req);
  if (user && session.owner_user_id === user.id) return session;
  return null;
}

// ---- live sync ----
let server: Server;
function publish(shareId: string, msg: object) {
  server?.publish(`session:${shareId}`, JSON.stringify(msg));
}
interface WsData {
  topic: string | null;
}

// ---- Discord OAuth ----
async function handleAuth(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path === "/auth/discord") {
    if (!DISCORD_CLIENT_ID)
      return new Response("Discord login is not configured on this server.", {
        status: 503,
      });
    const state = crypto.randomUUID();
    const redirectUri =
      process.env.DISCORD_REDIRECT_URI || `${originOf(req)}/auth/discord/callback`;
    const authorize = new URL("https://discord.com/oauth2/authorize");
    authorize.searchParams.set("client_id", DISCORD_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "identify");
    authorize.searchParams.set("state", state);
    return redirect(
      authorize.toString(),
      cookieStr("nuzlocke_oauth_state", state, {
        secure: originOf(req).startsWith("https"),
        maxAge: 600,
      }),
    );
  }

  if (path === "/auth/discord/callback") {
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET)
      return new Response("Discord login is not configured.", { status: 503 });
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const cookieState = parseCookies(req).nuzlocke_oauth_state;
    if (!code || !state || state !== cookieState)
      return redirect("/login?error=auth");
    const redirectUri =
      process.env.DISCORD_REDIRECT_URI || `${originOf(req)}/auth/discord/callback`;
    try {
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) return redirect("/login?error=token");
      const { access_token } = (await tokenRes.json()) as { access_token: string };
      const meRes = await fetch("https://discord.com/api/users/@me", {
        headers: { authorization: `Bearer ${access_token}` },
      });
      if (!meRes.ok) return redirect("/login?error=me");
      const me = (await meRes.json()) as {
        id: string;
        username: string;
        global_name?: string;
        avatar?: string | null;
      };
      const user = await upsertUser({
        provider: "discord",
        providerId: me.id,
        name: me.global_name || me.username,
        avatarUrl: me.avatar
          ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png`
          : null,
      });
      const token = signPayload({
        uid: user.id,
        exp: Math.floor(Date.now() / 1000) + COOKIE_DAYS * 86400,
      });
      return redirect(
        "/sessions",
        cookieStr("nuzlocke_auth", token, {
          secure: originOf(req).startsWith("https"),
          maxAge: COOKIE_DAYS * 86400,
        }),
      );
    } catch {
      return redirect("/login?error=exception");
    }
  }

  if (path === "/auth/logout") {
    return redirect(
      "/login",
      cookieStr("nuzlocke_auth", "", { clear: true }),
    );
  }

  return bad("not found", 404);
}

// ---- JSON API ----
async function handleApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const body = async () => {
    try {
      return (await req.json()) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  };
  const seg = (i: number) => path.split("/")[i] ?? "";
  const numSeg = (i: number) => Number(seg(i));

  // --- who am I ---
  if (path === "/api/me" && method === "GET") {
    const user = await currentUser(req);
    return json({
      user: user
        ? { id: user.id, name: user.name, avatar_url: user.avatar_url }
        : null,
    });
  }

  // --- sessions list (owner only) ---
  if (path === "/api/sessions" && method === "GET") {
    const user = await currentUser(req);
    if (!user) return bad("login required", 401);
    return json(await listSessionsForUser(user.id));
  }
  // --- create session ---
  if (path === "/api/sessions" && method === "POST") {
    const b = await body();
    const name = String(b.name ?? "").trim();
    if (!name) return bad("name required");
    const mode = isMode(b.mode) ? b.mode : "normal";
    const user = await currentUser(req);
    const session = await createSession({
      name,
      game: optStr(b.game),
      mode,
      player1: mode === "soullink" ? optStr(b.player1) ?? "Player 1" : null,
      player2: mode === "soullink" ? optStr(b.player2) ?? "Player 2" : null,
      ownerUserId: user?.id ?? null,
    });
    return json(session, 201);
  }

  // --- a specific session by share id ---
  if (path.startsWith("/api/sessions/")) {
    const shareId = seg(3);
    const session = await getSessionByShareId(shareId);
    if (!session) return bad("not found", 404);
    const access = await sessionAccess(req, session.id);

    // GET meta + attempts (open to anyone who has the share id)
    if (path === `/api/sessions/${shareId}` && method === "GET") {
      await touchSession(session.id);
      const user = await currentUser(req);
      return json({
        session,
        runs: await listRuns(session.id),
        isOwner: !!user && session.owner_user_id === user.id,
      });
    }
    if (!access) return bad("no access", 403);

    if (path === `/api/sessions/${shareId}` && method === "PUT") {
      const b = await body();
      const fields: { name?: string; game?: string | null } = {};
      if ("name" in b) {
        const name = String(b.name ?? "").trim();
        if (!name) return bad("name cannot be empty");
        fields.name = name;
      }
      if ("game" in b) fields.game = optStr(b.game);
      const updated = await updateSession(session.id, fields);
      publish(shareId, { type: "session" });
      return updated ? json(updated) : bad("not found", 404);
    }
    if (path === `/api/sessions/${shareId}` && method === "DELETE") {
      await deleteSession(session.id);
      return json({ ok: true });
    }
    if (path === `/api/sessions/${shareId}/runs` && method === "POST") {
      const run = await createNextRun(session.id);
      publish(shareId, { type: "session" });
      return run ? json(run, 201) : bad("not found", 404);
    }
    return bad("not found", 404);
  }

  // --- run-scoped: routes & level caps ---
  if (path.startsWith("/api/runs/")) {
    const runId = numSeg(3);
    const tail = seg(4);
    const session = await sessionAccess(req, await getRunSessionId(runId));
    if (tail === "routes") {
      if (method === "GET") {
        // viewing routes also requires access (the share id) now
        if (!session) return bad("no access", 403);
        return json(await listRoutes(runId));
      }
      if (method === "POST") {
        if (!session) return bad("no access", 403);
        const b = await body();
        const name = String(b.name ?? "").trim();
        if (!name) return bad("route name required");
        const route = await createRoute(runId, name);
        publish(session.share_id, { type: "routes", runId });
        return json(route, 201);
      }
    }
    if (tail === "level-caps") {
      if (!session) return bad("no access", 403);
      if (method === "GET") return json(await listLevelCaps(runId));
      if (method === "POST") {
        const b = await body();
        const name = String(b.name ?? "").trim();
        if (!name) return bad("name required");
        const cap = await createLevelCap(runId, name, capLevel(b.level));
        publish(session.share_id, { type: "caps", runId });
        return json(cap, 201);
      }
    }
    if (tail === "reorder" && method === "PUT") {
      if (!session) return bad("no access", 403);
      const b = await body();
      const order = Array.isArray(b.order)
        ? b.order.filter((x): x is number => typeof x === "number")
        : [];
      await reorderRoutes(runId, order);
      publish(session.share_id, { type: "routes", runId });
      return json({ ok: true });
    }
    return bad("not found", 404);
  }

  // --- route rename / delete ---
  if (path.startsWith("/api/routes/") && (method === "PUT" || method === "DELETE")) {
    const id = numSeg(3);
    const session = await sessionAccess(req, await getRouteSessionId(id));
    if (!session) return bad("no access", 403);
    const runId = await getRouteRunId(id);
    if (method === "PUT") {
      const b = await body();
      const name = String(b.name ?? "").trim();
      if (!name) return bad("route name cannot be empty");
      const row = await updateRouteName(id, name);
      if (runId) publish(session.share_id, { type: "routes", runId });
      return row ? json(row) : bad("not found", 404);
    }
    await deleteRoute(id);
    if (runId) publish(session.share_id, { type: "routes", runId });
    return json({ ok: true });
  }

  // --- encounter update (live-synced, soullink-aware) ---
  if (path.startsWith("/api/encounters/") && method === "PUT") {
    const id = numSeg(3);
    const session = await sessionAccess(req, await getEncounterSessionId(id));
    if (!session) return bad("no access", 403);
    const runId = await getEncounterRunId(id);
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
    if (runId) publish(session.share_id, { type: "routes", runId });
    return json(res);
  }

  // --- level cap update / delete ---
  if (path.startsWith("/api/level-caps/") && (method === "PUT" || method === "DELETE")) {
    const id = numSeg(3);
    const session = await sessionAccess(req, await getLevelCapSessionId(id));
    if (!session) return bad("no access", 403);
    const runId = await getLevelCapRunId(id);
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
      if (runId) publish(session.share_id, { type: "caps", runId });
      return row ? json(row) : bad("not found", 404);
    }
    await deleteLevelCap(id);
    if (runId) publish(session.share_id, { type: "caps", runId });
    return json({ ok: true });
  }

  return bad("not found", 404);
}

function serveStatic(url: URL): Response {
  const asset = ASSETS[url.pathname] ?? ASSETS["/"]; // SPA fallback for client routes
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
      return srv.upgrade(req, { data: { topic: null } })
        ? undefined
        : new Response("websocket upgrade failed", { status: 400 });
    }
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, url);
      if (url.pathname.startsWith("/auth/")) return await handleAuth(req, url);
      return serveStatic(url);
    } catch (err) {
      console.error(err);
      return json({ error: "internal error" }, 500);
    }
  },
  websocket: {
    open() {},
    async message(ws: ServerWebSocket<WsData>, raw) {
      let msg: { op?: string; shareId?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.op === "watch" && typeof msg.shareId === "string") {
        if (!(await getSessionByShareId(msg.shareId))) return;
        if (ws.data.topic) ws.unsubscribe(ws.data.topic);
        ws.data.topic = `session:${msg.shareId}`;
        ws.subscribe(ws.data.topic);
      }
    },
    close() {},
  },
});

// Periodically delete ownerless sessions untouched for 30 days.
cleanupGuestSessions().catch(() => {});
setInterval(() => cleanupGuestSessions().catch(() => {}), 6 * 3600 * 1000);

console.log(`\n🎮  Custom Nuzlocke Tracker running`);
console.log(`    Local:   http://localhost:${server.port}`);
console.log(
  `    Discord login: ${DISCORD_CLIENT_ID ? "configured" : "NOT configured (set DISCORD_CLIENT_ID/SECRET)"}\n`,
);
