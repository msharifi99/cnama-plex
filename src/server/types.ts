export type MediaType = "movie" | "series";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "skipped";

export type DetectedLink = {
  url: string;
  label?: string;
};

export type PreviewItem = DetectedLink & {
  id: string;
  selected: boolean;
  episode?: number;
  extension: string;
  destinationPath: string;
};

export type PreviewResponse = {
  title: string;
  year?: string;
  mediaType: MediaType;
  season: number;
  items: PreviewItem[];
};

export type CreateBatchRequest = {
  sourcePageUrl?: string;
  pageTitle?: string;
  title: string;
  year?: string;
  mediaType: MediaType;
  season?: number;
  links: Array<DetectedLink & { selected?: boolean; episode?: number }>;
};

export type JobRecord = {
  id: number;
  batchId: string;
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
  status: JobStatus;
  error?: string;
  bytesReceived: number;
  bytesTotal?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};
