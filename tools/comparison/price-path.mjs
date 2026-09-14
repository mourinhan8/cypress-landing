const DAY_MS = 86_400_000;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const POOL_INITIALIZATION = "2026-09-06T05:36:17.000Z";
const POOL_ADDRESS = "0x962265593a7f6f5f0804b6a3ed203aa5d2e0d1e9";
const CP_ADDRESS = "0x934ef4bfffdce191ac4bcc351b2fe7892865b440";
const USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const Q192 = 1n << 192n;

export const PRICE_PATH_SCHEMA_VERSION = 2;
export const DISCLOSURE = Object.freeze({
  vi: "Kết quả mô phỏng dựa trên dữ liệu giá lịch sử, có sử dụng giá ước lượng.",
  en: "Simulation based on historical price data, including estimated prices."
});

export const PERIODS = Object.freeze({
  "7D": Object.freeze({ kind: "elapsed_days", value: 7 }),
  "30D": Object.freeze({ kind: "elapsed_days", value: 30 }),
  "6M": Object.freeze({ kind: "calendar_months", value: 6 }),
  "1Y": Object.freeze({ kind: "calendar_years", value: 1 })
});

function canonicalTimestamp(value, label) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(label + " must be a canonical UTC ISO timestamp");
  }
  return timestamp;
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function rational(numerator, denominator) {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint" || denominator <= 0n) {
    throw new Error("invalid rational value");
  }
  if (numerator <= 0n) throw new Error("price must be positive");
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function addRational(left, right) {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

export function parsePositiveDecimal(value, label = "price") {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(label + " must be a canonical positive decimal string");
  const [integer, fraction = ""] = value.split(".");
  const parsed = BigInt(integer + fraction);
  if (parsed <= 0n) throw new Error(label + " must be positive");
  return rational(parsed, 10n ** BigInt(fraction.length));
}

export function formatRational(value, decimalPlaces = 36) {
  if (!value || typeof value.numerator !== "bigint" || typeof value.denominator !== "bigint" || value.denominator <= 0n) {
    throw new Error("invalid rational value");
  }
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 100) throw new Error("invalid decimal precision");
  const integer = value.numerator / value.denominator;
  if (decimalPlaces === 0) return integer.toString();
  const fraction = ((value.numerator % value.denominator) * 10n ** BigInt(decimalPlaces) / value.denominator)
    .toString().padStart(decimalPlaces, "0").replace(/0+$/, "");
  return fraction ? integer + "." + fraction : integer.toString();
}

function serializedPrice(value, raw = null) {
  const reduced = rational(value.numerator, value.denominator);
  return {
    numerator: reduced.numerator.toString(),
    denominator: reduced.denominator.toString(),
    decimal: formatRational(reduced),
    raw,
    decimalPlaces: 36,
    rounding: "toward-zero"
  };
}

function priceOf(point) {
  return { numerator: BigInt(point.priceUsd.numerator), denominator: BigInt(point.priceUsd.denominator) };
}

function interpolatePrice(before, after, targetMs) {
  const beforeMs = canonicalTimestamp(before.timestamp, "before timestamp");
  const afterMs = canonicalTimestamp(after.timestamp, "after timestamp");
  if (targetMs <= beforeMs || targetMs >= afterMs) throw new Error("interpolation target must be strictly bracketed");
  const a = priceOf(before);
  const b = priceOf(after);
  const elapsed = BigInt(afterMs - beforeMs);
  const leftWeight = BigInt(afterMs - targetMs);
  const rightWeight = BigInt(targetMs - beforeMs);
  return rational(
    a.numerator * b.denominator * leftWeight + b.numerator * a.denominator * rightWeight,
    a.denominator * b.denominator * elapsed
  );
}

function pointId(kind, timestamp) {
  return kind + ":" + timestamp;
}

