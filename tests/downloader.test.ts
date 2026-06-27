import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cnama-plex-downloader-"));

process.env.SQLITE_PATH = path.join(root, "cnama.sqlite");
process.env.DOWNLOAD_TMP_DIR = path.join(root, "downloads");
process.env.PLEX_MOVIES_DIR = path.join(root, "Movies");
process.env.PLEX_TV_DIR = path.join(root, "TV");

const { AppDatabase } = await import("../src/server/db.js");
const { DownloadManager } = await import("../src/server/downloader.js");

test("cancel leaves completed jobs unchanged", () => {
  const db = new AppDatabase();
  const broadcasts: unknown[] = [];
  const downloads = new DownloadManager(db, (event) => broadcasts.push(event));
  const batchId = db.createBatch("Dune", "movie", [
    {
      sourceUrl: "https://example.com/dune.mkv",
      mediaType: "movie",
      title: "Dune",
      destinationPath: path.join(root, "Movies", "Dune", "Dune.mkv"),
      tmpPath: path.join(root, "downloads", "dune.part")
    }
  ]);
  const job = db.listJobs().find((item) => item.batchId === batchId);
  assert.ok(job);

  db.updateJob(job.id, { status: "completed", completedAt: new Date().toISOString() });

  const result = downloads.cancel(job.id);

  assert.equal(result?.status, "completed");
  assert.equal(db.getJob(job.id)?.status, "completed");
});
