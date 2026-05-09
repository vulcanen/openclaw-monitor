import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { TimeSeriesChart } from "../components/TimeSeriesChart.js";
import { usePolling } from "../hooks.js";

export function Tools() {
  const { data, error } = usePolling(api.tools, 5_000);

  return (
    <div>
      <h2 className="page-title">Tools</h2>
      <div className="subtitle">tool execution top-N + blocked / errored counts</div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h3>tool execs / 10s · last 15m</h3>
          <TimeSeriesChart metric="tool.execs" windowSec={900} height={180} />
        </div>
        <div className="panel">
          <h3>tool errors + blocks / 10s · last 15m</h3>
          <TimeSeriesChart metric="tool.errors" windowSec={900} height={180} />
        </div>
      </div>

      <div className="panel">
        <h3>per-tool rollup</h3>
        {error ? (
          <div className="error-banner">{error}</div>
        ) : !data ? (
          <div className="empty">loading…</div>
        ) : (
          <DimensionTable rows={data.rows} keyLabel="tool" />
        )}
      </div>
    </div>
  );
}
