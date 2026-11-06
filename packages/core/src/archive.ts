// twizz-sentinel raw-log archive search (docs/NEBULA.md §N8). READ ONLY, one FIXED query
// template over Athena (workgroup `sentinel`, table sentinel_logs.sentinel_app_logs — owned by
// twizz-idp infra/addons). Caller values are bound as Athena execution PARAMETERS, never
// concatenated into SQL; shapes are checked first. Partition projection prunes by env + dt.
import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand, StopQueryExecutionCommand } from "@aws-sdk/client-athena";

const region = process.env.AWS_REGION ?? "eu-west-1";
let client: AthenaClient | null = null;
const athena = () => (client ??= new AthenaClient({ region, maxAttempts: 2, requestHandler: { requestTimeout: 15_000, connectionTimeout: 3_000 } }));

export const ARCHIVE_WORKGROUP = process.env.NEBULA_ARCHIVE_WORKGROUP || "sentinel";
export const ARCHIVE_ENVS = ["prod", "staging"] as const;
export type ArchiveEnv = (typeof ARCHIVE_ENVS)[number];

export type ArchiveQuery = { env: ArchiveEnv; from: string; to: string; contains?: string; pod?: string; limit?: number };
export type ArchiveRow = { ts: number; pod: string; msg: string };
export type ArchiveResult = { status: "complete" | "timeout" | "failed"; rows: ArchiveRow[]; scannedBytes?: number; error?: string; queryId?: string };

const DAY = 24 * 3600_000;
const POD_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/;

/** Shape-check and normalise (throws on bad input). ≤ 7 days, ≤ 1000 rows. */
export function archiveQueryPlan(q: ArchiveQuery): { sql: string; params: string[]; days: string[] } {
  if (!(ARCHIVE_ENVS as readonly string[]).includes(q.env)) throw new Error(`env must be one of ${ARCHIVE_ENVS.join(", ")}`);
  const from = Date.parse(q.from);
  const to = Date.parse(q.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) throw new Error("from/to must be ISO times with to > from");
  if (to - from > 7 * DAY) throw new Error("at most 7 days per search");
  if (q.contains !== undefined && (q.contains.length < 3 || q.contains.length > 200)) throw new Error("contains must be 3–200 characters");
  if (q.pod !== undefined && !POD_RE.test(q.pod)) throw new Error("pod must be a kubernetes pod name or prefix");
  const limit = Math.min(1000, Math.max(1, Math.floor(q.limit ?? 200)));
  const days: string[] = [];
  for (let d = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate()); d <= to; d += DAY) days.push(new Date(d).toISOString().slice(0, 10));
  // LIKE patterns: the user's text is a literal — escape the wildcards, bind it as a parameter
  const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const where = ["env = ?", `dt IN (${days.map(() => "?").join(", ")})`, "ts BETWEEN ? AND ?"];
  const params = [q.env, ...days, String(from), String(to)];
  if (q.contains) {
    where.push("msg LIKE ? ESCAPE '\\'");
    params.push(`%${esc(q.contains)}%`);
  }
  if (q.pod) {
    where.push("pod LIKE ? ESCAPE '\\'");
    params.push(`${esc(q.pod)}%`);
  }
  // Athena binds ? positionally; strings are passed quoted
  const sql = `SELECT ts, pod, msg FROM sentinel_logs.sentinel_app_logs WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ${limit}`;
  return { sql, params: params.map((p, i) => (i >= 1 + days.length && i < 3 + days.length ? p : `'${p.replace(/'/g, "''")}'`)), days };
}

export async function searchArchive(q: ArchiveQuery, opts: { timeoutMs?: number } = {}): Promise<ArchiveResult> {
  const { sql, params } = archiveQueryPlan(q);
  // ONE deadline for submit + poll + results; every SDK call is bounded by it
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  const left = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const started = await athena().send(new StartQueryExecutionCommand({ QueryString: sql, ExecutionParameters: params, WorkGroup: ARCHIVE_WORKGROUP }), { abortSignal: left() });
  const id = started.QueryExecutionId;
  if (!id) return { status: "failed", rows: [], error: "Athena returned no query id" };
  let terminal = false;
  try {
    for (;;) {
      if (Date.now() > deadline) return { status: "timeout", rows: [], queryId: id };
      await new Promise((r) => setTimeout(r, 1000));
      const ex = (await athena().send(new GetQueryExecutionCommand({ QueryExecutionId: id }), { abortSignal: left() })).QueryExecution;
      const state = ex?.Status?.State;
      if (state === "FAILED" || state === "CANCELLED") {
        terminal = true;
        return { status: "failed", rows: [], error: ex?.Status?.StateChangeReason?.slice(0, 300), queryId: id };
      }
      if (state !== "SUCCEEDED") continue;
      terminal = true;
      const rows: ArchiveRow[] = [];
      let NextToken: string | undefined;
      let header = true;
      do {
        if (Date.now() > deadline) return { status: "timeout", rows: [], queryId: id };
        const r = await athena().send(new GetQueryResultsCommand({ QueryExecutionId: id, NextToken, MaxResults: 1000 }), { abortSignal: left() });
        for (const row of r.ResultSet?.Rows ?? []) {
          if (header) {
            header = false;
            continue;
          }
          const [ts, pod, msg] = (row.Data ?? []).map((d) => d.VarCharValue ?? "");
          rows.push({ ts: Number(ts), pod, msg });
        }
        NextToken = r.NextToken;
      } while (NextToken && rows.length < 1000);
      return { status: "complete", rows: rows.slice(0, 1000), scannedBytes: ex?.Statistics?.DataScannedInBytes, queryId: id };
    }
  } finally {
    // any exit without a known terminal state (timeout, poll error) stops the scan
    if (!terminal) await athena().send(new StopQueryExecutionCommand({ QueryExecutionId: id }), { abortSignal: AbortSignal.timeout(5_000) }).catch(() => {});
  }
}
