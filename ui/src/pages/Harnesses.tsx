import { useMemo } from "react";
import { api } from "../api.js";
import { DimensionTable } from "../components/DimensionTable.js";
import { usePolling } from "../hooks.js";
import { useI18n } from "../i18n/index.js";
import { harnessesFromEvents, type RawEvent } from "../lib/windowed-dimension.js";
import { useTimeWindow, WINDOW_TO_SECONDS } from "../time-window.js";

/**
 * Harness rollup page (v0.9.8+).
 *
 * Harness ids (e.g. `pi`, `codex-app-server`) are populated by host
 * 2026.5.14+ on `llm_output.harnessId` — see decision #59 in
 * rules/host-contract.md. Earlier hosts leave the field undefined; this page
 * renders an info banner in that case so operators don't think the plugin is
 * broken.
 */
export function Harnesses() {
  const { t } = useI18n();
  const { window: timeWindow } = useTimeWindow();

  const tokenFetcher = useMemo(
    () => () => api.events({ type: "llm.tokens.recorded", limit: 1000 }),
    [],
  );
  const { data, error } = usePolling(tokenFetcher, 5_000);

  const cutoffMs = Date.now() - WINDOW_TO_SECONDS[timeWindow] * 1000;
  const rows = useMemo(() => {
    const events = (data?.events ?? []) as RawEvent[];
    return harnessesFromEvents(events, cutoffMs);
  }, [data, cutoffMs]);

  const loading = !data;
  // True when every priced event in the window lacks a harnessId — proxy for
  // "host < 2026.5.14" since the field is otherwise always populated.
  const totalEvents = (data?.events ?? []).length;
  const hostMissingField = !loading && totalEvents > 0 && rows.length === 0;

  return (
    <div>
      <h2 className="page-title">{t("harnesses.title")}</h2>
      <div className="subtitle">{t("harnesses.subtitle")}</div>

      <div className="panel">
        <h3>
          {t("harnesses.rollup")}{" "}
          <span
            style={{
              fontSize: 11,
              color: "var(--text-dim)",
              fontWeight: 400,
              letterSpacing: 0,
              textTransform: "none",
              marginLeft: 8,
            }}
          >
            · {t(`topbar.window.${timeWindow}`)}
          </span>
        </h3>
        {error ? (
          <div className="error-banner" role="alert">
            {error}
          </div>
        ) : loading ? (
          <div className="empty">{t("common.loading")}</div>
        ) : hostMissingField ? (
          <div className="empty">{t("harnesses.empty.noField")}</div>
        ) : (
          <DimensionTable rows={rows} keyLabel={t("harnesses.col.key")} showTokens />
        )}
      </div>
    </div>
  );
}
