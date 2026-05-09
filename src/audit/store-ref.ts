import type { ConversationStore } from "./conversation-store.js";

export type ConversationStoreRef = {
  set: (store: ConversationStore | undefined) => void;
  get: () => ConversationStore | undefined;
};

export function createConversationStoreRef(): ConversationStoreRef {
  let current: ConversationStore | undefined;
  return {
    set: (store) => {
      current = store;
    },
    get: () => current,
  };
}
