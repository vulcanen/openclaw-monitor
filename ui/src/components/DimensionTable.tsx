import type { DimensionRow } from "../api.js";

type Props = {
  rows: DimensionRow[];
  keyLabel: string;
  showTokens?: boolean;
};

function fmtMs(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

function fmtPct(num: number, denom: number): string {
  if (denom === 0) return "0%";
  const pct = (num / denom) * 100;
  if (pct < 0.01) return "<0.01%";
  return `${pct.toFixed(2)}%`;
}

export function DimensionTable({ rows, keyLabel, showTokens = false }: Props) {
  if (rows.length === 0) {
    return <div className="empty">no data captured yet</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>{keyLabel}</th>
          <th className="num">total</th>
          <th className="num">errors</th>
          <th className="num">err rate</th>
          <th className="num">p50</th>
          <th className="num">p95</th>
          {showTokens ? <th className="num">tokens in</th> : null}
          {showTokens ? <th className="num">tokens out</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>{row.key}</td>
            <td className="num">{row.total}</td>
            <td className={`num ${row.errors > 0 ? "err" : ""}`}>{row.errors}</td>
            <td className={`num ${row.errors > 0 ? "err" : ""}`}>
              {fmtPct(row.errors, row.total)}
            </td>
            <td className="num">{fmtMs(row.p50Ms)}</td>
            <td className="num">{fmtMs(row.p95Ms)}</td>
            {showTokens ? <td className="num">{row.tokensIn ?? 0}</td> : null}
            {showTokens ? <td className="num">{row.tokensOut ?? 0}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
