import { useMemo, useState } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";

// Mirrors RetroUsageReport from src/db/usage-queries.ts. Kept inline so the
// view is self-contained for ui-leaf's bundler.
interface TimelinePoint {
  date: string;
  count: number;
}
interface RetroUsageEntry {
  retro_id: string;
  cortex: string;
  content: string | null;
  created_at: string | null;
  surface_count: number;
  brief_count: number;
  recall_count: number;
  first_surfaced: string;
  last_surfaced: string;
  queries: string[];
  timeline: TimelinePoint[];
}
interface DeadRetro {
  retro_id: string;
  cortex: string;
  content: string;
  created_at: string;
}
interface RetroUsageReport {
  generated_at: string;
  total_surfacings: number;
  cortexes: string[];
  surfaced: RetroUsageEntry[];
  dead: DeadRetro[];
}

const COLORS = {
  bg: "#0f1115",
  panel: "#171a21",
  border: "#262b36",
  text: "#e6e9ef",
  dim: "#8a93a6",
  brief: "#5b9dff",
  recall: "#34d399",
  accent: "#f4b740",
  dead: "#6b7280",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function fmtAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function Sparkline({ points }: { points: TimelinePoint[] }) {
  const max = points.reduce((m, p) => Math.max(m, p.count), 0) || 1;
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 28 }}>
      {points.map((p) => (
        <div
          key={p.date}
          title={`${p.date}: ${p.count}`}
          style={{
            width: 6,
            height: `${Math.max(3, (p.count / max) * 28)}px`,
            background: COLORS.accent,
            borderRadius: 1,
            opacity: 0.85,
          }}
        />
      ))}
    </div>
  );
}

function SourceBar({ brief, recall }: { brief: number; recall: number }) {
  const total = brief + recall || 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 120 }}>
      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: COLORS.border }}>
        <div style={{ width: `${(brief / total) * 100}%`, background: COLORS.brief }} />
        <div style={{ width: `${(recall / total) * 100}%`, background: COLORS.recall }} />
      </div>
      <div style={{ fontSize: 11, color: COLORS.dim }}>
        <span style={{ color: COLORS.brief }}>brief {brief}</span>
        {"  ·  "}
        <span style={{ color: COLORS.recall }}>recall {recall}</span>
      </div>
    </div>
  );
}

function RetroRow({ entry }: { entry: RetroUsageEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        background: COLORS.panel,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 10,
        padding: "14px 16px",
        marginBottom: 10,
      }}
    >
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div
          style={{
            fontSize: 26,
            fontWeight: 700,
            color: COLORS.accent,
            minWidth: 48,
            textAlign: "right",
            lineHeight: 1,
          }}
          title="times surfaced"
        >
          {entry.surface_count}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: COLORS.text, fontSize: 14, lineHeight: 1.45 }}>
            {entry.content ?? <em style={{ color: COLORS.dim }}>(retro no longer in memories)</em>}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: COLORS.dim }}>
            <span style={{ color: COLORS.text }}>{entry.cortex}</span>
            {"  ·  last surfaced "}
            {fmtAgo(entry.last_surfaced)}
            {"  ·  created "}
            {fmtDate(entry.created_at)}
            {entry.queries.length > 0 && (
              <>
                {"  ·  "}
                <button
                  type="button"
                  onClick={() => setOpen((o) => !o)}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: COLORS.brief,
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 12,
                  }}
                >
                  {open ? "hide" : `${entry.queries.length} queries`}
                </button>
              </>
            )}
          </div>
          {open && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: COLORS.dim, fontSize: 12 }}>
              {entry.queries.map((q, i) => (
                <li key={i} style={{ marginBottom: 2 }}>
                  {q}
                </li>
              ))}
            </ul>
          )}
        </div>
        <SourceBar brief={entry.brief_count} recall={entry.recall_count} />
        <Sparkline points={entry.timeline} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 22, fontWeight: 700, color: COLORS.text }}>{value}</span>
      <span style={{ fontSize: 12, color: COLORS.dim }}>{label}</span>
    </div>
  );
}

export default function UsageRetros({ data }: ViewProps<RetroUsageReport>) {
  const [showDead, setShowDead] = useState(false);
  const surfaced = useMemo(
    () => [...data.surfaced].sort((a, b) => b.surface_count - a.surface_count),
    [data.surfaced],
  );

  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: COLORS.bg,
        color: COLORS.text,
        minHeight: "100vh",
        padding: "32px 24px",
      }}
    >
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Retro usage</h1>
        <p style={{ color: COLORS.dim, fontSize: 13, marginTop: 4 }}>
          How often each retro surfaces in <code>think recall</code> / <code>think brief</code>.
          Generated {fmtDate(data.generated_at)}.
        </p>

        <div
          style={{
            display: "flex",
            gap: 40,
            padding: "18px 20px",
            background: COLORS.panel,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            margin: "16px 0 24px",
          }}
        >
          <Stat label="total surfacings" value={data.total_surfacings} />
          <Stat label="retros surfaced" value={surfaced.length} />
          <Stat label="dead retros" value={data.dead.length} />
          <Stat label="cortexes" value={data.cortexes.length} />
        </div>

        {surfaced.length === 0 ? (
          <p style={{ color: COLORS.dim }}>No retros have surfaced yet.</p>
        ) : (
          surfaced.map((e) => <RetroRow key={`${e.cortex}/${e.retro_id}`} entry={e} />)
        )}

        {data.dead.length > 0 && (
          <div style={{ marginTop: 32 }}>
            <button
              type="button"
              onClick={() => setShowDead((s) => !s)}
              style={{
                background: "transparent",
                border: `1px solid ${COLORS.border}`,
                color: COLORS.text,
                borderRadius: 8,
                padding: "8px 12px",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {showDead ? "Hide" : "Show"} {data.dead.length} dead retro
              {data.dead.length === 1 ? "" : "s"} (never surfaced)
            </button>
            {showDead && (
              <div style={{ marginTop: 12 }}>
                {data.dead.map((d) => (
                  <div
                    key={`${d.cortex}/${d.retro_id}`}
                    style={{
                      borderLeft: `3px solid ${COLORS.dead}`,
                      padding: "8px 12px",
                      marginBottom: 8,
                      background: COLORS.panel,
                      borderRadius: "0 8px 8px 0",
                    }}
                  >
                    <div style={{ fontSize: 13, color: COLORS.text }}>{d.content}</div>
                    <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 4 }}>
                      {d.cortex} · created {fmtDate(d.created_at)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
