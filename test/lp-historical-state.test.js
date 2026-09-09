"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let history, cacheModule, simulator, fixture;

test.before(async () => {
  history = await import("../tools/lp/historical-state.mjs");
  cacheModule = await import("../tools/lp/historical-state-cache.mjs");
  simulator = await import("../tools/lp/full-range-simulator.mjs");
  fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/lp-pool-states.json"), "utf8"));
});

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function quantity(value) { return "0x" + BigInt(value).toString(16); }
function uintWord(value) { return "0x" + BigInt(value).toString(16).padStart(64, "0"); }
function addressWord(address) { return "0x" + address.slice(2).padStart(64, "0"); }
function signedWord(value, bits = 256) { return uintWord(BigInt.asUintN(bits, BigInt(value))); }
function hashFor(number) { return "0x" + BigInt(number).toString(16).padStart(64, "0"); }

const initialization = 50_941_815n;
const initializationSeconds = BigInt(Date.parse("2026-09-06T05:36:17.000Z") / 1000);

function generatedBlock(number, overrides = {}) {
  const value = BigInt(number);
  return {
    number: quantity(overrides.number ?? value),
    hash: overrides.hash || hashFor(value),
    timestamp: quantity(overrides.timestampSeconds ?? initializationSeconds + ((value - initialization) * 2n))
  };
}

function snapshotFromFixture(index = 0) {
  const state = fixture.states[index];
  return {
    schemaVersion: 1, chainId: fixture.chainId, pool: fixture.pool, factory: fixture.factory,
    blockNumber: state.blockNumber, blockHash: state.blockHash, timestamp: state.timestamp,
    token0: fixture.token0, token1: fixture.token1, fee: fixture.fee, tickSpacing: fixture.tickSpacing,
    sqrtPriceX96: state.sqrtPriceX96, tick: state.tick, activeLiquidity: state.activeLiquidity, finalized: true
  };
}

function acquisitionClient(state = fixture.states[0], mutations = {}) {
  let calls = 0;
  const block = {
    number: quantity(state.blockNumber), hash: mutations.blockHash || state.blockHash,
    timestamp: quantity(BigInt(Date.parse(state.timestamp) / 1000))
  };
  return {
    get calls() { return calls; },
    async request(method, params) {
      calls += 1;
      if (method === "eth_chainId") return mutations.chainId || "0x2105";
      if (method === "eth_getBlockByNumber") return mutations.recheckedBlock && calls > 10 ? mutations.recheckedBlock : block;
      const selector = params[0].data;
      const values = {
        "0x0dfe1681": addressWord(mutations.token0 || fixture.token0.address),
        "0xd21220a7": addressWord(mutations.token1 || fixture.token1.address),
        "0xc45a0155": addressWord(mutations.factory || fixture.factory),
        "0xddca3f43": uintWord(mutations.fee || fixture.fee),
        "0xd0c93a7c": signedWord(mutations.tickSpacing || fixture.tickSpacing),
        "0x313ce567": uintWord(params[0].to.toLowerCase() === fixture.token0.address
          ? (mutations.token0Decimals ?? fixture.token0.decimals) : (mutations.token1Decimals ?? fixture.token1.decimals)),
        "0x3850c7bd": "0x" + [uintWord(state.sqrtPriceX96), signedWord(state.tick), uintWord(0), uintWord(1), uintWord(1), uintWord(0), uintWord(mutations.unlocked ?? 1)].map(x => x.slice(2)).join(""),
        "0x1a686502": uintWord(state.activeLiquidity)
      };
      return mutations[selector] || values[selector];
    }
  };
}

test("B1 golden fixture metadata is frozen to verified block identities", () => {
  assert.deepEqual(fixture.states.map(value => [value.blockNumber, value.timestamp, value.sqrtPriceX96]), [
    ["50941815", "2026-09-06T05:36:17.000Z", "638407101806347576136442032642785978"],
    ["51064756", "2026-09-09T01:54:19.000Z", "637434091718179387822692496724259019"]
  ]);
});

