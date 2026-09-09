import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { POOL } from "./full-range-simulator.mjs";
import { HISTORICAL_STATE_SCHEMA_VERSION, POOL_FACTORY, toSimulatorState } from "./historical-state.mjs";

export const LP_DATASET_SCHEMA_VERSION = 1;
export const MAX_DATASET_SNAPSHOTS = 400;

function canonicalTimestamp(value, label) {
  const milliseconds = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error(label + " must be canonical UTC ISO");
  return milliseconds;
}

export function buildHistoricalDataset({ store, report, generatedAt, maxSnapshots = MAX_DATASET_SNAPSHOTS }) {
  if (!store || store.schemaVersion !== HISTORICAL_STATE_SCHEMA_VERSION || store.chainId !== POOL.chainId || store.pool !== POOL.address) {
    throw new Error("LP historical cache identity is incompatible");
  }
  canonicalTimestamp(generatedAt, "dataset generation timestamp");
  const successfulResults = report?.results?.filter(result => result.status === "acquired" || result.status === "reused");
  const selectedBlocks = successfulResults ? new Set(successfulResults.map(result => result.blockNumber)) : null;
  const selectedTimestamps = successfulResults ? new Set(successfulResults.map(result => result.requestedTimestamp)) : null;
  const snapshots = Object.values(store.blocks)
    .filter(snapshot => !selectedBlocks || selectedBlocks.has(snapshot.blockNumber))
    .sort((left, right) => BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1 : 1);
  if (snapshots.length === 0) throw new Error("cannot export an empty LP dataset");
  if (!Number.isInteger(maxSnapshots) || maxSnapshots < 1 || maxSnapshots > MAX_DATASET_SNAPSHOTS || snapshots.length > maxSnapshots) {
    throw new Error("LP dataset exceeds the bounded snapshot limit");
  }
  for (const snapshot of snapshots) toSimulatorState(snapshot);
  const resolutions = Object.entries(store.resolutions)
    .filter(([requestedTimestamp]) => !selectedTimestamps || selectedTimestamps.has(requestedTimestamp))
    .map(([requestedTimestamp, value]) => ({ requestedTimestamp, ...value }))
    .sort((left, right) => canonicalTimestamp(left.requestedTimestamp, "resolution timestamp") - canonicalTimestamp(right.requestedTimestamp, "resolution timestamp"));
  const gaps = (report?.results || []).filter(result => result.status === "failed" || result.status === "unavailable").map(result => ({
    requestedTimestamp: result.requestedTimestamp, status: result.status, errorCode: result.errorCode, message: result.message
  }));
  const latest = snapshots.at(-1);
  const dataset = {
    schemaVersion: LP_DATASET_SCHEMA_VERSION,
    kind: "cypress-lp-principal-history",
    identity: {
      chainId: POOL.chainId, pool: POOL.address, factory: POOL_FACTORY,
      token0: POOL.token0, token1: POOL.token1, fee: String(POOL.fee), tickSpacing: String(POOL.tickSpacing),
      fullRange: { tickLower: POOL.tickLower, tickUpper: POOL.tickUpper }
    },
    initialization: { blockNumber: POOL.initializationBlock.toString(), timestamp: POOL.initializationTime },
    generatedAt,
    latestIncludedFinalizedBlock: { blockNumber: latest.blockNumber, blockHash: latest.blockHash, timestamp: latest.timestamp },
    availableRange: { from: snapshots[0].timestamp, through: latest.timestamp },
    resolutionPolicy: {
      exactRequestedTimestampsOnly: true,
      ordinaryUtcMidnightStarts: "2026-09-07",
      initializationDateTimestamp: POOL.initializationTime,
      defaultEnd: "latest_included_finalized_block",
      interpolation: false
    },
    snapshots,
    resolutions,
    gaps,
    fees: { included: false, status: "unavailable" }
  };
  return validateHistoricalDataset(dataset);
}

export function validateHistoricalDataset(dataset) {
  if (!dataset || dataset.schemaVersion !== LP_DATASET_SCHEMA_VERSION || dataset.kind !== "cypress-lp-principal-history") throw new Error("LP dataset schema is incompatible");
  if (dataset.identity?.chainId !== POOL.chainId || dataset.identity?.pool !== POOL.address || dataset.identity?.factory !== POOL_FACTORY
      || dataset.identity?.fee !== String(POOL.fee) || dataset.identity?.tickSpacing !== String(POOL.tickSpacing)
      || dataset.identity?.token0?.address !== POOL.token0.address || dataset.identity?.token0?.decimals !== POOL.token0.decimals
      || dataset.identity?.token1?.address !== POOL.token1.address || dataset.identity?.token1?.decimals !== POOL.token1.decimals
      || dataset.identity?.fullRange?.tickLower !== POOL.tickLower || dataset.identity?.fullRange?.tickUpper !== POOL.tickUpper
      || dataset.initialization?.blockNumber !== POOL.initializationBlock.toString() || dataset.initialization?.timestamp !== POOL.initializationTime) {
    throw new Error("LP dataset identity is invalid");
  }
  canonicalTimestamp(dataset.generatedAt, "dataset generation timestamp");
  if (!Array.isArray(dataset.snapshots) || dataset.snapshots.length === 0 || dataset.snapshots.length > MAX_DATASET_SNAPSHOTS) throw new Error("LP dataset snapshot count is invalid");
  let prior = -1n;
  for (const snapshot of dataset.snapshots) {
    toSimulatorState(snapshot);
    const number = BigInt(snapshot.blockNumber);
    if (number <= prior) throw new Error("LP dataset snapshots are not strictly ordered");
    prior = number;
  }
  const first = dataset.snapshots[0];
  const latest = dataset.snapshots.at(-1);
  if (dataset.availableRange?.from !== first.timestamp || dataset.availableRange?.through !== latest.timestamp
      || dataset.latestIncludedFinalizedBlock?.blockNumber !== latest.blockNumber
      || dataset.latestIncludedFinalizedBlock?.blockHash !== latest.blockHash
      || dataset.latestIncludedFinalizedBlock?.timestamp !== latest.timestamp) throw new Error("LP dataset range metadata is inconsistent");
  if (!Array.isArray(dataset.resolutions) || !Array.isArray(dataset.gaps)
      || dataset.resolutions.length > MAX_DATASET_SNAPSHOTS || dataset.gaps.length > MAX_DATASET_SNAPSHOTS) {
    throw new Error("LP dataset resolutions or gaps are invalid");
  }
  const blocks = new Map(dataset.snapshots.map(snapshot => [snapshot.blockNumber, snapshot]));
  for (const resolution of dataset.resolutions) {
    canonicalTimestamp(resolution.requestedTimestamp, "resolution timestamp");
    const snapshot = blocks.get(resolution.blockNumber);
    if (!snapshot || snapshot.blockHash !== resolution.blockHash) throw new Error("LP dataset resolution is inconsistent");
  }
  for (const gap of dataset.gaps) canonicalTimestamp(gap.requestedTimestamp, "gap timestamp");
  if (dataset.fees?.included !== false || dataset.fees?.status !== "unavailable" || dataset.resolutionPolicy?.interpolation !== false) {
    throw new Error("LP dataset fee or interpolation policy is invalid");
  }
  return dataset;
}

export function writeDatasetAtomic(file, dataset) {
  validateHistoricalDataset(dataset);
  if (fs.existsSync(file)) {
    let prior;
    try { prior = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { throw new Error("existing LP dataset is malformed: " + error.message); }
    validateHistoricalDataset(prior);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(dataset, null, 2) + "\n", "utf8");
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  try { fs.renameSync(temporary, file); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  return file;
}
