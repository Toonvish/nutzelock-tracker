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

Uses **libSQL** (`@libsql/client`) — SQLite-compatible. Two modes, chosen by env:

- **Local (default):** a SQLite file at `data/nuzlocke.db` (override with `NUZLOCKE_DB`).
- **Hosted:** set `TURSO_DATABASE_URL` (and `TURSO_AUTH_TOKEN`) to use a [Turso](https://turso.tech) database — durable and free, ideal for hosts with ephemeral disks like Render.

Schema: `runs` → `routes` → `encounters` (one per slot; soullink uses slots 0 and 1) + `level_caps`. Deleting a run removes its routes, encounters, and caps. The DB auto-creates its tables and migrates older single-encounter data on first run.

## Deploy on Render

The server reads `PORT` from the environment and binds `0.0.0.0`, so it runs on Render's **free** plan as-is — and because data lives in Turso, no persistent disk is needed.

**1. Create a free database (Turso):**

```sh
# https://docs.turso.tech/quickstart
turso db create nuzlocke
turso db show nuzlocke --url        # -> TURSO_DATABASE_URL  (libsql://…)
turso db tokens create nuzlocke     # -> TURSO_AUTH_TOKEN
```

**2. Create the Render Web Service** (New → Web Service):

| Field | Value |
|---|---|
| Build Command | `bun install` |
| Start Command | `bun run start` |
| Runtime | **Bun** if offered, else **Node** (the committed `bun.lock` makes Render install Bun) |

Then add the two environment variables `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. (Render injects `PORT`; don't set it.) The app creates its tables automatically on first request.

**One-click blueprint.** `render.yaml` encodes the service + env vars (it prompts for the two Turso secrets). On Render: **New → Blueprint**, select the repo; edit `region` first if needed.

**Docker (alternative).** Set the runtime to **Docker** to run on the official `oven/bun` image (`Dockerfile` included); pass the same two Turso env vars.

## Build a single binary

```sh
bun run build:win        # dist/nuzlocke-win.exe
bun run build:linux-x64
bun run build:pi
```
