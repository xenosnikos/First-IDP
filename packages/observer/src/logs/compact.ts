import { isErrorLevel, severity, type Level } from "./level";
import { joinMultiline, type LogRecord, type NormLine } from "./normalize";
import { mergeCounts, redact, redactionTotal } from "./redact";
import { podShort, signatureHash, signatureOf } from "./signature";

/** The unit of log understanding — and, in phase 2, the unit to embed. */
export type LogGroup = {
  signature: string;
  hash: string;
  level: Level;
  count: number;
  first: string;
  last: string;
  pods: Record<string, number>;
  containers: string[];
  context?: string;
  /** Redacted head line + a few continuation lines. */
  sample: string;
  sampleRedactions: number;
};

export type CompactStatus = "complete" | "timeout" | "failed";

export type TimelineBucket = { bucket: string; count: number; errors: number };

const SAMPLE_CHARS = 500;
const ERROR_SAMPLE_CHARS = 800;
const SAMPLE_FRAMES = 6;
const ERROR_SAMPLE_FRAMES = 12;

function sampleOf(r: LogRecord): { sample: string; redactions: number } {
  const err = isErrorLevel(r.level);
  const frames = r.continuationLines.slice(0, err ? ERROR_SAMPLE_FRAMES : SAMPLE_FRAMES);
  const more = r.continuationLines.length - frames.length + r.omitted;
  const raw = [r.text, ...frames.map((f) => "  " + f.trim()), ...(more > 0 ? [`  … +${more} more lines`] : [])].join("\n");
  const cap = err ? ERROR_SAMPLE_CHARS : SAMPLE_CHARS;
  const { text, counts } = redact(raw);
  const clipped = text.length > cap ? text.slice(0, cap) + " …" : text;
  return { sample: clipped, redactions: redactionTotal(counts) };
}

/** Group chronological lines by (level, signature). */
export function groupLines(lines: NormLine[]): LogGroup[] {
  const records = joinMultiline(lines);
  const byKey = new Map<string, { g: LogGroup; sampleRec: LogRecord }>();
  for (const r of records) {
    const signature = signatureOf(r.text);
    const key = `${r.level}|${signature}`;
    const existing = byKey.get(key);
    if (existing) {
      const g = existing.g;
      g.count++;
      if (r.ts < g.first) g.first = r.ts;
      if (r.ts > g.last) g.last = r.ts;
      g.pods[r.pod] = (g.pods[r.pod] ?? 0) + 1;
      if (!g.containers.includes(r.container)) g.containers.push(r.container);
      // prefer the richest sample (most continuation lines)
      if (r.continuationLines.length > existing.sampleRec.continuationLines.length) existing.sampleRec = r;
      continue;
    }
    byKey.set(key, {
      g: {
        signature,
        hash: signatureHash(key),
        level: r.level,
        count: 1,
        first: r.ts,
        last: r.ts,
        pods: { [r.pod]: 1 },
        containers: [r.container],
        context: r.context,
        sample: "",
        sampleRedactions: 0,
      },
      sampleRec: r,
    });
  }
  const groups: LogGroup[] = [];
  for (const { g, sampleRec } of byKey.values()) {
    const s = sampleOf(sampleRec);
    g.sample = s.sample;
    g.sampleRedactions = s.redactions;
    groups.push(g);
  }
  return sortGroups(groups);
}

export function sortGroups(groups: LogGroup[]): LogGroup[] {
  return [...groups].sort((a, b) => severity(b.level) - severity(a.level) || b.count - a.count || a.first.localeCompare(b.first));
}

