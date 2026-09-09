"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let population, datasets, history, simulator, fixture;

test.before(async () => {
  population = await import("../tools/lp/populate-history.mjs");
  datasets = await import("../tools/lp/historical-dataset.mjs");
  history = await import("../tools/lp/historical-state.mjs");
  simulator = await import("../tools/lp/full-range-simulator.mjs");
  fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/lp-pool-states.json"), "utf8"));
});

function snapshot(index) {
  const state = fixture.states[index];
  return {
    schemaVersion: 1, chainId: fixture.chainId, pool: fixture.pool, factory: fixture.factory,
    blockNumber: state.blockNumber, blockHash: state.blockHash, timestamp: state.timestamp,
    token0: fixture.token0, token1: fixture.token1, fee: fixture.fee, tickSpacing: fixture.tickSpacing,
    sqrtPriceX96: state.sqrtPriceX96, tick: state.tick, activeLiquidity: state.activeLiquidity, finalized: true
  };
}

function store() {
  const first = snapshot(0), second = snapshot(1);
  return {
    schemaVersion: 1, chainId: fixture.chainId, pool: fixture.pool,
    blocks: { [first.blockNumber]: first, [second.blockNumber]: second },
    resolutions: {
      [first.timestamp]: { blockNumber: first.blockNumber, blockHash: first.blockHash },
      [second.timestamp]: { blockNumber: second.blockNumber, blockHash: second.blockHash }
    }
  };
}

test("date policy preserves the initialization special case and UTC midnight", () => {
  assert.equal(population.timestampForDate("2026-09-06"), "2026-09-06T05:36:17.000Z");
  assert.equal(population.timestampForDate("2026-09-07"), "2026-09-07T00:00:00.000Z");
  assert.throws(() => population.timestampForDate("2026-09-05"), /predates/);
  assert.throws(() => population.timestampForDate("09\/07\/2026"), /YYYY-MM-DD/);
  assert.deepEqual(population.buildDateRange({ startDate: "2026-09-06", endDate: "2026-09-08" }), [
    "2026-09-06T05:36:17.000Z", "2026-09-07T00:00:00.000Z", "2026-09-08T00:00:00.000Z"
  ]);
});

test("bounded timestamp ranges include an exact non-aligned end without scanning", () => {
  const values = population.buildTimestampRange({
    start: "2026-09-07T00:00:00.000Z", end: "2026-09-09T01:00:00.000Z", intervalSeconds: 86_400
  });
  assert.deepEqual(values, [
    "2026-09-07T00:00:00.000Z", "2026-09-08T00:00:00.000Z", "2026-09-09T00:00:00.000Z", "2026-09-09T01:00:00.000Z"
  ]);
  assert.throws(() => population.buildTimestampRange({
    start: "2026-09-07T00:00:00.000Z", end: "2026-09-08T00:00:00.000Z", intervalSeconds: 1, maxPoints: 10
  }), /bounded point limit/);
});

