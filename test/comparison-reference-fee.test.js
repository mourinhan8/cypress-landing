"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

let collector, fees, strategy;
const pool = "0x962265593a7f6f5f0804b6a3ed203aa5d2e0d1e9";
const initialization = "2026-09-06T05:36:17.000Z";
const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/comparison/price-path-v2.json"), "utf8"));
const actualCache = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/comparison/reference-fee-window-v1.json"), "utf8"));

test.before(async () => {
  collector = await import("../tools/comparison/collect-reference-fee.mjs");
  fees = await import("../tools/comparison/reference-fee.mjs");
  strategy = await import("../tools/comparison/hold-vs-rebalanced-lp.mjs");
});

test("constructs bounded UTC-hour sampling boundaries without moving exact endpoints", () => {
  assert.deepEqual(collector.hourlyBoundaries(initialization, "2026-09-06T07:12:34.000Z"), [
    initialization,
    "2026-09-06T06:00:00.000Z",
    "2026-09-06T07:00:00.000Z",
    "2026-09-06T07:12:34.000Z"
  ]);
});

function decimal(value) {
  const [integer, fraction = ""] = value.split(".");
  return { numerator: BigInt(integer + fraction).toString(), denominator: (10n ** BigInt(fraction.length)).toString() };
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function cacheFixture(options = {}) {
  const startMs = Date.parse(initialization);
  const durationHours = options.durationHours ?? 48;
  const endMs = startMs + durationHours * 3_600_000;
  const tvls = options.tvls || Array.from({ length: durationHours + 1 }, () => "100");
  const snapshots = tvls.map((tvl, index) => ({
    blockNumber: String(50_941_815 + index * 1_800),
    blockHash: "0x" + (index + 1).toString(16).padStart(64, "0"),
    timestamp: iso(startMs + index * 3_600_000),
    token0BalanceRaw: "1",
    token1BalanceRaw: "1",
    sqrtPriceX96: "1",
    tvlUsd: decimal(tvl),
    stateSourceBlockNumber: String(50_941_815 + index * 1_800),
    stateSourceBlockHash: "0x" + (index + 1).toString(16).padStart(64, "0"),
    stateSourceTimestamp: iso(startMs + index * 3_600_000),
    carriedForwardNoPoolEvents: false
  }));
  const volumeIntervals = (options.volumes || []).map((volume, index) => ({
    startTimestamp: iso(startMs + index * 3_600_000),
    endTimestamp: iso(startMs + (index + 1) * 3_600_000),
    volumeUsd: decimal(volume),
    finalized: true,
    rawRecordHash: (index + 1).toString(16).padStart(64, "0")
  }));
  return {
    schemaVersion: 1,
    kind: "cypress-reference-fee-window",
    generatedAt: iso(endMs + 60_000),
    cacheVersion: "fixture-v1",
    identity: { chainId: 8453, pool, feeTier: "10000" },
    window: {
      requestedDays: 7,
      initializationTimestamp: initialization,
      startTimestamp: initialization,
      endTimestamp: iso(endMs),
      latestFinalizedBlock: { blockNumber: "1", blockHash: "0x" + "1".repeat(64), timestamp: iso(endMs) }
    },
    volume: {
      source: "geckoterminal",
      generationId: "fixture-generation",
      coverageStart: initialization,
      coverageEnd: iso(endMs),
      sparseIntervalsMeanZeroVolume: true,
      intervals: volumeIntervals
    },
    tvl: { method: "hourly_block_pinned_balances_trapezoidal", snapshots },
    protocolFee: {
      eventTopic: "0x973d8d92bb299f4af6ce49b52a8adb85ae46b9f214c4c4fc06ac77401237b133",
      historyVerified: true,
      segments: options.protocolSegments || [{
        startTimestamp: initialization,
        endTimestamp: iso(endMs),
        token0Denominator: 0,
        token1Denominator: 0
      }]
    }
  };
}

function pricePoint(index, price) {
  return {
    id: "p" + index,
    timestamp: iso(Date.UTC(2025, 0, 1 + index)),
    priceUsd: decimal(price),
    observed: true,
    estimated: false,
    carriedForward: false,
    source: { provider: "fixture" }
  };
}

test("uses partial pool-age windows and switches deterministically to a full seven days", () => {
  const partial = fees.calculateReferenceApr(cacheFixture({ durationHours: 72 }));
  const complete = fees.calculateReferenceApr(cacheFixture({ durationHours: 168 }));
  assert.equal(partial.available, true);
  assert.equal(partial.window.partial, true);
  assert.equal(partial.window.durationDays.decimal, "3");
  assert.equal(complete.available, true);
  assert.equal(complete.window.partial, false);
  assert.equal(complete.window.durationDays.decimal, "7");
});

test("enforces initialization and seven-day window boundaries", () => {
  const before = cacheFixture();
  before.window.startTimestamp = "2026-09-06T05:36:16.000Z";
  assert.equal(fees.calculateReferenceApr(before).available, false);
  const tooLong = cacheFixture({ durationHours: 169 });
  assert.equal(fees.calculateReferenceApr(tooLong).available, false);
});

test("calculates a trapezoidal time-weighted average TVL", () => {
  const result = fees.calculateReferenceApr(cacheFixture({
    durationHours: 2,
    tvls: ["100", "200", "300"],
    volumes: ["100"]
  }));
  assert.equal(result.timeWeightedAverageTvlUsd.decimal, "200");
  assert.equal(result.totalVolumeUsd.decimal, "100");
  assert.equal(result.grossAprPercent.decimal, "2190");
});

test("applies verified protocol-fee changes to their own finalized volume intervals", () => {
  const startMs = Date.parse(initialization);
  const result = fees.calculateReferenceApr(cacheFixture({
    durationHours: 2,
    volumes: ["100", "100"],
    protocolSegments: [
      { startTimestamp: initialization, endTimestamp: iso(startMs + 3_600_000), token0Denominator: 0, token1Denominator: 0 },
      { startTimestamp: iso(startMs + 3_600_000), endTimestamp: iso(startMs + 7_200_000), token0Denominator: 4, token1Denominator: 4 }
    ]
  }));
  assert.equal(result.volumeWeightedProtocolFeeShare.decimal, "0.125");
  assert.equal(result.grossAprPercent.decimal, "8760");
  assert.equal(result.lpNetAprPercent.decimal, "7665");
});

test("does not guess protocol deductions when direction differs or a change bisects aggregate volume", () => {
  const unequal = cacheFixture();
  unequal.protocolFee.segments[0].token0Denominator = 4;
  unequal.protocolFee.segments[0].token1Denominator = 6;
  assert.equal(fees.calculateReferenceApr(unequal).available, false);

  const startMs = Date.parse(initialization);
  const bisected = cacheFixture({
    durationHours: 1,
    volumes: ["100"],
    protocolSegments: [
      { startTimestamp: initialization, endTimestamp: iso(startMs + 1_800_000), token0Denominator: 0, token1Denominator: 0 },
      { startTimestamp: iso(startMs + 1_800_000), endTimestamp: iso(startMs + 3_600_000), token0Denominator: 4, token1Denominator: 4 }
    ]
  });
  assert.equal(fees.calculateReferenceApr(bisected).available, false);
});

test("accepts verified zero volume but rejects invalid volume, TVL, and missing coverage", () => {
  const zero = fees.calculateReferenceApr(cacheFixture());
  assert.equal(zero.available, true);
  assert.equal(zero.grossAprPercent.decimal, "0");
  assert.equal(zero.lpNetAprPercent.decimal, "0");

  const invalidVolume = cacheFixture({ volumes: ["1"] });
  invalidVolume.volume.intervals[0].volumeUsd.numerator = "-1";
  assert.equal(fees.calculateReferenceApr(invalidVolume).available, false);
  const zeroTvl = cacheFixture();
  zeroTvl.tvl.snapshots[0].tvlUsd.numerator = "0";
  assert.equal(fees.calculateReferenceApr(zeroTvl).available, false);
  const missingTvl = cacheFixture();
  missingTvl.tvl.snapshots.pop();
  assert.equal(fees.calculateReferenceApr(missingTvl).available, false);
  const missingVolumeCoverage = cacheFixture();
  missingVolumeCoverage.volume.coverageEnd = iso(Date.parse(missingVolumeCoverage.window.endTimestamp) - 1);
  assert.equal(fees.calculateReferenceApr(missingVolumeCoverage).available, false);
});

test("preserves high-precision rational inputs and deterministic output", () => {
  const candidate = cacheFixture({
    durationHours: 1,
    tvls: ["12345.678901234567890123456789", "12345.678901234567890123456789"],
    volumes: ["0.12345678901234567890123456789"]
  });
  const first = fees.calculateReferenceApr(candidate);
  const second = fees.calculateReferenceApr(structuredClone(candidate));
  assert.deepEqual(first, second);
  assert.equal(first.totalVolumeUsd.decimal, "0.12345678901234567890123456789");
});

test("flat projection accrues a separate non-compounding fee ledger", () => {
  const points = [pricePoint(0, "1"), pricePoint(1, "1"), pricePoint(2, "1")];
  const projection = fees.projectFeesOnPrincipalPath(points, decimal("0.365"));
  assert.equal(projection.endingPrincipalValueUsdc.decimal, "1000");
  assert.equal(projection.estimatedFeesUsdc.decimal, "2");
  assert.equal(projection.endingValueIncludingEstimatedFeesUsdc.decimal, "1002");
  assert.equal(projection.reinvested, false);
});

test("rising, falling, and oscillating paths accrue against changing principal", () => {
  for (const values of [["1", "1.2", "1.4"], ["1", "0.8", "0.6"], ["1", "1.2", "0.9", "1"]]) {
    const points = values.map((price, index) => pricePoint(index, price));
    const principal = strategy.evaluateRebalancedPath(points);
    const projection = fees.projectFeesOnPrincipalPath(points, decimal("0.1"));
    assert.equal(projection.endingPrincipalValueUsdc.decimal, principal.endingPrincipalValueUsdc.decimal);
    assert.ok(BigInt(projection.estimatedFeesUsdc.numerator) > 0n);
  }
});

test("uses trapezoidal changing principal and never adds fees back into later exposure", () => {
  const points = [pricePoint(0, "1"), pricePoint(1, "2")];
  points[1].timestamp = iso(Date.UTC(2026, 0, 1));
  points[0].timestamp = iso(Date.UTC(2025, 0, 1));
  const principal = strategy.evaluateRebalancedPath(points).endingPrincipalValueUsdc;
  const projection = fees.projectFeesOnPrincipalPath(points, decimal("0.1"));
  const expectedNumerator = (1000n * BigInt(principal.denominator) + BigInt(principal.numerator)) * 1n;
  const expectedDenominator = 2n * BigInt(principal.denominator) * 10n;
  assert.equal(BigInt(projection.estimatedFeesUsdc.numerator) * expectedDenominator,
    expectedNumerator * BigInt(projection.estimatedFeesUsdc.denominator));
  assert.equal(projection.principalSeries.at(-1).principalValueUsdc.decimal, principal.decimal);
});

test("unavailable APR preserves the complete principal-only comparison and Hold result", () => {
  const unavailable = fees.calculateReferenceApr({});
  const projected = fees.projectPeriodFees(dataset, "7D", unavailable);
  const principal = strategy.comparePeriod(dataset, "7D");
  assert.equal(projected.referenceFee.available, false);
  assert.equal(projected.rebalancedLp.estimatedFeesUsdc, null);
  assert.deepEqual(projected.holdCp, principal.holdCp);
  assert.deepEqual(projected.rebalancedLp.principalEndingValueUsdc, principal.rebalancedLpPrincipal.endingValueUsdc);
  assert.deepEqual(projected.rebalancedLp.endingValueIncludingEstimatedFeesUsdc,
    principal.rebalancedLpPrincipal.endingValueUsdc);
});

test("all four periods use one shared reference APR and leave Hold returns unchanged", () => {
  const apr = fees.calculateReferenceApr(actualCache);
  const results = fees.projectAllPeriodFees(dataset, apr);
  const intervalCounts = { "7D": 7, "30D": 30, "6M": 184, "1Y": 365 };
  for (const period of ["7D", "30D", "6M", "1Y"]) {
    assert.equal(results[period].referenceFee.cacheVersion, apr.cacheVersion);
    assert.deepEqual(results[period].holdCp, strategy.comparePeriod(dataset, period).holdCp);
    assert.equal(results[period].rebalancedLp.feeProjectionIncluded, true);
    assert.equal(results[period].rebalancedLp.feesReinvested, false);
    assert.equal(results[period].rebalancedLp.intervalCount, intervalCounts[period]);
    assert.ok(BigInt(results[period].rebalancedLp.estimatedFeesUsdc.numerator) > 0n);
  }
});

test("the pinned cache produces the reproducible current partial-window APR", () => {
  const result = fees.calculateReferenceApr(actualCache);
  assert.equal(result.available, true);
  assert.equal(result.window.startTimestamp, initialization);
  assert.equal(result.window.endTimestamp, "2026-09-09T12:58:19.000Z");
  assert.equal(result.window.durationSeconds, "285722");
  assert.equal(result.totalVolumeUsd.decimal, "85.57922818550132");
  assert.equal(result.timeWeightedAverageTvlUsd.decimal, "19878.910674371007760300798706937836030438");
  assert.equal(result.volumeWeightedProtocolFeeShare.decimal, "0.166666666666666666666666666666666666");
  assert.equal(result.grossAprPercent.decimal, "0.475158725380187330991548508515001733");
  assert.equal(result.lpNetAprPercent.decimal, "0.395965604483489442492957090429168111");
  assert.equal(actualCache.protocolFee.events.length, 1);
  assert.equal(actualCache.tvl.snapshots.length, 81);
});