export function timeline(lines: NormLine[], bucketMinutes: number): TimelineBucket[] {
  const ms = Math.max(1, bucketMinutes) * 60_000;
  const map = new Map<number, TimelineBucket>();
  for (const l of lines) {
    const t = Date.parse(l.ts);
    if (Number.isNaN(t)) continue;
    const b = Math.floor(t / ms) * ms;
    let bucket = map.get(b);
    if (!bucket) {
      bucket = { bucket: new Date(b).toISOString(), count: 0, errors: 0 };
      map.set(b, bucket);
    }
    bucket.count++;
    if (isErrorLevel(l.level)) bucket.errors++;
  }
  return [...map.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export type RenderOpts = {
  maxChars: number;
  totalLines: number;
  status: CompactStatus;
  /** True when the query returned exactly its limit (older lines exist). */
  limitHit?: boolean;
  timeline?: TimelineBucket[];
  window?: { from: string; to: string };
};

export type Rendered = { text: string; shownGroups: number; truncatedGroups: number; truncatedLines: number; chars: number };

const hhmmss = (iso: string) => iso.replace("T", " ").slice(11, 19) || iso;
const hhmm = (iso: string) => iso.replace("T", " ").slice(11, 16) || iso;

function podList(pods: Record<string, number>): string {
  const entries = Object.entries(pods).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, 3).map(([p, n]) => (n > 1 ? `${podShort(p)}(${n})` : podShort(p)));
  return shown.join(",") + (entries.length > 3 ? `,+${entries.length - 3}` : "");
}

function header(g: LogGroup): string {
  const ctx = g.context ? ` [${g.context}]` : "";
  return `[${g.level} ×${g.count} ${hhmmss(g.first)}→${hhmmss(g.last)} pods=${podList(g.pods)}${ctx}]`;
}

/** Deterministic, budgeted text for the model. Largest groups first with
 * their samples; when the budget runs out, remaining groups get a header
 * line only; anything past that is counted in the honest footer. */
export function renderCompact(groups: LogGroup[], opts: RenderOpts): Rendered {
  const sorted = sortGroups(groups);
  const totalGroups = sorted.length;
  const head: string[] = [];
  if (opts.window) head.push(`window ${opts.window.from} → ${opts.window.to}`);
  head.push(`lines=${opts.totalLines}${opts.limitHit ? " (query limit hit; older lines exist)" : ""} groups=${totalGroups} query=${opts.status}`);
  if (opts.timeline && opts.timeline.length > 0) {
    head.push("timeline: " + opts.timeline.map((b) => `${hhmm(b.bucket)} ${b.count}${b.errors ? `/${b.errors}e` : ""}`).join("  "));
  }
  const footerReserve = 160;
  let text = head.join("\n") + "\n";
  let shown = 0;
  let headerOnly = 0;
  let shownLines = 0;
  let i = 0;
  for (; i < sorted.length; i++) {
    const g = sorted[i];
    const block = header(g) + "\n" + g.sample.split("\n").map((l) => "  " + l).join("\n") + "\n";
    if (text.length + block.length + footerReserve <= opts.maxChars) {
      text += block;
      shown++;
      shownLines += g.count;
      continue;
    }
    const h = header(g) + "\n";
    if (text.length + h.length + footerReserve <= opts.maxChars) {
      text += h;
      headerOnly++;
      shownLines += g.count;
      continue;
    }
    break;
  }
  const truncatedGroups = totalGroups - shown - headerOnly;
  const truncatedLines = Math.max(0, opts.totalLines - shownLines);
  const parts = [`-- showing ${shown} of ${totalGroups} groups with samples`];
  if (headerOnly) parts.push(`${headerOnly} header-only`);
  if (truncatedGroups > 0) parts.push(`${truncatedGroups} groups (${truncatedLines} lines) not shown — narrow by pod, level or filter`);
  parts.push(`query status: ${opts.status} --`);
  text += parts.join("; ");
  return { text, shownGroups: shown + headerOnly, truncatedGroups, truncatedLines, chars: text.length };
}

/** Phase-2 embedding input: post-redaction, PII-light, shape not identifiers. */
export function embedText(g: LogGroup): string {
  const pod = Object.keys(g.pods)[0] ? podShort(Object.keys(g.pods)[0]).replace(/-…[a-z0-9]{5}$/, "") : "";
  return `${g.level} | ${g.signature} | ${pod} | ${g.sample.slice(0, 400)}`;
}

/** Whole pipeline for callers that hold raw lines. */
export function compact(
  lines: NormLine[],
  opts: Omit<RenderOpts, "totalLines" | "timeline"> & { bucketMinutes?: number },
): { groups: LogGroup[]; rendered: Rendered; timeline: TimelineBucket[]; redactions: Record<string, number> } {
  const groups = groupLines(lines);
  const tl = timeline(lines, opts.bucketMinutes ?? 5);
  const rendered = renderCompact(groups, { ...opts, totalLines: lines.length, timeline: tl });
  let redactions: Record<string, number> = {};
  for (const g of groups) if (g.sampleRedactions) redactions = mergeCounts(redactions, { sample: g.sampleRedactions });
  return { groups, rendered, timeline: tl, redactions };
}
