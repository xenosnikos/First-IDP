import { createHash, randomBytes } from "node:crypto";

const ATLAS_PUBLIC_KEY = process.env.ATLAS_PUBLIC_KEY ?? "";
const ATLAS_PRIVATE_KEY = process.env.ATLAS_PRIVATE_KEY ?? "";
const ATLAS_PROJECT_ID = process.env.ATLAS_PROJECT_ID ?? "";
const ATLAS_API = "https://cloud.mongodb.com/api/atlas/v2";
/** processes + measurements are served on the 2023-01-01 API version */
const MEASURE_ACCEPT = "application/vnd.atlas.2023-01-01+json";
const ATLAS_TIMEOUT_MS = 15_000;

/** Parse a `WWW-Authenticate: Digest k="v", k2=v2` challenge. */
export function parseDigestChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.replace(/^Digest\s+/i, "").matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

/** RFC 2617 Digest (MD5, qop=auth) — Atlas programmatic API keys do not accept Basic. */
export function digestAuthorization(o: { user: string; pass: string; method: string; uri: string; challenge: Record<string, string>; cnonce: string; nc?: string }): string {
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  const { realm = "", nonce = "", qop, opaque, algorithm } = o.challenge;
  const nc = o.nc ?? "00000001";
  const ha1 = md5(`${o.user}:${realm}:${o.pass}`);
  const ha2 = md5(`${o.method}:${o.uri}`);
  const useQop = qop?.split(",").map((q) => q.trim()).includes("auth") ? "auth" : undefined;
  const response = useQop ? md5(`${ha1}:${nonce}:${nc}:${o.cnonce}:${useQop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  return [
    `Digest username="${o.user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${o.uri}"`,
    ...(algorithm ? [`algorithm=${algorithm}`] : []),
    `response="${response}"`,
    ...(opaque !== undefined ? [`opaque="${opaque}"`] : []),
    ...(useQop ? [`qop=${useQop}`, `nc=${nc}`, `cnonce="${o.cnonce}"`] : []),
  ].join(", ");
}

export type AtlasCreds = { publicKey: string; privateKey: string; projectId: string };
const DEFAULT_CREDS: AtlasCreds = { publicKey: ATLAS_PUBLIC_KEY, privateKey: ATLAS_PRIVATE_KEY, projectId: ATLAS_PROJECT_ID };

async function atlasFetch(path: string, options: RequestInit = {}, creds: AtlasCreds = DEFAULT_CREDS) {
  const url = `${ATLAS_API}${path}`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/vnd.atlas.2023-11-15+json",
    ...(options.headers as Record<string, string> | undefined),
  };
  // Digest is challenge/response: the first call earns the nonce, the second is authenticated.
  // Every call is hard-timed: a hung Atlas must never hang a Nebula request.
  const timed = () => ({ signal: options.signal ?? AbortSignal.timeout(ATLAS_TIMEOUT_MS) });
  let res = await fetch(url, { ...options, ...timed(), headers });
  const challenge = res.status === 401 ? res.headers.get("www-authenticate") : null;
  if (challenge && /^Digest/i.test(challenge)) {
    await res.text();
    const authorization = digestAuthorization({
      user: creds.publicKey,
      pass: creds.privateKey,
      method: (options.method ?? "GET").toUpperCase(),
      uri: new URL(url).pathname + new URL(url).search,
      challenge: parseDigestChallenge(challenge),
      cnonce: randomBytes(8).toString("hex"),
    });
    res = await fetch(url, { ...options, ...timed(), headers: { ...headers, Authorization: authorization } });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Atlas API ${res.status}: ${body}`);
  }

  return res.json() as Promise<any>;
}

export class AtlasService {
  async listClusters(): Promise<Array<{ name: string; state: string; connectionString: string }>> {
    const data = await atlasFetch(`/groups/${ATLAS_PROJECT_ID}/clusters`);
    return (data.results ?? []).map((c: any) => ({
      name: c.name,
      state: c.stateName,
      connectionString: c.connectionStrings?.standardSrv ?? "",
    }));
  }

  async createDatabaseUser(
    dbName: string,
    username: string,
    password: string,
  ): Promise<{ username: string; connectionString: string }> {
    await atlasFetch(`/groups/${ATLAS_PROJECT_ID}/databaseUsers`, {
      method: "POST",
      body: JSON.stringify({
        databaseName: "admin",
        username,
        password,
        roles: [{ databaseName: dbName, roleName: "readWrite" }],
        scopes: [],
      }),
    });

    const clusters = await this.listClusters();
    const cluster = clusters[0];

    return {
      username,
      connectionString: cluster
        ? `${cluster.connectionString}/${dbName}?retryWrites=true&w=majority`
        : "",
    };
  }

