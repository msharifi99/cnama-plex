import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
loadDotEnv(path.join(cwd, ".env"));

function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePath(value: string | undefined, fallback: string): string {
  return path.resolve(cwd, value ?? fallback);
}

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === "/") {
    return "";
  }
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/g, "");
}

function loadDotEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    process.env[key] ??= value;
  }
}

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: envInt("PORT", 8001),
  upstreamOrigin: process.env.UPSTREAM_ORIGIN ?? "https://30nama.com",
  sqlitePath: resolvePath(process.env.SQLITE_PATH, "./data/cnama.sqlite"),
  downloadTmpDir: resolvePath(process.env.DOWNLOAD_TMP_DIR, "./data/downloads"),
  plexMoviesDir: resolvePath(process.env.PLEX_MOVIES_DIR, "./data/plex/Movies"),
  plexTvDir: resolvePath(process.env.PLEX_TV_DIR, "./data/plex/TV"),
  downloadConcurrency: envInt("DOWNLOAD_CONCURRENCY", 2),
  publicBasePath: normalizeBasePath(process.env.PUBLIC_BASE_PATH)
};