function observedHistoricalPoint(observation) {
  if (!observation || observation.source !== "coingecko_csv" || observation.source_kind !== "daily_close"
      || observation.source_asset_id !== "cypress" || observation.quality !== "observed_daily_close") {
    throw new Error("historical observation identity or quality mismatch");
  }
  const timestampMs = canonicalTimestamp(observation.interval_start, "historical interval_start");
  if (timestampMs % DAY_MS !== 0) throw new Error("historical observation must start at UTC midnight");
  const value = parsePositiveDecimal(observation.close_usd, "historical close_usd");
  return {
    id: pointId("coingecko", observation.interval_start),
    timestamp: observation.interval_start,
    priceUsd: serializedPrice(value, observation.close_usd),
    observed: true,
    estimated: false,
    carriedForward: false,
    source: {
      provider: observation.source,
      kind: observation.source_kind,
      assetId: observation.source_asset_id,
      sourceRow: observation.source_row,
      sourceSha256: observation.source_sha256,
      ruleVersion: observation.rule_version,
      intervalStart: observation.interval_start,
      intervalEnd: observation.interval_end,
      quality: observation.quality
    }
  };
}

function historicalRejectionMap(auditRecords = []) {
  const result = new Map();
  for (const record of auditRecords) {
    if (!record || record.status === "accepted" || typeof record.normalized_date !== "string") continue;
    const timestamp = record.normalized_date + "T00:00:00.000Z";
    canonicalTimestamp(timestamp, "audit normalized_date");
    const reasons = result.get(timestamp) || [];
    reasons.push({ status: record.status, reason: record.reason, sourceRow: record.source_row });
    result.set(timestamp, reasons);
  }
  return result;
}

function historicalObservedPrices(observations) {
  const observed = observations.map(observedHistoricalPoint).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return observed;
}

function assertPoolIdentity(snapshot, label) {
  if (!snapshot || snapshot.chainId !== 8453 || snapshot.pool?.toLowerCase() !== POOL_ADDRESS
      || snapshot.token0?.address?.toLowerCase() !== USDC_ADDRESS || snapshot.token0.decimals !== 6
      || snapshot.token1?.address?.toLowerCase() !== CP_ADDRESS || snapshot.token1.decimals !== 18
      || snapshot.fee !== "10000" || snapshot.tickSpacing !== "200" || snapshot.finalized !== true) {
    throw new Error(label + " pool identity or finalized state mismatch");
  }
  canonicalTimestamp(snapshot.timestamp, label + " timestamp");
  if (!/^[1-9]\d*$/.test(snapshot.blockNumber) || !/^0x[0-9a-f]{64}$/.test(snapshot.blockHash)
      || !/^[1-9]\d*$/.test(snapshot.sqrtPriceX96)) throw new Error(label + " has invalid exact state fields");
}

export function poolPriceFromSqrtPriceX96(snapshot) {
  assertPoolIdentity(snapshot, "pool snapshot");
  const sqrtPriceX96 = BigInt(snapshot.sqrtPriceX96);
  return rational(Q192 * 10n ** 12n, sqrtPriceX96 * sqrtPriceX96);
}

function exactPoolPoint(snapshot, role) {
  const value = poolPriceFromSqrtPriceX96(snapshot);
  return {
    id: pointId("b2-" + role, snapshot.timestamp),
    timestamp: snapshot.timestamp,
    priceUsd: serializedPrice(value),
    observed: true,
    estimated: false,
    carriedForward: false,
    source: {
      provider: "base_archive_rpc",
      kind: "exact_b2_pool_state",
      role,
      chainId: snapshot.chainId,
      pool: snapshot.pool,
      blockNumber: snapshot.blockNumber,
      blockHash: snapshot.blockHash,
      sqrtPriceX96: snapshot.sqrtPriceX96,
      quoteAssumption: "USDC_equals_USD"
    }
  };
}

function swapHourPoint(observation) {
  if (!observation || observation.source !== "geckoterminal" || observation.source_kind !== "real_ohlcv"
      || observation.network !== "base" || observation.pool?.toLowerCase() !== POOL_ADDRESS
      || observation.source_asset_id?.toLowerCase() !== CP_ADDRESS || observation.finalized !== true
      || observation.quality !== "real_ohlcv") throw new Error("swap-hour observation identity or quality mismatch");
  const startMs = canonicalTimestamp(observation.interval_start, "swap interval_start");
  const endMs = canonicalTimestamp(observation.interval_end, "swap interval_end");
  if (endMs <= startMs || endMs - startMs !== 3_600_000) throw new Error("swap observation must cover exactly one hour");
  const value = parsePositiveDecimal(observation.close_usd, "swap close_usd");
  return {
    id: pointId("geckoterminal", observation.interval_end),
    timestamp: observation.interval_end,
    priceUsd: serializedPrice(value, observation.close_usd),
    observed: true,
    estimated: false,
    carriedForward: false,
    source: {
      provider: observation.source,
      kind: observation.source_kind,
      sourceStreamVersion: observation.source_stream_version,
      network: observation.network,
      pool: observation.pool,
      intervalStart: observation.interval_start,
      intervalEnd: observation.interval_end,
      rawRecordHash: observation.raw_record_hash,
      quality: observation.quality
    }
  };
}

