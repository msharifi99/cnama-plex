# CNama Plex

TypeScript/Fastify/React web app for pasting direct media links, reviewing the inferred Plex layout, and downloading selected items into Plex library folders.

## What It Does

- Detects direct HTTP/HTTPS media links from pasted text.
- Infers movie or series metadata from page titles, link labels, and filenames.
- Previews Plex destination paths before anything is queued.
- Matches existing Plex folders, including high-confidence fuzzy matches and ambiguous folder choices.
- Downloads selected items with a SQLite-backed queue, live WebSocket progress, cancel, and retry actions.
- Uses parallel byte-range downloads when the upstream server supports ranges, then falls back to resumable sequential downloads when needed.
- Skips files that already exist at the final Plex destination.

The downloader only accepts HTTP and HTTPS URLs and refuses download hosts that resolve to private network addresses.

## Project Layout

- `src/client` contains the React/Vite UI.
- `src/server` contains the Fastify API, SQLite persistence, naming logic, and downloader.
- `tests` contains Node test runner coverage for naming, queue payloads, and downloader behavior.
- `deploy` contains the systemd service and production env example for tarball installs.
- `Dockerfile` and `docker-compose.yml` define the containerized deployment.

## Requirements

- Docker with Docker Compose for the container workflow.
- Node.js 22 or newer for direct local/systemd installs. Node.js 24 is what the Docker image uses.
- Writable movie and TV library directories for the user running the app.

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Open the Vite dev app:

```text
http://localhost:5173
```

The API server runs at `http://localhost:8010` and is proxied by Vite during development.

For a production-style local run:

```bash
npm run build
npm start
```

Open:

```text
http://localhost:8010
```

## Scripts

```bash
npm run dev         # API server on :8010 and Vite app on :5173
npm run test        # TypeScript compile for tests, then node --test
npm run typecheck   # Type-check client/shared and server configs
npm run build       # Build Vite client and TypeScript server into dist/
npm run release     # Build and create cnama-plex-<version>.tgz
```

## Docker Compose

Build and run the app:

```bash
docker compose up -d --build
```

Open:

```text
http://localhost:8010
```

By default, Compose stores the SQLite database and temporary downloads in `./data`, and maps Plex libraries to local test folders under `./data/plex`.

For a real Plex server, create a `.env` file next to `docker-compose.yml` and point the bind mounts at your host library folders:

```bash
PORT=8010
PUID=1000
PGID=1000
CNAMA_DATA_DIR=/srv/cnama-plex
PLEX_MOVIES_DIR=/your/plex/Movies
PLEX_TV_DIR=/your/plex/TV
DOWNLOAD_CONCURRENCY=2
DOWNLOAD_CONNECTIONS=32
PUBLIC_BASE_PATH=
```

The image runs the app as `PUID`/`PGID`, defaulting to `1000:1000`. On startup it fixes ownership for the app-owned `/data` mount, but your Plex Movies and TV directories still need to be writable by that UID/GID on the host.

Inside the container, these are always mapped to:

```bash
SQLITE_PATH=/data/cnama.sqlite
DOWNLOAD_TMP_DIR=/data/downloads
PLEX_MOVIES_DIR=/media/movies
PLEX_TV_DIR=/media/tv
```

## Portainer Deployment

This repository does not include a registry-publishing workflow or a separate Portainer compose file. Use the existing `docker-compose.yml` as the Portainer stack file.

1. Push this repo to a Git host Portainer can read.
2. On your homelab host, create persistent app storage:

```bash
sudo mkdir -p /srv/cnama-plex
sudo chown -R 1000:1000 /srv/cnama-plex
```

If you set different `PUID`/`PGID` values, use those for ownership instead. Make sure that same UID/GID can also write to your Plex Movies and TV folders.

3. In Portainer, add a stack from Git:

```text
Stacks -> Add stack -> Repository
Repository URL: <your repo URL>
Repository reference: refs/heads/main
Compose path: docker-compose.yml
```

4. Add these stack environment variables in Portainer:

```bash
PORT=8010
PUID=1000
PGID=1000
CNAMA_DATA_DIR=/srv/cnama-plex
PLEX_MOVIES_DIR=/your/plex/Movies
PLEX_TV_DIR=/your/plex/TV
DOWNLOAD_CONCURRENCY=2
DOWNLOAD_CONNECTIONS=32
PUBLIC_BASE_PATH=
```

5. Deploy the stack. Portainer builds `cnama-plex:latest` from this repo because the compose file includes `build.context: .`.
6. Enable GitOps updates for the stack. Use a webhook for immediate redeploys, or polling if you prefer Portainer to check the repo periodically.

```text
git push -> Portainer pulls the repo -> Portainer rebuilds/redeploys the stack
```

For a manual update, push your code, then open the stack in Portainer and choose pull/redeploy.

## Home Server Requirements

- Linux server with systemd.
- Node.js 22 or newer. The app uses Node's built-in SQLite module.
- A user that can write to the Plex library folders.
- Plex movie and TV library paths already mounted on the server.

Check Node:

```bash
node -v
which node
```

## Build a Release on This Machine