test("RPC transport retries bounded rate limits and preserves request identity", async () => {
  let calls = 0;
  const delays = [];
  const client = history.createRpcClient({
    fetchImpl: async (_url, options) => {
      calls += 1;
      const request = JSON.parse(options.body);
      return calls === 1 ? response(429, {}) : response(200, { jsonrpc: "2.0", id: request.id, result: "0x2105" });
    },
    sleep: async delay => delays.push(delay), maxAttempts: 2, baseRetryDelayMs: 10, timeoutMs: 100
  });
  assert.equal(await client.request("eth_chainId"), "0x2105");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [10]);
});

test("RPC transport reports timeout, archive unavailability, and inconsistent responses", async () => {
  const timed = history.createRpcClient({
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    timeoutMs: 5, maxAttempts: 1
  });
  await assert.rejects(timed.request("eth_call"), error => error.code === "TIMEOUT");
  const archive = history.createRpcClient({ fetchImpl: async (_url, options) => response(200, {
    jsonrpc: "2.0", id: JSON.parse(options.body).id, error: { code: -32602, message: "Archive requests require a personal token" }
  }), maxAttempts: 1 });
  await assert.rejects(archive.request("eth_call"), error => error.code === "ARCHIVE_UNAVAILABLE");
  const inconsistent = history.createRpcClient({ fetchImpl: async () => response(200, { jsonrpc: "2.0", id: 999, result: "0x1" }), maxAttempts: 1 });
  await assert.rejects(inconsistent.request("eth_chainId"), error => error.code === "INCONSISTENT_RESPONSE");
});

test("resolver selects the greatest finalized block at or before a timestamp", async () => {
  const finalizedNumber = initialization + 1_000n;
  const client = { async request(_method, params) {
    return params[0] === "finalized" ? generatedBlock(finalizedNumber) : generatedBlock(BigInt(params[0]));
  } };
  const target = new Date(Number(initializationSeconds + 401n) * 1000).toISOString();
  const resolved = await history.resolveFinalizedBlockAtOrBefore(client, target);
  assert.equal(resolved.number, initialization + 200n);
  assert.ok(resolved.timestamp <= target);
  assert.equal(generatedBlock(resolved.number + 1n).timestamp, quantity(initializationSeconds + 402n));
});

test("resolver enforces initialization, exact boundary, and latest-finalized limits", async () => {
  const finalized = generatedBlock(initialization + 10n);
  const client = { async request(_method, params) { return params[0] === "finalized" ? finalized : generatedBlock(BigInt(params[0])); } };
  await assert.rejects(history.resolveFinalizedBlockAtOrBefore(client, "2026-09-06T05:36:16.000Z"), /predates/);
  assert.equal((await history.resolveFinalizedBlockAtOrBefore(client, "2026-09-06T05:36:17.000Z")).number, initialization);
  assert.equal((await history.resolveFinalizedBlockAtOrBefore(client, "2026-09-07T00:00:00.000Z")).number, initialization + 10n);
  await assert.rejects(history.resolveFinalizedBlockAtOrBefore({ async request() { return null; } }, "2026-09-07T00:00:00.000Z"), /missing/);
});

test("pool acquisition returns exact raw strings and a B1-compatible state", async () => {
  const state = fixture.states[0];
  const client = acquisitionClient(state);
  const snapshot = await history.acquirePoolSnapshot(client, {
    number: BigInt(state.blockNumber), hash: state.blockHash, timestamp: state.timestamp,
    timestampSeconds: BigInt(Date.parse(state.timestamp) / 1000)
  });
  assert.deepEqual(snapshot, snapshotFromFixture(0));
  const compatible = history.toSimulatorState(snapshot);
  assert.equal(typeof compatible.blockNumber, "bigint");
  assert.equal(typeof compatible.sqrtPriceX96, "bigint");
  assert.equal(compatible.sqrtPriceX96.toString(), state.sqrtPriceX96);
});

