# syntax=docker/dockerfile:1

# Stage 1: Build frontend and install production dependencies
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install native compilation dependencies for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install all dependencies (dev dependencies needed for vite build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy frontend source files and configuration
COPY vite.config.js index.html ./
COPY src/ ./src/
COPY public/ ./public/

# Build React production bundle into dist/
RUN npm run build

# Remove development dependencies to keep production footprint minimal
RUN npm prune --omit=dev

# Stage 2: Minimal production runtime
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/filament.db

# Prepare persistent data directory with permissions for the non-root 'node' user
RUN mkdir -p /data && chown -R node:node /data /app

# Copy production dependencies and built static assets
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json server.js ./

# Run container as non-root user
USER node

# Expose HTTP port
EXPOSE 8080

# Persist SQLite database and WAL files
VOLUME ["/data"]

# Health check using Node.js built-in fetch API
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/config').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
