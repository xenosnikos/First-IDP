// CloudWatch metrics (GetMetricData / ListMetrics) for the Monitor pane
// (docs/NEBULA.md §N6). READ ONLY: the dashboard role has cloudwatch:GetMetricData
// + ListMetrics on "*" and nothing that writes metrics or alarms.
import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand, type MetricDataQuery } from "@aws-sdk/client-cloudwatch";

const region = process.env.AWS_REGION ?? "eu-west-1";
let client: CloudWatchClient | null = null;
// hard timeouts: a slow CloudWatch must never hang a Nebula request
const cw = () => (client ??= new CloudWatchClient({ region, maxAttempts: 2, requestHandler: { requestTimeout: 15_000, connectionTimeout: 3_000 } }));

export type MetricQuery = {
  /** unique per call, [a-z][a-zA-Z0-9_]* */
  id: string;
  namespace: string;
  metric: string;
  dims: Record<string, string>;
  /** Average | Sum | Maximum | SampleCount | p95 … */
  stat: string;
  period: number;
};

/** [epochMs, value] ascending */
export type Series = Array<[number, number]>;

const BATCH = 500; // GetMetricData limit per request

/** Fetch many series in as few calls as possible. Missing data = empty series. */
export async function getMetricSeries(queries: MetricQuery[], startMs: number, endMs: number): Promise<Record<string, Series>> {
  const out: Record<string, Series> = {};
  for (let i = 0; i < queries.length; i += BATCH) {
    const MetricDataQueries: MetricDataQuery[] = queries.slice(i, i + BATCH).map((q) => ({
      Id: q.id,
      ReturnData: true,
      MetricStat: {
        Metric: { Namespace: q.namespace, MetricName: q.metric, Dimensions: Object.entries(q.dims).map(([Name, Value]) => ({ Name, Value })) },
        Period: q.period,
        Stat: q.stat,
      },
    }));
    let NextToken: string | undefined;
    do {
      const r = await cw().send(new GetMetricDataCommand({ MetricDataQueries, StartTime: new Date(startMs), EndTime: new Date(endMs), ScanBy: "TimestampAscending", NextToken }));
      for (const m of r.MetricDataResults ?? []) {
        const s = (out[m.Id!] ??= []);
        (m.Timestamps ?? []).forEach((t, k) => s.push([t.getTime(), m.Values?.[k] ?? 0]));
      }
      NextToken = r.NextToken;
    } while (NextToken);
  }
  for (const s of Object.values(out)) s.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Dimension sets of a metric that reported in the last 3 hours (stale ones are skipped). */
export async function listMetricDims(namespace: string, metric: string, dims: Record<string, string>): Promise<Array<Record<string, string>>> {
  const out: Array<Record<string, string>> = [];
  let NextToken: string | undefined;
  do {
    const r = await cw().send(
      new ListMetricsCommand({ Namespace: namespace, MetricName: metric, Dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })), RecentlyActive: "PT3H", NextToken }),
    );
    for (const m of r.Metrics ?? []) out.push(Object.fromEntries((m.Dimensions ?? []).map((d) => [d.Name!, d.Value!])));
    NextToken = r.NextToken;
  } while (NextToken && out.length < 2000);
  return out;
}