function utcDayTimestamp(timestamp) {
  const value = canonicalTimestamp(timestamp, "price point timestamp");
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
}

function observationIdentity(point) {
  const source = point.source || {};
  if (source.provider === "coingecko_csv") {
    return [source.provider, source.sourceSha256, source.sourceRow, source.intervalStart].join(":");
  }
  if (source.provider === "geckoterminal") {
    return [source.provider, source.rawRecordHash, source.intervalStart, source.intervalEnd].join(":");
  }
  if (source.provider === "base_archive_rpc") return [source.provider, source.blockHash].join(":");
  return point.id;
}

function preservedObservation(point) {
  return structuredClone(point);
}

function normalizedObservedDay(timestamp, observations, duplicateObservationCount = 0) {
  let total = null;
  for (const observation of observations) {
    const price = priceOf(observation);
    total = total ? addRational(total, price) : price;
  }
  const mean = rational(total.numerator, total.denominator * BigInt(observations.length));
  const providers = [...new Set(observations.map(point => point.source.provider))].sort();
  return {
    id: pointId("daily", timestamp),
    timestamp,
    priceUsd: serializedPrice(mean),
    observed: true,
    estimated: false,
    carriedForward: false,
    source: {
      provider: "daily_normalization",
      kind: "utc_daily_arithmetic_mean",
      observationCount: observations.length,
      providers
    },
    normalization: {
      method: "arithmetic_mean_all_valid_observations_utc_day",
      utcDate: timestamp.slice(0, 10),
      observationCount: observations.length,
      duplicateObservationCount,
      sourcePointIds: observations.map(point => point.id),
      sourceProviders: providers,
      observations: observations.map(preservedObservation)
    }
  };
}

function normalizedEstimatedDay(before, after, targetMs, reason) {
  const timestamp = new Date(targetMs).toISOString();
  return {
    id: pointId("daily-estimated", timestamp),
    timestamp,
    priceUsd: serializedPrice(interpolatePrice(before, after, targetMs)),
    observed: false,
    estimated: true,
    carriedForward: false,
    source: { provider: "daily_interpolation", kind: "missing_utc_day" },
    normalization: {
      method: "no_valid_observations",
      utcDate: timestamp.slice(0, 10),
      observationCount: 0,
      duplicateObservationCount: 0,
      sourcePointIds: [],
      sourceProviders: [],
      observations: []
    },
    provenance: {
      method: "linear_interpolation_elapsed_time",
      reason,
      beforePointId: before.id,
      beforeTimestamp: before.timestamp,
      afterPointId: after.id,
      afterTimestamp: after.timestamp
    }
  };
}

function normalizedCarriedDay(timestamp, priorObservation) {
  return {
    id: pointId("daily-carried-forward", timestamp),
    timestamp,
    priceUsd: serializedPrice(priceOf(priorObservation)),
    observed: false,
    estimated: false,
    carriedForward: true,
    source: { provider: "daily_carry_forward", kind: "no_swap_utc_day" },
    normalization: {
      method: "no_valid_observations",
      utcDate: timestamp.slice(0, 10),
      observationCount: 0,
      duplicateObservationCount: 0,
      sourcePointIds: [],
      sourceProviders: [],
      observations: []
    },
    provenance: {
      method: "carry_forward_latest_valid_pool_state",
      reason: { type: "no_intervening_swap" },
      fromPointId: priorObservation.id,
      fromTimestamp: priorObservation.timestamp
    }
  };
}

