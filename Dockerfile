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
    PORT=8001 \
    SQLITE_PATH=/data/cnama.sqlite \
    DOWNLOAD_TMP_DIR=/data/downloads \
    PLEX_MOVIES_DIR=/media/movies \
    PLEX_TV_DIR=/media/tv

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist

RUN mkdir -p /data/downloads /media/movies /media/tv \
  && chown -R node:node /app /data /media

USER node
EXPOSE 8001
VOLUME ["/data", "/media/movies", "/media/tv"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8001) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
