import { POOL, validatePoolState } from "./full-range-simulator.mjs";

export const BASE_RPC_URL = "https://mainnet.base.org";
export const HISTORICAL_STATE_SCHEMA_VERSION = 1;
export const POOL_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd";

const SELECTOR = Object.freeze({
  token0: "0x0dfe1681", token1: "0xd21220a7", factory: "0xc45a0155",
  fee: "0xddca3f43", tickSpacing: "0xd0c93a7c", slot0: "0x3850c7bd",
  liquidity: "0x1a686502", decimals: "0x313ce567"
});

export class RpcError extends Error {
  constructor(message, code, retryable = false) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.retryable = retryable;
  }
}

const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function createRpcClient(options = {}) {
  const rpcUrl = options.rpcUrl || BASE_RPC_URL;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxAttempts = options.maxAttempts ?? 4;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 5_000;
  const sleep = options.sleep || defaultSleep;
  let nextId = 1;
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("RPC bounds are invalid");
  }

  async function request(method, params = []) {
    const id = nextId++;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: controller.signal
        });
        if (!response || !response.ok) {
          const status = response && Number.isInteger(response.status) ? response.status : 0;
          throw new RpcError("Base RPC returned HTTP " + status, "HTTP_" + status, status === 429 || status >= 500);
        }
        const payload = await response.json();
        if (!payload || payload.jsonrpc !== "2.0" || payload.id !== id) {
          throw new RpcError("Base RPC returned an inconsistent response", "INCONSISTENT_RESPONSE");
        }
        if (payload.error) {
          const message = String(payload.error.message || "unknown RPC error");
          const rateLimited = payload.error.code === -32016 || /rate.?limit/i.test(message);
          const archiveUnavailable = /archive|historical state|missing trie node/i.test(message);
          throw new RpcError(
            "Base RPC " + method + " failed: " + message,
            archiveUnavailable ? "ARCHIVE_UNAVAILABLE" : rateLimited ? "RATE_LIMITED" : "RPC_ERROR",
            rateLimited
          );
        }
        if (!("result" in payload)) throw new RpcError("Base RPC response is missing a result", "MISSING_RESULT");
        return payload.result;
      } catch (error) {
        lastError = error && error.name === "AbortError"
          ? new RpcError("Base RPC request timed out", "TIMEOUT", true)
          : error instanceof RpcError ? error : new RpcError("Base RPC request failed: " + error.message, "NETWORK", true);
      } finally {
        clearTimeout(timer);
      }
      if (!lastError.retryable || attempt === maxAttempts) throw lastError;
      await sleep(Math.min(maxRetryDelayMs, baseRetryDelayMs * (2 ** (attempt - 1))));
    }
    throw lastError;
  }
  return Object.freeze({ rpcUrl, request });
}

function quantity(value, label) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error(label + " is malformed");
  return BigInt(value);
}

function data(value, bytes, label) {
  if (typeof value !== "string" || !new RegExp("^0x[0-9a-f]{" + (bytes * 2) + "}$", "i").test(value)) {
    throw new Error(label + " is malformed");
  }
  return value.toLowerCase();
}

function words(value, minimum, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value) || (value.length - 2) % 64 !== 0) {
    throw new Error(label + " is malformed");
  }
  const output = value.slice(2).match(/.{64}/g) || [];
  if (output.length < minimum) throw new Error(label + " is incomplete");
  return output;
}

function uintWord(value, label, index = 0) { return BigInt("0x" + words(value, index + 1, label)[index]); }
function addressWord(value, label) { return "0x" + words(value, 1, label)[0].slice(24).toLowerCase(); }
function signedWord(value, bits, label, index) { return BigInt.asIntN(bits, uintWord(value, label, index)); }
function blockHex(number) { return "0x" + number.toString(16); }

export function parseBlock(value, label = "block") {
  if (!value || typeof value !== "object") throw new Error(label + " is missing");
  const number = quantity(value.number, label + " number");
  const timestampSeconds = quantity(value.timestamp, label + " timestamp");
  const hash = data(value.hash, 32, label + " hash");
  return Object.freeze({
    number,
    numberString: number.toString(),
    hash,
    timestamp: new Date(Number(timestampSeconds) * 1000).toISOString(),
    timestampSeconds
  });
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new Error(label + " is required");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error(label + " must be canonical UTC ISO");
  return { value, milliseconds, seconds: BigInt(Math.floor(milliseconds / 1000)) };
}

export async function resolveFinalizedBlockAtOrBefore(client, targetTimestamp) {
  const target = canonicalTimestamp(targetTimestamp, "target timestamp");
  const initializationMs = Date.parse(POOL.initializationTime);
  if (target.milliseconds < initializationMs) throw new Error("target timestamp predates pool initialization");
  const finalized = parseBlock(await client.request("eth_getBlockByNumber", ["finalized", false]), "finalized block");
  if (finalized.number < POOL.initializationBlock) throw new Error("latest finalized block predates pool initialization");
  if (target.seconds >= finalized.timestampSeconds) return finalized;

  let low = POOL.initializationBlock;
  let high = finalized.number;
  let eligible = null;
  while (low <= high) {
    const middle = (low + high) >> 1n;
    const block = parseBlock(await client.request("eth_getBlockByNumber", [blockHex(middle), false]), "historical block");
    if (block.number !== middle) throw new Error("provider returned the wrong historical block number");
    if (block.timestampSeconds <= target.seconds) {
      eligible = block;
      low = middle + 1n;
    } else {
      high = middle - 1n;
    }
  }
  if (!eligible) throw new Error("no eligible pool-history block exists for target timestamp");
  return eligible;
}

async function pinnedCall(client, to, selector, blockNumber) {
  return client.request("eth_call", [{ to, data: selector }, blockHex(blockNumber)]);
}

