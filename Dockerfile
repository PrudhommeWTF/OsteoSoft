# ============================================================
# OsteoSoft — image unique : l'API Node sert /api ET le frontend Angular.
# Un seul conteneur suffit à l'auto-hébergement.
# ============================================================

# ---- Stage 1: build (frontend Angular + dépendances natives compilées) ----
FROM node:20-slim AS builder
ENV NG_CLI_ANALYTICS=false
WORKDIR /app

# Outils de compilation pour les modules natifs (better-sqlite3, argon2).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# Sources nécessaires au build Angular.
COPY angular.json tsconfig.json tsconfig.app.json tsconfig.spec.json ./
COPY src ./src
COPY public ./public
RUN npm run build

# Retire les devDependencies : ne restent que les deps runtime (dont les modules
# natifs déjà compilés), réutilisées telles quelles dans l'image finale.
RUN npm prune --omit=dev && npm cache clean --force

# ---- Stage 2: runtime (slim, sans outils de build) ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node_modules pruné (modules natifs compilés sur la même base → ABI/glibc identiques).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json package-lock.json ./
COPY server ./server
COPY CHANGELOG.md ./

ENV API_PORT=4199
ENV OSTEOSOFT_STATIC_DIR=/app/dist/OsteoSoft/browser
VOLUME ["/app/server/data"]
EXPOSE 4199

# Healthcheck via le fetch global de Node (endpoint public /api/config).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4199/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]

# CI: image Docker unique construite et testée par .github/workflows/docker-image.yml
