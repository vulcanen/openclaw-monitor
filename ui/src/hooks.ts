import { useEffect, useState } from "react";

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
        if (active) setError(String(err));
      }
    };
    run();
    const timer = setInterval(run, intervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick]);

  return { data, error, refresh: () => setTick((value) => value + 1) };
}
