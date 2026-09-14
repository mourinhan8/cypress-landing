"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

let DISCLOSURE, buildPricePathDataset, formatRational, normalizeDailyPricePoints, parsePositiveDecimal, periodStartTimestamp;

const POOL = "0x962265593a7f6f5f0804b6a3ed203aa5d2e0d1e9";
const CP = "0x934ef4bfffdce191ac4bcc351b2fe7892865b440";
const lpHistory = JSON.parse(fs.readFileSync(path.join(__dirname, "../api/lp/v1/history.json"), "utf8"));

test.before(async () => {
  ({ DISCLOSURE, buildPricePathDataset, formatRational, normalizeDailyPricePoints, parsePositiveDecimal, periodStartTimestamp }
    = await import("../tools/comparison/price-path.mjs"));
});

function dayRange(first = "2025-09-01", last = "2026-09-05") {
  const result = [];
  for (let value = Date.parse(first + "T00:00:00.000Z"); value <= Date.parse(last + "T00:00:00.000Z"); value += 86_400_000) {
    result.push(new Date(value).toISOString().slice(0, 10));
  }
  return result;
}

function historicalObservation(date, close = "0.01", overrides = {}) {
  const start = date + "T00:00:00.000Z";
  return {
    continuity_id: "cypress-cp",
    source: "coingecko_csv",
    source_kind: "daily_close",
    source_asset_namespace: "coingecko",
    source_asset_id: "cypress",
    chain_scope: "coingecko_listing_continuity",
    interval_start: start,
    interval_end: new Date(Date.parse(start) + 86_400_000).toISOString(),
    close_usd: close,
    source_volume_usd: "1",
    source_row: 2,
    source_sha256: "a".repeat(64),
    rule_version: "test-policy-v1",
    quality: "observed_daily_close",
    ...overrides
  };
}

function currentObservation(start, close = "0.015") {
  return {
    continuity_id: "cypress-cp",
    source: "geckoterminal",
    source_kind: "real_ohlcv",
    source_asset_id: CP,
    network: "base",
    pool: POOL,
    interval_start: start,
    interval_end: new Date(Date.parse(start) + 3_600_000).toISOString(),
    close_usd: close,
    source_stream_version: "test-stream-v1",
    raw_record_hash: "b".repeat(64),
    quality: "real_ohlcv",
    finalized: true
  };
}

function input(options = {}) {
  const missing = new Set(options.missing || []);
  const prices = options.prices || {};
  const historical = dayRange(options.first, options.last)
    .filter(date => !missing.has(date))
    .map(date => historicalObservation(date, prices[date] || "0.01"));
  return {
    generatedAt: "2026-09-09T07:00:00.000Z",
    historical: {
      metadata: {
        source: "coingecko_csv",
        source_asset_id: "cypress",
        import_version: "test-import-v1",
        source_sha256: "a".repeat(64),
        first_source_date: options.first || "2025-09-01",
        last_source_date: options.last || "2026-09-05"
      },
      observations: options.observations || historical,
      auditRecords: options.auditRecords || []
    },
    current: {
      metadata: {
        source: "geckoterminal",
        pool: POOL,
        generation_id: "test-generation-v1",
        source_stream_version: "test-stream-v1"
      },
      observations: options.current || []
    },
    lpHistory
  };
}

function point(dataset, timestamp) {
  return dataset.points.find(item => item.timestamp === timestamp);
}

function normalizationPoint(id, timestamp, price) {
  const value = parsePositiveDecimal(price);
  return {
    id,
    timestamp,
    priceUsd: { numerator: value.numerator.toString(), denominator: value.denominator.toString(), raw: price },
    observed: true,
    estimated: false,
    carriedForward: false,
    source: { provider: "fixture", identity: id }
  };
}

test("defines deterministic UTC boundaries for all four periods and shares them between strategies", () => {
  const dataset = buildPricePathDataset(input());
  assert.equal(dataset.periods["7D"].targetStartTimestamp, "2026-09-02T00:00:00.000Z");
  assert.equal(dataset.periods["30D"].targetStartTimestamp, "2026-08-10T00:00:00.000Z");
  assert.equal(dataset.periods["6M"].targetStartTimestamp, "2026-03-09T00:00:00.000Z");
  assert.equal(dataset.periods["1Y"].targetStartTimestamp, "2025-09-09T00:00:00.000Z");
  for (const period of Object.values(dataset.periods)) {
    assert.deepEqual(period.strategyBoundaries.holdCp, period.strategyBoundaries.rebalancedLp);
    assert.equal(period.actualEndTimestamp, "2026-09-09T00:00:00.000Z");
  }
});

test("uses the exact arithmetic mean for multiple same-day observations", () => {
  const source = [
    normalizationPoint("a", "2026-01-01T01:00:00.000Z", "0.01"),
    normalizationPoint("b", "2026-01-01T12:00:00.000Z", "0.02"),
    normalizationPoint("c", "2026-01-01T23:00:00.000Z", "0.03")
  ];
  const normalized = normalizeDailyPricePoints(source);
  assert.equal(normalized.points[0].priceUsd.decimal, "0.02");
  assert.equal(normalized.points[0].normalization.observationCount, 3);
  assert.deepEqual(normalized.points[0].normalization.observations, source);
});

