# Custom Nuzlocke Tracker

A web app to track a custom Pokémon Nuzlocke — solo or as a two-player **Soullink** — with live sync between both players. Create multiple **runs**, add **routes**, and record the **encounter(s)** on each route: Pokémon (name + sprite from [PokeAPI](https://pokeapi.co/)), a **nickname**, and a **status**.

## Stack

Bun + `bun:sqlite` + `Bun.serve` (HTTP + WebSocket), with a dependency-free vanilla-JS SPA in `public/`.

## Run

```sh
bun install      # first time only (pulls bun-types)
bun run dev      # watch mode
# or
bun run start
```

The server binds `0.0.0.0`, so it's reachable on your LAN. Open <http://localhost:3001> yourself, and share `http://<your-LAN-ip>:3001` with your Soullink partner (the startup log prints the hint).

## Features

- **Runs** — flat list in the sidebar. Create / switch / delete. The last opened run reopens on reload. Sidebar shows a 🔗 (soullink) or 🔒 (protected) badge.
- **Routes** — free-text names you add as you play (e.g. `Route 1`, `Viridian Forest`).
- **Encounters** — pick a Pokémon (sprite-thumbnail dropdown backed by the full PokéAPI list, cached in `localStorage`), give it a **nickname**, set a **status** (`Caught` / `Boxed` / `Fainted` / `Missed`; defaults to *Caught* on capture). Per encounter: an **ℹ️ info** modal (base stat total + ability effects) and a **🧬 evolve** button (walks the PokéAPI evolution chain).
- **Soullink mode** — two encounters per route, one per player (names configurable). Status is linked: if one side **faints** or is **missed**, the partner's becomes **"Bro failed"**; if one is **boxed**, the partner is boxed too; *caught* stays independent.
- **Live sync** — both players connect over WebSocket; any change (encounter, route, status) appears for the other instantly. A green dot in the run header shows the connection is live.
- **Password protection** — optionally protect a run with a password; it's then required to open *and* edit. The session list shows a 🔒 until unlocked. Passwords are hashed (`Bun.password`); access is granted via in-memory tokens.
- Sprites and names are stored in the DB, so saved runs render even if PokeAPI is offline later.

## Data

SQLite at `data/nuzlocke.db` (override with `NUZLOCKE_DB`). Schema: `runs` → `routes` → `encounters` (one per slot; soullink uses slots 0 and 1). Deleting a run cascades to its routes and encounters. The DB auto-migrates older single-encounter data into the encounters table on first run.

## Deploy on Render

The server already reads `PORT` from the environment and binds `0.0.0.0`, so it works on Render as-is.

**Commands** (Render dashboard → New → Web Service):

| Field | Value |
|---|---|
| Build Command | `bun install` |
| Start Command | `bun run start` |

Runtime: pick **Bun** if offered; otherwise pick **Node** — the committed `bun.lock` makes Render install Bun automatically. (Render injects `PORT`; no need to set it.)

**Persist the database.** The app stores everything in SQLite at `data/nuzlocke.db`, and Render's filesystem is wiped on every deploy/restart. To keep your runs, add a **Persistent Disk** (requires a paid instance) and point the DB at it:

- Disk mount path: `/var/data`
- Env var: `NUZLOCKE_DB=/var/data/nuzlocke.db`

On the free plan there's no persistent disk, so data resets on each deploy/sleep.

**One-click blueprint.** `render.yaml` encodes all of the above (web service + disk + env). On Render: **New → Blueprint**, select the repo. Edit `region`/`plan` first if needed.

**Docker (most reliable).** If the native Bun path gives trouble, set the service runtime to **Docker** — the included `Dockerfile` runs on the official `oven/bun` image. Still mount a disk at `/data` (the Dockerfile sets `NUZLOCKE_DB=/data/nuzlocke.db`).

## Build a single binary

```sh
bun run build:win        # dist/nuzlocke-win.exe
bun run build:linux-x64
bun run build:pi
```
