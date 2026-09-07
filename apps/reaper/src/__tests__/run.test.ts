import { describe, expect, it, vi } from "vitest";

// The audited fake deletes below must never land in a real audit file.
// (hoisted above the imports; only node globals are available here)
vi.hoisted(() => {
  process.env.REAPER_AUDIT_FILE = `${process.env.TMPDIR ?? "/tmp"}/reaper-test-audit-${process.pid}.jsonl`;
  delete process.env.DATABASE_URL;
});
import { reapOrphans } from "../index";
import type { KubeClient } from "../kube";
import type { NamespaceInfo } from "../orphans";

describe("reapOrphans (fake kube client)", () => {
  it("deletes only orphans, keeps counting on per-item failure", async () => {
    const now = new Date("2026-09-07T12:00:00Z");
    const old = new Date(now.getTime() - 3_600_000);
    const deleted: string[] = [];
    const kube: KubeClient = {
      listPreviewNamespaces: async (): Promise<NamespaceInfo[]> => [
        { name: "env-smoke", labels: { "twizz-idp/preview": "true" }, createdAt: old },
        { name: "env-gone", labels: { "twizz-idp/preview": "true" }, createdAt: old },
        { name: "env-stuck", labels: { "twizz-idp/preview": "true" }, createdAt: old },
        { name: "kube-system", labels: {}, createdAt: old },
      ],
      listArgoApplications: async () => [{ name: "env-smoke", labels: {} }],
      deleteNamespace: vi.fn(async (name: string) => {
        if (name === "env-stuck") throw new Error("409 conflict");
        deleted.push(name);
      }),
    };
    const r = await reapOrphans(kube, now);
    expect(deleted).toEqual(["env-gone"]);
    expect(r).toEqual({ namespaces: 4, orphans: 2, failures: 1 });
  });
});
