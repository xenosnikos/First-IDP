const ATLAS_PUBLIC_KEY = process.env.ATLAS_PUBLIC_KEY ?? "";
const ATLAS_PRIVATE_KEY = process.env.ATLAS_PRIVATE_KEY ?? "";
const ATLAS_PROJECT_ID = process.env.ATLAS_PROJECT_ID ?? "";
const ATLAS_API = "https://cloud.mongodb.com/api/atlas/v2";

async function atlasFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${ATLAS_API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.atlas.2023-11-15+json",
      Authorization: `Basic ${Buffer.from(`${ATLAS_PUBLIC_KEY}:${ATLAS_PRIVATE_KEY}`).toString("base64")}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Atlas API ${res.status}: ${body}`);
  }

  return res.json();
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

export const atlasService = new AtlasService();
