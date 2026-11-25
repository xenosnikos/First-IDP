import { describe, expect, it } from "vitest";
import { manifestToYaml, parseManifest, type BuildRun, type FileChange, type NamedEnvManifest } from "@twizz-idp/actions";
import { watchBuilds, type WatchDeps } from "../watch-builds";

// external review 2026-11-25, idp #16: the builder pushed `<service>:nb-…` and the watcher looked in
// `<service>`, while the chart pulls from the registry's `ecrRepo` — for moly-backend (`molybackend`),
// frontend (`twizz-frontend`) and business (`twizz-business`) those are different repositories, so a
// built env was promoted onto an image its pods could never pull. One name now: envEcrRepo.

const NOW = new Date("2026-11-25T12:10:00Z");
const pending = (over: Partial<NamedEnvManifest>): NamedEnvManifest => ({
  name: "plo-2611-moly-backend",
  kind: "backend",
  service: "moly-backend",
  owner: "nick",
  expiresAt: "2026-11-28T12:00:00.000Z",
  db: { mode: "isolated", generation: 1 },
  frontendOrigins: [],
  source: { repo: "twizz-app/Moly-backend", ref: "plo/bundle/2026-11", sha: "b2".repeat(20) },
  build: { status: "RUNNING", expectedTag: "nb-plo-2611-moly-backend-b2b2b2b2b2b2", startedAt: "2026-11-25T12:00:00.000Z", runId: 7 },
  ...over,
});

function world(m: NamedEnvManifest, imagesIn: string[]) {
  const files = new Map<string, string>([[`named-envs/pending/${m.name}.yaml`, manifestToYaml(m)]]);
  const asked: string[] = [];
  const titles: string[] = [];
  const done: BuildRun = { id: 7, url: "https://gh/runs/7", status: "completed", conclusion: "success", createdAt: "2026-11-25T12:00:30Z" };
  const deps: WatchDeps = {
    now: () => NOW,
    gitops: {
      async getFile(path: string) {
        const c = files.get(path);
        return c === undefined ? null : { content: c, sha: "s" };
      },
      async putFile(path: string, content: string) {
        files.set(path, content);
      },
      async deleteFile(path: string) {
        files.delete(path);
      },
      async listDir(dir: string) {
        return [...files.keys()].filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1));
      },
      async commit(changes: FileChange[]) {
        for (const c of changes) {
          if (c.content === null) files.delete(c.path);
          else files.set(c.path, c.content);
        }
        return "c1";
      },
    } as unknown as WatchDeps["gitops"],
    builds: {
      async dispatch() {},
      async findRun(q: { displayTitle: string }) {
        titles.push(q.displayTitle);
        return done;
      },
      async getRun() {
        return done;
      },
      displayTitle: (i: { envName: string; service: string; sha: string }) => `nebula-build ${i.envName} ${i.service} ${i.sha}`,
    } as unknown as WatchDeps["builds"],
    images: {
      async describeTag(repo: string, tag: string) {
        asked.push(`${repo}:${tag}`);
        return imagesIn.includes(`${repo}:${tag}`) ? { tags: [tag], pushedAt: NOW, digest: "sha256:x" } : null;
      },
      async listImages() {
        return [];
      },
    } as unknown as WatchDeps["images"],
  };
  return { deps, files, asked, titles };
}

describe("watchBuilds looks for the image where the chart pulls it from", () => {
  it("moly-backend: the image is in ECR `molybackend`, not in `moly-backend`", async () => {
    const m = pending({});
    const tag = m.build!.expectedTag;
    const ok = world(m, [`molybackend:${tag}`]);
    expect(await watchBuilds(ok.deps)).toMatchObject({ promoted: 1, failed: 0 });
    expect(ok.asked).toEqual([`molybackend:${tag}`]);
    expect(parseManifest(ok.files.get(`named-envs/${m.name}.yaml`)!)).toMatchObject({ imageTag: tag, build: { status: "PASS" } });

    // an image that only exists under the SERVICE name is one the pods cannot pull: not promoted
    const wrong = world(m, [`moly-backend:${tag}`]);
    expect(await watchBuilds(wrong.deps)).toMatchObject({ promoted: 0, failed: 1 });
    expect(wrong.files.has(`named-envs/${m.name}.yaml`)).toBe(false);
  });

  it("finds the run under the title the dispatch gave it (the ECR repository), and a service whose repository is its own name is unchanged", async () => {
    const be = pending({ build: { status: "PENDING", expectedTag: "nb-plo-2611-moly-backend-b2b2b2b2b2b2", startedAt: "2026-11-25T12:09:00.000Z" } });
    const w = world(be, []);
    await watchBuilds(w.deps);
    expect(w.titles).toEqual([`nebula-build plo-2611-moly-backend molybackend ${"b2".repeat(20)}`]);

    const s = pending({ name: "plo-2611-twizz-sentinel", service: "twizz-sentinel", source: { repo: "twizz-app/twizz-sentinel", ref: "plo/bundle/2026-11", sha: "a1".repeat(20) }, build: { status: "RUNNING", expectedTag: "nb-plo-2611-twizz-sentinel-a1a1a1a1a1a1", startedAt: "2026-11-25T12:00:00.000Z", runId: 7 } });
    const sw = world(s, ["twizz-sentinel:nb-plo-2611-twizz-sentinel-a1a1a1a1a1a1"]);
    expect(await watchBuilds(sw.deps)).toMatchObject({ promoted: 1 });
    expect(sw.asked).toEqual(["twizz-sentinel:nb-plo-2611-twizz-sentinel-a1a1a1a1a1a1"]);
  });
});
