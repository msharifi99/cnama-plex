import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import type { JobRecord, JobStatus, MediaType } from "./types.js";

type JobRow = {
  id: number;
  batch_id: string;
  source_url: string;
  source_page_url: string | null;
  label: string | null;
  media_type: MediaType;
  title: string;
  year: string | null;
  season: number | null;
  episode: number | null;
  destination_path: string;
  tmp_path: string;
  status: JobStatus;
  error: string | null;
  bytes_received: number;
  bytes_total: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type NewJobInput = {
  sourceUrl: string;
  sourcePageUrl?: string;
  label?: string;
  mediaType: MediaType;
  title: string;
  year?: string;
  season?: number;
  episode?: number;
  destinationPath: string;
  tmpPath: string;
};

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor() {
    fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
    this.db = new DatabaseSync(config.sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  createBatch(title: string, mediaType: MediaType, jobs: NewJobInput[]): string {
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
        insertJob.run(
          batchId,
          job.sourceUrl,
          job.sourcePageUrl ?? null,
          job.label ?? null,
          job.mediaType,
          job.title,
          job.year ?? null,
          job.season ?? null,
          job.episode ?? null,
          job.destinationPath,
          job.tmpPath,
          now,
          now
        );
      }
      this.db.exec("COMMIT");
      return batchId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listJobs(limit = 200): JobRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?")
      .all(limit) as JobRow[];
    return rows.map(mapJob);
  }

  getJob(id: number): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  nextQueuedJob(): JobRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
      .get() as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  resetInterruptedJobs(): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'")
      .run(now);
  }

  updateJob(
    id: number,
    patch: Partial<Pick<JobRecord, "status" | "bytesReceived" | "bytesTotal" | "completedAt">> & {
      error?: string | null;
    }
  ): JobRecord | undefined {
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
      .run(
        next.status,
        next.error ?? null,
        next.bytesReceived,
        next.bytesTotal ?? null,
        new Date().toISOString(),
        next.completedAt ?? null,
        id
      );

    return this.getJob(id);
  }

  retryJob(id: number): JobRecord | undefined {
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

  private migrate(): void {
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

function mapJob(row: JobRow): JobRecord {
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
