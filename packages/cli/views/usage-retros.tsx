import { useMemo } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";

interface BySource {
  brief: number;
  recall: number;
  mcp: number;
  hook: number;
}
interface RetroUsageEntry {
  retro_id: string;
  cortex: string;
  content: string | null;
  created_at: string | null;
  surface_count: number;
  by_source: BySource;
  session_start_count: number;
  mid_session_count: number;
  first_surfaced: string;
  last_surfaced: string;
  queries: string[];
  timeline: { date: string; count: number }[];
}
interface DeadRetro {
  retro_id: string;
  cortex: string;
  content: string;
}
interface RetroUsageReport {
  surfaced: RetroUsageEntry[];
  dead: DeadRetro[];
}

const BORDER = "1px solid #e2e2e2";

function fmtAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function sources(b: BySource): string {
  const parts: string[] = [];
  if (b.brief) parts.push(`brief ${b.brief}`);
  if (b.recall) parts.push(`recall ${b.recall}`);
  if (b.mcp) parts.push(`mcp ${b.mcp}`);
  if (b.hook) parts.push(`hook ${b.hook}`);
  return parts.join(", ") || "—";
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  borderBottom: "2px solid #111",
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "#555",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = { padding: "10px 12px", borderBottom: BORDER, verticalAlign: "top" };
const num: React.CSSProperties = { ...td, fontVariantNumeric: "tabular-nums", fontWeight: 700, textAlign: "right" };

export default function UsageRetros({ data }: ViewProps<RetroUsageReport>) {
  const rows = useMemo(
    () => [...data.surfaced].sort((a, b) => b.surface_count - a.surface_count),
    [data.surfaced],
  );

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", color: "#111", background: "#fff", minHeight: "100vh", padding: 28 }}>
      <h1 style={{ fontSize: 20, margin: "0 0 16px" }}>Retro usage</h1>

      <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 1100, fontSize: 14 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "right" }}>Called</th>
            <th style={th}>Retro</th>
            <th style={th}>Repo</th>
            <th style={th}>Session stage</th>
            <th style={th}>Where from</th>
            <th style={th}>Last</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={`${e.cortex}/${e.retro_id}`}>
              <td style={num}>{e.surface_count}</td>
              <td style={{ ...td, maxWidth: 520 }}>
                {e.content ?? <em style={{ color: "#999" }}>(deleted)</em>}
                {e.queries.length > 0 && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ cursor: "pointer", color: "#2563eb", fontSize: 12 }}>
                      {e.queries.length} queries
                    </summary>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#555", fontSize: 12 }}>
                      {e.queries.map((q, i) => (
                        <li key={i}>“{q}”</li>
                      ))}
                    </ul>
                  </details>
                )}
              </td>
              <td style={td}>{e.cortex}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>
                {e.session_start_count} start / {e.mid_session_count} mid
              </td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{sources(e.by_source)}</td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtAgo(e.last_surfaced)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td style={td} colSpan={6}>
                No retros have been called yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {data.dead.length > 0 && (
        <>
          <h2 style={{ fontSize: 15, margin: "28px 0 8px" }}>
            Never called <span style={{ color: "#888", fontWeight: 400 }}>— candidates to delete ({data.dead.length})</span>
          </h2>
          <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 1100, fontSize: 14 }}>
            <thead>
              <tr>
                <th style={th}>Retro</th>
                <th style={th}>Repo</th>
              </tr>
            </thead>
            <tbody>
              {data.dead.map((d) => (
                <tr key={`${d.cortex}/${d.retro_id}`}>
                  <td style={{ ...td, maxWidth: 700, color: "#444" }}>{d.content}</td>
                  <td style={td}>{d.cortex}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
