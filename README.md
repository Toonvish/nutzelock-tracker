# Custom Nuzlocke Tracker

A simple local web app to track a custom Pokémon Nuzlocke: create multiple **runs**, add **routes** as you play, and record the **encounter** caught on each route — Pokémon (name + sprite from [PokeAPI](https://pokeapi.co/)), a **nickname**, and a **status**.

## Stack

Bun + `bun:sqlite` + `Bun.serve`, with a dependency-free vanilla-JS SPA in `public/`. Same shape as the Haushalt app.

## Run

```sh
bun install      # first time only (pulls bun-types)
bun run dev      # watch mode
# or
bun run start
```

Open <http://localhost:3001> (localhost only).

## Features

- **Runs** — flat list in the sidebar. Create / switch / delete. Each run keeps its own routes. The last opened run reopens on reload.
- **Routes** — free-text names you add as you play (e.g. `Route 1`, `Viridian Forest`).
- **Encounters** — per route: pick a Pokémon (autocomplete backed by the full PokéAPI name list, cached in `localStorage`), give it a nickname, and set a **status**: `Caught` / `Boxed` / `Fainted` / `Missed`. Setting a Pokémon on a fresh route defaults its status to *Caught*.
- Sprites and names are stored in the DB, so saved runs render even if PokeAPI is offline later.

## Data

SQLite at `data/nuzlocke.db` (override with `NUZLOCKE_DB`). Deleting a run cascades to its routes.

## Build a single binary

```sh
bun run build:win        # dist/nuzlocke-win.exe
bun run build:linux-x64
bun run build:pi
```
