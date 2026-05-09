import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { usePolling } from "../hooks.js";

export function Models() {
  const { data, error } = usePolling(api.models, 5_000);

  return (
    <div>
      <h2 className="page-title">Models</h2>
      <div className="subtitle">model call breakdown by provider × model</div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h3>model calls / 10s · last 15m</h3>
          <TimeSeriesChart metric="model.calls" windowSec={900} height={180} />
        </div>
        <div className="panel">
          <h3>model errors / 10s · last 15m</h3>
          <TimeSeriesChart metric="model.errors" windowSec={900} height={180} />
        </div>
      </div>

      <div className="panel">
        <h3>per-model rollup</h3>
        {error ? (
          <div className="error-banner">{error}</div>
        ) : !data ? (
          <div className="empty">loading…</div>
        ) : (
          <DimensionTable rows={data.rows} keyLabel="provider / model" showTokens />
        )}
      </div>
    </div>
  );
}
