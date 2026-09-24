// Fake ports shared by the action tests. In-memory, deterministic.
import type { BuildDispatcher, BuildInputs, BuildRun, FileChange, GitopsRepo, ImageInfo, ImageRegistry, SecretStore } from "../named-envs";

export class FakeGitops implements GitopsRepo {
  files = new Map<string, string>();
  commits: string[] = [];
  private shaOf(content: string) {
    return `sha-${content.length}-${content.slice(0, 8)}`;
  }
  async getFile(path: string) {
    const content = this.files.get(path);
    return content === undefined ? null : { content, sha: this.shaOf(content) };
  }
  async putFile(path: string, content: string, message: string, sha?: string) {
    const existing = this.files.get(path);
    if (existing !== undefined && sha !== this.shaOf(existing)) throw new Error("sha mismatch (GitHub 409)");
    if (existing === undefined && sha) throw new Error("sha given for a new file");
    this.files.set(path, content);
    this.commits.push(message);
  }
  async deleteFile(path: string, message: string, sha: string) {
    const existing = this.files.get(path);
    if (existing === undefined || sha !== this.shaOf(existing)) throw new Error("sha mismatch (GitHub 409)");
    this.files.delete(path);
    this.commits.push(message);
  }
  async listDir(dir: string) {
    return [...this.files.keys()].filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1));
  }
  /** One entry per atomic commit: the paths it touched. */
  atomic: string[][] = [];
  async commit(changes: FileChange[], message: string) {
    if (changes.length === 0) throw new Error("commit: no changes");
    for (const c of changes) {
      if (c.content === null) {
        if (!this.files.has(c.path)) throw new Error(`commit: delete of missing ${c.path}`);
        this.files.delete(c.path);
      } else this.files.set(c.path, c.content);
    }
    this.commits.push(message);
    this.atomic.push(changes.map((c) => c.path));
    return `commit-${this.commits.length}`;
  }
}

export class FakeSecrets implements SecretStore {
  store = new Map<string, Record<string, string>>();
  tags = new Map<string, Record<string, string>>();
  constructor() {
    this.store.set("preview/moly-backend", {
      MONGO_URI: "mongodb+srv://u:p@host/moly?retryWrites=true",
      SHIFT_FOUR_MONGO_URI: "mongodb+srv://u:p@host/moly",
      BUSINESS_URL: "https://stg.twizz.com",
      TOKEN_SECRET: "old",
      REDIS_HOST: "staging-redis",
      REDIS_PASSWORD: "x",
    });
  }
  async getJson(name: string) {
    const v = this.store.get(name);
    if (!v) throw new Error(`ResourceNotFoundException: ${name}`);
    return { ...v };
  }
  async createJson(name: string, value: Record<string, string>, tags: Record<string, string>) {
    if (this.store.has(name)) throw new Error(`ResourceExistsException: ${name}`);
    this.store.set(name, value);
    this.tags.set(name, tags);
  }
  async putJson(name: string, value: Record<string, string>) {
    if (!this.store.has(name)) throw new Error(`ResourceNotFoundException: ${name}`);
    this.store.set(name, value);
  }
  async deleteNow(name: string) {
    if (!this.store.delete(name)) throw new Error(`ResourceNotFoundException: ${name}`);
  }
}

export class FakeEcr implements ImageRegistry {
  constructor(private images: Record<string, ImageInfo[]>) {}
  async describeTag(repo: string, tag: string) {
    return this.images[repo]?.find((i) => i.tags.includes(tag)) ?? null;
  }
  async listImages(repo: string) {
    return this.images[repo] ?? [];
  }
}


export class FakeBuilds implements BuildDispatcher {
  dispatched: BuildInputs[] = [];
  runs = new Map<number, BuildRun>();
  failDispatch = false;
  private nextId = 1000;
  displayTitle(i: Pick<BuildInputs, "envName" | "service" | "sha">) {
    return `nebula-build ${i.envName} ${i.service} ${i.sha}`;
  }
  async dispatch(inputs: BuildInputs) {
    if (this.failDispatch) throw new Error("workflow_dispatch failed (422)");
    this.dispatched.push(inputs);
    const id = this.nextId++;
    this.runs.set(id, { id, url: `https://github.com/xenosnikos/First-IDP/actions/runs/${id}`, status: "queued", createdAt: new Date().toISOString() });
    (this.runs.get(id) as BuildRun & { title?: string }).title = this.displayTitle(inputs);
  }
  async findRun(q: { displayTitle: string; createdAfter: Date }) {
    const hits = [...this.runs.values()].filter((r) => (r as BuildRun & { title?: string }).title === q.displayTitle && Date.parse(r.createdAt) >= q.createdAfter.getTime() - 60_000);
    return hits.sort((a, b) => b.id - a.id)[0] ?? null;
  }
  async getRun(runId: number) {
    const r = this.runs.get(runId);
    if (!r) throw new Error(`run ${runId} not found`);
    return r;
  }
}

// ── release train ──────────────────────────────────────────────────────
import type { PromotionPr, PromotionRepo } from "../promote";

export class FakePromotions implements PromotionRepo {
  /** files on main */
  main = new Map<string, string>();
  prs: Array<PromotionPr & { files: Record<string, string>; body: string }> = [];
  merged: Array<{ number: number; sha: string; title: string }> = [];
  private seq = 100;
  private shaOf(s: string) {
    return `sha-${s.length}-${s.slice(0, 6)}`;
  }
  async readFile(path: string) {
    const c = this.main.get(path);
    return c === undefined ? null : { content: c, sha: this.shaOf(c) };
  }
  async openPr(input: { branch: string; files: Record<string, string>; title: string; body: string }) {
    const number = ++this.seq;
    const headSha = this.shaOf(Object.values(input.files).join(""));
    this.prs.push({ number, url: `https://github.com/TwizzyNicky/twizz-gitops/pull/${number}`, title: input.title, branch: input.branch, headSha, author: "nebula-bot", createdAt: new Date(2026, 8, 24, 0, number).toISOString(), state: "open", files: input.files, body: input.body });
    return { number, url: `https://github.com/TwizzyNicky/twizz-gitops/pull/${number}`, headSha };
  }
  async listOpenPrs(prefix: string) {
    return this.prs.filter((p) => p.state === "open" && p.branch.startsWith(prefix)).map(({ files: _f, body: _b, ...p }) => p);
  }
  async getPr(number: number) {
    const p = this.prs.find((x) => x.number === number);
    if (!p) return null;
    const { files: _f, body: _b, ...rest } = p;
    return rest;
  }
  async mergePr(number: number, opts: { title: string; sha: string }) {
    const p = this.prs.find((x) => x.number === number);
    if (!p || p.state !== "open") throw new Error(`PR ${number} not open`);
    if (p.headSha !== opts.sha) throw new Error("Head branch was modified. Review and try the merge again. (405)");
    p.state = "merged";
    for (const [path, content] of Object.entries(p.files)) this.main.set(path, content);
    const sha = `merge-${number}`;
    this.merged.push({ number, sha, title: opts.title });
    return { sha };
  }
}
