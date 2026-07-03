import path from "node:path";
import { fileURLToPath } from "node:url";
import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { AppDatabase } from "./db.js";
import { DownloadManager } from "./downloader.js";
import { buildJobsFromBatch, buildPreview } from "./naming.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(__dirname, "../client");
const app = fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });
await app.register(websocket);
const sockets = new Set();
const db = new AppDatabase();
const downloads = new DownloadManager(db, broadcast);
registerApiRoutes("");
if (config.publicBasePath) {
    registerApiRoutes(config.publicBasePath);
    app.get(config.publicBasePath, async (_request, reply) => reply.redirect(`${config.publicBasePath}/`));
}
app.get("/favicon.ico", async (_req, reply) => reply.code(204).send());
await app.register(fastifyStatic, { root: clientRoot, prefix: "/", decorateReply: true });
if (config.publicBasePath) {
    await app.register(fastifyStatic, { root: clientRoot, prefix: `${config.publicBasePath}/`, decorateReply: false });
}
app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
        reply.sendFile("index.html");
        return;
    }
    reply.code(404).send({ error: "Not found" });
});
downloads.start();
try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`CNama Plex listening on http://${config.host}:${config.port}`);
}
catch (error) {
    app.log.error(error);
    process.exit(1);
}
function broadcast(event) {
    const data = JSON.stringify(event);
    for (const socket of sockets) {
        try {
            socket.send(data);
        }
        catch {
            sockets.delete(socket);
        }
    }
}
function registerApiRoutes(prefix) {
    app.get(`${prefix}/api/health`, async () => ({ ok: true }));
    app.get(`${prefix}/ws/jobs`, { websocket: true }, (socket) => {
        sockets.add(socket);
        socket.send(JSON.stringify({ type: "jobs", jobs: db.listJobs() }));
        socket.on("close", () => sockets.delete(socket));
    });
    app.post(`${prefix}/api/detected-links/preview`, async (request, reply) => {
        const body = request.body;
        if (!Array.isArray(body.links)) {
            reply.code(400).send({ error: "links must be an array" });
            return;
        }
        return buildPreview(body.pageTitle, body.links, body.folderName);
    });
    app.post(`${prefix}/api/download-batches`, async (request, reply) => {
        const body = request.body;
        if (!isMediaType(body.mediaType)) {
            reply.code(400).send({ error: "mediaType must be movie or series" });
            return;
        }
        if (!body.title || !Array.isArray(body.links)) {
            reply.code(400).send({ error: "title and links are required" });
            return;
        }
        const batch = {
            sourcePageUrl: body.sourcePageUrl,
            pageTitle: body.pageTitle,
            title: body.title,
            folderName: body.folderName,
            year: body.year,
            mediaType: body.mediaType,
            season: body.season,
            links: body.links,
        };
        const jobs = buildJobsFromBatch(batch);
        if (jobs.length === 0) {
            reply.code(400).send({ error: "No valid links to download" });
            return;
        }
        const batchId = db.createBatch(batch.title, batch.mediaType, jobs);
        downloads.notifyQueueChanged();
        reply.code(201).send({ batchId, jobs: db.listJobs().filter((j) => j.batchId === batchId) });
    });
    app.get(`${prefix}/api/jobs`, async () => ({ jobs: db.listJobs() }));
    app.post(`${prefix}/api/jobs/history/clear`, async (request, reply) => {
        const body = request.body;
        if (!Array.isArray(body.ids)) {
            reply.code(400).send({ error: "ids must be an array of job ids" });
            return;
        }
        const ids = parseJobIds(body.ids);
        if (ids.length === 0) {
            reply.code(400).send({ error: "ids must include at least one valid job id" });
            return;
        }
        const result = downloads.clearHistory(ids);
        if (result.deletedIds.length === 0 && result.blockedIds.length > 0) {
            reply.code(409).send({ error: "Active downloads must be canceled or finished before clearing history", ...result });
            return;
        }
        if (result.deletedIds.length === 0 && result.blockedIds.length === 0) {
            reply.code(404).send({ error: "No matching jobs found", ...result });
            return;
        }
        return result;
    });
    app.post(`${prefix}/api/jobs/:id/cancel`, async (request, reply) => {
        const id = getIdParam(request.params);
        if (!id) {
            reply.code(400).send({ error: "Invalid job id" });
            return;
        }
        const job = downloads.cancel(id);
        if (!job) {
            reply.code(404).send({ error: "Job not found" });
            return;
        }
        return { job };
    });
    app.post(`${prefix}/api/jobs/:id/retry`, async (request, reply) => {
        const id = getIdParam(request.params);
        if (!id) {
            reply.code(400).send({ error: "Invalid job id" });
            return;
        }
        const job = downloads.retry(id);
        if (!job) {
            reply.code(404).send({ error: "Job not found" });
            return;
        }
        return { job };
    });
}
function isMediaType(value) {
    return value === "movie" || value === "series";
}
function getIdParam(params) {
    const id = Number.parseInt(String(params.id), 10);
    return Number.isFinite(id) && id > 0 ? id : undefined;
}
function parseJobIds(value) {
    const ids = value
        .map((id) => (typeof id === "number" ? id : Number.parseInt(String(id), 10)))
        .filter((id) => Number.isInteger(id) && id > 0);
    return [...new Set(ids)];
}