test("averages all 24 hourly observations and only available partial-day observations", () => {
  const hourly = Array.from({ length: 24 }, (_, hour) => normalizationPoint(
    "h" + hour,
    `2026-01-01T${String(hour).padStart(2, "0")}:00:00.000Z`,
    String(hour + 1)
  ));
  const complete = normalizeDailyPricePoints(hourly).points[0];
  assert.equal(complete.priceUsd.decimal, "12.5");
  assert.equal(complete.normalization.observationCount, 24);
  const partial = normalizeDailyPricePoints([hourly[0], hourly[5], hourly[23]]).points[0];
  assert.equal(partial.priceUsd.decimal, "10.333333333333333333333333333333333333");
  assert.equal(partial.normalization.observationCount, 3);
});

test("calendar subtraction clamps month ends and leap days deterministically", () => {
  assert.equal(periodStartTimestamp("2026-08-31T12:34:56.789Z", "6M"), "2026-02-28T12:34:56.789Z");
  assert.equal(periodStartTimestamp("2024-02-29T00:00:00.000Z", "1Y"), "2023-02-28T00:00:00.000Z");
});

test("an isolated missing daily price is the arithmetic average of valid neighbors", () => {
  const dataset = buildPricePathDataset(input({
    missing: ["2026-08-16"],
    prices: { "2026-08-15": "0.010", "2026-08-17": "0.012" }
  }));
  const estimated = point(dataset, "2026-08-16T00:00:00.000Z");
  assert.equal(estimated.priceUsd.decimal, "0.011");
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.provenance.method, "linear_interpolation_elapsed_time");
});

test("multiple consecutive missing days use proportional elapsed-time interpolation", () => {
  const dataset = buildPricePathDataset(input({
    missing: ["2026-08-08", "2026-08-09"],
    prices: { "2026-08-07": "0.01", "2026-08-10": "0.016" }
  }));
  assert.equal(point(dataset, "2026-08-08T00:00:00.000Z").priceUsd.decimal, "0.012");
  assert.equal(point(dataset, "2026-08-09T00:00:00.000Z").priceUsd.decimal, "0.014");
});

test("a missing normalized start day is interpolated and retains provenance", () => {
  const dataset = buildPricePathDataset(input({
    missing: ["2026-09-02"],
    prices: { "2026-09-01": "0.01", "2026-09-03": "0.02" }
  }));
  const startId = dataset.periods["7D"].strategyBoundaries.holdCp.startPointId;
  const start = dataset.points.find(item => item.id === startId);
  assert.equal(start.timestamp, "2026-09-02T00:00:00.000Z");
  assert.equal(start.estimated, true);
  assert.equal(start.provenance.reason.type, "absent_source_observation");
  assert.match(start.provenance.beforePointId, /^daily:/);
  assert.match(start.provenance.afterPointId, /^daily:/);
});

test("does not extrapolate a period start beyond historical coverage", () => {
  assert.throws(() => buildPricePathDataset(input({ first: "2025-09-10" })), /outside available price boundaries/);
});

test("normalizes only post-cutover pool observations and preserves exact source boundaries", () => {
  const dataset = buildPricePathDataset(input({
    current: [
      currentObservation("2026-09-06T12:00:00.000Z", "0.015"),
      currentObservation("2026-09-09T06:00:00.000Z", "0.099")
    ]
  }));
  const cutoverDay = point(dataset, "2026-09-06T00:00:00.000Z");
  const endDay = point(dataset, "2026-09-09T00:00:00.000Z");
  assert.equal(cutoverDay.normalization.observationCount, 2);
  assert.deepEqual(cutoverDay.normalization.sourceProviders, ["base_archive_rpc", "geckoterminal"]);
  assert.equal(cutoverDay.normalization.observations[0].source.role, "initialization");
  assert.equal(cutoverDay.normalization.observations[1].source.intervalStart, "2026-09-06T12:00:00.000Z");
  assert.equal(endDay.normalization.observationCount, 1);
  assert.equal(endDay.normalization.observations[0].source.role, "finalized_end");
  assert.equal(endDay.normalization.observations.some(item => item.timestamp === "2026-09-09T07:00:00.000Z"), false,
    "post-end candle must not create look-ahead");
});