export function normalizeDailyPricePoints(points, options = {}) {
  if (!Array.isArray(points) || points.length === 0) throw new Error("observed price points are required");
  const initializationTimestamp = options.initializationTimestamp || POOL_INITIALIZATION;
  const initializationMs = canonicalTimestamp(initializationTimestamp, "initialization timestamp");
  const initializationDayMs = Date.parse(utcDayTimestamp(initializationTimestamp));
  const rejectionMap = historicalRejectionMap(options.auditRecords || []);
  const unique = new Map();
  const duplicateDays = new Map();
  let duplicates = 0;
  for (const point of points) {
    canonicalTimestamp(point?.timestamp, "price point timestamp");
    priceOf(point);
    if (point.observed !== true || point.estimated === true || point.carriedForward === true || !point.source?.provider) {
      throw new Error("daily normalization accepts only valid observed source points");
    }
    const identity = observationIdentity(point);
    const existing = unique.get(identity);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(point)) throw new Error("conflicting duplicate observation: " + identity);
      duplicates += 1;
      const day = utcDayTimestamp(point.timestamp);
      duplicateDays.set(day, (duplicateDays.get(day) || 0) + 1);
      continue;
    }
    unique.set(identity, point);
  }
  const observations = [...unique.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)
    || left.id.localeCompare(right.id));
  const groups = new Map();
  for (const point of observations) {
    const timestamp = utcDayTimestamp(point.timestamp);
    const group = groups.get(timestamp) || [];
    group.push(point);
    groups.set(timestamp, group);
  }
  const observedDays = [...groups.entries()].sort(([left], [right]) => Date.parse(left) - Date.parse(right))
    .map(([timestamp, group]) => normalizedObservedDay(timestamp, group, duplicateDays.get(timestamp) || 0));
  const observedByTimestamp = new Map(observedDays.map(point => [point.timestamp, point]));
  const firstMs = Date.parse(observedDays[0].timestamp);
  const lastMs = Date.parse(observedDays.at(-1).timestamp);
  const normalized = [];
  for (let targetMs = firstMs; targetMs <= lastMs; targetMs += DAY_MS) {
    const timestamp = new Date(targetMs).toISOString();
    const observed = observedByTimestamp.get(timestamp);
    if (observed) {
      normalized.push(observed);
      continue;
    }
    if (targetMs >= initializationDayMs) {
      const priorObservation = [...observations].reverse().find(point => Date.parse(point.timestamp) < targetMs);
      if (!priorObservation || Date.parse(priorObservation.timestamp) < initializationMs) {
        throw new Error("missing pool day has no prior valid pool state: " + timestamp);
      }
      normalized.push(normalizedCarriedDay(timestamp, priorObservation));
      continue;
    }
    const before = [...observedDays].reverse().find(point => Date.parse(point.timestamp) < targetMs);
    const after = observedDays.find(point => Date.parse(point.timestamp) > targetMs);
    if (!before || !after || Date.parse(after.timestamp) >= initializationDayMs) {
      throw new Error("missing historical day is outside available interpolation boundaries: " + timestamp);
    }
    const rejected = rejectionMap.get(timestamp) || [];
    normalized.push(normalizedEstimatedDay(before, after, targetMs, rejected.length ? {
      type: "invalid_or_excluded_source_observation",
      sourceRecords: rejected
    } : { type: "absent_source_observation" }));
  }
  return {
    points: normalized,
    sourceObservationCount: observations.length,
    duplicateObservationCount: duplicates
  };
}

function findSnapshot(lpHistory, block) {
  return lpHistory.snapshots.find(snapshot => snapshot.blockNumber === block.blockNumber && snapshot.blockHash === block.blockHash);
}

function loadExactBoundaryPoints(lpHistory) {
  if (!lpHistory || lpHistory.schemaVersion !== 1 || lpHistory.kind !== "cypress-lp-principal-history") {
    throw new Error("LP history contract mismatch");
  }
  const initialization = lpHistory.snapshots.find(snapshot => snapshot.blockNumber === lpHistory.initialization.blockNumber
    && snapshot.timestamp === lpHistory.initialization.timestamp);
  const end = findSnapshot(lpHistory, lpHistory.latestIncludedFinalizedBlock);
  if (!initialization || !end) throw new Error("LP history does not contain exact initialization and end snapshots");
  assertPoolIdentity(initialization, "initialization snapshot");
  assertPoolIdentity(end, "end snapshot");
  if (initialization.timestamp !== POOL_INITIALIZATION) throw new Error("pool initialization timestamp mismatch");
  if (Date.parse(end.timestamp) < Date.parse(initialization.timestamp)) throw new Error("end snapshot predates initialization");
  return { initialization: exactPoolPoint(initialization, "initialization"), end: exactPoolPoint(end, "finalized_end") };
}