export async function acquirePoolSnapshot(client, resolvedBlock) {
  const expected = parseBlock({
    number: blockHex(BigInt(resolvedBlock.number ?? resolvedBlock.numberString)),
    hash: resolvedBlock.hash,
    timestamp: blockHex(BigInt(resolvedBlock.timestampSeconds ?? Math.floor(Date.parse(resolvedBlock.timestamp) / 1000)))
  }, "resolved block");
  const chainId = quantity(await client.request("eth_chainId", []), "chain ID");
  if (chainId !== BigInt(POOL.chainId)) throw new Error("chain identity mismatch");
  const before = parseBlock(await client.request("eth_getBlockByNumber", [blockHex(expected.number), false]), "pinned block");
  if (before.hash !== expected.hash || before.timestamp !== expected.timestamp) throw new Error("resolved block identity changed");

  const token0 = addressWord(await pinnedCall(client, POOL.address, SELECTOR.token0, before.number), "token0");
  const token1 = addressWord(await pinnedCall(client, POOL.address, SELECTOR.token1, before.number), "token1");
  const factory = addressWord(await pinnedCall(client, POOL.address, SELECTOR.factory, before.number), "factory");
  const fee = uintWord(await pinnedCall(client, POOL.address, SELECTOR.fee, before.number), "fee");
  const tickSpacing = signedWord(await pinnedCall(client, POOL.address, SELECTOR.tickSpacing, before.number), 24, "tick spacing", 0);
  const token0Decimals = uintWord(await pinnedCall(client, token0, SELECTOR.decimals, before.number), "token0 decimals");
  const token1Decimals = uintWord(await pinnedCall(client, token1, SELECTOR.decimals, before.number), "token1 decimals");
  const slot0 = await pinnedCall(client, POOL.address, SELECTOR.slot0, before.number);
  const sqrtPriceX96 = uintWord(slot0, "slot0", 0);
  const tick = signedWord(slot0, 24, "slot0", 1);
  const unlocked = uintWord(slot0, "slot0", 6);
  const activeLiquidity = uintWord(await pinnedCall(client, POOL.address, SELECTOR.liquidity, before.number), "liquidity");
  const after = parseBlock(await client.request("eth_getBlockByNumber", [blockHex(before.number), false]), "rechecked pinned block");
  if (after.hash !== before.hash || after.timestamp !== before.timestamp) throw new Error("inconsistent snapshot: block identity changed during acquisition");

  if (token0 !== POOL.token0.address || token1 !== POOL.token1.address || factory !== POOL_FACTORY) throw new Error("pool identity mismatch");
  if (fee !== BigInt(POOL.fee) || tickSpacing !== BigInt(POOL.tickSpacing)) throw new Error("pool fee or spacing mismatch");
  if (token0Decimals !== BigInt(POOL.token0.decimals) || token1Decimals !== BigInt(POOL.token1.decimals)) throw new Error("token decimals mismatch");
  if (sqrtPriceX96 === 0n || unlocked !== 1n) throw new Error("pool state is uninitialized or locked");

  const snapshot = Object.freeze({
    schemaVersion: HISTORICAL_STATE_SCHEMA_VERSION,
    chainId: POOL.chainId,
    pool: POOL.address,
    factory,
    blockNumber: before.numberString,
    blockHash: before.hash,
    timestamp: before.timestamp,
    token0: Object.freeze({ address: token0, decimals: POOL.token0.decimals }),
    token1: Object.freeze({ address: token1, decimals: POOL.token1.decimals }),
    fee: fee.toString(),
    tickSpacing: tickSpacing.toString(),
    sqrtPriceX96: sqrtPriceX96.toString(),
    tick: tick.toString(),
    activeLiquidity: activeLiquidity.toString(),
    finalized: true
  });
  toSimulatorState(snapshot);
  return snapshot;
}

export function toSimulatorState(snapshot) {
  const integerFields = ["blockNumber", "fee", "tickSpacing", "sqrtPriceX96", "activeLiquidity"];
  if (integerFields.some(field => typeof snapshot?.[field] !== "string" || !/^[0-9]+$/.test(snapshot[field]))
      || typeof snapshot?.tick !== "string" || !/^-?[0-9]+$/.test(snapshot.tick)) {
    throw new Error("historical snapshot integers are invalid");
  }
  if (!snapshot || snapshot.schemaVersion !== HISTORICAL_STATE_SCHEMA_VERSION || snapshot.chainId !== POOL.chainId
      || snapshot.pool !== POOL.address || snapshot.factory !== POOL_FACTORY
      || snapshot.blockHash !== data(snapshot.blockHash, 32, "block hash") || snapshot.finalized !== true) {
    throw new Error("historical snapshot identity is invalid");
  }
  const state = {
    chainId: snapshot.chainId, pool: snapshot.pool,
    token0: snapshot.token0, token1: snapshot.token1,
    fee: Number(BigInt(snapshot.fee)), tickSpacing: Number(BigInt(snapshot.tickSpacing)),
    blockNumber: BigInt(snapshot.blockNumber), timestamp: snapshot.timestamp,
    sqrtPriceX96: BigInt(snapshot.sqrtPriceX96)
  };
  validatePoolState(state);
  const tick = BigInt(snapshot.tick);
  if (tick < -8_388_608n || tick > 8_388_607n) throw new Error("historical snapshot tick is outside int24 bounds");
  return Object.freeze(state);
}

export function assertTimestampOrder(startTimestamp, endTimestamp) {
  const start = canonicalTimestamp(startTimestamp, "start timestamp");
  const end = canonicalTimestamp(endTimestamp, "end timestamp");
  if (end.milliseconds < start.milliseconds) throw new Error("end timestamp must not precede start timestamp");
}