test("deduplicates identical underlying observations and rejects conflicting duplicates", () => {
  const candidate = input();
  const original = candidate.historical.observations.find(item => item.interval_start === "2026-01-01T00:00:00.000Z");
  candidate.historical.observations.push(structuredClone(original));
  const dataset = buildPricePathDataset(candidate);
  assert.equal(point(dataset, "2026-01-01T00:00:00.000Z").normalization.observationCount, 1);
  assert.equal(point(dataset, "2026-01-01T00:00:00.000Z").normalization.duplicateObservationCount, 1);
  assert.equal(dataset.coverage.duplicateSourceObservationCount, 1);

  const conflicting = input();
  const conflict = structuredClone(conflicting.historical.observations.find(
    item => item.interval_start === "2026-01-01T00:00:00.000Z"));
  conflict.close_usd = "0.02";
  conflicting.historical.observations.push(conflict);
  assert.throws(() => buildPricePathDataset(conflicting), /conflicting duplicate observation/);
});

test("invalid prices fail closed and excluded audit rows are not interpolation anchors", () => {
  const invalid = input();
  invalid.historical.observations[0].close_usd = "NaN";
  assert.throws(() => buildPricePathDataset(invalid), /canonical positive decimal/);

  const dataset = buildPricePathDataset(input({
    missing: ["2026-08-16"],
    prices: { "2026-08-15": "0.01", "2026-08-17": "0.012" },
    auditRecords: [{
      normalized_date: "2026-08-16",
      source_row: 42,
      status: "excluded_outlier",
      reason: "approved_outlier_policy"
    }]
  }));
  const estimated = point(dataset, "2026-08-16T00:00:00.000Z");
  assert.equal(estimated.priceUsd.decimal, "0.011");
  assert.equal(estimated.provenance.reason.type, "invalid_or_excluded_source_observation");
  assert.equal(estimated.provenance.reason.sourceRecords[0].status, "excluded_outlier");
});

test("uses exact decimal/BigInt rational arithmetic without binary floating-point loss", () => {
  const value = parsePositiveDecimal("0.123456789012345678901234567890123456");
  assert.equal(formatRational(value), "0.123456789012345678901234567890123456");
  const dataset = buildPricePathDataset(input({
    missing: ["2026-08-16"],
    prices: {
      "2026-08-15": "0.123456789012345678901234567890123456",
      "2026-08-17": "0.123456789012345678901234567890123458"
    }
  }));
  assert.equal(point(dataset, "2026-08-16T00:00:00.000Z").priceUsd.decimal,
    "0.123456789012345678901234567890123457");
});

test("preserves original source objects and raw observed prices", () => {
  const candidate = input({ prices: { "2026-01-01": "0.0100" } });
  const original = structuredClone(candidate);
  const dataset = buildPricePathDataset(candidate);
  assert.deepEqual(candidate, original);
  assert.equal(point(dataset, "2026-01-01T00:00:00.000Z")
    .normalization.observations[0].priceUsd.raw, "0.0100");
});

test("exports localized disclosure and estimated-point metadata without presenting estimates as observations", () => {
  const dataset = buildPricePathDataset(input({ missing: ["2026-08-16"] }));
  assert.deepEqual(dataset.disclosure, DISCLOSURE);
  const estimated = point(dataset, "2026-08-16T00:00:00.000Z");
  assert.equal(estimated.observed, false);
  assert.equal(estimated.estimated, true);
  assert.ok(dataset.coverage.estimatedTimestamps.includes(estimated.timestamp));
});

test("repeated daily generation is byte-for-byte deterministic", () => {
  const candidate = input({
    missing: ["2026-08-08", "2026-08-09"],
    current: [currentObservation("2026-09-06T12:00:00.000Z")]
  });
  assert.equal(JSON.stringify(buildPricePathDataset(candidate)), JSON.stringify(buildPricePathDataset(structuredClone(candidate))));
});

test("checked-in normalized dataset is bounded, pinned, and uses one point per UTC day", () => {
  const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/comparison/price-path-v2.json"), "utf8"));
  assert.equal(dataset.schemaVersion, 2);
  assert.equal(dataset.sourceVersions.historicalImportVersion,
    "schema1-coingecko-cypress-close-outlier-v1-4aee259b8518ab45");
  assert.equal(dataset.sourceVersions.currentGenerationId, "generation-bd2ada112f0c33af359f");
  assert.equal(dataset.sourceVersions.latestExactBlockNumber, "51072166");
  assert.equal(dataset.coverage.firstPathTimestamp, "2025-09-09T00:00:00.000Z");
  assert.equal(dataset.coverage.throughExactTimestamp, "2026-09-09T06:01:19.000Z");
  assert.equal(dataset.coverage.throughDailyTimestamp, "2026-09-09T00:00:00.000Z");
  assert.deepEqual(dataset.coverage.unresolvedHistoricalDates, []);
  assert.equal(new Set(dataset.points.map(item => item.timestamp.slice(0, 10))).size, dataset.points.length);
  assert.deepEqual(Object.fromEntries(Object.entries(dataset.periods).map(([name, period]) => [
    name, period.pointRange.throughInclusive - period.pointRange.fromInclusive + 1
  ])), { "7D": 8, "30D": 31, "6M": 185, "1Y": 366 });
  for (const period of Object.values(dataset.periods)) {
    assert.deepEqual(period.strategyBoundaries.holdCp, period.strategyBoundaries.rebalancedLp);
  }
});
