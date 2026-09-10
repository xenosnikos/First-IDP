"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Pill } from "@/components/nebula/pill";
import { Button } from "@/components/nebula/button";
import { inputStyle } from "@/components/nebula/plate";
import { parseSseFrames } from "@/lib/nebula/sse";
import type { ObserverEvent, ObserverKind } from "@twizz-idp/observer"; // type-only: erased, the SDK never reaches the client bundle

// Observer (phase 1): the read-only log assistant, first incarnation of the
// "Observer" agent (docs/NEBULA.md §1 lists it as STUB). It sees exactly the
// scope the human applied in the Logs panel; every run is audited server-side.
// Words: STUB (no key) · DENIED (budget) · RUNNING · PASS · FAIL.

type Scope = { cluster: string; namespace: string; pod?: string; from: string; to: string };
type Turn = { role: "user" | "assistant"; content: string; kind?: ObserverKind; tools?: string[] };

export function ObserverPanel({ scope, selection }: { scope: Scope | null; selection: string }) {
  const status = trpc.observer.status.useQuery(undefined, { refetchInterval: 60_000, retry: false });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState<{ text: string; tools: string[] } | null>(null);
  const [word, setWord] = useState<"PASS" | "RUNNING" | "FAIL" | "DENIED" | "STUB" | null>(null);
  const [note, setNote] = useState<string>("");
  const [question, setQuestion] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns, live]);

  const configured = status.data?.configured ?? false;
  const denied = status.data?.word === "DENIED";
  const busy = word === "RUNNING";
  const canRun = !!scope && configured && !denied && !busy;

  const run = async (kind: ObserverKind, userText?: string) => {
    if (!scope) return;
    const label = kind === "chat" ? userText ?? "" : kind === "explain" ? `Explain this trace (${selection.split("\n").length} lines)` : kind === "errors" ? "Find errors" : "Summarize";
    const history = turns.filter((t) => t.content).map((t) => ({ role: t.role, content: t.content.slice(0, 8000) }));
    setTurns((t) => [...t, { role: "user", content: label, kind }]);
    setLive({ text: "", tools: [] });
    setWord("RUNNING");
    setNote("");
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await fetch("/api/observer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, kind, history, selection: kind === "explain" ? selection : undefined, userText }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { word?: string; message?: string };
        setWord((body.word as typeof word) ?? "FAIL");
        setNote(body.message ?? `HTTP ${res.status}`);
        setLive(null);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let text = "";
      const tools: string[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buf);
        buf = parsed.rest;
        for (const ev of parsed.events) {
          let e: ObserverEvent;
          try {
            e = JSON.parse(ev.data) as ObserverEvent;
          } catch {
            continue;
          }
          if (e.type === "text") {
            text += e.delta;
            setLive({ text, tools: [...tools] });
          } else if (e.type === "status") setNote(e.note ?? "");
          else if (e.type === "tool_use") {
            tools.push(`${e.name} ${summarizeInput(e.input)}`);
            setLive({ text, tools: [...tools] });
            setNote(`running ${e.name}`);
          } else if (e.type === "tool_result") {
            const i = tools.length - 1;
            if (i >= 0) tools[i] = `${tools[i]} → ${[e.status, e.lines != null ? `${e.lines} lines` : null, e.groups != null ? `${e.groups} groups` : null, e.redacted ? `${e.redacted} redacted` : null, `${(e.ms / 1000).toFixed(1)}s`].filter(Boolean).join(" · ")}`;
            setLive({ text, tools: [...tools] });
          } else if (e.type === "done") {
            setTurns((t) => [...t, { role: "assistant", content: e.text || text, tools }]);
            setLive(null);
            setWord("PASS");
            setNote("");
          } else if (e.type === "error") {
            setTurns((t) => [...t, { role: "assistant", content: (text ? text + "\n\n" : "") + `[${e.word}] ${e.message}`, tools }]);
            setLive(null);
            setWord(e.word);
            setNote(e.message);
          } else if (e.type === "usage") {
            setNote(`${e.iterations} turn${e.iterations === 1 ? "" : "s"} · ${(e.input / 1000).toFixed(1)}k in / ${(e.output / 1000).toFixed(1)}k out${e.cacheRead ? ` · ${(e.cacheRead / 1000).toFixed(1)}k cached` : ""}`);
          }
        }
      }
      if (word === "RUNNING") setWord("PASS");
    } catch (e) {
      const stopped = abort.signal.aborted;
      setTurns((t) => [...t, { role: "assistant", content: stopped ? "[stopped]" : `[FAIL] ${String((e as Error).message ?? e)}` }]);
      setLive(null);
      setWord(stopped ? "PASS" : "FAIL");
    } finally {
      abortRef.current = null;
      status.refetch();
    }
  };

  const headerWord = busy ? "RUNNING" : (status.data?.word ?? "PENDING");

  return (
    <aside className="n-plate" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, maxHeight: 640, minWidth: 0 }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <div className="n-display" style={{ fontSize: 18 }}>Observer</div>
        <Pill word={headerWord} title={status.data?.reason} />
      </header>
      <div style={{ fontSize: 10, color: "var(--n-ink-muted)", lineHeight: 1.5 }}>
        read-only log analyst · scope = the applied query · every run is audited
        {status.data && <> · runs today {status.data.actorRunsToday} / {status.data.perActorCap} (you) · {status.data.runsToday} / {status.data.dailyCap} (all)</>}
      </div>
      {!scope && <div style={{ fontSize: 11, color: "var(--n-ink-muted)" }}><Pill word="PENDING" /> Query logs first — Observer works on the applied scope.</div>}
      {status.data && !configured && <div style={{ fontSize: 11, color: "var(--n-ink-muted)" }}><Pill word="STUB" /> {status.data.reason}</div>}
      {status.data && configured && denied && <div style={{ fontSize: 11, color: "var(--n-ink-muted)" }}><Pill word="DENIED" /> {status.data.reason}</div>}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button variant="ion" disabled={!canRun} onClick={() => run("summarize")} style={{ padding: "5px 9px", fontSize: 10 }}>Summarize</Button>
        <Button variant="ion" disabled={!canRun} onClick={() => run("errors")} style={{ padding: "5px 9px", fontSize: 10 }}>Find errors</Button>
        <Button variant="ion" disabled={!canRun || !selection} onClick={() => run("explain")} style={{ padding: "5px 9px", fontSize: 10 }} title={selection ? `${selection.split("\n").length} selected lines` : "select lines in the log view first"}>
          Explain this trace
        </Button>
        {busy && <Button variant="danger" onClick={() => abortRef.current?.abort()} style={{ padding: "5px 9px", fontSize: 10, marginLeft: "auto" }}>Stop</Button>}
      </div>

      <div style={{ flex: 1, minHeight: 120, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, fontSize: 11, lineHeight: 1.55 }}>
        {turns.map((t, i) => (
          <div key={i} style={{ background: t.role === "user" ? "var(--n-raised)" : "var(--n-surface)", border: "1px solid var(--n-hairline)", borderRadius: "var(--n-radius)", padding: "8px 10px" }}>
            {t.role === "user" ? (
              <div style={{ color: "var(--n-ion-soft)" }}>{t.content}</div>
            ) : (
              <>
                {t.tools && t.tools.length > 0 && <ToolRows tools={t.tools} />}
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--n-ink)" }}>{t.content}</div>
              </>
            )}
          </div>
        ))}
        {live && (
          <div style={{ background: "var(--n-surface)", border: "1px solid var(--n-ion)", borderRadius: "var(--n-radius)", padding: "8px 10px" }}>
            {live.tools.length > 0 && <ToolRows tools={live.tools} />}
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--n-ink)" }}>{live.text || <span style={{ color: "var(--n-ink-muted)" }}>{note || "thinking…"}</span>}</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {note && !busy && <div style={{ fontSize: 10, color: "var(--n-ink-faint)" }}>{note}</div>}
      {busy && note && <div style={{ fontSize: 10, color: "var(--n-ink-faint)" }}><Pill word="RUNNING" /> {note}</div>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const q = question.trim();
          if (!q || !canRun) return;
          setQuestion("");
          run("chat", q);
        }}
        style={{ display: "flex", gap: 6 }}
      >
        <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={scope ? "ask about these logs…" : "query logs first"} disabled={!canRun} style={{ ...inputStyle, flex: 1 }} maxLength={4000} />
        <Button variant="ion" type="submit" disabled={!canRun || !question.trim()} style={{ padding: "6px 10px", fontSize: 10 }}>Ask</Button>
      </form>
    </aside>
  );
}

function ToolRows({ tools }: { tools: string[] }) {
  return (
    <div style={{ marginBottom: 6, display: "flex", flexDirection: "column", gap: 2 }}>
      {tools.map((t, i) => (
        <div key={i} style={{ fontSize: 10, color: "var(--n-ink-muted)", wordBreak: "break-word" }}>⌁ {t}</div>
      ))}
    </div>
  );
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}
