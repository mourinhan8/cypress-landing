"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const cache = JSON.parse(fs.readFileSync(path.join(root, "data/comparison/reference-fee-window-v2.json"), "utf8"));
const oldPool = "0x962265593a7f6f5f0804b6a3ed203aa5d2e0d1e9";
const v2Pool = "0xa290c53cc25f0b857d21421b2f757f9a3434f80e";
let collector, fees, ui;

test.before(async () => {
  collector = await import("../tools/comparison/collect-v2-reference-fee.mjs");
  fees = await import("../tools/comparison/reference-fee.mjs");
  ui = await import("../assets/js/lp-calculator.mjs");
});

test("uses the specified V2 pool and fixed 0.25% LP fee", () => {
  assert.equal(collector.V2_POOL, v2Pool);
  assert.deepEqual(cache.identity.lpFeeFraction, { numerator: "1", denominator: "400" });
  assert.equal(fees.V2_LP_FEE_FRACTION.numerator, 1n);
  assert.equal(fees.V2_LP_FEE_FRACTION.denominator, 400n);
  const invalid = structuredClone(cache);
  invalid.identity.lpFeeFraction = { numerator: "3", denominator: "1000" };
  assert.equal(fees.calculateV2ReferenceApr(invalid).available, false);
});

test("annualizes the exact seven-day V2 observations deterministically", () => {
  const result = fees.calculateV2ReferenceApr(cache);
  assert.equal(result.available, true);
  assert.equal(result.window.durationSeconds, "604800");
  assert.equal(result.window.durationDays.decimal, "7");
  assert.equal(result.totalVolumeUsd.decimal, "161.70824362329669");
  assert.equal(result.timeWeightedAverageTvlUsd.decimal, "4504.206031966854320922780286450773174242");
  assert.equal(result.lpFeeFraction.decimal, "0.0025");
  assert.equal(result.lpNetAprFraction.decimal, "0.004680031167662818382469688036291698");
  assert.equal(result.lpNetAprPercent.decimal, "0.468003116766281838246968803629169812");
  assert.equal(result.sourceCoverage.volumeIntervals, 7);
  assert.equal(result.sourceCoverage.tvlSnapshots, 8);
  assert.deepEqual(fees.calculateV2ReferenceApr(structuredClone(cache)), result);
});

test("rejects incomplete observation windows instead of fabricating APR", () => {
  const missingVolume = structuredClone(cache);
  missingVolume.volume.intervals.pop();
  assert.equal(fees.calculateV2ReferenceApr(missingVolume).available, false);
  const missingLiquidity = structuredClone(cache);
  missingLiquidity.tvl.snapshots.pop();
  assert.equal(fees.calculateV2ReferenceApr(missingLiquidity).available, false);
});

test("main product path uses V2 APR while legacy V3 reference remains inactive", () => {
  const active = fs.readFileSync(path.join(root, "assets/js/lp-calculator.mjs"), "utf8");
  assert.match(active, /calculateV2ReferenceApr\(referenceFeeWindow\)/);
  assert.match(active, /reference-fee-window-v2\.json/);
  assert.doesNotMatch(active, /calculateReferenceApr\(referenceFeeWindow\)|reference-fee-window-v1\.json/);
  assert.doesNotMatch(active, new RegExp(oldPool, "i"));
  assert.equal(ui.REFERENCE_FEE_URL, "/data/comparison/reference-fee-window-v2.json");
});

test("XYK principal is unchanged and new APR affects only the fee ledger", () => {
  const prices = JSON.parse(fs.readFileSync(path.join(root, "data/comparison/price-path-v2.json"), "utf8"));
  const comparison = ui.buildComparisonResults(prices, cache);
  assert.equal(comparison.periods["7D"].xykLp.principalEndingValueUsdc.decimal,
    "1024.727594768024536810784444022797709943");
  assert.equal(comparison.periods["1Y"].xykLp.principalEndingValueUsdc.decimal,
    "941.24229401382160521275866293376149016");
  assert.equal(comparison.periods["7D"].xykLp.estimatedFeesUsdc.decimal,
    "0.091232010684107885430078519221013075");
  assert.equal(comparison.periods["1Y"].xykLp.estimatedFeesUsdc.decimal,
    "4.066023539599642892002376595416925916");
});
