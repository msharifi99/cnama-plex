# CNama Plex

TypeScript/Node web app for pasting direct media links, reviewing the inferred Plex layout, and downloading selected items into Plex library folders.

## Local Development

```bash
npm install
cp .env.example .env
npm run build
npm start
```

Open:

```text
http://localhost:8001
```

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
http://192.168.2.13:8001
```

## Running Behind nginx at /cnama

The frontend build uses relative asset URLs, so `/cnama/` can load its JS and CSS from `/cnama/assets/...`.

If nginx strips the `/cnama` prefix before proxying to the Node app, no app config change is needed:

```nginx
location /cnama/ {
  proxy_pass http://127.0.0.1:8001/;
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

The app reads `/etc/cnama-plex.env` through systemd and also supports a local `.env` file when run manually.

```bash
HOST=0.0.0.0
PORT=8001
PUBLIC_BASE_PATH=
SQLITE_PATH=/var/lib/cnama-plex/cnama.sqlite
DOWNLOAD_TMP_DIR=/var/lib/cnama-plex/downloads
PLEX_MOVIES_DIR=/your/plex/Movies
PLEX_TV_DIR=/your/plex/TV
DOWNLOAD_CONCURRENCY=2
```
