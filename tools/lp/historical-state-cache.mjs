import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HISTORICAL_STATE_SCHEMA_VERSION, toSimulatorState } from "./historical-state.mjs";
import { POOL } from "./full-range-simulator.mjs";

function emptyStore() {
  return { schemaVersion: HISTORICAL_STATE_SCHEMA_VERSION, chainId: POOL.chainId, pool: POOL.address, blocks: {}, resolutions: {} };
}

function stable(value) { return JSON.stringify(value); }

export class HistoricalStateCache {
  constructor(file) { this.file = file; }

  load() {
    if (!fs.existsSync(this.file)) return emptyStore();
    let store;
    try { store = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (error) { throw new Error("LP historical cache is malformed: " + error.message); }
    if (store.schemaVersion !== HISTORICAL_STATE_SCHEMA_VERSION || store.chainId !== POOL.chainId || store.pool !== POOL.address
        || !store.blocks || !store.resolutions) throw new Error("LP historical cache identity is incompatible");
    for (const [number, snapshot] of Object.entries(store.blocks)) {
      if (snapshot.blockNumber !== number) throw new Error("LP historical cache block key mismatch");
      toSimulatorState(snapshot);
    }
    return store;
  }

  get(targetTimestamp) {
    const store = this.load();
    const resolution = store.resolutions[targetTimestamp];
    if (!resolution) return null;
    const snapshot = store.blocks[resolution.blockNumber];
    if (!snapshot || snapshot.blockHash !== resolution.blockHash) throw new Error("LP historical cache resolution is inconsistent");
    return snapshot;
  }

  put(targetTimestamp, snapshot) {
    toSimulatorState(snapshot);
    const store = this.load();
    const priorBlock = store.blocks[snapshot.blockNumber];
    if (priorBlock && stable(priorBlock) !== stable(snapshot)) throw new Error("conflicting LP historical snapshot for block " + snapshot.blockNumber);
    const priorResolution = store.resolutions[targetTimestamp];
    if (priorResolution && (priorResolution.blockNumber !== snapshot.blockNumber || priorResolution.blockHash !== snapshot.blockHash)) {
      throw new Error("conflicting LP historical timestamp resolution");
    }
    store.blocks[snapshot.blockNumber] = snapshot;
    store.resolutions[targetTimestamp] = { blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { fs.renameSync(temporary, this.file); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
    return snapshot;
  }
}

export function createHistoricalStateService({ client, cache }) {
  if (!client || !cache) throw new Error("historical state client and cache are required");
  const service = {
    async getStateAtTimestamp(targetTimestamp) {
      const cached = cache.get(targetTimestamp);
      if (cached) return { snapshot: cached, simulatorState: toSimulatorState(cached), cacheHit: true };
      const { resolveFinalizedBlockAtOrBefore, acquirePoolSnapshot } = await import("./historical-state.mjs");
      const block = await resolveFinalizedBlockAtOrBefore(client, targetTimestamp);
      const snapshot = await acquirePoolSnapshot(client, block);
      cache.put(targetTimestamp, snapshot);
      return { snapshot, simulatorState: toSimulatorState(snapshot), cacheHit: false };
    },
    async getSimulationStates({ startTimestamp, endTimestamp }) {
      const { assertTimestampOrder } = await import("./historical-state.mjs");
      assertTimestampOrder(startTimestamp, endTimestamp);
      const start = await service.getStateAtTimestamp(startTimestamp);
      const end = await service.getStateAtTimestamp(endTimestamp);
      return { start, end };
    }
  };
  return Object.freeze(service);
}
