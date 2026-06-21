# Custom Nuzlocke Tracker

A web app to track a custom Pokémon Nuzlocke — solo or as a two-player **Soullink** — with live sync between both players. A **session** holds **routes** and one or more **runs (attempts)**; each run records the **encounter(s)** on each route: Pokémon (name + sprite from [PokeAPI](https://pokeapi.co/)), a **nickname**, and a **status**.

## Access model

- **Log in with Discord** to own sessions — your list of sessions is private to you.
- Or open a session via its **share link** (`/s/<share-id>`): anyone with the link can view *and* edit it (collaborative, e.g. a Soullink partner).
- **Guests** (not logged in) can create sessions too; they're reachable only by their share link and are auto-deleted after a year without access.

## Stack

Bun + `@libsql/client` + `Bun.serve` (HTTP + WebSocket), with a dependency-free vanilla-JS SPA in `public/`. Login is Discord OAuth via a stateless signed cookie.

## Run

```sh
bun install      # first time only (pulls bun-types)
bun run dev      # watch mode
# or
bun run start
```

The server binds `0.0.0.0` and serves three pages: `/login`, `/sessions` (your sessions), and `/s/<share-id>` (a full-page session view). Discord login needs env vars (below); guest sessions work without them.

## Features

- **Sessions & runs** — a session holds the routes; within it you keep multiple **runs (attempts)**, switched with a run-number select. **"+ New run"** copies the current routes + level caps with **empty encounters** and stays on the page.
- **Routes** — free-text names you add as you play (e.g. `Route 1`, `Viridian Forest`); drag the grip handle to reorder.
- **Encounters** — pick a Pokémon (sprite-thumbnail dropdown backed by the full PokéAPI list, cached in `localStorage`), give it a **nickname**, set a **status** (`Alive` / `Boxed` / `Fainted` / `Missed`; defaults to *Alive* on capture). Per encounter: an **ℹ️ info** modal (base stat total + ability effects) and a **🧬 evolve** button.
- **Soullink mode** — two encounters per route, one per player. Status is linked: if one side **faints** or is **missed**, the partner's becomes **"Bro failed"**; if one is **boxed**, the partner is boxed too; *alive* stays independent.
- **Level caps**, a per-generation **type chart**, and a **type-matchup** calculator (rom-hack typings supported).
- **Live sync** — everyone viewing a session connects over WebSocket; any change appears for the others instantly (green dot = connected).
- **Dupes clause** — warns if a Pokémon's evolution line is already an encounter elsewhere in the run.
- Sprites and names are stored in the DB, so saved runs render even if PokeAPI is offline later.

## Data

Uses **libSQL** (`@libsql/client`) — SQLite-compatible. Two modes, chosen by env:

- **Local (default):** a SQLite file at `data/nuzlocke.db` (override with `NUZLOCKE_DB`).
- **Hosted:** set `TURSO_DATABASE_URL` (and `TURSO_AUTH_TOKEN`) to use a [Turso](https://turso.tech) database — durable and free, ideal for hosts with ephemeral disks like Render.

Schema: `users` own `sessions`; a session has `runs` (attempts); each run has `routes` → `encounters` (one per slot; soullink uses slots 0 and 1) + `level_caps`. Tables auto-create on first run. Ownerless (guest) sessions are pruned after a year without access.

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

Then add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. (Render injects `PORT`; don't set it.) The app creates its tables automatically.

**3. Set up Discord login.** At <https://discord.com/developers/applications> create an app, and under **OAuth2** add a redirect URL `https://<your-render-url>/auth/discord/callback` (and `http://localhost:3001/auth/discord/callback` for local dev). Then set env vars:

| Var | Value |
|---|---|
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | from the Discord app's OAuth2 page |
| `SESSION_SECRET` | any long random string (signs login cookies) |
| `DISCORD_REDIRECT_URI` | *optional* — only if the auto-derived callback URL is wrong (e.g. behind extra proxies) |

Guests can use the app without Discord configured; only the "Log in with Discord" button needs these.

**One-click blueprint.** `render.yaml` encodes the service + all of the above (it prompts for the secrets and generates `SESSION_SECRET`). On Render: **New → Blueprint**, select the repo; edit `region` first if needed.

**Docker (alternative).** Set the runtime to **Docker** to run on the official `oven/bun` image (`Dockerfile` included); pass the same two Turso env vars.

## Build a single binary

```sh
bun run build:win        # dist/nuzlocke-win.exe
bun run build:linux-x64
bun run build:pi
```
