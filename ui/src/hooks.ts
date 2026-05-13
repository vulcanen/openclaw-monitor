import { useEffect, useState } from "react";
import { ApiError } from "./api.js";

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 5_000,
): { data: T | undefined; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const result = await fetcher();
        if (active) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!active) return;
        // Friendly errors only for ApiError. UnauthorizedError is handled
        // globally by the auth gate so we deliberately swallow it here —
        // surfacing it again would be redundant. Anything else is an
        // unexpected programmer error: keep the raw String(err) for
        // debugging visibility but cap to one line.
        if (err instanceof ApiError) {
          setError(err.friendly());
        } else if (err instanceof Error && err.name === "UnauthorizedError") {
          // Auth gate takes over; clear any stale banner.
          setError(null);
        } else {
          const text = String(err);
          setError(text.length > 200 ? `${text.slice(0, 200)}…` : text);
        }
      }
    };
    // Initial fetch + interval polling. Both are fire-and-forget async
    // functions whose errors land in setError via the try/catch inside
    // `run` — `void` here tells the runtime (and lint) we accept that.
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // Include `fetcher` in deps so callers that close over filter state
    // (e.g. Logs page: `level`, `typePrefix`) get an immediate refetch
    // when their filter changes. Pre-v0.9.7 we excluded `fetcher` with
    // an eslint-disable comment, which meant filter changes only took
    // effect on the next polling tick — feels broken when a user clicks
    // a select and nothing happens for 4 seconds. Callers must memoize
    // their fetcher (with useMemo / useCallback) so this doesn't tear
    // down the timer on every render.
  }, [intervalMs, tick, fetcher]);

  return { data, error, refresh: () => setTick((value) => value + 1) };
}