  async deleteDatabaseUser(username: string): Promise<void> {
    await atlasFetch(
      `/groups/${ATLAS_PROJECT_ID}/databaseUsers/admin/${username}`,
      { method: "DELETE" },
    );
  }

  async getConnectionString(clusterName: string, dbName: string): Promise<string> {
    const data = await atlasFetch(
      `/groups/${ATLAS_PROJECT_ID}/clusters/${clusterName}`,
    );
    const base = data.connectionStrings?.standardSrv ?? "";
    return `${base}/${dbName}?retryWrites=true&w=majority`;
  }
}

/** A dedicated cluster's compute tier, as the capacity planner sees it
 * (docs/NEBULA.md §N5). `instanceSize` is Atlas's own string (M10, M30, …;
 * shared/flex tiers come back as-is and are not resizable here). */
export type AtlasClusterTier = {
  name: string;
  state: string;
  instanceSize: string;
  autoScaling?: { min: string; max: string };
};

function regionConfigs(c: any): any[] {
  return (c.replicationSpecs ?? []).flatMap((r: any) => r.regionConfigs ?? []);
}

/** Read the tier of a cluster from a 2023-11-15 cluster description. */
export function tierOf(c: any): AtlasClusterTier {
  const rc = regionConfigs(c)[0] ?? {};
  const compute = rc.autoScaling?.compute;
  return {
    name: c.name,
    state: c.stateName,
    instanceSize: rc.electableSpecs?.instanceSize ?? c.providerSettings?.instanceSizeName ?? "unknown",
    autoScaling: compute?.enabled ? { min: compute.minInstanceSize, max: compute.maxInstanceSize } : undefined,
  };
}

/** Node specs resent with a new tier. STANDARD volumes derive IOPS from the
 * tier, so the old `diskIOPS` is dropped (only PROVISIONED IOPS are pinned). */
function resized(spec: any, instanceSize: string): any {
  const { diskIOPS, ...rest } = spec;
  return { ...rest, instanceSize, ...(spec.ebsVolumeType === "PROVISIONED" && diskIOPS !== undefined ? { diskIOPS } : {}) };
}

/** The PATCH body that changes ONLY the compute tier (+ auto-scaling bounds)
 * of every region config; everything else is sent back exactly as read. */
export function tierPatch(c: any, size: { instanceSize: string; autoScaling?: { min: string; max: string } }): { replicationSpecs: any[] } {
  return {
    replicationSpecs: (c.replicationSpecs ?? []).map((r: any) => ({
      ...r,
      regionConfigs: (r.regionConfigs ?? []).map((rc: any) => {
        // an existing auto-scaling setup keeps its scale-down choice (prod may pin it off)
        const was = rc.autoScaling?.compute;
        const scaleDown = was?.enabled ? was.scaleDownEnabled !== false : true;
        const compute = size.autoScaling
          ? { enabled: true, scaleDownEnabled: scaleDown, minInstanceSize: size.autoScaling.min, maxInstanceSize: size.autoScaling.max }
          : { enabled: false, scaleDownEnabled: false };
        // No analytics nodes (nodeCount 0): keep their spec + auto-scaling in
        // lockstep with the electable tier so Atlas never sees mismatched
        // bounds. Real analytics nodes are left exactly as they are.
        const noAnalytics = !rc.analyticsSpecs?.nodeCount;
        return {
          ...rc,
          electableSpecs: resized(rc.electableSpecs ?? {}, size.instanceSize),
          // read-only nodes must match the electable tier (even at nodeCount 0)
          ...(rc.readOnlySpecs ? { readOnlySpecs: resized(rc.readOnlySpecs, size.instanceSize) } : {}),
          ...(noAnalytics && rc.analyticsSpecs ? { analyticsSpecs: resized(rc.analyticsSpecs, size.instanceSize) } : {}),
          autoScaling: { ...rc.autoScaling, compute },
          ...(noAnalytics && rc.analyticsAutoScaling ? { analyticsAutoScaling: { ...rc.analyticsAutoScaling, compute } } : {}),
        };
      }),
    })),
  };
}

export class AtlasTierService {
  /** default: the ATLAS_* project (NonProd); prod lives in another Atlas account (ATLAS_PROD_*) */
  constructor(private readonly creds: AtlasCreds = DEFAULT_CREDS) {}

  /** every cluster in the project (prod has more than one) */
  async listClusterTiers(): Promise<AtlasClusterTier[]> {
    const data = await atlasFetch(`/groups/${this.creds.projectId}/clusters`, {}, this.creds);
    return (data.results ?? []).map(tierOf);
  }

