import { useI18n } from "../i18n/index.js";

/**
 * Simple front-end pager. Pages are 1-indexed for display, 0-indexed in
 * the `page` state value supplied by the caller. We deliberately keep
 * page-size + page-index in the consumer page's state so the URL / scroll
 * position stay scoped to that page; this component is pure UI.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100, 200],
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (next: number) => void;
  onPageSizeChange?: (next: number) => void;
  pageSizeOptions?: number[];
}) {
  const { t } = useI18n();
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const startIdx = total === 0 ? 0 : safePage * pageSize + 1;
  const endIdx = Math.min(total, (safePage + 1) * pageSize);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 4px",
        fontSize: 12,
        color: "var(--text-dim)",
        flexWrap: "wrap",
      }}
    >
      <span>
        {t("pagination.range", {
          start: startIdx,
          end: endIdx,
          total,
        })}
      </span>
      <span style={{ flex: 1 }} />
      {onPageSizeChange ? (
        <>
          <label htmlFor="page-size">{t("pagination.pageSize")}</label>
          <select
            id="page-size"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number.parseInt(e.target.value, 10))}
            style={{
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              padding: "2px 8px",
              borderRadius: 4,
              fontFamily: "var(--font)",
              fontSize: 12,
            }}
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <button
        type="button"
        disabled={safePage === 0}
        onClick={() => onPageChange(safePage - 1)}
        style={pagerButton(safePage === 0)}
      >
        {t("pagination.prev")}
      </button>
      <span style={{ fontFamily: "var(--mono)" }}>
        {t("pagination.pageOf", { page: safePage + 1, total: pageCount })}
      </span>
      <button
        type="button"
        disabled={safePage >= pageCount - 1}
        onClick={() => onPageChange(safePage + 1)}
        style={pagerButton(safePage >= pageCount - 1)}
      >
        {t("pagination.next")}
      </button>
    </div>
  );
}

function pagerButton(disabled: boolean): React.CSSProperties {
  return {
    background: "var(--panel-2)",
    border: "1px solid var(--border)",
    color: disabled ? "var(--text-dim)" : "var(--text)",
    padding: "4px 10px",
    borderRadius: 4,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "var(--font)",
    fontSize: 12,
    opacity: disabled ? 0.5 : 1,
  };
}
