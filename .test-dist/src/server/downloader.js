import dns from "node:dns/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";
export class DownloadManager {
    db;
    broadcast;
    active = new Map();
    pumping = false;
    constructor(db, broadcast) {
        this.db = db;
        this.broadcast = broadcast;
    }
    start() {
        fsp.mkdir(config.downloadTmpDir, { recursive: true }).catch((error) => {
            console.error("Failed to create download tmp directory", error);
        });
        this.db.resetInterruptedJobs();
        this.pump();
    }
    notifyQueueChanged() {
        this.broadcastJobs();
        this.pump();
    }
    cancel(id) {
        const current = this.db.getJob(id);
        if (!current || (current.status !== "queued" && current.status !== "running")) {
            return current;
        }
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
    retry(id) {
        const job = this.db.retryJob(id);
        this.broadcastJobs();
        this.pump();
        return job;
    }
    clearHistory(ids) {
        const result = this.db.clearHistory(ids);
        if (result.deletedIds.length > 0) {
            this.broadcastJobs();
        }
        return result;
    }
    pump() {
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
            }
            finally {
                this.pumping = false;
            }
        });
    }
    async run(job) {
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
        }
        catch (error) {
            const current = this.db.getJob(job.id);
            if (current?.status !== "canceled") {
                this.db.updateJob(job.id, {
                    status: "failed",
                    error: error instanceof Error ? error.message : "Download failed"
                });
            }
        }
        finally {
            this.active.delete(job.id);
            this.broadcastJobs();
            this.pump();
        }
    }
    async download(job, signal) {
        await assertSafeDownloadUrl(job.sourceUrl);
        if (await exists(job.destinationPath)) {
            this.db.updateJob(job.id, {
                status: "skipped",
                error: null,
                completedAt: new Date().toISOString()
            });
            return;
        }
        await ensureWritableDirectory("temporary download", path.dirname(job.tmpPath), job.tmpPath);
        await ensureWritableDirectory("Plex destination", path.dirname(job.destinationPath), job.destinationPath);
        const partialBytes = await fileSize(job.tmpPath);
        if (partialBytes === 0 && config.downloadConnections > 1) {
            const remoteInfo = await getRemoteFileInfo(job.sourceUrl, signal);
            if (remoteInfo.supportsRanges && remoteInfo.totalBytes && remoteInfo.totalBytes > 0) {
                try {
                    await this.downloadInParallel(job, signal, remoteInfo.totalBytes);
                    await moveCompletedFile(job.tmpPath, job.destinationPath);
                    return;
                }
                catch (error) {
                    if (signal.aborted) {
                        throw error;
                    }
                    await removeIfExists(job.tmpPath);
                }
            }
        }
        await this.downloadSequentially(job, signal);
        await moveCompletedFile(job.tmpPath, job.destinationPath);
    }
    async downloadSequentially(job, signal) {
        const partialBytes = await fileSize(job.tmpPath);
        const headers = {
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
            transform: (chunk, _encoding, callback) => {
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
        await pipeline(Readable.fromWeb(response.body), progress, output, { signal });
        this.db.updateJob(job.id, {
            bytesReceived: received,
            bytesTotal: totalBytes
        });
    }
    async downloadInParallel(job, signal, totalBytes) {
        await fsp.writeFile(job.tmpPath, "");
        await fsp.truncate(job.tmpPath, totalBytes);
        const progress = {
            received: 0,
            totalBytes,
            lastWrite: 0
        };
        this.db.updateJob(job.id, {
            bytesReceived: 0,
            bytesTotal: totalBytes
        });
        const rangeController = new AbortController();
        const abortRanges = () => rangeController.abort(signal.reason);
        signal.addEventListener("abort", abortRanges, { once: true });
        try {
            const ranges = splitRanges(totalBytes, config.downloadConnections);
            const downloads = ranges.map((range) => this.downloadRange(job, rangeController.signal, range, progress).catch((error) => {
                rangeController.abort(error);
                throw error;
            }));
            const results = await Promise.allSettled(downloads);
            const failed = results.find((result) => result.status === "rejected");
            if (failed) {
                throw failed.reason;
            }
        }
        finally {
            signal.removeEventListener("abort", abortRanges);
        }
        const completedBytes = await fileSize(job.tmpPath);
        if (completedBytes !== totalBytes) {
            throw new Error(`Downloaded file size mismatch: expected ${totalBytes}, got ${completedBytes}`);
        }
        this.db.updateJob(job.id, {
            bytesReceived: totalBytes,
            bytesTotal: totalBytes
        });
    }
    async downloadRange(job, signal, range, progress) {
        const response = await fetch(job.sourceUrl, {
            headers: {
                "user-agent": userAgent(),
                range: `bytes=${range.start}-${range.end}`
            },
            signal,
            redirect: "follow"
        });
        if (response.status !== 206) {
            throw new Error(`Range request failed with HTTP ${response.status} ${response.statusText}`);
        }
        if (!response.body) {
            throw new Error("Upstream response did not include a body");
        }
        const expectedBytes = range.end - range.start + 1;
        let rangeBytes = 0;
        const progressStream = new Transform({
            transform: (chunk, _encoding, callback) => {
                rangeBytes += chunk.length;
                if (rangeBytes > expectedBytes) {
                    callback(new Error("Upstream sent more bytes than requested"));
                    return;
                }
                progress.received += chunk.length;
                const now = Date.now();
                if (now - progress.lastWrite > 1000) {
                    progress.lastWrite = now;
                    const updated = this.db.updateJob(job.id, {
                        bytesReceived: progress.received,
                        bytesTotal: progress.totalBytes
                    });
                    this.broadcast({ type: "job:update", job: updated });
                }
                callback(null, chunk);
            }
        });
        const output = fs.createWriteStream(job.tmpPath, { flags: "r+", start: range.start });
        await pipeline(Readable.fromWeb(response.body), progressStream, output, { signal });
        if (rangeBytes !== expectedBytes) {
            throw new Error(`Range ${range.start}-${range.end} ended early`);
        }
    }
    broadcastJobs() {
        this.broadcast({
            type: "jobs",
            jobs: this.db.listJobs()
        });
    }
}
async function getRemoteFileInfo(sourceUrl, signal) {
    const response = await fetch(sourceUrl, {
        headers: {
            "user-agent": userAgent(),
            range: "bytes=0-0"
        },
        signal,
        redirect: "follow"
    });
    await response.body?.cancel();
    if (response.status === 206) {
        const totalBytes = parseContentRangeTotal(response.headers.get("content-range"));
        return {
            supportsRanges: totalBytes !== undefined,
            totalBytes
        };
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    return {
        supportsRanges: false,
        totalBytes: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined
    };
}
function parseContentRangeTotal(value) {
    const match = value?.match(/^bytes \d+-\d+\/(\d+)$/i);
    if (!match) {
        return undefined;
    }
    const totalBytes = Number.parseInt(match[1], 10);
    return Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : undefined;
}
function splitRanges(totalBytes, connections) {
    const rangeCount = Math.min(connections, totalBytes);
    const chunkSize = Math.ceil(totalBytes / rangeCount);
    const ranges = [];
    for (let start = 0; start < totalBytes; start += chunkSize) {
        ranges.push({
            start,
            end: Math.min(start + chunkSize - 1, totalBytes - 1)
        });
    }
    return ranges;
}
async function assertSafeDownloadUrl(rawUrl) {
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
function isPrivateAddress(address) {
    if (net.isIPv6(address)) {
        const value = address.toLowerCase();
        return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:");
    }
    const [a, b] = address.split(".").map((part) => Number.parseInt(part, 10));
    return (a === 10 ||
        a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        a === 0);
}
async function moveCompletedFile(source, destination) {
    await ensureWritableDirectory("Plex destination", path.dirname(destination), destination);
    try {
        await fsp.rename(source, destination);
    }
    catch (error) {
        if (error.code !== "EXDEV") {
            throw error;
        }
        await fsp.copyFile(source, destination);
        await fsp.unlink(source);
    }
}
async function ensureWritableDirectory(label, directory, targetPath) {
    try {
        await fsp.mkdir(directory, { recursive: true });
    }
    catch (error) {
        throw new Error(`Unable to create ${label} directory ${directory} for ${targetPath}: ${formatError(error)}. ` +
            "Ensure the app user can write to the parent directory. For Docker bind mounts, make the host " +
            "directory writable by PUID/PGID; for systemd, check ownership, group permissions, and ReadWritePaths.", { cause: error });
    }
    try {
        await fsp.access(directory, fs.constants.W_OK);
    }
    catch (error) {
        throw new Error(`${capitalize(label)} directory is not writable at ${directory} for ${targetPath}: ${formatError(error)}. ` +
            "Ensure the app user can write to this directory. For Docker bind mounts, make the host directory " +
            "writable by PUID/PGID; for systemd, check ownership, group permissions, and ReadWritePaths.", { cause: error });
    }
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
async function exists(filePath) {
    try {
        await fsp.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function fileSize(filePath) {
    try {
        const stat = await fsp.stat(filePath);
        return stat.size;
    }
    catch {
        return 0;
    }
}
async function removeIfExists(filePath) {
    try {
        await fsp.unlink(filePath);
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
}
function userAgent() {
    return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
}
