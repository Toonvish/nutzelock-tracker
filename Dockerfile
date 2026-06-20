# Optional: run on the official Bun image (choose "Docker" runtime on Render).
# Data lives in Turso — pass TURSO_DATABASE_URL / TURSO_AUTH_TOKEN at runtime.
FROM oven/bun:1

WORKDIR /app

# Install deps first for layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# App source.
COPY . .

# Render injects PORT at runtime; the server reads it and binds 0.0.0.0.
EXPOSE 3001
CMD ["bun", "src/server.ts"]
