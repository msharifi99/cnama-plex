import dns from "node:dns/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
import { AppDatabase } from "./db.js";
import type { JobRecord } from "./types.js";

type Broadcast = (event: unknown) => void;

export class DownloadManager {
  private readonly active = new Map<number, AbortController>();
  private pumping = false;

  constructor(
    private readonly db: AppDatabase,
    private readonly broadcast: Broadcast
  ) {}

  start(): void {
    fsp.mkdir(config.downloadTmpDir, { recursive: true }).catch((error) => {
      console.error("Failed to create download tmp directory", error);
    });
    this.db.resetInterruptedJobs();
    this.pump();
  }

  notifyQueueChanged(): void {
    this.broadcastJobs();
    this.pump();
  }

  cancel(id: number): JobRecord | undefined {
    const controller = this.active.get(id);
    const job = this.db.updateJob(id, {
      status: "canceled",
      error: null,
      completedAt: new Date().toISOString()
    });

    if (controller) {
      controller.abort();
    }

    this.broadcastJobs();
    this.pump();
    return job;
  }

  retry(id: number): JobRecord | undefined {
    const job = this.db.retryJob(id);
    this.broadcastJobs();
    this.pump();
    return job;
  }

  private pump(): void {
    if (this.pumping) {
      return;
    }

    this.pumping = true;
    queueMicrotask(() => {
      try {
        while (this.active.size < config.downloadConcurrency) {
          const job = this.db.nextQueuedJob();
          if (!job) {
            break;
          }
          void this.run(job);
        }
      } finally {
        this.pumping = false;
      }
    });
  }

  private async run(job: JobRecord): Promise<void> {
    const controller = new AbortController();
    this.active.set(job.id, controller);
    this.db.updateJob(job.id, { status: "running", error: null });
    this.broadcastJobs();

    try {
      await this.download(job, controller.signal);
      const finalJob = this.db.getJob(job.id);
      if (finalJob?.status !== "skipped") {
        this.db.updateJob(job.id, {
          status: "completed",
          error: null,
          completedAt: new Date().toISOString()
        });
      }
    } catch (error) {
      const current = this.db.getJob(job.id);
      if (current?.status !== "canceled") {
        this.db.updateJob(job.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "Download failed"
        });
      }
    } finally {
      this.active.delete(job.id);
      this.broadcastJobs();
      this.pump();
    }
  }

  private async download(job: JobRecord, signal: AbortSignal): Promise<void> {
    await assertSafeDownloadUrl(job.sourceUrl);

    if (await exists(job.destinationPath)) {
      this.db.updateJob(job.id, {
        status: "skipped",
        error: null,
        completedAt: new Date().toISOString()
      });
      return;
    }

    await fsp.mkdir(path.dirname(job.tmpPath), { recursive: true });
    await fsp.mkdir(path.dirname(job.destinationPath), { recursive: true });

    const partialBytes = await fileSize(job.tmpPath);
    const headers: Record<string, string> = {
      "user-agent": userAgent()
    };
    if (partialBytes > 0) {
      headers.range = `bytes=${partialBytes}-`;
    }

    const response = await fetch(job.sourceUrl, {
      headers,
      signal,
      redirect: "follow"
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error("Upstream response did not include a body");
    }

    const shouldAppend = partialBytes > 0 && response.status === 206;
    const startBytes = shouldAppend ? partialBytes : 0;
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? startBytes + contentLength : undefined;
    let received = startBytes;
    let lastWrite = 0;

    this.db.updateJob(job.id, {
      bytesReceived: received,
      bytesTotal: totalBytes
    });

    const progress = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastWrite > 1000) {
          lastWrite = now;
          const updated = this.db.updateJob(job.id, {
            bytesReceived: received,
            bytesTotal: totalBytes
          });
          this.broadcast({ type: "job:update", job: updated });
        }
        callback(null, chunk);
      }
    });

    const output = fs.createWriteStream(job.tmpPath, { flags: shouldAppend ? "a" : "w" });
    await pipeline(Readable.fromWeb(response.body as never), progress, output, { signal });

    this.db.updateJob(job.id, {
      bytesReceived: received,
      bytesTotal: totalBytes
    });
    await moveCompletedFile(job.tmpPath, job.destinationPath);
  }

  private broadcastJobs(): void {
    this.broadcast({
      type: "jobs",
      jobs: this.db.listJobs()
    });
  }
}

async function assertSafeDownloadUrl(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS downloads are allowed");
  }

  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true });

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new Error(`Refusing to download from private address ${entry.address}`);
    }
  }
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
  }

  const [a, b] = address.split(".").map((part) => Number.parseInt(part, 10));
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

async function moveCompletedFile(source: string, destination: string): Promise<void> {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fsp.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    await fsp.copyFile(source, destination);
    await fsp.unlink(source);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

function userAgent(): string {
  return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
}
