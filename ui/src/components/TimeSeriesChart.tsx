import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, type SeriesPoint } from "../api.js";

type Props = {
  metric: string;
  windowSec?: number;
  height?: number;
};

export function TimeSeriesChart({ metric, windowSec = 900, height = 200 }: Props) {
  const [points, setPoints] = useState<SeriesPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await api.series(metric, windowSec);
        if (active) {
          setPoints(result.points);
          setError(null);
        }
      } catch (err) {
        if (active) setError(String(err));
      }
    };
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [metric, windowSec]);

  if (error) return <div className="error-banner">series load failed: {error}</div>;
  if (points.length === 0) return <div className="empty">no data yet</div>;

  const data = points.map((p) => ({
    ts: p.ts,
    label: new Date(p.ts).toLocaleTimeString(),
    value: p.value,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`grad-${metric}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#58a6ff" stopOpacity={0.5} />
            <stop offset="95%" stopColor="#58a6ff" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a3142" />
        <XAxis dataKey="label" tick={{ fill: "#8b949e", fontSize: 11 }} stroke="#2a3142" />
        <YAxis tick={{ fill: "#8b949e", fontSize: 11 }} stroke="#2a3142" allowDecimals={false} />
        <Tooltip
          contentStyle={{
            background: "#161b22",
            border: "1px solid #2a3142",
            borderRadius: 6,
            fontSize: 12,
          }}
          labelStyle={{ color: "#8b949e" }}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="#58a6ff"
          strokeWidth={2}
          fill={`url(#grad-${metric})`}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
