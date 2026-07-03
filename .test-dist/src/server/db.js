import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
const REMOVABLE_JOB_STATUSES = new Set(["completed", "failed", "canceled", "skipped"]);
export class AppDatabase {
    db;
    constructor(sqlitePath = config.sqlitePath) {
        prepareSqlitePath(sqlitePath);
        this.db = openDatabase(sqlitePath);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA foreign_keys = ON");
        this.migrate();
    }
    close() {
        this.db.close();
    }
    createBatch(title, mediaType, jobs) {
        const batchId = randomUUID();
        const now = new Date().toISOString();
        const tx = this.db.prepare(`
      INSERT INTO batches (id, title, media_type, created_at)
      VALUES (?, ?, ?, ?)
    `);
        const insertJob = this.db.prepare(`
      INSERT INTO jobs (
        batch_id, source_url, source_page_url, label, media_type, title, year,
        season, episode, destination_path, tmp_path, status, error,
        bytes_received, bytes_total, created_at, updated_at, completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, NULL, ?, ?, NULL)
    `);
        this.db.exec("BEGIN");
        try {
            tx.run(batchId, title, mediaType, now);
            for (const job of jobs) {
                insertJob.run(batchId, job.sourceUrl, job.sourcePageUrl ?? null, job.label ?? null, job.mediaType, job.title, job.year ?? null, job.season ?? null, job.episode ?? null, job.destinationPath, job.tmpPath, now, now);
            }
            this.db.exec("COMMIT");
            return batchId;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    listJobs(limit = 200) {
        const rows = this.db
            .prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?")
            .all(limit);
        return rows.map(mapJob);
    }
    getJob(id) {
        const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
        return row ? mapJob(row) : undefined;
    }
    nextQueuedJob() {
        const row = this.db
            .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
            .get();
        return row ? mapJob(row) : undefined;
    }
    resetInterruptedJobs() {
        const now = new Date().toISOString();
        this.db
            .prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'")
            .run(now);
    }
    updateJob(id, patch) {
        const current = this.getJob(id);
        if (!current) {
            return undefined;
        }
        const next = {
            status: patch.status ?? current.status,
            error: patch.error === undefined ? current.error : patch.error ?? undefined,
            bytesReceived: patch.bytesReceived ?? current.bytesReceived,
            bytesTotal: patch.bytesTotal ?? current.bytesTotal,
            completedAt: patch.completedAt === undefined ? current.completedAt : patch.completedAt
        };
        this.db
            .prepare(`
        UPDATE jobs
        SET status = ?, error = ?, bytes_received = ?, bytes_total = ?,
            updated_at = ?, completed_at = ?
        WHERE id = ?
      `)
            .run(next.status, next.error ?? null, next.bytesReceived, next.bytesTotal ?? null, new Date().toISOString(), next.completedAt ?? null, id);
        return this.getJob(id);
    }
    retryJob(id) {
        const job = this.getJob(id);
        if (!job || (job.status !== "failed" && job.status !== "canceled")) {
            return job;
        }
        return this.updateJob(id, {
            status: "queued",
            error: null,
            bytesReceived: 0,
            bytesTotal: undefined,
            completedAt: undefined
        });
    }
    clearHistory(ids) {
        const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
        if (uniqueIds.length === 0) {
            return { deletedIds: [], blockedIds: [], missingIds: [] };
        }
        const placeholders = uniqueIds.map(() => "?").join(", ");
        const rows = this.db
            .prepare(`SELECT id, status FROM jobs WHERE id IN (${placeholders})`)
            .all(...uniqueIds);
        const foundIds = new Set(rows.map((row) => row.id));
        const deletedIds = rows.filter((row) => REMOVABLE_JOB_STATUSES.has(row.status)).map((row) => row.id);
        const blockedIds = rows.filter((row) => !REMOVABLE_JOB_STATUSES.has(row.status)).map((row) => row.id);
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        if (deletedIds.length > 0) {
            const deletePlaceholders = deletedIds.map(() => "?").join(", ");
            this.db.exec("BEGIN");
            try {
                this.db.prepare(`DELETE FROM jobs WHERE id IN (${deletePlaceholders})`).run(...deletedIds);
                this.db.prepare("DELETE FROM batches WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.batch_id = batches.id)").run();
                this.db.exec("COMMIT");
            }
            catch (error) {
                this.db.exec("ROLLBACK");
                throw error;
            }
        }
        return { deletedIds, blockedIds, missingIds };
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        media_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        source_url TEXT NOT NULL,
        source_page_url TEXT,
        label TEXT,
        media_type TEXT NOT NULL,
        title TEXT NOT NULL,
        year TEXT,
        season INTEGER,
        episode INTEGER,
        destination_path TEXT NOT NULL,
        tmp_path TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        bytes_received INTEGER NOT NULL DEFAULT 0,
        bytes_total INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_id ON jobs(status, id);
      CREATE INDEX IF NOT EXISTS idx_jobs_batch_id ON jobs(batch_id);
    `);
    }
}
function prepareSqlitePath(sqlitePath) {
    const directory = path.dirname(sqlitePath);
    try {
        fs.mkdirSync(directory, { recursive: true });
    }
    catch (error) {
        throw new Error(`Unable to create SQLite directory ${directory} for ${sqlitePath}: ${formatError(error)}`, {
            cause: error
        });
    }
    try {
        if (fs.existsSync(sqlitePath)) {
            fs.accessSync(sqlitePath, fs.constants.R_OK | fs.constants.W_OK);
        }
        else {
            fs.accessSync(directory, fs.constants.W_OK);
        }
    }
    catch (error) {
        throw new Error(`SQLite database is not writable at ${sqlitePath}. Ensure the app user can write to ${directory}. ` +
            "For Docker bind mounts, make the host data directory writable by the configured PUID/PGID.", { cause: error });
    }
}
function openDatabase(sqlitePath) {
    try {
        return new DatabaseSync(sqlitePath);
    }
    catch (error) {
        throw new Error(`Unable to open SQLite database at ${sqlitePath}: ${formatError(error)}`, { cause: error });
    }
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function mapJob(row) {
    return {
        id: row.id,
        batchId: row.batch_id,
        sourceUrl: row.source_url,
        sourcePageUrl: row.source_page_url ?? undefined,
        label: row.label ?? undefined,
        mediaType: row.media_type,
        title: row.title,
        year: row.year ?? undefined,
        season: row.season ?? undefined,
        episode: row.episode ?? undefined,
        destinationPath: row.destination_path,
        tmpPath: row.tmp_path,
        status: row.status,
        error: row.error ?? undefined,
        bytesReceived: row.bytes_received,
        bytesTotal: row.bytes_total ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at ?? undefined
    };
}
