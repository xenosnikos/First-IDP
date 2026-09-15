"use client";

import { useCallback, useRef, useState } from "react";
import type { ConfiguratorEvent, Proposal } from "@twizz-idp/observer"; // type-only: erased, the SDK never reaches the client bundle
import { parseSseFrames } from "./sse";

// SSE consumer for POST /api/configurator (same wire format as the Observer).
// Words: STUB (no key) · DENIED (budget) · RUNNING · PASS · FAIL.

export type ConfiguratorWord = "RUNNING" | "PASS" | "FAIL" | "DENIED" | "STUB";

export type ConfiguratorRun = {
  word: ConfiguratorWord | null;
  note: string;
  text: string;
  tools: string[];
  proposal: Proposal | null;
  error: string | null;
};

const idle: ConfiguratorRun = { word: null, note: "", text: "", tools: [], proposal: null, error: null };

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>)
    .filter(([k, v]) => k !== "twizzYaml" && k !== "dockerfile" && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v).slice(0, 60)}`)
    .join(" ");
}

export function useConfigurator() {
  const [run, setRun] = useState<ConfiguratorRun>(idle);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => setRun(idle), []);

  const start = useCallback(async (body: { repo: string; ref: string; sha: string; hints?: string; kindHint?: "backend" | "frontend" | "worker" }) => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    let text = "";
    const tools: string[] = [];
    setRun({ ...idle, word: "RUNNING", note: "starting" });
    try {
      const res = await fetch("/api/configurator", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: abort.signal });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { word?: ConfiguratorWord; message?: string };
        setRun({ ...idle, word: err.word ?? "FAIL", error: err.message ?? `HTTP ${res.status}` });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let proposal: Proposal | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buf);
        buf = parsed.rest;
        for (const ev of parsed.events) {
          let e: ConfiguratorEvent;
          try {
            e = JSON.parse(ev.data) as ConfiguratorEvent;
          } catch {
            continue;
          }
          if (e.type === "text") {
            text += e.delta;
            setRun((r) => ({ ...r, text }));
          } else if (e.type === "status") setRun((r) => ({ ...r, note: e.note ?? "" }));
          else if (e.type === "tool_use") {
            tools.push(`${e.name} ${summarizeInput(e.input)}`.trim());
            setRun((r) => ({ ...r, tools: [...tools], note: `running ${e.name}` }));
          } else if (e.type === "tool_result") {
            const i = tools.length - 1;
            if (i >= 0) tools[i] = `${tools[i]} → ${[e.status, e.lines != null ? `${e.lines} lines` : null, e.chars ? `${e.chars} chars` : null, `${(e.ms / 1000).toFixed(1)}s`].filter(Boolean).join(" · ")}`;
            setRun((r) => ({ ...r, tools: [...tools] }));
          } else if (e.type === "proposal") {
            proposal = e.proposal;
            setRun((r) => ({ ...r, proposal }));
          } else if (e.type === "done") {
            setRun((r) => ({ ...r, word: "PASS", note: "", text: e.text || text, proposal: proposal ?? r.proposal }));
          } else if (e.type === "error") {
            setRun((r) => ({ ...r, word: e.word, error: e.message, note: "" }));
          } else if (e.type === "usage") {
            setRun((r) => ({ ...r, note: `${e.iterations} turn${e.iterations === 1 ? "" : "s"} · ${(e.input / 1000).toFixed(1)}k in / ${(e.output / 1000).toFixed(1)}k out${e.cacheRead ? ` · ${(e.cacheRead / 1000).toFixed(1)}k cached` : ""}` }));
          }
        }
      }
      setRun((r) => (r.word === "RUNNING" ? { ...r, word: r.proposal ? "PASS" : "FAIL", error: r.proposal ? null : "stream ended without a proposal" } : r));
    } catch (e) {
      const stopped = abort.signal.aborted;
      setRun((r) => ({ ...r, word: stopped ? "FAIL" : "FAIL", error: stopped ? "stopped" : String((e as Error).message ?? e), note: "" }));
    } finally {
      abortRef.current = null;
    }
  }, []);

  return { run, start, stop, reset, busy: run.word === "RUNNING" };
}
