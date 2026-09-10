import { describe, expect, it } from "vitest";
import { buildHistogramQuery, buildLogsQuery, isSafeRegex, LOG_NAME_RE, quoteString, regexLiteral } from "../insights-query";

describe("Insights query escaping", () => {
  it("quotes string literals", () => {
    expect(quoteString("jobs")).toBe('"jobs"');
    expect(quoteString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("escapes slashes in regex literals and drops newlines", () => {
    expect(regexLiteral("api/v1")).toBe("/api\\/v1/");
    expect(regexLiteral("already\\/escaped")).toBe("/already\\/escaped/");
    expect(regexLiteral("ERROR|timeout")).toBe("/ERROR|timeout/");
    expect(regexLiteral("a\nb")).toBe("/a b/");
  });

  it("flags nested quantifiers as unsafe", () => {
    expect(isSafeRegex("(a+)+")).toBe(false);
    expect(isSafeRegex("ERROR|timeout")).toBe(true);
    expect(isSafeRegex("x".repeat(201))).toBe(false);
  });

  it("validates kubernetes names", () => {
    expect(LOG_NAME_RE.test("email-service-deployment-984d98f7b-m5qts")).toBe(true);
    expect(LOG_NAME_RE.test("Jobs")).toBe(false);
    expect(LOG_NAME_RE.test('a"b')).toBe(false);
  });
});

describe("buildLogsQuery", () => {
  it("filters namespace and optional pod/container", () => {
    const q = buildLogsQuery({ namespace: "jobs", podName: "email-service", containerName: "email-service", limit: 300 });
    expect(q).toContain('filter kubernetes.namespace_name = "jobs"');
    expect(q).toContain('filter kubernetes.pod_name like "email-service"');
    expect(q).toContain('filter kubernetes.container_name = "email-service"');
    expect(q.endsWith("limit 300")).toBe(true);
  });

  it("matches the filter against the log text OR the pod name", () => {
    const q = buildLogsQuery({ namespace: "jobs", filter: "email-service", limit: 50 });
    expect(q).toContain("filter (log like /email-service/ or kubernetes.pod_name like /email-service/)");
  });

  it("omits the pod clause when no pod is given", () => {
    expect(buildLogsQuery({ namespace: "jobs", limit: 10 })).not.toContain("pod_name like");
  });
});

describe("buildHistogramQuery", () => {
  it("bins by the requested minutes", () => {
    const q = buildHistogramQuery({ namespace: "jobs", binMinutes: 15, filter: "a/b" });
    expect(q).toContain("stats count(*) as n by bin(15m) as t");
    expect(q).toContain("/a\\/b/");
    expect(q.endsWith("sort t asc")).toBe(true);
  });
});