From the project folder:

```bash
npm install
npm run release
```

That creates a tarball like:

```text
cnama-plex-0.1.0.tgz
```

Copy it to the home server:

```bash
scp cnama-plex-0.1.0.tgz user@192.168.2.13:/tmp/
```

## Install on the Home Server

Run these on the home server:

```bash
sudo useradd --system --home /opt/cnama-plex --shell /usr/sbin/nologin cnama || true
sudo mkdir -p /opt/cnama-plex /var/lib/cnama-plex
sudo tar -xzf /tmp/cnama-plex-0.1.0.tgz -C /opt/cnama-plex --strip-components=1
cd /opt/cnama-plex
sudo npm install --omit=dev
sudo chown -R cnama:cnama /opt/cnama-plex /var/lib/cnama-plex
```

Create the server config:

```bash
sudo cp /opt/cnama-plex/deploy/cnama-plex.env.example /etc/cnama-plex.env
sudo nano /etc/cnama-plex.env
```

Set these paths correctly:

```bash
PLEX_MOVIES_DIR=/your/plex/Movies
PLEX_TV_DIR=/your/plex/TV
DOWNLOAD_TMP_DIR=/var/lib/cnama-plex/downloads
SQLITE_PATH=/var/lib/cnama-plex/cnama.sqlite
```

Make sure the `cnama` user can write to the Plex folders. One common approach is to add it to the Plex media group:

```bash
sudo usermod -aG plex cnama
sudo chmod -R g+rwX /your/plex/Movies /your/plex/TV
```

## Run on Boot with systemd

Install the service:

```bash
sudo cp /opt/cnama-plex/deploy/cnama-plex.service /etc/systemd/system/cnama-plex.service
sudo nano /etc/systemd/system/cnama-plex.service
```

Update this line so systemd is allowed to write to your real Plex path:

```ini
ReadWritePaths=/opt/cnama-plex /var/lib/cnama-plex /your/plex
```

If `which node` is not `/usr/bin/node`, also update `ExecStart` to use the real Node path.

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable cnama-plex
sudo systemctl start cnama-plex
sudo systemctl status cnama-plex
```

The app should now survive reboots and restart automatically after failures.

Open it from your LAN:

```text
http://192.168.2.13:8010
```

## Running Behind nginx at /cnama

The frontend build uses relative asset URLs, so `/cnama/` can load its JS and CSS from `/cnama/assets/...`.

If nginx strips the `/cnama` prefix before proxying to the Node app, no app config change is needed:

```nginx
location /cnama/ {
  proxy_pass http://127.0.0.1:8010/;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

If nginx keeps the `/cnama` prefix when proxying, set this in `/etc/cnama-plex.env`:

```bash
PUBLIC_BASE_PATH=/cnama
```

Then restart:

```bash
sudo systemctl restart cnama-plex
```

## Logs and Maintenance

View logs:

```bash
journalctl -u cnama-plex -f
```

Restart after config changes:

```bash
sudo systemctl restart cnama-plex
```

Update to a new release:

```bash
sudo systemctl stop cnama-plex
sudo tar -xzf /tmp/cnama-plex-0.1.0.tgz -C /opt/cnama-plex --strip-components=1
cd /opt/cnama-plex
sudo npm install --omit=dev
sudo chown -R cnama:cnama /opt/cnama-plex
sudo systemctl start cnama-plex
```

## Configuration

The app reads `/etc/cnama-plex.env` through systemd and also supports a local `.env` file when run manually. Docker Compose also reads `.env` for host bind-mount paths.

```bash
HOST=0.0.0.0
PORT=8010
PUID=1000
PGID=1000
PUBLIC_BASE_PATH=
SQLITE_PATH=/var/lib/cnama-plex/cnama.sqlite
DOWNLOAD_TMP_DIR=/var/lib/cnama-plex/downloads
PLEX_MOVIES_DIR=/your/plex/Movies
PLEX_TV_DIR=/your/plex/TV
DOWNLOAD_CONCURRENCY=2
DOWNLOAD_CONNECTIONS=32
```

- `HOST` and `PORT` control where Fastify listens.
- `PUID` and `PGID` control the UID/GID used by the Docker container after startup.
- `PUBLIC_BASE_PATH` serves the app and API under a prefix such as `/cnama`.
- `SQLITE_PATH` stores the queue database.
- `DOWNLOAD_TMP_DIR` stores partial `.part` files before they are moved into Plex.
- `PLEX_MOVIES_DIR` and `PLEX_TV_DIR` are the final Plex library roots.
- `DOWNLOAD_CONCURRENCY` controls how many queued items run at the same time.
- `DOWNLOAD_CONNECTIONS` controls how many byte-range connections each new file download uses when the upstream server supports ranges.
- `CNAMA_DATA_DIR` is only used by Docker Compose to choose the host directory mounted at `/data`.

## API Surface

- `GET /api/health`
- `POST /api/detected-links/preview`
- `POST /api/download-batches`
- `GET /api/jobs`
- `POST /api/jobs/:id/cancel`
- `POST /api/jobs/:id/retry`
- `GET /ws/jobs`
