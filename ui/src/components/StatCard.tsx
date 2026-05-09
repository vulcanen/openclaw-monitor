import type { ReactNode } from "react";

export type StatCardProps = {
  label: string;
  value: ReactNode;
  delta?: string;
  tone?: "good" | "bad" | "warn" | "neutral";
};

export function StatCard({ label, value, delta, tone = "neutral" }: StatCardProps) {
  return (
    <div className="panel stat">
      <h3>{label}</h3>
      <div className="value">{value}</div>
      {delta ? <div className={`delta ${tone === "neutral" ? "" : tone}`}>{delta}</div> : null}
    </div>
  );
}
