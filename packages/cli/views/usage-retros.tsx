import { useMemo } from "react";
import type { ViewProps } from "@openthink/ui-leaf/view";

interface RetroUsageEntry {
  retro_id: string;
  content: string | null;
  surface_count: number;
}
interface DeadRetro {
  retro_id: string;
  content: string;
}
interface RetroUsageReport {
  surfaced: RetroUsageEntry[];
  dead: DeadRetro[];
}

export default function UsageRetros({ data }: ViewProps<RetroUsageReport>) {
  const rows = useMemo(() => {
    const all = [
      ...data.surfaced.map((e) => ({ count: e.surface_count, text: e.content ?? "(deleted)" })),
      ...data.dead.map((d) => ({ count: 0, text: d.content })),
    ];
    return all.sort((a, b) => b.count - a.count);
  }, [data]);

  return (
    <div
      style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: "#fff",
        color: "#111",
        minHeight: "100vh",
        padding: 32,
      }}
    >
      <table style={{ borderCollapse: "collapse", fontSize: 15 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #111" }}>
            <th style={{ padding: "6px 16px 6px 0" }}>Times called</th>
            <th style={{ padding: "6px 0" }}>Retro</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #ddd" }}>
              <td style={{ padding: "8px 16px 8px 0", fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
                {r.count}
              </td>
              <td style={{ padding: "8px 0" }}>{r.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
