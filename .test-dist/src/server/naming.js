import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";
const MEDIA_EXTENSIONS = new Set([
    ".mp4",
    ".mkv",
    ".avi",
    ".mov",
    ".m4v",
    ".webm",
    ".wmv",
    ".srt",
    ".ass",
    ".ssa",
    ".sub",
    ".zip",
    ".rar"
]);
export function normalizeLinks(links) {
    const seen = new Map();
    for (const item of links) {
        const raw = item.url.trim();
        let url;
        try {
            url = new URL(raw);
        }
        catch {
            continue;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            continue;
        }
        const normalized = url.toString();
        if (!seen.has(normalized)) {
            seen.set(normalized, {
                url: normalized,
                label: item.label?.trim() || undefined
            });
        }
    }
    return [...seen.values()];
}
export function buildPreview(pageTitle, links, folderName) {
    const normalized = normalizeLinks(links);
    const inferred = inferTitle(pageTitle, normalized);
    const mediaType = inferMediaType(inferred.title, normalized);
    const folderMatch = resolveFolderMatch(inferred.title, inferred.year, mediaType, folderName);
    const season = inferSeason(inferred.title, normalized) ?? 1;
    const title = folderMatch.title ?? inferred.title;
    const year = folderMatch.year ?? inferred.year;
    return {
        title,
        year,
        mediaType,
        season,
        libraryPaths: {
            movie: config.plexMoviesDir,
            series: config.plexTvDir
        },
        matchedFolderName: folderMatch.matchedFolderName,
        folderCandidates: folderMatch.folderCandidates,
        items: normalized.map((link, index) => {
            const episode = mediaType === "series" ? inferEpisode(link, index + 1) : undefined;
            const extension = guessExtension(link.url);
            return {
                ...link,
                id: `${index}-${stableId(link.url)}`,
                selected: true,
                episode,
                extension,
                destinationPath: buildDestinationPath({
                    mediaType,
                    title,
                    folderName: folderMatch.matchedFolderName,
                    year,
                    season,
                    episode,
                    extension
                })
            };
        })
    };
}
export function buildJobsFromBatch(batch) {
    const title = cleanTitle(batch.title || batch.pageTitle || "Untitled");
    const folderMatch = batch.folderName
        ? { matchedFolderName: batch.folderName, year: batch.year }
        : resolveFolderMatch(title, batch.year, batch.mediaType);
    const year = folderMatch.year ?? batch.year;
    const selectedInput = batch.links.filter((link) => link.selected !== false);
    const selectedLinks = normalizeLinks(selectedInput);
    const originalByUrl = new Map();
    for (const input of selectedInput) {
        const [normalized] = normalizeLinks([input]);
        if (normalized && !originalByUrl.has(normalized.url)) {
            originalByUrl.set(normalized.url, input);
        }
    }
    const requestedSeason = toPositiveInteger(batch.season);
    const season = batch.mediaType === "series" ? requestedSeason ?? 1 : undefined;
    return selectedLinks.map((link, index) => {
        const original = originalByUrl.get(link.url);
        const requestedEpisode = toPositiveInteger(original?.episode);
        const episode = batch.mediaType === "series" ? requestedEpisode ?? inferEpisode(link, index + 1) : undefined;
        const extension = guessExtension(link.url);
        const destinationPath = buildDestinationPath({
            mediaType: batch.mediaType,
            title,
            folderName: folderMatch.matchedFolderName,
            year,
            season,
            episode,
            extension
        });
        const tmpPath = path.join(config.downloadTmpDir, `${stableId(link.url)}${extension}.part`);
        return {
            sourceUrl: link.url,
            sourcePageUrl: batch.sourcePageUrl,
            label: link.label,
            mediaType: batch.mediaType,
            title,
            year,
            season,
            episode,
            destinationPath,
            tmpPath
        };
    });
}
export function guessExtension(rawUrl) {
    try {
        const pathname = new URL(rawUrl).pathname;
        const ext = path.extname(decodeURIComponent(pathname)).toLowerCase();
        if (MEDIA_EXTENSIONS.has(ext)) {
            return ext;
        }
    }
    catch {
        return ".mp4";
    }
    return ".mp4";
}
function buildDestinationPath(input) {
    const title = safeSegment(input.title);
    const folderTitle = input.folderName ? safeSegment(input.folderName) : title;
    const yearSuffix = input.year ? ` (${input.year})` : "";
    if (input.mediaType === "movie") {
        const folder = input.folderName ? folderTitle : `${title}${yearSuffix}`;
        return path.join(config.plexMoviesDir, folder, `${folder}${input.extension}`);
    }
    const season = input.season ?? 1;
    const episode = input.episode ?? 1;
    const seasonFolder = `Season ${pad2(season)}`;
    const file = `${title} - s${pad2(season)}e${pad2(episode)}${input.extension}`;
    return path.join(config.plexTvDir, folderTitle, seasonFolder, file);
}
function resolveFolderMatch(title, year, mediaType, preferredFolderName) {
    const folders = listLibraryFolders(mediaType);
    if (preferredFolderName) {
        const preferred = folders.find((folder) => folder.name === preferredFolderName);
        if (preferred) {
            return {
                title: preferred.title,
                year: mediaType === "movie" ? preferred.year ?? year : year,
                matchedFolderName: preferred.name,
                folderCandidates: []
            };
        }
    }
    const normalizedTitle = normalizeTitleForMatch(title);
    let exactMatches = folders.filter((folder) => normalizeTitleForMatch(folder.name) === normalizedTitle);
    if (mediaType === "movie" && year) {
        const yearMatches = exactMatches.filter((folder) => folder.year === year);
        if (yearMatches.length > 0) {
            exactMatches = yearMatches;
        }
    }
    if (exactMatches.length === 1) {
        const match = exactMatches[0];
        return {
            title: match.title,
            year: mediaType === "movie" ? match.year ?? year : year,
            matchedFolderName: match.name,
            folderCandidates: []
        };
    }
    if (exactMatches.length > 1) {
        return { folderCandidates: exactMatches.map((folder) => folder.name).sort((a, b) => a.localeCompare(b)) };
    }
    const fuzzyMatches = folders
        .map((folder) => ({
        folder,
        score: similarity(normalizedTitle, normalizeTitleForMatch(folder.name))
    }))
        .filter((match) => match.score >= 0.92)
        .sort((a, b) => b.score - a.score);
    const best = fuzzyMatches[0];
    const second = fuzzyMatches[1];
    if (best && (!second || best.score - second.score >= 0.04)) {
        return {
            title: best.folder.title,
            year: mediaType === "movie" ? best.folder.year ?? year : year,
            matchedFolderName: best.folder.name,
            folderCandidates: []
        };
    }
    return { folderCandidates: fuzzyMatches.map((match) => match.folder.name).sort((a, b) => a.localeCompare(b)) };
}
function listLibraryFolders(mediaType) {
    const libraryDir = mediaType === "movie" ? config.plexMoviesDir : config.plexTvDir;
    try {
        return fs.readdirSync(libraryDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
            const parsed = parseFolderTitle(entry.name);
            return { name: entry.name, title: parsed.title, year: parsed.year };
        });
    }
    catch {
        return [];
    }
}
function parseFolderTitle(value) {
    const year = value.match(/\((19\d{2}|20\d{2})\)\s*$/)?.[1];
    const title = year ? value.replace(/\s*\((19\d{2}|20\d{2})\)\s*$/, "") : value;
    return { title: cleanTitle(title), year };
}
function normalizeTitleForMatch(value) {
    return cleanTitle(value)
        .replace(/\b(19\d{2}|20\d{2})\b/g, "")
        .replace(/\b(?:480p|720p|1080p|2160p|4k|uhd|hdr|webrip|webdl|bluray|brrip|x264|x265|h264|h265|hevc|aac)\b/gi, "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}
function similarity(left, right) {
    if (left === right) {
        return 1;
    }
    const longest = Math.max(left.length, right.length);
    if (longest === 0) {
        return 1;
    }
    return 1 - levenshteinDistance(left, right) / longest;
}
function levenshteinDistance(left, right) {
    let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
        const current = [leftIndex + 1];
        for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
            const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
            current[rightIndex + 1] = Math.min(current[rightIndex] + 1, previous[rightIndex + 1] + 1, previous[rightIndex] + cost);
        }
        previous = current;
    }
    return previous[right.length];
}
function inferTitle(pageTitle, links) {
    const firstLabel = links.find((link) => link.label)?.label;
    const filenameTitle = links.map((link) => titleFromUrl(link.url)).find((title) => title);
    const raw = pageTitle || firstLabel || filenameTitle || "Untitled";
    const releaseTitle = cleanReleaseTitle(raw);
    const year = raw.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
    const title = cleanTitle(releaseTitle.replace(/\b(19\d{2}|20\d{2})\b/g, ""));
    return { title, year };
}
function titleFromUrl(rawUrl) {
    try {
        const pathname = decodeURIComponent(new URL(rawUrl).pathname);
        const filename = path.basename(pathname);
        const extension = path.extname(filename);
        return extension ? filename.slice(0, -extension.length) : filename;
    }
    catch {
        return undefined;
    }
}
function cleanReleaseTitle(value) {
    return value
        .replace(/\bs\d{1,2}e\d{1,3}\b/gi, " ")
        .replace(/\b(?:episode|ep)\s*\d{1,3}\b/gi, " ")
        .replace(/\bseason\s*\d{1,2}\b/gi, " ")
        .replace(/\b(?:480p|720p|1080p|2160p|4k|uhd|hdr|webrip|webdl|web-dl|bluray|brrip|x264|x265|h264|h265|hevc|aac)\b/gi, " ")
        .replace(/[.]+/g, " ");
}
function inferMediaType(title, links) {
    const text = `${title} ${links.map((link) => `${link.label ?? ""} ${link.url}`).join(" ")}`;
    if (/\bs\d{1,2}e\d{1,3}\b/i.test(text) || /\bseason\b/i.test(text) || links.length > 1) {
        return "series";
    }
    return "movie";
}
function inferSeason(title, links) {
    const text = `${title} ${links.map((link) => `${link.label ?? ""} ${link.url}`).join(" ")}`;
    const sxe = text.match(/\bs0?(\d{1,2})e\d{1,3}\b/i);
    if (sxe) {
        return Number.parseInt(sxe[1], 10);
    }
    const match = text.match(/\bs(?:eason)?\s*0?(\d{1,2})\b/i);
    return match ? Number.parseInt(match[1], 10) : undefined;
}
function inferEpisode(link, fallback) {
    const text = `${link.label ?? ""} ${link.url}`;
    const sxe = text.match(/\bs\d{1,2}e0?(\d{1,3})\b/i);
    if (sxe) {
        return Number.parseInt(sxe[1], 10);
    }
    const episode = text.match(/\b(?:episode|ep|e)\s*0?(\d{1,3})\b/i);
    if (episode) {
        return Number.parseInt(episode[1], 10);
    }
    return fallback;
}
function cleanTitle(value) {
    return (value
        .replace(/\b30nama\b/gi, "")
        .replace(/\bdownload\b/gi, "")
        .replace(/\(\s*\)/g, " ")
        .replace(/[|_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim() || "Untitled");
}
function safeSegment(value) {
    return cleanTitle(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim() || "Untitled";
}
function pad2(value) {
    return String(value).padStart(2, "0");
}
function toPositiveInteger(value) {
    if (typeof value !== "number" && typeof value !== "string") {
        return undefined;
    }
    const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function stableId(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}
