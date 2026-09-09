import { getDb } from "@/lib/db/sqlite";
import { SqliteConsentStore } from "./sqlite-store";
import { JsonFileConsentStore, type ConsentStore } from "./store";

let singleton: ConsentStore | undefined;

/**
 * Process-wide consent store. Database-backed by default. Set
 * CONSENT_STORE_PATH to a JSON file path to use the file store instead.
 */
export function getConsentStore(): ConsentStore {
  if (!singleton) {
    const jsonPath = process.env.CONSENT_STORE_PATH?.trim();
    singleton = jsonPath ? new JsonFileConsentStore(jsonPath) : new SqliteConsentStore(getDb());
  }
  return singleton;
}

/** Test hook. */
export function setConsentStore(store: ConsentStore | undefined) {
  singleton = store;
}
