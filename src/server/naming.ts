import path from "node:path";
import { config } from "./config.js";
import type { CreateBatchRequest, DetectedLink, MediaType, PreviewResponse } from "./types.js";

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

export function normalizeLinks(links: DetectedLink[]): DetectedLink[] {
  const seen = new Map<string, DetectedLink>();

  for (const item of links) {
    const raw = item.url.trim();
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
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

export function buildPreview(pageTitle: string | undefined, links: DetectedLink[]): PreviewResponse {
  const normalized = normalizeLinks(links);
  const inferred = inferTitle(pageTitle, normalized);
  const mediaType = inferMediaType(inferred.title, normalized);
  const season = inferSeason(inferred.title, normalized) ?? 1;

  return {
    title: inferred.title,
    year: inferred.year,
    mediaType,
    season,
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
          title: inferred.title,
          year: inferred.year,
          season,
          episode,
          extension
        })
      };
    })
  };
}

export function buildJobsFromBatch(batch: CreateBatchRequest): Array<{
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
}> {
  const title = cleanTitle(batch.title || batch.pageTitle || "Untitled");
  const selectedInput = batch.links.filter((link) => link.selected !== false);
  const selectedLinks = normalizeLinks(selectedInput);
  const originalByUrl = new Map(selectedInput.map((link) => [link.url, link]));
  const season = batch.mediaType === "series" ? batch.season ?? 1 : undefined;

  return selectedLinks.map((link, index) => {
    const original = originalByUrl.get(link.url);
    const episode = batch.mediaType === "series" ? original?.episode ?? inferEpisode(link, index + 1) : undefined;
    const extension = guessExtension(link.url);
    const destinationPath = buildDestinationPath({
      mediaType: batch.mediaType,
      title,
      year: batch.year,
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
      year: batch.year,
      season,
      episode,
      destinationPath,
      tmpPath
    };
  });
}

export function guessExtension(rawUrl: string): string {
  try {
    const pathname = new URL(rawUrl).pathname;
    const ext = path.extname(decodeURIComponent(pathname)).toLowerCase();
    if (MEDIA_EXTENSIONS.has(ext)) {
      return ext;
    }
  } catch {
    return ".mp4";
  }

  return ".mp4";
}

function buildDestinationPath(input: {
  mediaType: MediaType;
  title: string;
  year?: string;
  season?: number;
  episode?: number;
  extension: string;
}): string {
  const title = safeSegment(input.title);
  const yearSuffix = input.year ? ` (${input.year})` : "";

  if (input.mediaType === "movie") {
    const folder = `${title}${yearSuffix}`;
    return path.join(config.plexMoviesDir, folder, `${folder}${input.extension}`);
  }

  const season = input.season ?? 1;
  const episode = input.episode ?? 1;
  const seasonFolder = `Season ${pad2(season)}`;
  const file = `${title} - s${pad2(season)}e${pad2(episode)}${input.extension}`;
  return path.join(config.plexTvDir, title, seasonFolder, file);
}

function inferTitle(pageTitle: string | undefined, links: DetectedLink[]): { title: string; year?: string } {
  const firstLabel = links.find((link) => link.label)?.label;
  const raw = pageTitle || firstLabel || "Untitled";
  const year = raw.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  const title = cleanTitle(raw.replace(/\b(19\d{2}|20\d{2})\b/g, ""));
  return { title, year };
}

function inferMediaType(title: string, links: DetectedLink[]): MediaType {
  const text = `${title} ${links.map((link) => `${link.label ?? ""} ${link.url}`).join(" ")}`;
  if (/\bs\d{1,2}e\d{1,3}\b/i.test(text) || /\bseason\b/i.test(text) || links.length > 1) {
    return "series";
  }
  return "movie";
}

function inferSeason(title: string, links: DetectedLink[]): number | undefined {
  const text = `${title} ${links.map((link) => `${link.label ?? ""} ${link.url}`).join(" ")}`;
  const match = text.match(/\bs(?:eason)?\s*0?(\d{1,2})\b/i);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function inferEpisode(link: DetectedLink, fallback: number): number {
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

function cleanTitle(value: string): string {
  return (
    value
      .replace(/\b30nama\b/gi, "")
      .replace(/\bdownload\b/gi, "")
      .replace(/[|_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Untitled"
  );
}

function safeSegment(value: string): string {
  return cleanTitle(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim() || "Untitled";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
