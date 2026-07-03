import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cnama-plex-"));
const moviesDir = path.join(root, "Movies");
const tvDir = path.join(root, "TV");
fs.mkdirSync(path.join(moviesDir, "Dune (2021)"), { recursive: true });
fs.mkdirSync(path.join(tvDir, "Better Call Saul"), { recursive: true });
process.env.PLEX_MOVIES_DIR = moviesDir;
process.env.PLEX_TV_DIR = tvDir;
const { buildJobsFromBatch, buildPreview } = await import("../src/server/naming.js");
test("preview reuses an existing series folder when the title is a normalized match", () => {
    const preview = buildPreview("Better_Call_Saul - 30nama download", [
        { url: "https://example.com/better-call-saul-s01e01.mp4" }
    ]);
    assert.equal(preview.title, "Better Call Saul");
    assert.equal(preview.matchedFolderName, "Better Call Saul");
    assert.equal(preview.items[0]?.destinationPath, path.join(tvDir, "Better Call Saul", "Season 01", "Better Call Saul - s01e01.mp4"));
});
test("preview reuses a single high-confidence fuzzy folder match", () => {
    const preview = buildPreview("Better Call Saull", [
        { url: "https://example.com/better-call-saul-s01e01.mp4" }
    ]);
    assert.equal(preview.title, "Better Call Saul");
    assert.equal(preview.matchedFolderName, "Better Call Saul");
    assert.deepEqual(preview.folderCandidates, []);
});
test("preview reuses an existing movie folder and keeps the folder year", () => {
    const preview = buildPreview("Dune 2021 download", [
        { url: "https://example.com/dune.mp4" }
    ]);
    assert.equal(preview.title, "Dune");
    assert.equal(preview.year, "2021");
    assert.equal(preview.matchedFolderName, "Dune (2021)");
    assert.equal(preview.items[0]?.destinationPath, path.join(moviesDir, "Dune (2021)", "Dune (2021).mp4"));
});
test("preview offers ambiguous existing movie folders without auto-matching until the year disambiguates", () => {
    fs.mkdirSync(path.join(moviesDir, "Dune (1984)"), { recursive: true });
    const ambiguous = buildPreview("Dune", [
        { url: "https://example.com/dune.mp4" }
    ]);
    assert.equal(ambiguous.matchedFolderName, undefined);
    assert.deepEqual(ambiguous.folderCandidates, ["Dune (1984)", "Dune (2021)"]);
    const disambiguated = buildPreview("Dune 2021", [
        { url: "https://example.com/dune.mp4" }
    ]);
    assert.equal(disambiguated.matchedFolderName, "Dune (2021)");
    assert.deepEqual(disambiguated.folderCandidates, []);
});
test("queued jobs use the user-selected existing folder name", () => {
    const jobs = buildJobsFromBatch({
        title: "Dune",
        folderName: "Dune (1984)",
        mediaType: "movie",
        links: [{ url: "https://example.com/dune.mp4" }]
    });
    assert.equal(jobs[0]?.destinationPath, path.join(moviesDir, "Dune (1984)", "Dune (1984).mp4"));
});
test("preview infers the season from SxxExx episode links", () => {
    const preview = buildPreview("Better Call Saul", [
        { url: "https://example.com/better-call-saul-s02e03.mkv" }
    ]);
    assert.equal(preview.season, 2);
    assert.equal(preview.items[0]?.episode, 3);
    assert.equal(preview.items[0]?.destinationPath, path.join(tvDir, "Better Call Saul", "Season 02", "Better Call Saul - s02e03.mkv"));
});
test("preview infers a clean series title from the first pasted filename", () => {
    const preview = buildPreview(undefined, [
        { url: "https://example.com/Better.Call.Saul.S02E03.1080p.WEB-DL.mkv" }
    ]);
    assert.equal(preview.title, "Better Call Saul");
    assert.equal(preview.matchedFolderName, "Better Call Saul");
    assert.equal(preview.items[0]?.destinationPath, path.join(tvDir, "Better Call Saul", "Season 02", "Better Call Saul - s02e03.mkv"));
});
test("queued jobs coerce JSON form season and episode values to numbers", () => {
    const jobs = buildJobsFromBatch({
        title: "Better Call Saul",
        mediaType: "series",
        season: "2",
        links: [{ url: "https://example.com/better-call-saul-s02e03.mkv", episode: "3" }]
    });
    assert.equal(jobs[0]?.season, 2);
    assert.equal(jobs[0]?.episode, 3);
    assert.equal(jobs[0]?.destinationPath, path.join(tvDir, "Better Call Saul", "Season 02", "Better Call Saul - s02e03.mkv"));
});
test("queued jobs preserve edited episodes after URL normalization", () => {
    const jobs = buildJobsFromBatch({
        title: "Better Call Saul",
        mediaType: "series",
        season: 2,
        links: [{ url: " https://example.com/better-call-saul-s02e03.mkv ", episode: 4 }]
    });
    assert.equal(jobs[0]?.episode, 4);
    assert.equal(jobs[0]?.destinationPath, path.join(tvDir, "Better Call Saul", "Season 02", "Better Call Saul - s02e04.mkv"));
});
test("preview removes empty year parentheses from new movie titles", () => {
    const preview = buildPreview("Arrival (2016)", [
        { url: "https://example.com/arrival.mkv" }
    ]);
    assert.equal(preview.title, "Arrival");
    assert.equal(preview.year, "2016");
    assert.equal(preview.items[0]?.destinationPath, path.join(moviesDir, "Arrival (2016)", "Arrival (2016).mkv"));
});
