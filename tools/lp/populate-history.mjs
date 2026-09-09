import path from "node:path";
import { fileURLToPath } from "node:url";

import { POOL } from "./full-range-simulator.mjs";
import { createRpcClient, assertTimestampOrder } from "./historical-state.mjs";
import { HistoricalStateCache, createHistoricalStateService } from "./historical-state-cache.mjs";
import { buildHistoricalDataset, writeDatasetAtomic } from "./historical-dataset.mjs";

export const MAX_POPULATION_POINTS = 400;
export const DEFAULT_INTERVAL_SECONDS = 86_400;

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new Error(label + " is required");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error(label + " must be canonical UTC ISO");
  if (milliseconds < Date.parse(POOL.initializationTime)) throw new Error(label + " predates pool initialization");
  return { value, milliseconds };
}

export function timestampForDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must use YYYY-MM-DD");
  if (date === "2026-09-06") return POOL.initializationTime;
  if (date < "2026-09-07") throw new Error("date predates ordinary LP date coverage");
  const timestamp = date + "T00:00:00.000Z";
  canonicalTimestamp(timestamp, "date timestamp");
  return timestamp;
}

export function buildDateRange({ startDate, endDate, maxPoints = MAX_POPULATION_POINTS }) {
  if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > MAX_POPULATION_POINTS) throw new Error("maxPoints is outside the bounded limit");
  const firstTimestamp = timestampForDate(startDate);
  timestampForDate(endDate);
  if (endDate < startDate) throw new Error("end date must not precede start date");
  const output = [];
  let current = Date.parse(startDate + "T00:00:00.000Z");
  const last = Date.parse(endDate + "T00:00:00.000Z");
  while (current <= last) {
    if (output.length >= maxPoints) throw new Error("requested date range exceeds the bounded point limit");
    const date = new Date(current).toISOString().slice(0, 10);
    output.push(date === startDate ? firstTimestamp : timestampForDate(date));
    current += DEFAULT_INTERVAL_SECONDS * 1000;
  }
  return output;
}

export function buildTimestampRange({ start, end, intervalSeconds = DEFAULT_INTERVAL_SECONDS, maxPoints = MAX_POPULATION_POINTS }) {
  const first = canonicalTimestamp(start, "start timestamp");
  const last = canonicalTimestamp(end, "end timestamp");
  assertTimestampOrder(first.value, last.value);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) throw new Error("intervalSeconds must be a positive integer");
  if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > MAX_POPULATION_POINTS) throw new Error("maxPoints is outside the bounded limit");
  const step = intervalSeconds * 1000;
  const output = [];
  for (let current = first.milliseconds; current <= last.milliseconds; current += step) {
    if (output.length >= maxPoints) throw new Error("requested timestamp range exceeds the bounded point limit");
    output.push(new Date(current).toISOString());
  }
  if (output.at(-1) !== last.value) {
    if (output.length >= maxPoints) throw new Error("requested timestamp range exceeds the bounded point limit");
    output.push(last.value);
  }
  return output;
}

export function normalizeTimestamps(values, maxPoints = MAX_POPULATION_POINTS) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("at least one requested timestamp is required");
  if (values.length > maxPoints || maxPoints > MAX_POPULATION_POINTS) throw new Error("requested timestamps exceed the bounded point limit");
  const unique = new Map();
  for (const value of values) {
    const parsed = canonicalTimestamp(value, "requested timestamp");
    unique.set(parsed.value, parsed.milliseconds);
  }
  return [...unique.keys()].sort((left, right) => unique.get(left) - unique.get(right));
}

export async function populateHistoricalCache({ timestamps, service, maxPoints = MAX_POPULATION_POINTS }) {
  if (!service || typeof service.getStateAtTimestamp !== "function") throw new Error("historical state service is required");
  const requested = normalizeTimestamps(timestamps, maxPoints);
  const report = { requested: requested.length, acquired: 0, reused: 0, unavailable: 0, failed: 0, results: [] };
  for (const timestamp of requested) {
    try {
      const state = await service.getStateAtTimestamp(timestamp);
      const status = state.cacheHit ? "reused" : "acquired";
      report[status] += 1;
      report.results.push({ requestedTimestamp: timestamp, status, blockNumber: state.snapshot.blockNumber, blockHash: state.snapshot.blockHash, timestamp: state.snapshot.timestamp });
    } catch (error) {
      const status = error?.code === "ARCHIVE_UNAVAILABLE" ? "unavailable" : "failed";
      report[status] += 1;
      report.results.push({ requestedTimestamp: timestamp, status, errorCode: error?.code || "ERROR", message: String(error?.message || error) });
    }
  }
  return report;
}

function parseArguments(argv, now = () => new Date()) {
  const options = { timestamps: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--timestamp", "--start", "--end", "--start-date", "--end-date", "--interval-seconds", "--cache", "--export", "--max-points"].includes(key)) {
      throw new Error("unknown argument: " + key);
    }
    const value = argv[++index];
    if (value === undefined) throw new Error("missing value for " + key);
    if (key === "--timestamp") options.timestamps.push(value);
    else options[key.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  }
  const maxPoints = options.maxPoints === undefined ? MAX_POPULATION_POINTS : Number(options.maxPoints);
  const intervalSeconds = options.intervalSeconds === undefined ? DEFAULT_INTERVAL_SECONDS : Number(options.intervalSeconds);
  let dated = [];
  if (options.startDate || options.endDate) {
    if (!options.startDate || !options.endDate || options.start || options.end) throw new Error("start-date and end-date must be supplied together without timestamp bounds");
    if (intervalSeconds !== DEFAULT_INTERVAL_SECONDS) throw new Error("date ranges use one exact UTC selection per calendar date");
    dated = buildDateRange({ startDate: options.startDate, endDate: options.endDate, maxPoints });
  }
  if (options.end === "latest") options.end = now().toISOString();
  const ranged = options.start || options.end ? buildTimestampRange({ start: options.start, end: options.end, intervalSeconds, maxPoints }) : [];
  const timestamps = normalizeTimestamps([...options.timestamps, ...dated, ...ranged], maxPoints);
  return { ...options, timestamps, maxPoints };
}

export async function runPopulationCli(argv, dependencies = {}) {
  const options = parseArguments(argv, dependencies.now);
  const cacheFile = path.resolve(options.cache || ".cache/lp/historical-states-v1.json");
  const cache = dependencies.cache || new HistoricalStateCache(cacheFile);
  const client = dependencies.client || createRpcClient({ rpcUrl: dependencies.rpcUrl || process.env.LP_BASE_RPC_URL });
  const service = dependencies.service || createHistoricalStateService({ client, cache });
  const report = await populateHistoricalCache({ timestamps: options.timestamps, service, maxPoints: options.maxPoints });
  let exported = null;
  if (options.export) {
    const dataset = buildHistoricalDataset({ store: cache.load(), report, generatedAt: (dependencies.now || (() => new Date()))().toISOString() });
    writeDatasetAtomic(path.resolve(options.export), dataset);
    exported = path.resolve(options.export);
  }
  return { cacheFile, exported, report };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runPopulationCli(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.report.failed > 0 || result.report.unavailable > 0) process.exitCode = 1;
  }).catch(error => {
    process.stderr.write("LP history population failed: " + error.message + "\n");
    process.exitCode = 1;
  });
}
