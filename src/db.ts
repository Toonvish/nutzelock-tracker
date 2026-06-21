// Data layer over libSQL (@libsql/client). Works against a local SQLite file
// in development and a Turso database in production — same code, same SQL.
//   - Set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) to use Turso.
//   - Otherwise it falls back to a local file (NUZLOCKE_DB, default data/nuzlocke.db).
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

async function columnNames(c: Client, table: string): Promise<string[]> {
  const r = await c.execute(`PRAGMA table_info(${table})`);
  return r.rows.map((row: any) => row.name as string);
}
async function addColumnIfMissing(
  c: Client,
  table: string,
  col: string,
  def: string,
) {
  if (!(await columnNames(c, table)).includes(col))
    await c.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

async function migrate(): Promise<void> {
  const c = client();
  await c.executeMultiple(`
    CREATE TABLE IF NOT EXISTS runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      game          TEXT,
      mode          TEXT NOT NULL DEFAULT 'normal',
      player1       TEXT,
      player2       TEXT,
      password_hash TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
    CREATE INDEX IF NOT EXISTS idx_routes_run ON routes(run_id);
    CREATE INDEX IF NOT EXISTS idx_encounters_route ON encounters(route_id);
    CREATE INDEX IF NOT EXISTS idx_caps_run ON level_caps(run_id);
  `);

  // Upgrade older `runs` tables created before soullink/password existed.
  await addColumnIfMissing(c, "runs", "mode", "TEXT NOT NULL DEFAULT 'normal'");
  await addColumnIfMissing(c, "runs", "player1", "TEXT");
  await addColumnIfMissing(c, "runs", "player2", "TEXT");
  await addColumnIfMissing(c, "runs", "password_hash", "TEXT");

  // Migrate legacy inline encounter columns from `routes` into `encounters`.
  const routeCols = await columnNames(c, "routes");
  if (routeCols.includes("status") || routeCols.includes("pokemon_id")) {
    await c.execute(`
      INSERT INTO encounters (route_id, slot, pokemon_id, pokemon_name, sprite_url, nickname, status)
      SELECT id, 0, pokemon_id, pokemon_name, sprite_url, nickname, status FROM routes
      WHERE (pokemon_id IS NOT NULL OR pokemon_name IS NOT NULL OR nickname IS NOT NULL OR status IS NOT NULL)
        AND id NOT IN (SELECT route_id FROM encounters WHERE slot = 0)`);
    await c.execute(`
      INSERT INTO encounters (route_id, slot)
      SELECT id, 0 FROM routes WHERE id NOT IN (SELECT route_id FROM encounters WHERE slot = 0)`);
    for (const col of ["pokemon_id", "pokemon_name", "sprite_url", "nickname", "status"]) {
      if ((await columnNames(c, "routes")).includes(col))
        await c.execute(`ALTER TABLE routes DROP COLUMN ${col}`);
    }
  }
}

// ---- Runs --------------------------------------------------------------

export interface RunRow {
  id: number;
  name: string;
  game: string | null;
  mode: Mode;
  player1: string | null;
  player2: string | null;
  password_hash: string | null;
  created_at: string;
}

export interface RunSummary {
  id: number;
  name: string;
  game: string | null;
  mode: Mode;
  player1: string | null;
  player2: string | null;
  protected: boolean;
  created_at: string;
  routes: number;
  caught: number;
  boxed: number;
  fainted: number;
  missed: number;
  bro_failed: number;
}

export async function listRuns(): Promise<RunSummary[]> {
  const rows = await all(
    `SELECT r.id, r.name, r.game, r.mode, r.player1, r.player2,
            (r.password_hash IS NOT NULL) AS prot,
            r.created_at,
            COUNT(DISTINCT rt.id)                    AS routes,
            COALESCE(SUM(e.status = 'caught'),0)     AS caught,
            COALESCE(SUM(e.status = 'boxed'),0)      AS boxed,
            COALESCE(SUM(e.status = 'fainted'),0)    AS fainted,
            COALESCE(SUM(e.status = 'missed'),0)     AS missed,
            COALESCE(SUM(e.status = 'bro_failed'),0) AS bro_failed
     FROM runs r
     LEFT JOIN routes rt ON rt.run_id = r.id
     LEFT JOIN encounters e ON e.route_id = rt.id
     GROUP BY r.id
     ORDER BY r.created_at DESC, r.id DESC`,
  );
  return rows.map(({ prot, ...r }) => ({ ...r, protected: !!prot }) as RunSummary);
}

export async function getRun(id: number): Promise<RunRow | null> {
  return (await one("SELECT * FROM runs WHERE id = ?", [id])) as RunRow | null;
}

export async function createRun(r: {
  name: string;
  game: string | null;
  mode: Mode;
  player1: string | null;
  player2: string | null;
  passwordHash: string | null;
}): Promise<RunRow> {
  return (await one(
    `INSERT INTO runs (name, game, mode, player1, player2, password_hash)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    [r.name, r.game, r.mode, r.player1, r.player2, r.passwordHash],
  )) as RunRow;
}

export async function updateRun(
  id: number,
  fields: { name?: string; game?: string | null },
): Promise<RunRow | null> {
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
  if (!sets.length) return getRun(id);
  args.push(id);
  return (await one(
    `UPDATE runs SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    args,
  )) as RunRow | null;
}

export async function deleteRun(id: number): Promise<void> {
  await ready();
  await client().batch(
    [
      {
        sql: "DELETE FROM encounters WHERE route_id IN (SELECT id FROM routes WHERE run_id = ?)",
        args: [id],
      },
      { sql: "DELETE FROM level_caps WHERE run_id = ?", args: [id] },
      { sql: "DELETE FROM routes WHERE run_id = ?", args: [id] },
      { sql: "DELETE FROM runs WHERE id = ?", args: [id] },
    ],
    "write",
  );
}

/** Fresh run reusing a source run's settings + routes, with empty encounters. */
export async function cloneRun(
  sourceId: number,
  newName: string,
): Promise<RunRow | null> {
  const src = await getRun(sourceId);
  if (!src) return null;
  await ready();
  const tx = await client().transaction("write");
  try {
    const run = (
      await tx.execute({
        sql: `INSERT INTO runs (name, game, mode, player1, player2, password_hash)
              VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [newName, src.game, src.mode, src.player1, src.player2, src.password_hash],
      })
    ).rows[0] as any as RunRow;
    const srcRoutes = (
      await tx.execute({
        sql: "SELECT name, position FROM routes WHERE run_id = ? ORDER BY position, id",
        args: [sourceId],
      })
    ).rows as any[];
    const slots = src.mode === "soullink" ? [0, 1] : [0];
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
        args: [sourceId],
      })
    ).rows as any[];
    for (const c of srcCaps)
      await tx.execute({
        sql: "INSERT INTO level_caps (run_id, name, level, position) VALUES (?, ?, ?, ?)",
        args: [run.id, c.name, c.level, c.position],
      });
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

export async function createRoute(
  runId: number,
  name: string,
): Promise<RouteRow> {
  const run = await getRun(runId);
  const { pos } = await one(
    "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM routes WHERE run_id = ?",
    [runId],
  );
  const route = (await one(
    "INSERT INTO routes (run_id, name, position) VALUES (?, ?, ?) RETURNING *",
    [runId, name, pos],
  )) as Omit<RouteRow, "encounters">;
  const slots = run?.mode === "soullink" ? [0, 1] : [0];
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

/** Persist a new route order; `order` is route ids in the desired sequence. */
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

export async function getEncounterRunId(encId: number): Promise<number | null> {
  const r = await one(
    `SELECT rt.run_id AS run_id FROM encounters e
     JOIN routes rt ON rt.id = e.route_id WHERE e.id = ?`,
    [encId],
  );
  return r ? (r.run_id as number) : null;
}

/**
 * Update an encounter and, in soullink runs, propagate to the partner slot:
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
      `SELECT r.mode AS mode FROM encounters e
       JOIN routes rt ON rt.id = e.route_id
       JOIN runs r ON r.id = rt.run_id WHERE e.id = ?`,
      [id],
    );
    if (ctx?.mode === "soullink") {
      const s = fields.status;
      let partnerStatus: Status | null = null;
      if (s === "fainted" || s === "missed") partnerStatus = "bro_failed";
      else if (s === "boxed") partnerStatus = "boxed";
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
