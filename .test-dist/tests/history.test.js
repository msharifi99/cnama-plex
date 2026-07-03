import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const { AppDatabase } = await import("../src/server/db.js");
const { DownloadManager } = await import("../src/server/downloader.js");
test("clearing completed history leaves the downloaded file in place", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cnama-plex-history-"));
    const db = new AppDatabase(path.join(root, "cnama.sqlite"));
    const downloads = new DownloadManager(db, () => undefined);
    const destinationPath = path.join(root, "Movies", "Dune", "Dune.mkv");
    try {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.writeFileSync(destinationPath, "finished");
        const batchId = db.createBatch("Dune", "movie", [
            {
                sourceUrl: "https://example.com/dune.mkv",
                mediaType: "movie",
                title: "Dune",
                destinationPath,
                tmpPath: path.join(root, "downloads", "dune.part")
            }
        ]);
        const job = db.listJobs().find((item) => item.batchId === batchId);
        assert.ok(job);
        db.updateJob(job.id, { status: "completed", completedAt: new Date().toISOString() });
        const result = downloads.clearHistory([job.id]);
        assert.deepEqual(result.deletedIds, [job.id]);
        assert.deepEqual(result.blockedIds, []);
        assert.equal(db.getJob(job.id), undefined);
        assert.equal(fs.readFileSync(destinationPath, "utf8"), "finished");
    }
    finally {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
test("clearing history refuses active jobs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cnama-plex-history-active-"));
    const db = new AppDatabase(path.join(root, "cnama.sqlite"));
    const downloads = new DownloadManager(db, () => undefined);
    try {
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
        db.updateJob(job.id, { status: "running" });
        const result = downloads.clearHistory([job.id]);
        assert.deepEqual(result.deletedIds, []);
        assert.deepEqual(result.blockedIds, [job.id]);
        assert.equal(db.getJob(job.id)?.status, "running");
    }
    finally {
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
