# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY index.html vite.config.ts tsconfig.json tsconfig.server.json ./
COPY icon_64x64.8dabdc.png ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8010 \
    PUID=1000 \
    PGID=1000 \
    SQLITE_PATH=/data/cnama.sqlite \
    DOWNLOAD_TMP_DIR=/data/downloads \
    PLEX_MOVIES_DIR=/media/movies \
    PLEX_TV_DIR=/media/tv

WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --omit=dev \
  && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/cnama-plex-entrypoint

RUN mkdir -p /data/downloads /media/movies /media/tv \
  && chmod +x /usr/local/bin/cnama-plex-entrypoint \
  && chown -R node:node /app /data /media

EXPOSE 8010
VOLUME ["/data", "/media/movies", "/media/tv"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8001) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["cnama-plex-entrypoint"]
CMD ["node", "dist/server/index.js"]