test("pool acquisition fails closed on identity, state, and block inconsistencies", async () => {
  const state = fixture.states[0];
  const resolved = { number: BigInt(state.blockNumber), hash: state.blockHash, timestamp: state.timestamp, timestampSeconds: BigInt(Date.parse(state.timestamp) / 1000) };
  await assert.rejects(history.acquirePoolSnapshot(acquisitionClient(state, { chainId: "0x1" }), resolved), /chain identity/);
  await assert.rejects(history.acquirePoolSnapshot(acquisitionClient(state, { token0: "0x0000000000000000000000000000000000000001" }), resolved), /pool identity/);
  await assert.rejects(history.acquirePoolSnapshot(acquisitionClient(state, { token1: "0x0000000000000000000000000000000000000001" }), resolved), /pool identity/);
  await assert.rejects(history.acquirePoolSnapshot(acquisitionClient(state, { factory: "0x0000000000000000000000000000000000000001" }), resolved), /pool identity/);
  await assert.rejects(history.acquirePoolSnapshot(acquisitionClient(state, { fee: "3000" }), resolved), /fee or spacing/);
  await assert.rejects(history.acquirePoolSnapshot(acquisitionClient(state, { tickSpacing: "60" }), resolved), /fee or spacing/);
  await assert.rejects(history.acquirePoolSnapshot(acquisitionClient(state, { token0Decimals: 18 }), resolved), /token decimals/);
  await assert.rejects(history.acquirePoolSnapshot(acquisitionClient(state, { unlocked: 0 }), resolved), /uninitialized or locked/);
  await assert.rejects(history.acquirePoolSnapshot(acquisitionClient(state, { "0x3850c7bd": "0x01" }), resolved), /slot0.*malformed/);
  await assert.rejects(history.acquirePoolSnapshot(acquisitionClient(state, { blockHash: hashFor(1) }), resolved), /identity changed/);
});

test("cache distinguishes hits, misses, conflicts, and malformed persisted data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-lp-cache-"));
  const file = path.join(directory, "states.json");
  const cache = new cacheModule.HistoricalStateCache(file);
  const snapshot = snapshotFromFixture(0);
  assert.equal(cache.get(snapshot.timestamp), null);
  cache.put(snapshot.timestamp, snapshot);
  assert.deepEqual(cache.get(snapshot.timestamp), snapshot);
  assert.throws(() => cache.put(snapshot.timestamp, { ...snapshot, activeLiquidity: "999" }), /conflicting/);
  fs.writeFileSync(file, "not-json");
  assert.throws(() => cache.load(), /malformed/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("cached raw integers retain precision and feed the deterministic B1 engine", () => {
  const start = snapshotFromFixture(0);
  const end = snapshotFromFixture(1);
  assert.equal(history.toSimulatorState(end).sqrtPriceX96, 637434091718179387822692496724259019n);
  const result = simulator.simulateFullRange({ start: history.toSimulatorState(start), end: history.toSimulatorState(end) });
  assert.equal(result.start.cpPriceUsdc.decimal, "0.01540152582256633385881587147082629");
  assert.ok(result.ending.assetPnlUsdc.numerator > 0n);
  assert.equal(result.fees.status, "unavailable");
});

test("timestamp ordering is explicit", () => {
  assert.doesNotThrow(() => history.assertTimestampOrder("2026-09-07T00:00:00.000Z", "2026-09-07T00:00:00.000Z"));
  assert.throws(() => history.assertTimestampOrder("2026-09-08T00:00:00.000Z", "2026-09-07T00:00:00.000Z"), /must not precede/);
});

test("historical service avoids RPC on a cache hit and checks pair ordering", async () => {
  const snapshot = snapshotFromFixture(0);
  let rpcCalls = 0;
  const cache = { get(timestamp) { return timestamp === snapshot.timestamp ? snapshot : null; } };
  const service = cacheModule.createHistoricalStateService({ client: { async request() { rpcCalls += 1; } }, cache });
  const result = await service.getStateAtTimestamp(snapshot.timestamp);
  assert.equal(result.cacheHit, true);
  assert.equal(rpcCalls, 0);
  await assert.rejects(service.getSimulationStates({
    startTimestamp: "2026-09-08T00:00:00.000Z", endTimestamp: "2026-09-07T00:00:00.000Z"
  }), /must not precede/);
});
