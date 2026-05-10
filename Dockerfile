# ─────────────────────────────────────────────────────────────────────────────
# Slovak Data Protection MCP — multi-stage Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Build:  docker build -t slovak-data-protection-mcp .
# Run:    docker run --rm -p 3000:3000 slovak-data-protection-mcp
#
# The image expects a pre-built database at /app/data/uoou_sk.db.
# Override with UOOU_SK_DB_PATH for a custom location.
#
# Multi-stage to preserve native bindings (better-sqlite3 postinstall):
# the production stage COPYs node_modules from the builder so the compiled
# .node binary is preserved; running `npm ci --omit=dev --ignore-scripts`
# in the production stage strips the binding and breaks every SQLite call.
# ─────────────────────────────────────────────────────────────────────────────

# --- Stage 1: Build TypeScript + native bindings ---
FROM node:20-slim AS builder

WORKDIR /app

# Build deps for better-sqlite3 native compile
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# Full install (including dev deps) WITH postinstall scripts so
# better-sqlite3 builds its native binding.
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Prune dev deps but keep the compiled native binding intact.
RUN npm prune --omit=dev

# --- Stage 2: Production ---
FROM node:20-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV UOOU_SK_DB_PATH=/app/data/uoou_sk.db

COPY package.json package-lock.json* ./

# Bring node_modules with the prebuilt better-sqlite3 .node binding
# from the builder stage — DO NOT re-run `npm ci` here.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist/ dist/

# Database (provisioned by ghcr-build.yml from GitHub Release: data/database.db)
COPY data/database.db data/uoou_sk.db

# Non-root user for security
RUN addgroup --system --gid 1001 mcp && \
    adduser --system --uid 1001 --ingroup mcp mcp && \
    chown -R mcp:mcp /app
USER mcp

# Health check: verify HTTP server responds
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/src/http-server.js"]
