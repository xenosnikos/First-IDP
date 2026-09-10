import { describe, expect, it } from "vitest";
import { decodeLogsState, encodeLogsState } from "@/lib/nebula/logs-url";
import { groupPodsByDeployment } from "@/lib/nebula/pods";
import { parseSseFrames } from "@/lib/nebula/sse";

const CLUSTERS = ["EKS-Twizz-NonProd", "EKS-Moly-staging", "EKS-Moly-Prod"];

describe("logs url state", () => {
  it("round-trips", () => {
    const s = { cluster: "EKS-Moly-Prod", namespace: "jobs", pod: "email-service", minutesBack: 60, filter: "ERROR|timeout", errorsOnly: true };
    expect(decodeLogsState(encodeLogsState(s), CLUSTERS)).toEqual(s);
  });
  it("rejects unknown clusters and bad names, clamps the window", () => {
    expect(decodeLogsState("c=EKS-Moly-Prod&ns=Jobs", CLUSTERS)).toBeNull();
    expect(decodeLogsState("c=nope&ns=jobs", CLUSTERS)).toBeNull();
    expect(decodeLogsState("c=EKS-Moly-Prod&ns=jobs&w=7&pod=Bad", CLUSTERS)).toEqual({ cluster: "EKS-Moly-Prod", namespace: "jobs", pod: undefined, minutesBack: 30, filter: "", errorsOnly: false });
  });
});

describe("groupPodsByDeployment", () => {
  it("groups replicas under their deployment", () => {
    const g = groupPodsByDeployment([{ podName: "api-7d9f8c6b4-x2k9p" }, { podName: "api-7d9f8c6b4-aaaaa" }, { podName: "fluent-bit-k7x2p" }, { podName: "postgres-0" }]);
    expect(g.map((x) => [x.deployment, x.pods.length])).toEqual([["api", 2], ["fluent-bit", 1], ["postgres", 1]]);
  });
});

describe("parseSseFrames", () => {
  it("parses complete frames and keeps the partial tail", () => {
    const { events, rest } = parseSseFrames('event: text\ndata: {"delta":"a"}\n\n: ping\n\nevent: done\ndata: {"x":1}\n\nevent: text\ndata: {"del');
    expect(events).toEqual([{ event: "text", data: '{"delta":"a"}' }, { event: "done", data: '{"x":1}' }]);
    expect(rest).toBe('event: text\ndata: {"del');
  });
});
