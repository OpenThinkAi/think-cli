import { useEffect, useRef, useState } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";

interface PanelItem {
  title: string;
  detail?: string;
  time?: string;
}
interface PanelMeta {
  key: string;
  title: string;
  accent: string;
  render: "digest" | "today";
}
interface DashboardData {
  cortex: string | null;
  windowDays: number;
  generatedAt: string;
  panels: PanelMeta[];
  items: Record<string, PanelItem[]>;
}

const INK = "#1a1a1a";
const MUTE = "#6b7280";
const BORDER = "1px solid #e5e7eb";
const CARD_BG = "#ffffff";
const PAGE_BG = "#f7f7f8";

// AI-panel refresh is manual; the raw 'today' panels poll the DB cheaply.
const TODAY_POLL_MS = 20_000;

function fmtAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Minimal, dependency-free markdown-ish rendering for the answer box. */
function renderAnswer(text: string) {
  return text.split("\n").map((line, i) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("### ") || trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
      return (
        <div key={i} style={{ fontWeight: 700, marginTop: i ? "0.6rem" : 0 }}>
          {trimmed.replace(/^#+\s/, "")}
        </div>
      );
    }
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      return (
        <div key={i} style={{ paddingLeft: "1rem", textIndent: "-0.6rem" }}>
          • {inline(trimmed.slice(2))}
        </div>
      );
    }
    if (trimmed === "") return <div key={i} style={{ height: "0.5rem" }} />;
    return <div key={i}>{inline(trimmed)}</div>;
  });
}

/** Render **bold** and `code` spans inline without a markdown lib. */
function inline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`"))
      return (
        <code key={i} style={{ background: "#f0f0f1", borderRadius: 3, padding: "0 3px", fontSize: "0.85em" }}>
          {p.slice(1, -1)}
        </code>
      );
    return <span key={i}>{p}</span>;
  });
}

function Panel({ meta, items }: { meta: PanelMeta; items: PanelItem[] }) {
  return (
    <section
      style={{
        background: CARD_BG,
        border: BORDER,
        borderRadius: 10,
        padding: "1rem 1.1rem",
        display: "flex",
        flexDirection: "column",
        minHeight: "12rem",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, background: meta.accent }} />
        <h2 style={{ fontSize: "0.8rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", margin: 0 }}>
          {meta.title}
        </h2>
        <span style={{ marginLeft: "auto", color: MUTE, fontSize: "0.8rem" }}>{items.length}</span>
      </header>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        {items.length === 0 ? (
          <div style={{ color: MUTE, fontSize: "0.85rem", fontStyle: "italic" }}>
            {meta.render === "today" ? "Nothing yet today." : "Nothing here."}
          </div>
        ) : (
          items.map((it, i) => (
            <div key={i} style={{ fontSize: "0.9rem", lineHeight: 1.4 }}>
              <div style={{ color: INK }}>
                {it.time && <span style={{ color: MUTE, fontSize: "0.8rem", marginRight: "0.5rem" }}>{it.time}</span>}
                {it.title}
              </div>
              {it.detail && <div style={{ color: MUTE, fontSize: "0.82rem", marginTop: 1 }}>{it.detail}</div>}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export default function Dashboard({ data, mutate }: ViewProps<DashboardData>) {
  const [items, setItems] = useState<Record<string, PanelItem[]>>(data.items);
  const [generatedAt, setGeneratedAt] = useState<string>(data.generatedAt);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [askErr, setAskErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasTodayPanel = data.panels.some((p) => p.render === "today");
  const cols = Math.min(Math.max(data.panels.length, 1), 4);

  // Live tail of the raw 'today' panels — no AI, cheap DB poll.
  useEffect(() => {
    if (!hasTodayPanel) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await mutate<{ items: Record<string, PanelItem[]> }>("today");
        if (alive) setItems((prev) => ({ ...prev, ...r.items }));
      } catch {
        /* transient — keep last good lists */
      }
    };
    const id = setInterval(tick, TODAY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mutate, hasTodayPanel]);

  async function refresh() {
    setRefreshing(true);
    setRefreshErr(null);
    try {
      const r = await mutate<DashboardData>("refresh");
      setItems(r.items);
      setGeneratedAt(r.generatedAt);
    } catch (e) {
      setRefreshErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setAskErr(null);
    setAnswer(null);
    try {
      const r = await mutate<{ answer: string }>("ask", { question: q });
      setAnswer(r.answer);
    } catch (err) {
      setAskErr(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: PAGE_BG,
        color: INK,
        minHeight: "100vh",
        padding: "2rem 1.5rem 3rem",
      }}
    >
      <div style={{ maxWidth: "60rem", margin: "0 auto" }}>
        <header style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "1.25rem" }}>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>think</h1>
          <span style={{ color: MUTE, fontSize: "0.85rem" }}>
            {data.cortex ? `cortex: ${data.cortex}` : "local"} · last {data.windowDays}d
          </span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ color: MUTE, fontSize: "0.8rem" }}>updated {fmtAgo(generatedAt)}</span>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              style={{
                border: BORDER,
                background: CARD_BG,
                borderRadius: 7,
                padding: "0.35rem 0.8rem",
                fontSize: "0.85rem",
                cursor: refreshing ? "default" : "pointer",
                color: INK,
              }}
            >
              {refreshing ? "Refreshing…" : "↻ Refresh"}
            </button>
          </div>
        </header>

        {refreshErr && (
          <p role="alert" style={{ color: "#b91c1c", fontSize: "0.85rem", marginTop: 0 }}>
            {refreshErr}
          </p>
        )}

        {/* The prompt box — the focal center of the dashboard. */}
        <form
          onSubmit={ask}
          style={{
            background: CARD_BG,
            border: BORDER,
            borderRadius: 12,
            padding: "1rem 1.1rem",
            marginBottom: "1.5rem",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <input
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask anything about your work — “what did I decide about the V2 schema?”"
              disabled={asking}
              style={{ flex: 1, border: "none", outline: "none", fontSize: "1rem", background: "transparent", color: INK }}
            />
            <button
              type="submit"
              disabled={asking || !question.trim()}
              style={{
                border: "none",
                background: question.trim() && !asking ? "#111827" : "#d1d5db",
                color: "#fff",
                borderRadius: 8,
                padding: "0.45rem 1.1rem",
                fontSize: "0.9rem",
                cursor: asking || !question.trim() ? "default" : "pointer",
              }}
            >
              {asking ? "Thinking…" : "Ask"}
            </button>
          </div>
          {(answer || askErr || asking) && (
            <div
              style={{
                marginTop: "0.9rem",
                paddingTop: "0.9rem",
                borderTop: BORDER,
                fontSize: "0.92rem",
                lineHeight: 1.5,
                color: askErr ? "#b91c1c" : INK,
              }}
            >
              {asking && <span style={{ color: MUTE }}>Searching your corpus…</span>}
              {askErr && <span>{askErr}</span>}
              {answer && <div>{renderAnswer(answer)}</div>}
            </div>
          )}
        </form>

        {/* Panels — rendered generically from the configured panel set. */}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: "1rem" }}>
          {data.panels.map((p) => (
            <Panel key={p.key} meta={p} items={items[p.key] ?? []} />
          ))}
        </div>
      </div>
    </div>
  );
}
