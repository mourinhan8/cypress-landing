import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FX_SCHEMA_VERSION = 1;
export const FX_PROVIDER_URL = "https://open.er-api.com/v6/latest/USD";
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_RESPONSE_BYTES = 128 * 1024;

function canonicalTimestamp(value, label) {
  const milliseconds = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(label + " must be canonical UTC ISO");
  }
  return milliseconds;
}

export function validateRate(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("USD/VND rate must be finite and positive");
  }
  return value;
}

export function validateProviderPayload(payload) {
  if (!payload || payload.result !== "success" || payload.base_code !== "USD") {
    throw new Error("ExchangeRate-API response identity is invalid");
  }
  return validateRate(payload.rates?.VND);
}

export function validateFxSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== FX_SCHEMA_VERSION || snapshot.base !== "USD" || snapshot.quote !== "VND"
      || snapshot.provider !== "ExchangeRate-API") throw new Error("USD/VND cache identity is invalid");
  const checkedAt = canonicalTimestamp(snapshot.checkedAt, "USD/VND checkedAt");
  if (snapshot.rate === null) {
    if (snapshot.updatedAt !== null) throw new Error("unavailable USD/VND cache has an update timestamp");
  } else {
    validateRate(snapshot.rate);
    if (canonicalTimestamp(snapshot.updatedAt, "USD/VND updatedAt") > checkedAt) throw new Error("USD/VND cache timestamps are inconsistent");
  }
  return snapshot;
}

export function readFxSnapshot(file) {
  if (!fs.existsSync(file)) return null;
  return validateFxSnapshot(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function writeFxSnapshotAtomic(file, snapshot) {
  validateFxSnapshot(snapshot);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const temporary = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  const descriptor = fs.openSync(temporary, "wx", 0o640);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try { fs.renameSync(temporary, file); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  return file;
}

export async function fetchUsdVndRate(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10_000);
  try {
    const response = await fetchImpl(options.url || FX_PROVIDER_URL, {
      headers: { accept: "application/json" }, signal: controller.signal
    });
    if (!response?.ok) throw new Error("ExchangeRate-API returned HTTP " + (response?.status || 0));
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("ExchangeRate-API response exceeds its byte bound");
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) throw new Error("ExchangeRate-API response exceeds its byte bound");
    return validateProviderPayload(JSON.parse(body));
  } finally {
    clearTimeout(timer);
  }
}

function safeRead(file) {
  try { return readFxSnapshot(file); } catch (_) { return null; }
}

export async function refreshUsdVnd(options) {
  if (!options?.cacheFile) throw new Error("USD/VND cache file is required");
  const now = options.now ? options.now() : new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("current time is invalid");
  const checkedAt = now.toISOString();
  const prior = safeRead(options.cacheFile);
  if (prior) {
    const age = now.getTime() - Date.parse(prior.checkedAt);
    if (age >= 0 && age < (options.refreshIntervalMs || REFRESH_INTERVAL_MS)) {
      return { status: prior.rate === null ? "unavailable" : "reused", snapshot: prior, fetched: false };
    }
  }
  try {
    const rate = await fetchUsdVndRate(options);
    const snapshot = {
      schemaVersion: FX_SCHEMA_VERSION, base: "USD", quote: "VND", provider: "ExchangeRate-API",
      rate, updatedAt: checkedAt, checkedAt
    };
    writeFxSnapshotAtomic(options.cacheFile, snapshot);
    return { status: "updated", snapshot, fetched: true };
  } catch (error) {
    const snapshot = {
      schemaVersion: FX_SCHEMA_VERSION, base: "USD", quote: "VND", provider: "ExchangeRate-API",
      rate: prior?.rate ?? null, updatedAt: prior?.updatedAt ?? null, checkedAt
    };
    writeFxSnapshotAtomic(options.cacheFile, snapshot);
    return { status: snapshot.rate === null ? "unavailable" : "stale", snapshot, fetched: true, error: String(error?.message || error) };
  }
}

function parseArguments(argv) {
  let cacheFile = "api/fx/v1/usd-vnd.json";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--cache" || argv[index + 1] === undefined) throw new Error("usage: --cache <file>");
    cacheFile = argv[++index];
  }
  return { cacheFile: path.resolve(cacheFile) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  refreshUsdVnd(parseArguments(process.argv.slice(2))).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status === "unavailable") process.exitCode = 1;
  }).catch(error => {
    process.stderr.write("USD/VND refresh failed: " + error.message + "\n");
    process.exitCode = 1;
  });
}
