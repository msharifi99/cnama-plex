export type ClientMediaType = "movie" | "series";
export type ClientJobStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "skipped";

export type ClientDetectedLink = {
  url: string;
  label?: string;
};

export type ClientJobTitle = {
  mediaType: ClientMediaType;
  title: string;
  season?: number;
  episode?: number;
};

export type QueuePreview = {
  title: string;
  year?: string;
  mediaType: ClientMediaType;
  season: string | number;
  matchedFolderName?: string;
  items: Array<ClientDetectedLink & {
    selected: boolean;
    episode?: string | number;
  }>;
};

export type QueueRequest = {
  pageTitle: string;
  title: string;
  folderName?: string;
  year?: string;
  mediaType: ClientMediaType;
  season?: number;
  links: Array<ClientDetectedLink & {
    selected: boolean;
    episode?: number;
  }>;
};

export function jobTitleLine(job: ClientJobTitle): string {
  if (job.mediaType === "series" && job.season && job.episode) {
    return `${job.title} · S${pad2(job.season)}E${pad2(job.episode)}`;
  }
  if (job.mediaType === "series" && job.episode) {
    return `${job.title} · E${pad2(job.episode)}`;
  }
  return job.title;
}

export function buildQueueRequest(input: {
  pageTitle: string;
  selectedFolderName?: string;
  preview: QueuePreview;
}): QueueRequest {
  const season = input.preview.mediaType === "series" ? toPositiveInteger(input.preview.season) ?? 1 : undefined;

  return {
    pageTitle: input.pageTitle,
    title: input.preview.title,
    folderName: input.selectedFolderName ?? input.preview.matchedFolderName,
    year: input.preview.year,
    mediaType: input.preview.mediaType,
    season,
    links: input.preview.items.map((item) => ({
      url: item.url,
      label: item.label,
      selected: item.selected,
      episode: input.preview.mediaType === "series" ? toPositiveInteger(item.episode) : undefined
    }))
  };
}

export function statusLabel(status: ClientJobStatus): string {
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

export function parseLinks(text: string): ClientDetectedLink[] {
  const urlRe = /https?:\/\/[^\s"'<>]+/gi;
  const mediaRe = /\.(mp4|mkv|avi|mov|m4v|webm|wmv|srt|ass|ssa|sub|zip|rar)(?:[?&#]|$)/i;
  const seen = new Map<string, ClientDetectedLink>();

  for (const line of text.split(/\n+/)) {
    for (const match of line.matchAll(urlRe)) {
      const clean = match[0].replace(/&amp;/gi, "&").replace(/[),.;\]]+$/g, "");
      try {
        const url = new URL(clean);
        if ((url.protocol === "http:" || url.protocol === "https:") && mediaRe.test(url.pathname + url.search)) {
          const normalized = url.toString();
          if (!seen.has(normalized)) {
            seen.set(normalized, { url: normalized, label: line.trim() || undefined });
          }
        }
      } catch {
        // Ignore malformed pasted text.
      }
    }
  }

  return [...seen.values()];
}

export function formatBytes(received: number, total?: number): string {
  if (!total) return humanBytes(received);
  return `${humanBytes(received)} / ${humanBytes(total)}`;
}

function humanBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let unit = units[0];
  for (let i = 1; amount >= 1024 && i < units.length; i += 1) {
    amount /= 1024;
    unit = units[i];
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