test("population is sequential and reports acquired, reused, unavailable, and failed", async () => {
  const requested = ["2026-09-07T00:00:00.000Z", "2026-09-08T00:00:00.000Z", "2026-09-09T00:00:00.000Z", "2026-09-10T00:00:00.000Z"];
  let active = 0, maximumActive = 0;
  const service = { async getStateAtTimestamp(timestamp) {
    active += 1; maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    const index = requested.indexOf(timestamp);
    if (index === 2) throw Object.assign(new Error("archive unavailable"), { code: "ARCHIVE_UNAVAILABLE" });
    if (index === 3) throw new Error("malformed state");
    return { cacheHit: index === 1, snapshot: snapshot(index === 0 ? 0 : 1) };
  } };
  const report = await population.populateHistoricalCache({ timestamps: requested, service });
  assert.deepEqual([report.acquired, report.reused, report.unavailable, report.failed], [1, 1, 1, 1]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(report.results.map(item => item.status), ["acquired", "reused", "unavailable", "failed"]);
});

test("resume reuses completed timestamps after a partial failure", async () => {
  const completed = new Set();
  let networkCalls = 0;
  const service = { async getStateAtTimestamp(timestamp) {
    if (completed.has(timestamp)) return { cacheHit: true, snapshot: snapshot(0) };
    networkCalls += 1;
    if (timestamp.startsWith("2026-09-08")) throw new Error("temporary failure");
    completed.add(timestamp);
    return { cacheHit: false, snapshot: snapshot(0) };
  } };
  const timestamps = ["2026-09-07T00:00:00.000Z", "2026-09-08T00:00:00.000Z"];
  const first = await population.populateHistoricalCache({ timestamps, service });
  const second = await population.populateHistoricalCache({ timestamps, service });
  assert.equal(first.acquired, 1);
  assert.equal(second.reused, 1);
  assert.equal(networkCalls, 3);
});

test("dataset preserves exact snapshots, resolutions, gaps, and fee boundary", () => {
  const source = store();
  source.resolutions["2026-09-09T01:00:00.000Z"] = {
    blockNumber: snapshot(1).blockNumber, blockHash: snapshot(1).blockHash
  };
  const report = { results: [
    { requestedTimestamp: snapshot(0).timestamp, status: "reused", blockNumber: snapshot(0).blockNumber, blockHash: snapshot(0).blockHash },
    { requestedTimestamp: snapshot(1).timestamp, status: "acquired", blockNumber: snapshot(1).blockNumber, blockHash: snapshot(1).blockHash },
    { requestedTimestamp: "2026-09-08T00:00:00.000Z", status: "unavailable", errorCode: "ARCHIVE_UNAVAILABLE", message: "archive unavailable" }
  ] };
  const dataset = datasets.buildHistoricalDataset({ store: source, report, generatedAt: "2026-09-09T04:30:00.000Z" });
  assert.equal(dataset.snapshots[1].sqrtPriceX96, "637434091718179387822692496724259019");
  assert.equal(dataset.latestIncludedFinalizedBlock.blockNumber, "51064756");
  assert.equal(dataset.gaps.length, 1);
  assert.equal(dataset.resolutions.length, 2);
  assert.deepEqual(dataset.fees, { included: false, status: "unavailable" });
  assert.equal(dataset.resolutionPolicy.interpolation, false);
});

test("committed sample dataset validates against the versioned contract", () => {
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/lp-dataset-v1.json"), "utf8"));
  assert.equal(datasets.validateHistoricalDataset(sample), sample);
  assert.equal(sample.snapshots.length, 2);
});

test("dataset validation detects hash, range, ordering, identity, and size conflicts", () => {
  const valid = datasets.buildHistoricalDataset({ store: store(), generatedAt: "2026-09-09T04:30:00.000Z" });
  assert.throws(() => datasets.validateHistoricalDataset({ ...valid, identity: { ...valid.identity, pool: "0x0" } }), /identity/);
  assert.throws(() => datasets.validateHistoricalDataset({ ...valid, availableRange: { ...valid.availableRange, through: valid.availableRange.from } }), /range metadata/);
  assert.throws(() => datasets.validateHistoricalDataset({ ...valid, snapshots: [...valid.snapshots].reverse() }), /strictly ordered/);
  assert.throws(() => datasets.validateHistoricalDataset({ ...valid, resolutions: [{ ...valid.resolutions[0], blockHash: "0x" + "0".repeat(64) }] }), /resolution/);
  assert.throws(() => datasets.buildHistoricalDataset({ store: store(), generatedAt: "2026-09-09T04:30:00.000Z", maxSnapshots: 1 }), /bounded snapshot/);
});

test("atomic export validates old and new datasets before replacement", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cypress-lp-export-"));
  const file = path.join(directory, "lp-v1.json");
  const valid = datasets.buildHistoricalDataset({ store: store(), generatedAt: "2026-09-09T04:30:00.000Z" });
  datasets.writeDatasetAtomic(file, valid);
  const before = fs.readFileSync(file, "utf8");
  assert.deepEqual(datasets.validateHistoricalDataset(JSON.parse(before)), valid);
  assert.throws(() => datasets.writeDatasetAtomic(file, { ...valid, fees: { included: true } }), /fee or interpolation/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.writeFileSync(file, "corrupt");
  assert.throws(() => datasets.writeDatasetAtomic(file, valid), /existing LP dataset is malformed/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("exported fixture states remain compatible with B1 principal and HODL math", () => {
  const dataset = datasets.buildHistoricalDataset({ store: store(), generatedAt: "2026-09-09T04:30:00.000Z" });
  const result = simulator.simulateFullRange({
    start: history.toSimulatorState(dataset.snapshots[0]), end: history.toSimulatorState(dataset.snapshots[1])
  });
  assert.ok(result.ending.assetPnlUsdc.numerator > 0n);
  assert.ok(result.ending.lpVsHodlUsdc.numerator < 0n);
  assert.equal(result.fees.status, "unavailable");
});
