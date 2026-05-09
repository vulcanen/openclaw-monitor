import type { JsonlStore } from "./jsonl-store.js";

export type StoreRef = {
  set: (store: JsonlStore | undefined) => void;
  get: () => JsonlStore | undefined;
};

export function createStoreRef(): StoreRef {
  let current: JsonlStore | undefined;
  return {
    set: (store) => {
      current = store;
    },
    get: () => current,
  };
}
