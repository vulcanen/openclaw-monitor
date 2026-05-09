import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { usePolling } from "../hooks.js";

export function Channels() {
  const { data, error } = usePolling(api.channels, 5_000);

  return (
    <div>
      <h2 className="page-title">Channels</h2>
      <div className="subtitle">message delivery health by channel</div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3>messages delivered / 10s · last 15m</h3>
        <TimeSeriesChart metric="messages.delivered" windowSec={900} height={180} />
      </div>

      <div className="panel">
        <h3>per-channel rollup</h3>
        {error ? (
          <div className="error-banner">{error}</div>
        ) : !data ? (
          <div className="empty">loading…</div>
        ) : (
          <DimensionTable rows={data.rows} keyLabel="channel" />
        )}
      </div>
    </div>
  );
}
