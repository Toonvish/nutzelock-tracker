// SQLite layer: schema, migration, and typed query helpers.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.NUZLOCKE_DB ?? "data/nuzlocke.db";

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

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  _db = db;
  return db;
}

function columnNames(db: Database, table: string): string[] {
  return (
    db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((r) => r.name);
}

function addColumnIfMissing(
  db: Database,
  table: string,
  col: string,
  def: string,
) {
  if (!columnNames(db, table).includes(col))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

function migrate(db: Database) {
  db.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_routes_run ON routes(run_id);
    CREATE INDEX IF NOT EXISTS idx_encounters_route ON encounters(route_id);
  `);

  // Upgrade older `runs` tables created before soullink/password existed.
  addColumnIfMissing(db, "runs", "mode", "TEXT NOT NULL DEFAULT 'normal'");
  addColumnIfMissing(db, "runs", "player1", "TEXT");
  addColumnIfMissing(db, "runs", "player2", "TEXT");
  addColumnIfMissing(db, "runs", "password_hash", "TEXT");

  // Migrate legacy inline encounter columns from `routes` into `encounters`.
  const routeCols = columnNames(db, "routes");
  if (routeCols.includes("status") || routeCols.includes("pokemon_id")) {
    // 1) Carry over routes that already had an encounter (slot 0, with data).
    db.exec(`
      INSERT INTO encounters (route_id, slot, pokemon_id, pokemon_name, sprite_url, nickname, status)
      SELECT id, 0, pokemon_id, pokemon_name, sprite_url, nickname, status
      FROM routes
      WHERE (pokemon_id IS NOT NULL OR pokemon_name IS NOT NULL OR nickname IS NOT NULL OR status IS NOT NULL)
        AND id NOT IN (SELECT route_id FROM encounters WHERE slot = 0);
    `);
    // 2) Ensure every remaining route has an (empty) slot-0 encounter too.
    db.exec(`
      INSERT INTO encounters (route_id, slot)
      SELECT id, 0 FROM routes
      WHERE id NOT IN (SELECT route_id FROM encounters WHERE slot = 0);
    `);
    // 3) Drop the now-unused legacy columns.
    for (const c of [
      "pokemon_id",
      "pokemon_name",
      "sprite_url",
      "nickname",
      "status",
    ]) {
      if (columnNames(db, "routes").includes(c))
        db.exec(`ALTER TABLE routes DROP COLUMN ${c}`);
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

/** A run plus per-status encounter tallies and a `protected` flag (no hash). */
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

export function listRuns(): RunSummary[] {
  const rows = getDb()
    .query(
      `SELECT r.id, r.name, r.game, r.mode, r.player1, r.player2,
              (r.password_hash IS NOT NULL) AS prot,
              r.created_at,
              COUNT(DISTINCT rt.id)                   AS routes,
              COALESCE(SUM(e.status = 'caught'),0)    AS caught,
              COALESCE(SUM(e.status = 'boxed'),0)     AS boxed,
              COALESCE(SUM(e.status = 'fainted'),0)   AS fainted,
              COALESCE(SUM(e.status = 'missed'),0)    AS missed,
              COALESCE(SUM(e.status = 'bro_failed'),0) AS bro_failed
       FROM runs r
       LEFT JOIN routes rt ON rt.run_id = r.id
       LEFT JOIN encounters e ON e.route_id = rt.id
       GROUP BY r.id
       ORDER BY r.created_at DESC, r.id DESC`,
    )
    .all() as (Omit<RunSummary, "protected"> & { prot: number })[];
  return rows.map(({ prot, ...r }) => ({ ...r, protected: !!prot }));
}

export function getRun(id: number): RunRow | null {
  return (getDb().query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow) ?? null;
}

export function createRun(r: {
  name: string;
  game: string | null;
  mode: Mode;
  player1: string | null;
  player2: string | null;
  passwordHash: string | null;
}): RunRow {
  return getDb()
    .query(
      `INSERT INTO runs (name, game, mode, player1, player2, password_hash)
       VALUES ($name, $game, $mode, $p1, $p2, $ph) RETURNING *`,
    )
    .get({
      $name: r.name,
      $game: r.game,
      $mode: r.mode,
      $p1: r.player1,
      $p2: r.player2,
      $ph: r.passwordHash,
    }) as RunRow;
}

export function updateRun(
  id: number,
  fields: { name?: string; game?: string | null },
): RunRow | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { $id: id };
  if (fields.name !== undefined) {
    sets.push("name = $name");
    params.$name = fields.name;
  }
  if (fields.game !== undefined) {
    sets.push("game = $game");
    params.$game = fields.game;
  }
  if (!sets.length) return getRun(id);
  return getDb()
    .query(`UPDATE runs SET ${sets.join(", ")} WHERE id = $id RETURNING *`)
    .get(params) as RunRow | null;
}

export function deleteRun(id: number): void {
  getDb().query("DELETE FROM runs WHERE id = ?").run(id);
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

function encountersForRoute(routeId: number): EncounterRow[] {
  return getDb()
    .query("SELECT * FROM encounters WHERE route_id = ? ORDER BY slot")
    .all(routeId) as EncounterRow[];
}

export function listRoutes(runId: number): RouteRow[] {
  const routes = getDb()
    .query("SELECT * FROM routes WHERE run_id = ? ORDER BY position, id")
    .all(runId) as Omit<RouteRow, "encounters">[];
  const encs = getDb()
    .query(
      `SELECT e.* FROM encounters e
       JOIN routes r ON r.id = e.route_id
       WHERE r.run_id = ? ORDER BY e.slot`,
    )
    .all(runId) as EncounterRow[];
  const byRoute = new Map<number, EncounterRow[]>();
  for (const e of encs) {
    if (!byRoute.has(e.route_id)) byRoute.set(e.route_id, []);
    byRoute.get(e.route_id)!.push(e);
  }
  return routes.map((rt) => ({ ...rt, encounters: byRoute.get(rt.id) ?? [] }));
}

export function createRoute(runId: number, name: string): RouteRow {
  const run = getRun(runId);
  const next = getDb()
    .query(
      "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM routes WHERE run_id = ?",
    )
    .get(runId) as { pos: number };
  const route = getDb()
    .query(
      `INSERT INTO routes (run_id, name, position)
       VALUES ($run_id, $name, $position) RETURNING *`,
    )
    .get({ $run_id: runId, $name: name, $position: next.pos }) as Omit<
    RouteRow,
    "encounters"
  >;
  const slots = run?.mode === "soullink" ? [0, 1] : [0];
  const insertEnc = getDb().query(
    "INSERT INTO encounters (route_id, slot) VALUES ($rid, $slot)",
  );
  for (const slot of slots) insertEnc.run({ $rid: route.id, $slot: slot });
  return { ...route, encounters: encountersForRoute(route.id) };
}

export function updateRouteName(id: number, name: string): RouteRow | null {
  const row = getDb()
    .query("UPDATE routes SET name = $name WHERE id = $id RETURNING *")
    .get({ $id: id, $name: name }) as Omit<RouteRow, "encounters"> | null;
  return row ? { ...row, encounters: encountersForRoute(row.id) } : null;
}

export function deleteRoute(id: number): void {
  getDb().query("DELETE FROM routes WHERE id = ?").run(id);
}

export function getRouteRunId(routeId: number): number | null {
  const r = getDb()
    .query("SELECT run_id FROM routes WHERE id = ?")
    .get(routeId) as { run_id: number } | null;
  return r?.run_id ?? null;
}

export function getEncounterRunId(encId: number): number | null {
  const r = getDb()
    .query(
      `SELECT rt.run_id AS run_id FROM encounters e
       JOIN routes rt ON rt.id = e.route_id WHERE e.id = ?`,
    )
    .get(encId) as { run_id: number } | null;
  return r?.run_id ?? null;
}

/**
 * Update an encounter and, in soullink runs, propagate to the partner slot:
 *   fainted | missed  -> partner becomes 'bro_failed'
 *   boxed             -> partner becomes 'boxed'
 * Returns the updated encounter and the partner encounter if it changed.
 */
export function updateEncounter(
  id: number,
  fields: {
    pokemon_id?: number | null;
    pokemon_name?: string | null;
    sprite_url?: string | null;
    nickname?: string | null;
    status?: Status | null;
  },
): { encounter: EncounterRow; partner: EncounterRow | null } | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { $id: id };
  for (const key of [
    "pokemon_id",
    "pokemon_name",
    "sprite_url",
    "nickname",
    "status",
  ] as const) {
    if (key in fields) {
      sets.push(`${key} = $${key}`);
      params[`$${key}`] = fields[key] ?? null;
    }
  }
  const encounter = (
    sets.length
      ? getDb()
          .query(
            `UPDATE encounters SET ${sets.join(", ")} WHERE id = $id RETURNING *`,
          )
          .get(params)
      : getDb().query("SELECT * FROM encounters WHERE id = ?").get(id)
  ) as EncounterRow | null;
  if (!encounter) return null;

  let partner: EncounterRow | null = null;
  if ("status" in fields) {
    const ctx = getDb()
      .query(
        `SELECT r.mode AS mode FROM encounters e
         JOIN routes rt ON rt.id = e.route_id
         JOIN runs r ON r.id = rt.run_id WHERE e.id = ?`,
      )
      .get(id) as { mode: Mode } | null;
    if (ctx?.mode === "soullink") {
      const s = fields.status;
      let partnerStatus: Status | null = null;
      if (s === "fainted" || s === "missed") partnerStatus = "bro_failed";
      else if (s === "boxed") partnerStatus = "boxed";
      if (partnerStatus) {
        partner = getDb()
          .query(
            `UPDATE encounters SET status = $st
             WHERE route_id = $rid AND slot = $slot RETURNING *`,
          )
          .get({
            $st: partnerStatus,
            $rid: encounter.route_id,
            $slot: encounter.slot === 0 ? 1 : 0,
          }) as EncounterRow | null;
      }
    }
  }
  return { encounter, partner };
}