export function periodStartTimestamp(endTimestamp, period) {
  const endMs = canonicalTimestamp(endTimestamp, "end timestamp");
  const definition = PERIODS[period];
  if (!definition) throw new Error("unsupported period: " + period);
  if (definition.kind === "elapsed_days") return new Date(endMs - definition.value * DAY_MS).toISOString();
  const end = new Date(endMs);
  const year = end.getUTCFullYear() - (definition.kind === "calendar_years" ? definition.value : 0);
  const monthIndex = end.getUTCMonth() - (definition.kind === "calendar_months" ? definition.value : 0);
  const normalizedYear = year + Math.floor(monthIndex / 12);
  const normalizedMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(normalizedYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(normalizedYear, normalizedMonth, Math.min(end.getUTCDate(), lastDay),
    end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds(), end.getUTCMilliseconds())).toISOString();
}

function sourceVersions(input) {
  return {
    historicalImportVersion: input.historical.metadata.import_version,
    historicalSourceSha256: input.historical.metadata.source_sha256,
    currentGenerationId: input.current.metadata.generation_id,
    currentSourceStreamVersion: input.current.metadata.source_stream_version,
    lpHistoryGeneratedAt: input.lpHistory.generatedAt,
    latestExactBlockNumber: input.lpHistory.latestIncludedFinalizedBlock.blockNumber,
    latestExactBlockHash: input.lpHistory.latestIncludedFinalizedBlock.blockHash
  };
}

function assertInputContracts(input) {
  if (!input?.historical?.metadata || !Array.isArray(input.historical.observations)
      || !Array.isArray(input.historical.auditRecords) || !input?.current?.metadata
      || !Array.isArray(input.current.observations)) throw new Error("complete immutable source inputs are required");
  if (input.historical.metadata.source !== "coingecko_csv" || input.historical.metadata.source_asset_id !== "cypress") {
    throw new Error("historical metadata identity mismatch");
  }
  if (input.current.metadata.source !== "geckoterminal" || input.current.metadata.pool?.toLowerCase() !== POOL_ADDRESS) {
    throw new Error("current metadata identity mismatch");
  }
  canonicalTimestamp(input.generatedAt, "generatedAt");
}

