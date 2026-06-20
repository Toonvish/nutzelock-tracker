// SQLite layer: schema, singleton connection, and typed query helpers.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.NUZLOCKE_DB ?? "data/nuzlocke.db";

export const STATUSES = ["caught", "boxed", "fainted", "missed"] as const;
export type Status = (typeof STATUSES)[number];

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

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      game       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS routes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      position     INTEGER NOT NULL DEFAULT 0,
      pokemon_id   INTEGER,
      pokemon_name TEXT,
      sprite_url   TEXT,
      nickname     TEXT,
      status       TEXT CHECK (status IN ('caught','boxed','fainted','missed')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_routes_run ON routes(run_id);
  `);
}

// ---- Runs --------------------------------------------------------------

export interface RunRow {
  id: number;
  name: string;
  game: string | null;
  created_at: string;
}

/** A run plus per-status route tallies for the sidebar. */
export interface RunSummary extends RunRow {
  routes: number;
  caught: number;
  boxed: number;
  fainted: number;
  missed: number;
}

export function listRuns(): RunSummary[] {
  return getDb()
    .query(
      `SELECT r.*,
              COUNT(rt.id)                                          AS routes,
              COALESCE(SUM(rt.status = 'caught'),  0)               AS caught,
              COALESCE(SUM(rt.status = 'boxed'),   0)               AS boxed,
              COALESCE(SUM(rt.status = 'fainted'), 0)               AS fainted,
              COALESCE(SUM(rt.status = 'missed'),  0)               AS missed
       FROM runs r
       LEFT JOIN routes rt ON rt.run_id = r.id
       GROUP BY r.id
       ORDER BY r.created_at DESC, r.id DESC`,
    )
    .all() as RunSummary[];
}

export function getRun(id: number): RunRow | null {
  return (getDb().query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow) ?? null;
}

export function createRun(name: string, game: string | null): RunRow {
  return getDb()
    .query(
      `INSERT INTO runs (name, game) VALUES ($name, $game) RETURNING *`,
    )
    .get({ $name: name, $game: game }) as RunRow;
}

export function deleteRun(id: number): void {
  // routes cascade via the foreign key + PRAGMA foreign_keys = ON
  getDb().query("DELETE FROM runs WHERE id = ?").run(id);
}

// ---- Routes ------------------------------------------------------------

export interface RouteRow {
  id: number;
  run_id: number;
  name: string;
  position: number;
  pokemon_id: number | null;
  pokemon_name: string | null;
  sprite_url: string | null;
  nickname: string | null;
  status: Status | null;
  created_at: string;
}

export function listRoutes(runId: number): RouteRow[] {
  return getDb()
    .query(
      "SELECT * FROM routes WHERE run_id = ? ORDER BY position, id",
    )
    .all(runId) as RouteRow[];
}

export function createRoute(runId: number, name: string): RouteRow {
  const next = getDb()
    .query(
      "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM routes WHERE run_id = ?",
    )
    .get(runId) as { pos: number };
  return getDb()
    .query(
      `INSERT INTO routes (run_id, name, position)
       VALUES ($run_id, $name, $position) RETURNING *`,
    )
    .get({ $run_id: runId, $name: name, $position: next.pos }) as RouteRow;
}

/** Patch any subset of editable fields on a route. */
export function updateRoute(
  id: number,
  fields: {
    name?: string;
    pokemon_id?: number | null;
    pokemon_name?: string | null;
    sprite_url?: string | null;
    nickname?: string | null;
    status?: Status | null;
  },
): RouteRow | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { $id: id };
  for (const key of [
    "name",
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
  if (sets.length === 0) {
    return (getDb().query("SELECT * FROM routes WHERE id = ?").get(id) as RouteRow) ?? null;
  }
  return getDb()
    .query(`UPDATE routes SET ${sets.join(", ")} WHERE id = $id RETURNING *`)
    .get(params) as RouteRow | null;
}

export function deleteRoute(id: number): void {
  getDb().query("DELETE FROM routes WHERE id = ?").run(id);
}
