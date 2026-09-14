import {
  comparePeriod,
  evaluateSegmentMultiplier,
  selectPeriodPath
} from "./hold-vs-rebalanced-lp.mjs";

const YEAR_SECONDS = 31_536_000n;
const DAY_SECONDS = 86_400n;
const LP_SCALE = 10n ** 72n;
const OUTPUT_DECIMALS = 36;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/;
const POOL = "0x962265593a7f6f5f0804b6a3ed203aa5d2e0d1e9";
const INITIALIZATION = "2026-09-06T05:36:17.000Z";

export const REFERENCE_FEE_SCHEMA_VERSION = 1;
export const FEE_TIER_FRACTION = Object.freeze({ numerator: 1n, denominator: 100n });

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function rational(numerator, denominator = 1n) {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint" || denominator === 0n) throw new Error("invalid rational value");
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor * sign, denominator: denominator / divisor * sign };
}

function add(left, right) {
  return rational(left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function subtract(left, right) {
  return rational(left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function multiply(left, right) {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divide(left, right) {
  if (right.numerator === 0n) throw new Error("division by zero");
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function compare(left, right) {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

function parseRational(input, label, allowZero = false) {
  const numerator = input?.numerator;
  const denominator = input?.denominator;
  const pattern = allowZero ? NON_NEGATIVE_INTEGER : POSITIVE_INTEGER;
  if (!pattern.test(numerator) || !POSITIVE_INTEGER.test(denominator)) throw new Error(label + " must be a valid rational");
  const result = rational(BigInt(numerator), BigInt(denominator));
  if (!allowZero && result.numerator <= 0n) throw new Error(label + " must be positive");
  return result;
}

function format(input, decimalPlaces = OUTPUT_DECIMALS) {
  const negative = input.numerator < 0n;
  const numerator = negative ? -input.numerator : input.numerator;
  const integer = numerator / input.denominator;
  const fraction = decimalPlaces === 0 ? "" : ((numerator % input.denominator) * 10n ** BigInt(decimalPlaces) / input.denominator)
    .toString().padStart(decimalPlaces, "0").replace(/0+$/, "");
  const rendered = fraction ? integer + "." + fraction : integer.toString();
  return negative && numerator !== 0n ? "-" + rendered : rendered;
}

function output(input, decimalPlaces = OUTPUT_DECIMALS) {
  return {
    numerator: input.numerator.toString(), denominator: input.denominator.toString(),
    decimal: format(input, decimalPlaces), decimalPlaces, rounding: "toward-zero"
  };
}

function timestamp(value, label) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(label + " must be a canonical UTC timestamp");
  }
  return milliseconds;
}

function unavailable(reasons, details = {}) {
  return {
    schemaVersion: REFERENCE_FEE_SCHEMA_VERSION,
    kind: "cypress-reference-fee-apr",
    status: "unavailable",
    available: false,
    reasons: [...new Set(reasons)],
    ...details
  };
}

function validateWindow(cache) {
  if (!cache || cache.schemaVersion !== REFERENCE_FEE_SCHEMA_VERSION || cache.kind !== "cypress-reference-fee-window"
      || cache.identity?.chainId !== 8453 || cache.identity?.pool?.toLowerCase() !== POOL
      || cache.identity?.feeTier !== "10000") throw new Error("reference-fee cache identity mismatch");
  const startMs = timestamp(cache.window?.startTimestamp, "window start");
  const endMs = timestamp(cache.window?.endTimestamp, "window end");
  if (startMs < Date.parse(INITIALIZATION) || endMs <= startMs) throw new Error("reference-fee window boundaries are invalid");
  if (endMs - startMs > Number(7n * DAY_SECONDS * 1000n)) throw new Error("reference-fee window exceeds seven days");
  if (cache.window.initializationTimestamp !== INITIALIZATION || cache.window.requestedDays !== 7) {
    throw new Error("reference-fee window policy mismatch");
  }
  return { startMs, endMs, durationSeconds: BigInt(endMs - startMs) / 1000n };
}

function calculateAverageTvl(cache, window) {
  const snapshots = cache.tvl?.snapshots;
  if (cache.tvl?.method !== "hourly_block_pinned_balances_trapezoidal" || !Array.isArray(snapshots) || snapshots.length < 2) {
    throw new Error("missing hourly TVL snapshots");
  }
  let weighted = rational(0n);
  let priorMs = null;
  for (const [index, snapshot] of snapshots.entries()) {
    const currentMs = timestamp(snapshot.timestamp, "TVL snapshot timestamp");
    if (index === 0 && currentMs !== window.startMs) throw new Error("TVL snapshots do not start at the window boundary");
    if (priorMs !== null && (currentMs <= priorMs || currentMs - priorMs > 3_600_000)) {
      throw new Error("TVL snapshot coverage is unordered or has an interval over one hour");
    }
    if (!POSITIVE_INTEGER.test(snapshot.blockNumber) || !/^0x[0-9a-f]{64}$/.test(snapshot.blockHash)
        || !NON_NEGATIVE_INTEGER.test(snapshot.token0BalanceRaw) || !NON_NEGATIVE_INTEGER.test(snapshot.token1BalanceRaw)
        || !POSITIVE_INTEGER.test(snapshot.sqrtPriceX96)) throw new Error("TVL snapshot block-pinned fields are invalid");
    const tvl = parseRational(snapshot.tvlUsd, "TVL", false);
    if (index > 0) {
      const prior = parseRational(snapshots[index - 1].tvlUsd, "prior TVL", false);
      const seconds = BigInt(currentMs - priorMs) / 1000n;
      weighted = add(weighted, multiply(divide(add(prior, tvl), rational(2n)), rational(seconds)));
    }
    priorMs = currentMs;
  }
  if (priorMs !== window.endMs) throw new Error("TVL snapshots do not end at the window boundary");
  return divide(weighted, rational(window.durationSeconds));
}

function validateVolume(cache, window) {
  if (cache.volume?.source !== "geckoterminal" || cache.volume?.sparseIntervalsMeanZeroVolume !== true
      || timestamp(cache.volume.coverageStart, "volume coverage start") > window.startMs
      || timestamp(cache.volume.coverageEnd, "volume coverage end") < window.endMs
      || !Array.isArray(cache.volume.intervals)) throw new Error("volume coverage is incomplete");
  const intervals = [];
  let priorEnd = window.startMs;
  for (const interval of cache.volume.intervals) {
    const startMs = timestamp(interval.startTimestamp, "volume interval start");
    const endMs = timestamp(interval.endTimestamp, "volume interval end");
    if (startMs < window.startMs || endMs > window.endMs || endMs <= startMs || startMs < priorEnd
        || interval.finalized !== true) throw new Error("volume intervals are invalid or overlapping");
    intervals.push({ ...interval, startMs, endMs, volume: parseRational(interval.volumeUsd, "volume", true) });
    priorEnd = endMs;
  }
  return intervals;
}

function protocolShare(denominator, label) {
  if (!Number.isInteger(denominator) || (denominator !== 0 && (denominator < 4 || denominator > 10))) {
    throw new Error(label + " is outside Uniswap V3 bounds");
  }
  return denominator === 0 ? rational(0n) : rational(1n, BigInt(denominator));
}

function validateProtocolSegments(cache, window) {
  if (cache.protocolFee?.eventTopic !== "0x973d8d92bb299f4af6ce49b52a8adb85ae46b9f214c4c4fc06ac77401237b133"
      || cache.protocolFee?.historyVerified !== true || !Array.isArray(cache.protocolFee.segments)
      || cache.protocolFee.segments.length === 0) throw new Error("protocol-fee history is unavailable");
  let cursor = window.startMs;
  return cache.protocolFee.segments.map(segment => {
    const startMs = timestamp(segment.startTimestamp, "protocol segment start");
    const endMs = timestamp(segment.endTimestamp, "protocol segment end");
    if (startMs !== cursor || endMs <= startMs || endMs > window.endMs) throw new Error("protocol-fee segments do not continuously cover the window");
    cursor = endMs;
    const token0 = protocolShare(segment.token0Denominator, "token0 protocol fee");
    const token1 = protocolShare(segment.token1Denominator, "token1 protocol fee");
    if (compare(token0, token1) !== 0) throw new Error("directional protocol fees cannot be applied to aggregate volume");
    return { ...segment, startMs, endMs, share: token0 };
  }).map((segment, index, segments) => {
    if (index === segments.length - 1 && segment.endMs !== window.endMs) throw new Error("protocol-fee history does not reach the window end");
    return segment;
  });
}

function retentionForVolume(interval, segments) {
  const overlaps = segments.filter(segment => segment.startMs < interval.endMs && segment.endMs > interval.startMs);
  if (overlaps.length === 0) throw new Error("protocol-fee history does not cover a volume interval");
  const first = overlaps[0].share;
  if (overlaps.some(segment => compare(segment.share, first) !== 0)) {
    throw new Error("protocol fee changes within an aggregated volume interval");
  }
  return subtract(rational(1n), first);
}

export function calculateReferenceApr(cache) {
  try {
    const window = validateWindow(cache);
    const averageTvl = calculateAverageTvl(cache, window);
    if (averageTvl.numerator <= 0n) return unavailable(["average_tvl_not_positive"]);
    const volumes = validateVolume(cache, window);
    const protocolSegments = validateProtocolSegments(cache, window);
    let totalVolume = rational(0n);
    let lpNetVolume = rational(0n);
    for (const interval of volumes) {
      totalVolume = add(totalVolume, interval.volume);
      lpNetVolume = add(lpNetVolume, multiply(interval.volume, retentionForVolume(interval, protocolSegments)));
    }
    const annualization = divide(rational(YEAR_SECONDS), rational(window.durationSeconds));
    const grossAprFraction = multiply(divide(multiply(totalVolume, FEE_TIER_FRACTION), averageTvl), annualization);
    const lpNetAprFraction = multiply(divide(multiply(lpNetVolume, FEE_TIER_FRACTION), averageTvl), annualization);
    const weightedProtocolShare = totalVolume.numerator === 0n ? rational(0n)
      : subtract(rational(1n), divide(lpNetVolume, totalVolume));
    return {
      schemaVersion: REFERENCE_FEE_SCHEMA_VERSION,
      kind: "cypress-reference-fee-apr",
      status: "available",
      available: true,
      cacheGeneratedAt: cache.generatedAt,
      cacheVersion: cache.cacheVersion,
      window: {
        startTimestamp: cache.window.startTimestamp,
        endTimestamp: cache.window.endTimestamp,
        durationSeconds: window.durationSeconds.toString(),
        durationDays: output(divide(rational(window.durationSeconds), rational(DAY_SECONDS))),
        requestedDays: 7,
        partial: window.durationSeconds < 7n * DAY_SECONDS
      },
      totalVolumeUsd: output(totalVolume),
      timeWeightedAverageTvlUsd: output(averageTvl),
      feeTierFraction: output(FEE_TIER_FRACTION),
      volumeWeightedProtocolFeeShare: output(weightedProtocolShare),
      grossAprFraction: output(grossAprFraction),
      grossAprPercent: output(multiply(grossAprFraction, rational(100n))),
      lpNetAprFraction: output(lpNetAprFraction),
      lpNetAprPercent: output(multiply(lpNetAprFraction, rational(100n))),
      sourceCoverage: {
        volumeIntervals: volumes.length,
        tvlSnapshots: cache.tvl.snapshots.length,
        protocolFeeSegments: protocolSegments.length,
        volumeGenerationId: cache.volume.generationId,
        latestFinalizedBlock: cache.window.latestFinalizedBlock
      },
      limitations: [
        "pool_level_volume_over_time_weighted_tvl_proxy",
        "not_position_specific_fee_apr",
        "hourly_tvl_sampling",
        "sparse_geckoterminal_intervals_treated_as_zero_volume"
      ]
    };
  } catch (error) {
    return unavailable(["invalid_or_incomplete_reference_data"], { detail: error.message });
  }
}

function principalSeries(points) {
  let raw = 1000n * LP_SCALE;
  const series = [{ timestamp: points[0].timestamp, principal: rational(raw, LP_SCALE) }];
  for (let index = 1; index < points.length; index += 1) {
    const multiplier = evaluateSegmentMultiplier(points[index - 1].priceUsd, points[index].priceUsd).multiplier;
    const multiplierValue = parseRational(multiplier, "segment multiplier", false);
    raw = raw * multiplierValue.numerator / multiplierValue.denominator;
    series.push({ timestamp: points[index].timestamp, principal: rational(raw, LP_SCALE) });
  }
  return series;
}

export function projectFeesOnPrincipalPath(points, annualAprFraction) {
  if (!Array.isArray(points) || points.length < 2) throw new Error("principal path must contain at least two points");
  const apr = parseRational(annualAprFraction, "annual APR", true);
  const series = principalSeries(points);
  let fees = rational(0n);
  for (let index = 1; index < series.length; index += 1) {
    const startMs = timestamp(series[index - 1].timestamp, "principal interval start");
    const endMs = timestamp(series[index].timestamp, "principal interval end");
    if (endMs <= startMs) throw new Error("principal interval timestamps must increase");
    const averagePrincipal = divide(add(series[index - 1].principal, series[index].principal), rational(2n));
    const elapsed = rational(BigInt(endMs - startMs) / 1000n, YEAR_SECONDS);
    fees = add(fees, multiply(multiply(averagePrincipal, apr), elapsed));
  }
  return {
    estimatedFeesUsdc: output(fees),
    endingPrincipalValueUsdc: output(series.at(-1).principal),
    endingValueIncludingEstimatedFeesUsdc: output(add(series.at(-1).principal, fees)),
    intervalCount: series.length - 1,
    reinvested: false,
    principalSeries: series.map(item => ({ timestamp: item.timestamp, principalValueUsdc: output(item.principal) }))
  };
}

export function projectPeriodFees(dataset, period, referenceApr) {
  const principal = comparePeriod(dataset, period);
  if (!referenceApr?.available || referenceApr.status !== "available") {
    return {
      schemaVersion: REFERENCE_FEE_SCHEMA_VERSION,
      kind: "cypress-hold-vs-rebalanced-lp-with-reference-fees",
      period,
      holdCp: principal.holdCp,
      principalComparison: principal,
      referenceFee: referenceApr || unavailable(["reference_apr_missing"]),
      rebalancedLp: {
        principalEndingValueUsdc: principal.rebalancedLpPrincipal.endingValueUsdc,
        estimatedFeesUsdc: null,
        endingValueIncludingEstimatedFeesUsdc: principal.rebalancedLpPrincipal.endingValueUsdc,
        feeProjectionIncluded: false
      }
    };
  }
  const selected = selectPeriodPath(dataset, period);
  const projection = projectFeesOnPrincipalPath(selected.points, referenceApr.lpNetAprFraction);
  const totalEnding = parseRational(projection.endingValueIncludingEstimatedFeesUsdc, "total LP ending value", false);
  const totalProfitLoss = subtract(totalEnding, rational(1000n));
  const holdEnding = parseRational(principal.holdCp.endingValueUsdc, "Hold ending value", false);
  const difference = subtract(holdEnding, totalEnding);
  return {
    schemaVersion: REFERENCE_FEE_SCHEMA_VERSION,
    kind: "cypress-hold-vs-rebalanced-lp-with-reference-fees",
    period,
    boundaries: principal.boundaries,
    holdCp: principal.holdCp,
    principalComparison: principal,
    referenceFee: referenceApr,
    rebalancedLp: {
      principalEndingValueUsdc: principal.rebalancedLpPrincipal.endingValueUsdc,
      estimatedFeesUsdc: projection.estimatedFeesUsdc,
      endingValueIncludingEstimatedFeesUsdc: projection.endingValueIncludingEstimatedFeesUsdc,
      profitLossIncludingEstimatedFeesUsdc: output(totalProfitLoss),
      returnIncludingEstimatedFeesPercent: output(divide(totalProfitLoss, rational(10n))),
      feeProjectionIncluded: true,
      feesReinvested: false,
      intervalCount: projection.intervalCount
    },
    differenceIncludingEstimatedFees: {
      holdMinusLpUsdc: output(difference),
      leader: compare(difference, rational(0n)) > 0 ? "hold_cp" : compare(difference, rational(0n)) < 0 ? "rebalanced_lp" : "tie"
    }
  };
}

export function projectAllPeriodFees(dataset, referenceApr) {
  return Object.fromEntries(["7D", "30D", "6M", "1Y"].map(period => [period, projectPeriodFees(dataset, period, referenceApr)]));
}
