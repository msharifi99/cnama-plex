import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

type MediaType = "movie" | "series";
type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "skipped";

type DetectedLink = { url: string; label?: string };

type PreviewItem = DetectedLink & {
  id: string;
  selected: boolean;
  episode?: number;
  extension: string;
  destinationPath: string;
};

type Preview = {
  title: string;
  year?: string;
  mediaType: MediaType;
  season: number;
  items: PreviewItem[];
};

type Job = {
  id: number;
  batchId: string;
  sourceUrl: string;
  label?: string;
  mediaType: MediaType;
  title: string;
  season?: number;
  episode?: number;
  destinationPath: string;
  status: JobStatus;
  error?: string;
  bytesReceived: number;
  bytesTotal?: number;
  updatedAt: string;
};

type JobsTab = "active" | "needs-action" | "done" | "all";

const JOB_TABS: Array<{ id: JobsTab; label: string }> = [
  { id: "active", label: "Active" },
  { id: "needs-action", label: "Needs action" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" }
];

const APP_BASE_PATH = getAppBasePath();

export function App() {
  const [rawText, setRawText] = useState("");
  const [pageTitle, setPageTitle] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [queuing, setQueuing] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const detectedLinks = useMemo(() => parseLinks(rawText), [rawText]);

  useEffect(() => {
    void refreshJobs();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}${APP_BASE_PATH}/ws/jobs`);
    ws.addEventListener("message", (e) => {
      const data = JSON.parse(e.data as string) as { type: string; jobs?: Job[]; job?: Job };
      if (data.type === "jobs" && data.jobs) setJobs(data.jobs);
      if (data.type === "job:update" && data.job) setJobs((cur) => mergeJob(cur, data.job!));
    });
    return () => ws.close();
  }, []);

  useEffect(() => {
    if (detectedLinks.length === 0) {
      setPreview(null);
      return;
    }

    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(apiPath("/api/detected-links/preview"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageTitle, links: detectedLinks }),
        signal: ac.signal
      })
        .then((r) => (r.ok ? (r.json() as Promise<Preview>) : null))
        .then((data) => {
          if (data) setPreview(data);
        })
        .catch(() => {});
    }, 300);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [detectedLinks, pageTitle]);

  const activeJobs = useMemo(() => jobs.filter((j) => j.status === "queued" || j.status === "running"), [jobs]);
  const needsActionJobs = useMemo(() => jobs.filter((j) => j.status === "failed" || j.status === "canceled"), [jobs]);
  const completedJobs = useMemo(() => jobs.filter((j) => j.status === "completed" || j.status === "skipped"), [jobs]);
  const selectedCount = useMemo(() => preview?.items.filter((i) => i.selected).length ?? 0, [preview]);

  useEffect(() => {
    if (activeJobs.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshJobs();
      }
    }, 1500);

    return () => window.clearInterval(timer);
  }, [activeJobs.length]);

  async function refreshJobs() {
    const r = await fetch(apiPath("/api/jobs"));
    setJobs(((await r.json()) as { jobs: Job[] }).jobs);
  }

  async function queueDownloads() {
    if (!preview || selectedCount === 0) return;

    setQueuing(true);
    const r = await fetch(apiPath("/api/download-batches"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pageTitle,
        title: preview.title,
        year: preview.year,
        mediaType: preview.mediaType,
        season: preview.season,
        links: preview.items.map((i) => ({
          url: i.url,
          label: i.label,
          selected: i.selected,
          episode: i.episode
        }))
      })
    });
    setQueuing(false);
    if (!r.ok) return;

    const count = selectedCount;
    setRawText("");
    setPageTitle("");
    setPreview(null);
    setSuccessMsg(`${count} download${count !== 1 ? "s" : ""} queued`);
    window.setTimeout(() => setSuccessMsg(null), 4000);
    void refreshJobs();
  }

  function updateItem(id: string, patch: Partial<PreviewItem>) {
    setPreview((p) => (p ? { ...p, items: p.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) } : null));
  }

  function selectAll(selected: boolean) {
    setPreview((p) => (p ? { ...p, items: p.items.map((i) => ({ ...i, selected })) } : null));
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            C
          </div>
          <div>
            <strong>CNama Plex</strong>
            <span>Link intake</span>
          </div>
        </div>

        <div className="header-stats" aria-label="Download summary">
          <Metric label="Detected" value={detectedLinks.length} />
          <Metric label="Active" value={activeJobs.length} />
          <Metric label="Done" value={completedJobs.length} />
          <Metric label="Issues" value={needsActionJobs.length} tone={needsActionJobs.length > 0 ? "danger" : undefined} />
        </div>
      </header>

      <main className="workspace">
        <section className="flow-pane" aria-label="Link import and review">
          {successMsg && (
            <div className="success-notice" role="status">
              <IconCheck />
              <span>{successMsg}</span>
            </div>
          )}

          <section className="import-hero">
            <div className="hero-copy">
              <span className="eyebrow">Import</span>
              <h1>Paste links, review episodes, queue to Plex.</h1>
            </div>
            <div className="import-meter" aria-label={`${detectedLinks.length} detected links`}>
              <span>{detectedLinks.length}</span>
              <small>links</small>
            </div>
          </section>

          <section className="paste-panel" aria-label="Paste download links">
            <div className="field-row">
              <label htmlFor="page-title">Title</label>
              <input
                id="page-title"
                className="title-hint"
                placeholder="Optional"
                value={pageTitle}
                onChange={(e) => setPageTitle(e.target.value)}
              />
            </div>
            <div className="field-row">
              <div className="inline-label">
                <label htmlFor="download-links">Download links</label>
                {detectedLinks.length > 0 && (
                  <span className="link-badge">
                    {detectedLinks.length} detected
                  </span>
                )}
              </div>
              <textarea
                id="download-links"
                className="links-input"
                placeholder="https://..."
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                spellCheck={false}
              />
            </div>
          </section>

          {preview ? (
            <section className="review-panel" aria-label="Review detected downloads">
              <div className="review-heading">
                <div>
                  <span className="eyebrow">Review</span>
                  <h2>{preview.title}</h2>
                </div>
                <div className="selection-summary">
                  <strong>{selectedCount}</strong>
                  <span>selected</span>
                </div>
              </div>

              <div className="metadata-grid">
                <Field label="Title">
                  <input
                    value={preview.title}
                    onChange={(e) => setPreview((p) => (p ? { ...p, title: e.target.value } : null))}
                  />
                </Field>
                <Field label="Year">
                  <input
                    value={preview.year ?? ""}
                    onChange={(e) => setPreview((p) => (p ? { ...p, year: e.target.value } : null))}
                  />
                </Field>
                <Field label="Type">
                  <select
                    value={preview.mediaType}
                    onChange={(e) => setPreview((p) => (p ? { ...p, mediaType: e.target.value as MediaType } : null))}
                  >
                    <option value="series">Series</option>
                    <option value="movie">Movie</option>
                  </select>
                </Field>
                <Field label="Season">
                  <input
                    type="number"
                    min="1"
                    value={preview.season}
                    disabled={preview.mediaType === "movie"}
                    onChange={(e) => setPreview((p) => (p ? { ...p, season: Number.parseInt(e.target.value, 10) || 1 } : null))}
                  />
                </Field>
              </div>

              <div className="items-header">
                <span>
                  {selectedCount} of {preview.items.length} downloads
                </span>
                <div className="segmented-actions" aria-label="Selection actions">
                  <button type="button" onClick={() => selectAll(true)}>
                    All
                  </button>
                  <button type="button" onClick={() => selectAll(false)}>
                    None
                  </button>
                </div>
              </div>

              <div className="episode-list">
                {preview.items.map((item, index) => (
                  <label className={item.selected ? "episode-row is-selected" : "episode-row"} key={item.id}>
                    <input
                      type="checkbox"
                      checked={item.selected}
                      onChange={(e) => updateItem(item.id, { selected: e.target.checked })}
                    />
                    <span className="episode-index">{index + 1}</span>
                    <div className="episode-copy">
                      <strong>{item.label || item.url}</strong>
                      <span>{item.destinationPath}</span>
                    </div>
                    <input
                      type="number"
                      min="1"
                      value={item.episode ?? ""}
                      aria-label="Episode number"
                      disabled={preview.mediaType === "movie"}
                      onChange={(e) => updateItem(item.id, { episode: Number.parseInt(e.target.value, 10) || undefined })}
                    />
                  </label>
                ))}
              </div>

              <div className="queue-footer">
                <button
                  type="button"
                  className="primary queue-btn"
                  disabled={selectedCount === 0 || queuing}
                  onClick={() => void queueDownloads()}
                >
                  <IconDownload />
                  <span>{queuing ? "Queuing" : `Queue ${selectedCount}`}</span>
                </button>
              </div>
            </section>
          ) : (
            <section className="empty-review" aria-label="Review placeholder">
              <div className="empty-review-icon" aria-hidden="true">
                <IconList />
              </div>
              <strong>No links ready</strong>
              <span>Paste direct media links to build a Plex-ready queue.</span>
            </section>
          )}
        </section>

        <JobsPanel jobs={jobs} onRefresh={() => void refreshJobs()} />
      </main>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div className={tone ? `metric metric-${tone}` : "metric"}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label>
      <span>{label}</span>
      {children}
    </label>
  );
}

function JobsPanel({ jobs, onRefresh }: { jobs: Job[]; onRefresh: () => void }) {
  const [activeTab, setActiveTab] = useState<JobsTab>("active");
  const [groupByTitle, setGroupByTitle] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());

  const counts = useMemo(
    () => ({
      active: jobs.filter(isActiveJob).length,
      "needs-action": jobs.filter(isNeedsActionJob).length,
      done: jobs.filter(isDoneJob).length,
      all: jobs.length
    }),
    [jobs]
  );

  const filteredJobs = useMemo(() => jobs.filter((job) => jobMatchesTab(job, activeTab)), [activeTab, jobs]);
  const groupedJobs = useMemo(() => groupJobsByTitle(filteredJobs), [filteredJobs]);

  function toggleGroup(title: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(title)) {
        next.delete(title);
      } else {
        next.add(title);
      }
      return next;
    });
  }

  return (
    <aside className="jobs-panel" aria-label="Downloads">
      <div className="panel-heading">
        <div>
          <strong>Downloads</strong>
          <span>{filteredJobs.length} shown of {jobs.length}</span>
        </div>
        <button type="button" className="icon-button" onClick={onRefresh} aria-label="Refresh downloads">
          <IconRefresh />
        </button>
      </div>

      <div className="jobs-controls">
        <div className="jobs-tabs" role="tablist" aria-label="Download states">
          {JOB_TABS.map((tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "is-active" : undefined}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
            >
              <span>{tab.label}</span>
              <strong>{counts[tab.id]}</strong>
            </button>
          ))}
        </div>

        <label className="group-toggle">
          <input type="checkbox" checked={groupByTitle} onChange={(event) => setGroupByTitle(event.target.checked)} />
          <span>Group by title</span>
        </label>
      </div>

      <div className="job-list">
        {filteredJobs.length === 0 ? (
          <div className="empty-jobs">
            <IconActivity />
            <strong>No {tabEmptyLabel(activeTab)}</strong>
            <span>{jobs.length === 0 ? "Queued items appear here." : "Try another download state."}</span>
          </div>
        ) : null}

        {groupByTitle
          ? groupedJobs.map((group) => {
              const collapsed = collapsedGroups.has(group.title);
              return (
                <section className={collapsed ? "job-group is-collapsed" : "job-group"} key={group.title}>
                  <button
                    type="button"
                    className="job-group-heading"
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroup(group.title)}
                  >
                    <span className="group-chevron" aria-hidden="true">
                      <IconChevron />
                    </span>
                    <span className="group-title">
                      <strong>{group.title}</strong>
                      <span>{group.jobs.length} item{group.jobs.length !== 1 ? "s" : ""}</span>
                    </span>
                    <GroupSummary jobs={group.jobs} />
                  </button>
                  {!collapsed ? (
                    <div className="job-group-list">
                      {group.jobs.map((job) => (
                        <JobCard job={job} onRefresh={onRefresh} key={job.id} />
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            })
          : filteredJobs.map((job) => <JobCard job={job} onRefresh={onRefresh} key={job.id} />)}
      </div>
    </aside>
  );
}

function JobCard({ job, onRefresh }: { job: Job; onRefresh: () => void }) {
  return (
    <article className="job-row">
      <div className="job-topline">
        <div className="job-main">
          <strong>{jobTitleLine(job)}</strong>
          <span>{job.destinationPath}</span>
        </div>
        <StatusBadge status={job.status} />
      </div>
      <div className="job-meta">
        <span>{formatBytes(job.bytesReceived, job.bytesTotal)}</span>
        <span>{job.mediaType}</span>
      </div>
      {job.bytesTotal ? (
        <div className="progress-track">
          <div style={{ width: `${Math.min(100, (job.bytesReceived / job.bytesTotal) * 100)}%` }} />
        </div>
      ) : null}
      {job.error ? <p className="job-error">{job.error}</p> : null}
      <div className="job-actions">
        {(job.status === "queued" || job.status === "running") && (
          <button type="button" onClick={() => void postJobAction(job.id, "cancel", onRefresh)}>
            Cancel
          </button>
        )}
        {(job.status === "failed" || job.status === "canceled") && (
          <button type="button" onClick={() => void postJobAction(job.id, "retry", onRefresh)}>
            Retry
          </button>
        )}
      </div>
    </article>
  );
}

function GroupSummary({ jobs }: { jobs: Job[] }) {
  const completed = jobs.filter(isDoneJob).length;
  const active = jobs.filter(isActiveJob).length;
  const needsAction = jobs.filter(isNeedsActionJob).length;

  return (
    <div className="group-summary" aria-label="Group status summary">
      {active > 0 ? <span>{active} active</span> : null}
      {needsAction > 0 ? <span className="summary-danger">{needsAction} issue{needsAction !== 1 ? "s" : ""}</span> : null}
      {completed > 0 ? <span>{completed} done</span> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`status status-${status}`}>{status}</span>;
}

async function postJobAction(id: number, action: "cancel" | "retry", onDone: () => void) {
  await fetch(apiPath(`/api/jobs/${id}/${action}`), { method: "POST" });
  onDone();
}

function apiPath(path: string): string {
  return `${APP_BASE_PATH}${path}`;
}

function getAppBasePath(): string {
  const bundlePath = new URL(import.meta.url).pathname;
  const assetsMarker = "/assets/";
  const markerIndex = bundlePath.lastIndexOf(assetsMarker);
  if (markerIndex === -1) {
    return "";
  }
  const basePath = bundlePath.slice(0, markerIndex);
  return basePath === "/" ? "" : basePath;
}

function mergeJob(jobs: Job[], job: Job): Job[] {
  const index = jobs.findIndex((j) => j.id === job.id);
  if (index === -1) return [job, ...jobs];
  const next = jobs.slice();
  next[index] = job;
  return next;
}

function jobMatchesTab(job: Job, tab: JobsTab): boolean {
  if (tab === "active") return isActiveJob(job);
  if (tab === "needs-action") return isNeedsActionJob(job);
  if (tab === "done") return isDoneJob(job);
  return true;
}

function isActiveJob(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

function isNeedsActionJob(job: Job): boolean {
  return job.status === "failed" || job.status === "canceled";
}

function isDoneJob(job: Job): boolean {
  return job.status === "completed" || job.status === "skipped";
}

function groupJobsByTitle(jobs: Job[]): Array<{ title: string; jobs: Job[] }> {
  const groups = new Map<string, Job[]>();
  for (const job of jobs) {
    const title = job.title.trim() || "Untitled";
    groups.set(title, [...(groups.get(title) ?? []), job]);
  }
  return [...groups.entries()].map(([title, groupJobs]) => ({ title, jobs: groupJobs }));
}

function jobTitleLine(job: Job): string {
  if (job.mediaType === "series" && job.episode) {
    return `${job.title} · E${String(job.episode).padStart(2, "0")}`;
  }
  return job.title;
}

function tabEmptyLabel(tab: JobsTab): string {
  if (tab === "active") return "active downloads";
  if (tab === "needs-action") return "items needing action";
  if (tab === "done") return "completed downloads";
  return "downloads";
}

function parseLinks(text: string): DetectedLink[] {
  const urlRe = /https?:\/\/[^\s"'<>]+/gi;
  const mediaRe = /\.(mp4|mkv|avi|mov|m4v|webm|wmv|srt|ass|ssa|sub|zip|rar)(?:[?#]|$)/i;
  const seen = new Map<string, DetectedLink>();

  for (const line of text.split(/\n+/)) {
    for (const match of line.matchAll(urlRe)) {
      const clean = match[0].replace(/[),.;\]]+$/g, "");
      try {
        const url = new URL(clean);
        if ((url.protocol === "http:" || url.protocol === "https:") && mediaRe.test(url.pathname + url.search)) {
          seen.set(url.toString(), { url: url.toString(), label: line.trim() || undefined });
        }
      } catch {
        // Ignore malformed pasted text.
      }
    }
  }

  return [...seen.values()];
}

function formatBytes(received: number, total?: number): string {
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

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}

function IconList() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  );
}

function IconActivity() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h4l2-7 4 14 2-7h4" />
    </svg>
  );
}

function IconChevron() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
