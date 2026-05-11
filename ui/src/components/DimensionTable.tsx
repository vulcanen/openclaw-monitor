import type { DimensionRow } from "../api.js";
import { useI18n } from "../i18n/index.js";

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
  const { t } = useI18n();
  if (rows.length === 0) {
    return <div className="empty">{t("empty.dataYet")}</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>{keyLabel}</th>
          <th className="num">{t("dim.col.total")}</th>
          <th className="num">{t("dim.col.errors")}</th>
          <th className="num">{t("dim.col.errRate")}</th>
          <th className="num">{t("dim.col.p50")}</th>
          <th className="num">{t("dim.col.p95")}</th>
          {showTokens ? <th className="num">{t("dim.col.tokensIn")}</th> : null}
          {showTokens ? <th className="num">{t("dim.col.tokensOut")}</th> : null}
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
