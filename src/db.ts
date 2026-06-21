// Data layer over libSQL (@libsql/client). Works against a local SQLite file
// in development and a Turso database in production — same code, same SQL.
//   - Set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) to use Turso.
//   - Otherwise it falls back to a local file (NUZLOCKE_DB, default data/nuzlocke.db).
//
// Hierarchy: users own sessions; a session contains runs (attempts); a run owns
// routes -> encounters and level_caps. A session is reached by its owner or by
// anyone holding its unguessable share_id.
import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const STATUSES = [
  "caught",
  "boxed",
  "fainted",
  "missed",
  "bro_failed",
] as const;
export type Status = (typeof STATUSES)[number];

export const MODES = ["normal", "soullink"] as const;
export type Mode = (typeof MODES)[number];

const FILE_DB = process.env.NUZLOCKE_DB ?? "data/nuzlocke.db";
const DB_URL = process.env.TURSO_DATABASE_URL ?? `file:${FILE_DB}`;
const AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

let _client: Client | null = null;
function client(): Client {
  if (!_client) {
    if (DB_URL.startsWith("file:"))
      mkdirSync(dirname(DB_URL.slice("file:".length)) || ".", { recursive: true });
    _client = createClient(
      AUTH_TOKEN ? { url: DB_URL, authToken: AUTH_TOKEN } : { url: DB_URL },
    );
  }
  return _client;
}

// ---- tiny async query helpers (positional ? params throughout) ----
let _init: Promise<void> | null = null;
const ready = () => (_init ??= migrate());

async function all(sql: string, args: any[] = []): Promise<any[]> {
  await ready();
  const r = await client().execute({ sql, args });
  return r.rows as any[];
}
async function one(sql: string, args: any[] = []): Promise<any> {
  return (await all(sql, args))[0] ?? null;
}
async function exec(sql: string, args: any[] = []): Promise<void> {
  await ready();
  await client().execute({ sql, args });
}