  async getClusterTier(clusterName: string): Promise<AtlasClusterTier | null> {
    try {
      return tierOf(await atlasFetch(`/groups/${this.creds.projectId}/clusters/${encodeURIComponent(clusterName)}`, {}, this.creds));
    } catch (e) {
      if (/Atlas API 404/.test(String((e as Error).message))) return null;
      throw e;
    }
  }

  /** The primary (+ secondaries) of a replica-set cluster, matched by the
   * replica set name in its standard connection string. */
  async clusterProcesses(clusterName: string): Promise<{ primary?: string; processes: Array<{ id: string; typeName: string }> }> {
    const c = await atlasFetch(`/groups/${this.creds.projectId}/clusters/${encodeURIComponent(clusterName)}`, {}, this.creds);
    const rs = /[?&]replicaSet=([^&]+)/.exec(String(c.connectionStrings?.standard ?? ""))?.[1];
    if (!rs) return { processes: [] };
    const data = await atlasFetch(`/groups/${this.creds.projectId}/processes?itemsPerPage=500`, { headers: { Accept: MEASURE_ACCEPT } }, this.creds);
    const processes = ((data.results ?? []) as any[])
      .filter((p) => p.replicaSetName === rs)
      .map((p) => ({ id: String(p.id), typeName: String(p.typeName) }));
    return { primary: processes.find((p) => p.typeName === "REPLICA_PRIMARY")?.id, processes };
  }

  /** Per-minute (or coarser) measurements of one process: name → [epochMs, value][] ascending, nulls dropped. */
  async processMeasurements(processId: string, o: { granularity: "PT1M" | "PT5M" | "PT1H"; period: string; metrics: readonly string[] }): Promise<Record<string, Array<[number, number]>>> {
    const qs = new URLSearchParams({ granularity: o.granularity, period: o.period });
    for (const m of o.metrics) qs.append("m", m);
    const data = await atlasFetch(`/groups/${this.creds.projectId}/processes/${encodeURIComponent(processId)}/measurements?${qs}`, { headers: { Accept: MEASURE_ACCEPT } }, this.creds);
    const out: Record<string, Array<[number, number]>> = {};
    for (const m of (data.measurements ?? []) as any[]) {
      out[m.name] = ((m.dataPoints ?? []) as any[]).filter((d) => typeof d.value === "number").map((d) => [Date.parse(d.timestamp), d.value] as [number, number]);
    }
    return out;
  }

  /** Resize a DEDICATED cluster. Callers gate this (policy + nonce + audit). */
  async updateClusterTier(
    clusterName: string,
    size: { instanceSize: string; autoScaling?: { min: string; max: string } },
    /** the tier the caller checked; the PATCH is built from a fresh read and refused if it moved */
    expect?: { instanceSize: string; autoScaling?: { min: string; max: string } },
  ): Promise<{ state: string }> {
    const path = `/groups/${this.creds.projectId}/clusters/${encodeURIComponent(clusterName)}`;
    const current = await atlasFetch(path, {}, this.creds);
    const now = tierOf(current);
    if (!/^M\d+$/.test(now.instanceSize)) throw new Error(`${clusterName} is a shared/flex tier (${now.instanceSize}) — upgrade it to a dedicated tier in the Atlas UI first`);
    if (now.state !== "IDLE") throw new Error(`${clusterName} is ${now.state} — not resized`);
    if (expect && JSON.stringify({ i: now.instanceSize, a: now.autoScaling ?? null }) !== JSON.stringify({ i: expect.instanceSize, a: expect.autoScaling ?? null })) {
      throw new Error(`${clusterName} changed while resizing (now ${now.instanceSize}) — not resized`);
    }
    const updated = await atlasFetch(path, { method: "PATCH", body: JSON.stringify(tierPatch(current, size)) }, this.creds);
    return { state: updated.stateName ?? "UPDATING" };
  }
}

export const atlasService = new AtlasService();
export const atlasTierService = new AtlasTierService();

/** Prod Atlas (another Atlas account): null until ATLAS_PROD_* are configured. */
export function prodAtlasTierService(): AtlasTierService | null {
  const c = { publicKey: process.env.ATLAS_PROD_PUBLIC_KEY ?? "", privateKey: process.env.ATLAS_PROD_PRIVATE_KEY ?? "", projectId: process.env.ATLAS_PROD_PROJECT_ID ?? "" };
  return c.publicKey && c.privateKey && c.projectId ? new AtlasTierService(c) : null;
}
