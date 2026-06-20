# Most reliable Render option: run on the official Bun image (no Bun
# auto-detection needed). On Render choose "Docker" as the runtime.
FROM oven/bun:1

WORKDIR /app

# Install deps first for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# App source.
COPY . .

# SQLite lives here — mount a Render disk at /data to persist it.
ENV NUZLOCKE_DB=/data/nuzlocke.db

# Render injects PORT at runtime; the server reads it and binds 0.0.0.0.
EXPOSE 3001
CMD ["bun", "src/server.ts"]