async function migrate(): Promise<void> {
  await client().executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      provider    TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      name        TEXT,
      avatar_url  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, provider_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      share_id       TEXT NOT NULL UNIQUE,
      name           TEXT NOT NULL,
      game           TEXT,
      mode           TEXT NOT NULL DEFAULT 'normal',
      player1        TEXT,
      player2        TEXT,
      owner_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_access_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS runs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_number INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS routes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS encounters (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id     INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
      slot         INTEGER NOT NULL DEFAULT 0,
      pokemon_id   INTEGER,
      pokemon_name TEXT,
      sprite_url   TEXT,
      nickname     TEXT,
      status       TEXT CHECK (status IN ('caught','boxed','fainted','missed','bro_failed')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(route_id, slot)
    );
    CREATE TABLE IF NOT EXISTS level_caps (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      level      INTEGER,
      position   INTEGER NOT NULL DEFAULT 0,
      cleared    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_routes_run ON routes(run_id);
    CREATE INDEX IF NOT EXISTS idx_encounters_route ON encounters(route_id);
    CREATE INDEX IF NOT EXISTS idx_caps_run ON level_caps(run_id);
  `);
}

// ---- Users -------------------------------------------------------------

export interface UserRow {
  id: number;
  provider: string;
  provider_id: string;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
}

export async function upsertUser(u: {
  provider: string;
  providerId: string;
  name: string | null;
  avatarUrl: string | null;
}): Promise<UserRow> {
  return (await one(
    `INSERT INTO users (provider, provider_id, name, avatar_url)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(provider, provider_id)
     DO UPDATE SET name = excluded.name, avatar_url = excluded.avatar_url
     RETURNING *`,
    [u.provider, u.providerId, u.name, u.avatarUrl],
  )) as UserRow;
}

export async function getUser(id: number): Promise<UserRow | null> {
  return (await one("SELECT * FROM users WHERE id = ?", [id])) as UserRow | null;
}

// ---- Sessions ----------------------------------------------------------

export interface SessionRow {
  id: number;
  share_id: string;
  name: string;
  game: string | null;
  mode: Mode;
  player1: string | null;
  player2: string | null;
  owner_user_id: number | null;
  created_at: string;
  last_access_at: string;
}

export interface SessionSummary extends SessionRow {
  run_count: number;
}

export async function listSessionsForUser(
  userId: number,
): Promise<SessionSummary[]> {
  return (await all(
    `SELECT s.*, (SELECT COUNT(*) FROM runs r WHERE r.session_id = s.id) AS run_count
     FROM sessions s WHERE s.owner_user_id = ?
     ORDER BY s.created_at DESC, s.id DESC`,
    [userId],
  )) as SessionSummary[];
}

export async function getSessionByShareId(
  shareId: string,
): Promise<SessionRow | null> {
  return (await one("SELECT * FROM sessions WHERE share_id = ?", [shareId])) as
    | SessionRow
    | null;
}

export async function getSessionById(id: number): Promise<SessionRow | null> {
  return (await one("SELECT * FROM sessions WHERE id = ?", [id])) as
    | SessionRow
    | null;
}

export async function createSession(s: {
  name: string;
  game: string | null;
  mode: Mode;
  player1: string | null;
  player2: string | null;
  ownerUserId: number | null;
}): Promise<SessionRow> {
  const shareId = crypto.randomUUID();
  const session = (await one(
    `INSERT INTO sessions (share_id, name, game, mode, player1, player2, owner_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [shareId, s.name, s.game, s.mode, s.player1, s.player2, s.ownerUserId],
  )) as SessionRow;
  await exec("INSERT INTO runs (session_id, run_number) VALUES (?, 1)", [
    session.id,
  ]);
  return session;
}

export async function updateSession(
  id: number,
  fields: { name?: string; game?: string | null },
): Promise<SessionRow | null> {
  const sets: string[] = [];
  const args: any[] = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    args.push(fields.name);
  }
  if (fields.game !== undefined) {
    sets.push("game = ?");
    args.push(fields.game);
  }
  if (!sets.length) return getSessionById(id);
  args.push(id);
  return (await one(
    `UPDATE sessions SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    args,
  )) as SessionRow | null;
}

export async function touchSession(id: number): Promise<void> {
  await exec("UPDATE sessions SET last_access_at = datetime('now') WHERE id = ?", [
    id,
  ]);
}

export async function deleteSession(id: number): Promise<void> {
  await ready();
  await client().batch(
    [
      {
        sql: `DELETE FROM encounters WHERE route_id IN
              (SELECT id FROM routes WHERE run_id IN
               (SELECT id FROM runs WHERE session_id = ?))`,
        args: [id],
      },
      {
        sql: "DELETE FROM level_caps WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)",
        args: [id],
      },
      {
        sql: "DELETE FROM routes WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)",
        args: [id],
      },
      { sql: "DELETE FROM runs WHERE session_id = ?", args: [id] },
      { sql: "DELETE FROM sessions WHERE id = ?", args: [id] },
    ],
    "write",
  );
}

/** Delete ownerless sessions untouched for `days` days. Returns count removed. */
export async function cleanupGuestSessions(days = 365): Promise<number> {
  const rows = await all(
    `SELECT id FROM sessions
     WHERE owner_user_id IS NULL AND last_access_at < datetime('now', ?)`,
    [`-${days} days`],
  );
  for (const r of rows) await deleteSession(r.id as number);
  return rows.length;
}

// ---- Runs (attempts) ---------------------------------------------------

export interface RunRow {
  id: number;
  session_id: number;
  run_number: number;
  created_at: string;
}

export interface RunSummary extends RunRow {
  routes: number;
  caught: number;
  boxed: number;
  fainted: number;
  missed: number;
  bro_failed: number;
}

export async function listRuns(sessionId: number): Promise<RunSummary[]> {
  return (await all(
    `SELECT r.id, r.session_id, r.run_number, r.created_at,
            COUNT(DISTINCT rt.id)                    AS routes,
            COALESCE(SUM(e.status = 'caught'),0)     AS caught,
            COALESCE(SUM(e.status = 'boxed'),0)      AS boxed,
            COALESCE(SUM(e.status = 'fainted'),0)    AS fainted,
            COALESCE(SUM(e.status = 'missed'),0)     AS missed,
            COALESCE(SUM(e.status = 'bro_failed'),0) AS bro_failed
     FROM runs r
     LEFT JOIN routes rt ON rt.run_id = r.id
     LEFT JOIN encounters e ON e.route_id = rt.id
     WHERE r.session_id = ?
     GROUP BY r.id
     ORDER BY r.run_number`,
    [sessionId],
  )) as RunSummary[];
}

export async function getRunSessionId(runId: number): Promise<number | null> {
  const r = await one("SELECT session_id FROM runs WHERE id = ?", [runId]);
  return r ? (r.session_id as number) : null;
}

/**
 * Start a new attempt in a session: copy the latest run's routes + level caps
 * with empty encounters, numbered max(run_number)+1. (Like the old cloneRun.)
 */
export async function createNextRun(sessionId: number): Promise<RunRow | null> {
  const session = await getSessionById(sessionId);
  if (!session) return null;
  const latest = await one(
    "SELECT id, MAX(run_number) AS n FROM runs WHERE session_id = ?",
    [sessionId],
  );
  const nextNumber = (latest?.n ?? 0) + 1;
  const slots = session.mode === "soullink" ? [0, 1] : [0];
  await ready();
  const tx = await client().transaction("write");
  try {
    const run = (
      await tx.execute({
        sql: "INSERT INTO runs (session_id, run_number) VALUES (?, ?) RETURNING *",
        args: [sessionId, nextNumber],
      })
    ).rows[0] as any as RunRow;
    if (latest?.id != null) {
      const srcRoutes = (
        await tx.execute({
          sql: "SELECT name, position FROM routes WHERE run_id = ? ORDER BY position, id",
          args: [latest.id],
        })
      ).rows as any[];
      for (const rt of srcRoutes) {
        const nr = (
          await tx.execute({
            sql: "INSERT INTO routes (run_id, name, position) VALUES (?, ?, ?) RETURNING id",
            args: [run.id, rt.name, rt.position],
          })
        ).rows[0] as any;
        for (const slot of slots)
          await tx.execute({
            sql: "INSERT INTO encounters (route_id, slot) VALUES (?, ?)",
            args: [nr.id, slot],
          });
      }
      const srcCaps = (
        await tx.execute({
          sql: "SELECT name, level, position FROM level_caps WHERE run_id = ? ORDER BY position, id",
          args: [latest.id],
        })
      ).rows as any[];
      for (const c of srcCaps)
        await tx.execute({
          sql: "INSERT INTO level_caps (run_id, name, level, position) VALUES (?, ?, ?, ?)",
          args: [run.id, c.name, c.level, c.position],
        });
    }
    await tx.commit();
    return run;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// ---- Routes + encounters ----------------------------------------------

export interface EncounterRow {
  id: number;
  route_id: number;
  slot: number;
  pokemon_id: number | null;
  pokemon_name: string | null;
  sprite_url: string | null;
  nickname: string | null;
  status: Status | null;
  created_at: string;
}

export interface RouteRow {
  id: number;
  run_id: number;
  name: string;
  position: number;
  created_at: string;
  encounters: EncounterRow[];
}

async function encountersForRoute(routeId: number): Promise<EncounterRow[]> {
  return (await all(
    "SELECT * FROM encounters WHERE route_id = ? ORDER BY slot",
    [routeId],
  )) as EncounterRow[];
}

export async function listRoutes(runId: number): Promise<RouteRow[]> {
  const routes = (await all(
    "SELECT * FROM routes WHERE run_id = ? ORDER BY position, id",
    [runId],
  )) as Omit<RouteRow, "encounters">[];
  const encs = (await all(
    `SELECT e.* FROM encounters e JOIN routes r ON r.id = e.route_id
     WHERE r.run_id = ? ORDER BY e.slot`,
    [runId],
  )) as EncounterRow[];
  const byRoute = new Map<number, EncounterRow[]>();
  for (const e of encs) {
    if (!byRoute.has(e.route_id)) byRoute.set(e.route_id, []);
    byRoute.get(e.route_id)!.push(e);
  }
  return routes.map((rt) => ({ ...rt, encounters: byRoute.get(rt.id) ?? [] }));
}

/** Slot count for a route depends on its session's mode. */
async function runMode(runId: number): Promise<Mode> {
  const r = await one(
    `SELECT s.mode AS mode FROM runs rn JOIN sessions s ON s.id = rn.session_id
     WHERE rn.id = ?`,
    [runId],
  );
  return (r?.mode as Mode) ?? "normal";
}

export async function createRoute(
  runId: number,
  name: string,
): Promise<RouteRow> {
  const mode = await runMode(runId);
  const { pos } = await one(
    "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM routes WHERE run_id = ?",
    [runId],
  );
  const route = (await one(
    "INSERT INTO routes (run_id, name, position) VALUES (?, ?, ?) RETURNING *",
    [runId, name, pos],
  )) as Omit<RouteRow, "encounters">;
  const slots = mode === "soullink" ? [0, 1] : [0];
  for (const slot of slots)
    await exec("INSERT INTO encounters (route_id, slot) VALUES (?, ?)", [
      route.id,
      slot,
    ]);
  return { ...route, encounters: await encountersForRoute(route.id) };
}

export async function updateRouteName(
  id: number,
  name: string,
): Promise<RouteRow | null> {
  const row = (await one(
    "UPDATE routes SET name = ? WHERE id = ? RETURNING *",
    [name, id],
  )) as Omit<RouteRow, "encounters"> | null;
  return row ? { ...row, encounters: await encountersForRoute(row.id) } : null;
}

export async function deleteRoute(id: number): Promise<void> {
  await ready();
  await client().batch(
    [
      { sql: "DELETE FROM encounters WHERE route_id = ?", args: [id] },
      { sql: "DELETE FROM routes WHERE id = ?", args: [id] },
    ],
    "write",
  );
}

export async function reorderRoutes(
  runId: number,
  order: number[],
): Promise<void> {
  if (!order.length) return;
  await ready();
  await client().batch(
    order.map((id, i) => ({
      sql: "UPDATE routes SET position = ? WHERE id = ? AND run_id = ?",
      args: [i, id, runId],
    })),
    "write",
  );
}

export async function getRouteRunId(routeId: number): Promise<number | null> {
  const r = await one("SELECT run_id FROM routes WHERE id = ?", [routeId]);
  return r ? (r.run_id as number) : null;
}

export async function getRouteSessionId(routeId: number): Promise<number | null> {
  const r = await one(
    `SELECT rn.session_id AS sid FROM routes rt
     JOIN runs rn ON rn.id = rt.run_id WHERE rt.id = ?`,
    [routeId],
  );
  return r ? (r.sid as number) : null;
}

export async function getEncounterRunId(encId: number): Promise<number | null> {
  const r = await one(
    `SELECT rt.run_id AS run_id FROM encounters e
     JOIN routes rt ON rt.id = e.route_id WHERE e.id = ?`,
    [encId],
  );
  return r ? (r.run_id as number) : null;
}

export async function getEncounterSessionId(
  encId: number,
): Promise<number | null> {
  const r = await one(
    `SELECT rn.session_id AS sid FROM encounters e
     JOIN routes rt ON rt.id = e.route_id
     JOIN runs rn ON rn.id = rt.run_id WHERE e.id = ?`,
    [encId],
  );
  return r ? (r.sid as number) : null;
}

/**
 * Update an encounter and, in soullink sessions, propagate to the partner slot:
 *   fainted | missed -> partner becomes 'bro_failed'; boxed -> partner 'boxed'.
 */
export async function updateEncounter(
  id: number,
  fields: {
    pokemon_id?: number | null;
    pokemon_name?: string | null;
    sprite_url?: string | null;
    nickname?: string | null;
    status?: Status | null;
  },
): Promise<{ encounter: EncounterRow; partner: EncounterRow | null } | null> {
  const sets: string[] = [];
  const args: any[] = [];
  for (const key of [
    "pokemon_id",
    "pokemon_name",
    "sprite_url",
    "nickname",
    "status",
  ] as const) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      args.push(fields[key] ?? null);
    }
  }
  let encounter: EncounterRow | null;
  if (sets.length) {
    args.push(id);
    encounter = (await one(
      `UPDATE encounters SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
      args,
    )) as EncounterRow | null;
  } else {
    encounter = (await one("SELECT * FROM encounters WHERE id = ?", [
      id,
    ])) as EncounterRow | null;
  }
  if (!encounter) return null;

  let partner: EncounterRow | null = null;
  if ("status" in fields) {
    const ctx = await one(
      `SELECT s.mode AS mode FROM encounters e
       JOIN routes rt ON rt.id = e.route_id
       JOIN runs rn ON rn.id = rt.run_id
       JOIN sessions s ON s.id = rn.session_id WHERE e.id = ?`,
      [id],
    );
    if (ctx?.mode === "soullink") {
      const st = fields.status;
      let partnerStatus: Status | null = null;
      if (st === "fainted" || st === "missed") partnerStatus = "bro_failed";
      else if (st === "boxed") partnerStatus = "boxed";
      if (partnerStatus)
        partner = (await one(
          "UPDATE encounters SET status = ? WHERE route_id = ? AND slot = ? RETURNING *",
          [partnerStatus, encounter.route_id, encounter.slot === 0 ? 1 : 0],
        )) as EncounterRow | null;
    }
  }
  return { encounter, partner };
}

