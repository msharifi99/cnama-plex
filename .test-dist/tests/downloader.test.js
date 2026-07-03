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
    const broadcasts = [];
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
test("downloads report unwritable destination directories clearly", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
    const testRoot = fs.mkdtempSync(path.join("/tmp", "cnama-plex-downloader-perms-"));
    const libraryRoot = path.join(testRoot, "Movies");
    fs.mkdirSync(libraryRoot);
    fs.chmodSync(libraryRoot, 0o555);
    const db = new AppDatabase(path.join(testRoot, "cnama.sqlite"));
    const downloads = new DownloadManager(db, () => undefined);
    const batchId = db.createBatch("Dune", "movie", [
        {
            sourceUrl: "http://93.184.216.34/dune.mkv",
            mediaType: "movie",
            title: "Dune",
            destinationPath: path.join(libraryRoot, "Dune", "Dune.mkv"),
            tmpPath: path.join(root, "downloads", "dune-perms.part")
        }
    ]);
    const job = db.listJobs().find((item) => item.batchId === batchId);
    assert.ok(job);
    try {
        await assert.rejects(() => downloads.download(job, new AbortController().signal), /Unable to create Plex destination directory .*Dune.*Ensure the app user can write/);
    }
    finally {
        db.close();
        fs.chmodSync(libraryRoot, 0o755);
        fs.rmSync(testRoot, { recursive: true, force: true });
    }
});
