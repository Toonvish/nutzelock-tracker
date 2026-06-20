// Bun HTTP server: JSON API + static frontend for the Nuzlocke tracker.
// Binds to localhost only (single-machine use).
import {
  STATUSES,
  type Status,
  listRuns,
  getRun,
  createRun,
  deleteRun,
  listRoutes,
  createRoute,
  updateRoute,
  deleteRoute,
} from "./db.ts";
// Embed the frontend into the binary so `bun build --compile` produces a single
// self-contained executable. In dev (`bun run`) these resolve to files on disk.
import indexHtml from "../public/index.html" with { type: "file" };
import appJs from "../public/app.js" with { type: "file" };
import stylesCss from "../public/styles.css" with { type: "file" };

const PORT = Number(process.env.PORT ?? 3001);

const ASSETS: Record<string, { path: string; type: string }> = {
  "/": { path: indexHtml, type: "text/html; charset=utf-8" },
  "/index.html": { path: indexHtml, type: "text/html; charset=utf-8" },
  "/app.js": { path: appJs, type: "text/javascript; charset=utf-8" },
  "/styles.css": { path: stylesCss, type: "text/css; charset=utf-8" },
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

/** Optional string field: trimmed string, or null if empty/absent. */
function optStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

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
  const idFromPath = (prefix: string) => Number(path.slice(prefix.length).split("/")[0]);

  // --- Runs ---
  if (path === "/api/runs" && method === "GET") {
    return json(listRuns());
  }
  if (path === "/api/runs" && method === "POST") {
    const b = await body();
    const name = String(b.name ?? "").trim();
    if (!name) return bad("name required");
    return json(createRun(name, optStr(b.game)), 201);
  }
  if (path.startsWith("/api/runs/") && path.endsWith("/routes")) {
    const id = idFromPath("/api/runs/");
    if (!getRun(id)) return bad("run not found", 404);
    if (method === "GET") return json(listRoutes(id));
    if (method === "POST") {
      const b = await body();
      const name = String(b.name ?? "").trim();
      if (!name) return bad("route name required");
      return json(createRoute(id, name), 201);
    }
  }
  if (path.startsWith("/api/runs/") && method === "DELETE") {
    deleteRun(idFromPath("/api/runs/"));
    return json({ ok: true });
  }

  // --- Routes ---
  if (path.startsWith("/api/routes/") && method === "PUT") {
    const id = idFromPath("/api/routes/");
    const b = await body();
    const fields: Parameters<typeof updateRoute>[1] = {};
    if ("name" in b) {
      const name = String(b.name ?? "").trim();
      if (!name) return bad("route name cannot be empty");
      fields.name = name;
    }
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
    const row = updateRoute(id, fields);
    return row ? json(row) : bad("route not found", 404);
  }
  if (path.startsWith("/api/routes/") && method === "DELETE") {
    deleteRoute(idFromPath("/api/routes/"));
    return json({ ok: true });
  }

  return bad("not found", 404);
}

function serveStatic(url: URL): Response {
  const asset = ASSETS[url.pathname] ?? ASSETS["/"]; // SPA fallback to index.html
  return new Response(Bun.file(asset.path), {
    headers: { "content-type": asset.type },
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, url);
      return serveStatic(url);
    } catch (err) {
      console.error(err);
      return json({ error: "internal error" }, 500);
    }
  },
});

console.log(`\n🎮  Custom Nuzlocke Tracker running`);
console.log(`    Local:   http://localhost:${server.port}\n`);