// ---- Level caps --------------------------------------------------------

export interface LevelCapRow {
  id: number;
  run_id: number;
  name: string;
  level: number | null;
  position: number;
  cleared: number;
  created_at: string;
}

export async function listLevelCaps(runId: number): Promise<LevelCapRow[]> {
  return (await all(
    "SELECT * FROM level_caps WHERE run_id = ? ORDER BY position, id",
    [runId],
  )) as LevelCapRow[];
}

export async function createLevelCap(
  runId: number,
  name: string,
  level: number | null,
): Promise<LevelCapRow> {
  const { pos } = await one(
    "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM level_caps WHERE run_id = ?",
    [runId],
  );
  return (await one(
    "INSERT INTO level_caps (run_id, name, level, position) VALUES (?, ?, ?, ?) RETURNING *",
    [runId, name, level, pos],
  )) as LevelCapRow;
}

export async function updateLevelCap(
  id: number,
  fields: { name?: string; level?: number | null; cleared?: number },
): Promise<LevelCapRow | null> {
  const sets: string[] = [];
  const args: any[] = [];
  for (const key of ["name", "level", "cleared"] as const) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      args.push(fields[key] ?? null);
    }
  }
  if (!sets.length)
    return (await one("SELECT * FROM level_caps WHERE id = ?", [id])) as
      | LevelCapRow
      | null;
  args.push(id);
  return (await one(
    `UPDATE level_caps SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    args,
  )) as LevelCapRow | null;
}

export async function deleteLevelCap(id: number): Promise<void> {
  await exec("DELETE FROM level_caps WHERE id = ?", [id]);
}

export async function getLevelCapRunId(id: number): Promise<number | null> {
  const r = await one("SELECT run_id FROM level_caps WHERE id = ?", [id]);
  return r ? (r.run_id as number) : null;
}

export async function getLevelCapSessionId(
  id: number,
): Promise<number | null> {
  const r = await one(
    `SELECT rn.session_id AS sid FROM level_caps lc
     JOIN runs rn ON rn.id = lc.run_id WHERE lc.id = ?`,
    [id],
  );
  return r ? (r.sid as number) : null;
}
