import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, type CostDimensionRow, type CostRangeSummary } from "../api.js";
import { StatCard } from "../components/StatCard.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import { useTimeWindow } from "../time-window.js";
import type { TimeWindow } from "../time-window.js";

function costWindowKey(w: TimeWindow): "1m" | "5m" | "15m" | "1h" {
  if (w === "1m" || w === "5m" || w === "15m" || w === "1h") return w;
  return "1h";
}

function fmtMoney(value: number, currency: string): string {
  // The currency string is a free-form display unit (CNY / USD / EUR ...).
  // We avoid Intl.NumberFormat to sidestep locale-specific symbol surprises;
  // operators usually want the raw value with the literal unit attached.
  if (value === 0) return `0 ${currency}`;
  if (Math.abs(value) < 0.01) return `${value.toFixed(6)} ${currency}`;
  if (Math.abs(value) < 1) return `${value.toFixed(4)} ${currency}`;
  return `${value.toFixed(2)} ${currency}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function DimensionTable({
  rows,
  currency,
  keyLabel,
}: {
  rows: CostDimensionRow[];
  currency: string;
  keyLabel: string;
}) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return <div className="empty">{t("costs.empty.dimension")}</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>{keyLabel}</th>
          <th className="num">{t("costs.col.calls")}</th>
          <th className="num">{t("costs.col.tokensIn")}</th>
          <th className="num">{t("costs.col.tokensOut")}</th>
          <th className="num">{t("costs.col.cost")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.key}</td>
            <td className="num">{r.calls}</td>
            <td className="num">{fmtTokens(r.tokensIn)}</td>
            <td className="num">{fmtTokens(r.tokensOut)}</td>
            <td className="num">{fmtMoney(r.cost, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RangeStatCard({
  label,
  range,
  currency,
}: {
  label: string;
  range: CostRangeSummary;
  currency: string;
}) {
  const { t } = useI18n();
  const totalTokens =
    range.tokensIn + range.tokensOut + range.cacheReadTokens + range.cacheWriteTokens;
  return (
    <StatCard
      label={label}
      value={fmtMoney(range.cost, currency)}
      delta={t("costs.stat.tokensTotal", { value: fmtTokens(totalTokens) })}
      tone="neutral"
    />
  );
}

export function Costs() {
  const { t } = useI18n();
  const { window: timeWindow } = useTimeWindow();
  const fetcher = useMemo(() => api.costs, []);
  const { data, error } = usePolling(fetcher, 10_000);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="empty">{t("common.loading")}</div>;

  const currency = data.currency;
  const dailyChart = data.daily.map((d) => ({
    day: d.day,
    cost: Number(d.cost.toFixed(4)),
  }));
  const windowedRange = data.windows[costWindowKey(timeWindow)];

  return (
    <div>
      <h2 className="page-title">{t("costs.title")}</h2>
      <div className="subtitle">
        {t("costs.subtitle", {
          currency,
          time: new Date(data.generatedAt).toLocaleTimeString(),
        })}
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        {/* First card now follows the global window selector — most-asked
            question is "how much did I spend in the last N minutes / hour".
            today / thisWeek / thisMonth are still on the second row so the
            persistent context isn't lost. */}
        <RangeStatCard
          label={t("costs.range.window", {
            window: t(`topbar.window.${costWindowKey(timeWindow)}`),
          })}
          range={windowedRange}
          currency={currency}
        />
        <RangeStatCard label={t("costs.range.today")} range={data.today} currency={currency} />
        <RangeStatCard
          label={t("costs.range.thisWeek")}
          range={data.thisWeek}
          currency={currency}
        />
        <RangeStatCard
          label={t("costs.range.thisMonth")}
          range={data.thisMonth}
          currency={currency}
        />
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>{t("costs.chart.last30d")}</h3>
        {dailyChart.length === 0 ? (
          <div className="empty">{t("costs.empty.daily")}</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={dailyChart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="grad-cost" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#58a6ff" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="#58a6ff" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a3142" />
              <XAxis dataKey="day" tick={{ fill: "#8b949e", fontSize: 11 }} stroke="#2a3142" />
              <YAxis
                tick={{ fill: "#8b949e", fontSize: 11 }}
                stroke="#2a3142"
                tickFormatter={(v: number) => `${v}`}
              />
              <Tooltip
                contentStyle={{
                  background: "#161b22",
                  border: "1px solid #2a3142",
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelStyle={{ color: "#8b949e" }}
                formatter={(value: number) => [`${value} ${currency}`, t("costs.col.cost")]}
              />
              <Area
                type="monotone"
                dataKey="cost"
                stroke="#58a6ff"
                strokeWidth={2}
                fill="url(#grad-cost)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h3>{t("costs.section.byModel")}</h3>
          {/* Horizontal "share of cost" bar chart above the table (v0.9.7).
              Surfaces "which model is eating my budget" at a glance — the
              table below still has the precise numbers for follow-up. */}
          {data.byModel.length > 0 && data.byModel.some((m) => m.cost > 0) ? (
            <div style={{ height: Math.max(60, Math.min(220, data.byModel.length * 28)) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={[...data.byModel].sort((a, b) => b.cost - a.cost).slice(0, 8)}
                  layout="vertical"
                  margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
                >
                  <CartesianGrid horizontal={false} stroke="#2a3142" />
                  <XAxis
                    type="number"
                    stroke="#8b949e"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v: number) => fmtMoney(v, currency)}
                  />
                  <YAxis
                    type="category"
                    dataKey="key"
                    stroke="#8b949e"
                    tick={{ fontSize: 11, fontFamily: "var(--mono)" }}
                    width={150}
                  />
                  <Tooltip
                    formatter={(v: number) => fmtMoney(v, currency)}
                    contentStyle={{
                      background: "#161b22",
                      border: "1px solid #2a3142",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                  {/* matches --accent */}
                  <Bar dataKey="cost" fill="#58a6ff" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : null}
          <DimensionTable rows={data.byModel} currency={currency} keyLabel={t("costs.col.model")} />
        </div>
        <div className="panel">
          <h3>{t("costs.section.byChannel")}</h3>
          <DimensionTable
            rows={data.byChannel}
            currency={currency}
            keyLabel={t("costs.col.channel")}
          />
        </div>
      </div>

      <div className="panel">
        <h3>{t("costs.section.bySource")}</h3>
        <DimensionTable rows={data.bySource} currency={currency} keyLabel={t("costs.col.source")} />
      </div>

      {data.byModel.every((m) => m.tokensIn === 0 && m.tokensOut === 0) &&
      data.byModel.length > 0 ? (
        <div className="panel" style={{ marginTop: 16, borderLeft: "3px solid var(--warn)" }}>
          <div style={{ fontSize: 13, color: "var(--warn)", marginBottom: 8 }}>
            {t("costs.notice.noTokens")}
          </div>
          {/* Three-tier diagnostic. The same shape as ConversationDetail's
              half-captured hint (decision #42): tell the operator the most
              common cause, the second most common, and the rare one — in
              order of likelihood — so they can fix it without spelunking
              through host source. */}
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.7 }}>
            <div style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }}>1.</strong>{" "}
              {t("costs.notice.noTokensHint.gate")}
            </div>
            <div style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }}>2.</strong>{" "}
              {t("costs.notice.noTokensHint.compat")}
            </div>
            <div>
              <strong style={{ color: "var(--text)" }}>3.</strong>{" "}
              {t("costs.notice.noTokensHint.adapter")}
            </div>
          </div>
        </div>
      ) : data.byModel.every((m) => m.cost === 0) && data.byModel.length > 0 ? (
        <div className="panel" style={{ marginTop: 16, borderLeft: "3px solid var(--warn)" }}>
          <div style={{ fontSize: 13, color: "var(--warn)", marginBottom: 8 }}>
            {t("costs.notice.noPricing")}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.6 }}>
            {t("costs.notice.noPricingHint")}
          </div>
        </div>
      ) : null}
    </div>
  );
}
