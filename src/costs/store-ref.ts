import type { DailyCostStore } from "./daily-store.js";

/**
 * Mutable holder so other layers (fanout, REST handlers) can talk to a
 * daily-cost store that's lazily created during service.start. Mirrors
 * the same pattern as src/storage/store-ref.ts and the audit store ref;
 * keeping the indirection means lifecycle code can swap or null the
 * store on plugin stop / re-init without rewiring callers.
 */
export type DailyCostStoreRef = {
  get: () => DailyCostStore | undefined;
  set: (store: DailyCostStore | undefined) => void;
};

export function createDailyCostStoreRef(): DailyCostStoreRef {
  let store: DailyCostStore | undefined;
  return {
    get: () => store,
    set: (next) => {
      store = next;
    },
  };
}