export function buildPricePathDataset(input) {
  assertInputContracts(input);
  const exact = loadExactBoundaryPoints(input.lpHistory);
  const initMs = Date.parse(exact.initialization.timestamp);
  const endMs = Date.parse(exact.end.timestamp);
  const initializationDayMs = Date.parse(utcDayTimestamp(exact.initialization.timestamp));
  const historical = historicalObservedPrices(input.historical.observations)
    .filter(point => Date.parse(point.timestamp) < initializationDayMs);
  const current = input.current.observations.map(swapHourPoint)
    .filter(point => Date.parse(point.timestamp) > initMs && Date.parse(point.timestamp) <= endMs)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const sourcePoints = [...historical, exact.initialization, ...current, exact.end]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const normalized = normalizeDailyPricePoints(sourcePoints, {
    initializationTimestamp: exact.initialization.timestamp,
    auditRecords: input.historical.auditRecords
  });
  const core = normalized.points;
  const dailyEnd = core.at(-1);

  const periodStarts = Object.fromEntries(Object.keys(PERIODS).map(period => {
    const target = periodStartTimestamp(dailyEnd.timestamp, period);
    const start = core.find(point => point.timestamp === target);
    if (!start) throw new Error("period start is outside available price boundaries: " + target);
    return [period, start];
  }));
  const earliestRequiredMs = Math.min(...Object.values(periodStarts).map(point => Date.parse(point.timestamp)));
  const points = core.filter(point => Date.parse(point.timestamp) >= earliestRequiredMs);
  const indexes = new Map(points.map((point, index) => [point.id, index]));
  const periods = Object.fromEntries(Object.entries(periodStarts).map(([period, start]) => {
    const boundary = { startPointId: start.id, endPointId: dailyEnd.id };
    return [period, {
      definition: PERIODS[period],
      targetStartTimestamp: start.timestamp,
      actualStartTimestamp: start.timestamp,
      actualEndTimestamp: dailyEnd.timestamp,
      pointRange: { fromInclusive: indexes.get(start.id), throughInclusive: indexes.get(dailyEnd.id) },
      strategyBoundaries: {
        holdCp: { ...boundary },
        rebalancedLp: { ...boundary }
      }
    }];
  }));
  const estimated = points.filter(point => point.estimated);
  const unresolvedHistoricalDates = input.historical.auditRecords
    .filter(record => record.status !== "accepted" && typeof record.normalized_date === "string")
    .map(record => record.normalized_date + "T00:00:00.000Z")
    .filter(timestamp => Date.parse(timestamp) >= earliestRequiredMs)
    .filter(timestamp => !points.some(point => point.timestamp === timestamp));

  return {
    schemaVersion: PRICE_PATH_SCHEMA_VERSION,
    kind: "cypress-hold-vs-rebalanced-lp-price-path",
    generatedAt: input.generatedAt,
    identity: {
      baseAsset: { symbol: "CP", address: CP_ADDRESS },
      quoteAsset: { symbol: "USD", poolQuoteToken: "USDC", address: USDC_ADDRESS },
      chainId: 8453,
      pool: POOL_ADDRESS
    },
    sourceVersions: sourceVersions(input),
    policy: {
      sourceCutoverTimestamp: exact.initialization.timestamp,
      prePoolSource: "accepted CoinGecko daily closes",
      postPoolSource: "finalized GeckoTerminal one-hour swap candles plus exact B2 boundaries",
      swapCloseEffectiveAt: "interval_end",
      dailyNormalization: "arithmetic_mean_all_valid_observed_prices_per_utc_calendar_day",
      dailyTimestamp: "UTC midnight identifying the represented calendar day",
      duplicateObservations: "same underlying source identity counted once; conflicting duplicates rejected",
      missingHistoricalPrices: "linear_interpolation_elapsed_time",
      interpolationArithmetic: "exact BigInt rational; decimal rendering truncates toward zero at 36 places",
      extrapolation: false,
      noSwapIntervals: "carry_forward_latest_valid_pool_state_without_creating_candles",
      endBoundary: "normalized UTC day containing the latest included finalized exact B2 pool state",
      periodBoundaries: {
        "7D": "normalized end day minus 7 elapsed UTC days",
        "30D": "normalized end day minus 30 elapsed UTC days",
        "6M": "normalized end day minus 6 UTC calendar months, clamped to month end",
        "1Y": "normalized end day minus 1 UTC calendar year, clamped for leap day"
      }
    },
    disclosure: DISCLOSURE,
    coverage: {
      sourceFirstHistoricalTimestamp: input.historical.metadata.first_source_date + "T00:00:00.000Z",
      sourceLastHistoricalDate: input.historical.metadata.last_source_date,
      lastAcceptedHistoricalTimestamp: historical.filter(point => point.observed).at(-1)?.timestamp || null,
      sourceQualityCounts: input.historical.metadata.counts,
      sourceMissingCalendarDates: input.historical.metadata.missing_calendar_dates,
      firstPathTimestamp: points[0]?.timestamp || null,
      throughExactTimestamp: exact.end.timestamp,
      throughDailyTimestamp: dailyEnd.timestamp,
      sourceAcceptedHistoricalObservations: input.historical.metadata.counts?.accepted
        ?? input.historical.observations.length,
      includedAcceptedHistoricalObservations: historical.filter(point => Date.parse(point.timestamp) >= earliestRequiredMs).length,
      sourceFinalizedSwapHourObservations: input.current.metadata.finalized_observation_count
        ?? input.current.observations.filter(observation => observation.finalized === true).length,
      includedFinalizedSwapHourObservations: current.length,
      exactPoolStatePoints: 2,
      normalizedDailyPointCount: points.length,
      normalizedObservedDayCount: points.filter(point => point.observed).length,
      normalizedCarriedForwardDayCount: points.filter(point => point.carriedForward).length,
      sourceObservationCount: normalized.sourceObservationCount,
      includedSourceObservationCount: points.reduce((count, point) =>
        count + (point.normalization?.observationCount || 0), 0),
      duplicateSourceObservationCount: normalized.duplicateObservationCount,
      estimatedPointCount: estimated.length,
      estimatedMissingDailyPointCount: estimated.length,
      estimatedBoundaryPointCount: 0,
      estimatedTimestamps: estimated.map(point => point.timestamp),
      unresolvedHistoricalDates: [...new Set(unresolvedHistoricalDates)].sort()
    },
    periods,
    points
  };
}
