const INTERNAL_DECIMALS = 72;
const INTERNAL_SCALE = 10n ** BigInt(INTERNAL_DECIMALS);
const OUTPUT_DECIMALS = 36;
const INITIAL_CAPITAL = Object.freeze({ numerator: 1000n, denominator: 1n });
const POSITIVE_INTEGER = /^[1-9]\d*$/;

export const STRATEGY_ENGINE_SCHEMA_VERSION = 2;
export const INITIAL_CAPITAL_USDC = "1000";

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function value(numerator, denominator = 1n) {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint" || denominator === 0n) {
    throw new Error("invalid rational value");
  }
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor * sign, denominator: denominator / divisor * sign };
}

function add(left, right) {
  return value(left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function subtract(left, right) {
  return value(left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function multiply(left, right) {
  return value(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divide(left, right) {
  if (right.numerator === 0n) throw new Error("division by zero");
  return value(left.numerator * right.denominator, left.denominator * right.numerator);
}

function compare(left, right) {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
}

function absolute(input) {
  return input.numerator < 0n ? value(-input.numerator, input.denominator) : input;
}

function maximum(left, right) {
  return compare(left, right) >= 0 ? left : right;
}

function floorPositive(input) {
  if (input.numerator < 0n) throw new Error("floorPositive requires a non-negative value");
  return input.numerator / input.denominator;
}

function ceilPositive(input) {
  if (input.numerator < 0n) throw new Error("ceilPositive requires a non-negative value");
  return (input.numerator + input.denominator - 1n) / input.denominator;
}

function format(input, decimalPlaces = OUTPUT_DECIMALS) {
  const negative = input.numerator < 0n;
  const numerator = negative ? -input.numerator : input.numerator;
  const integer = numerator / input.denominator;
  if (decimalPlaces === 0) return (negative && numerator !== 0n ? "-" : "") + integer;
  const fraction = ((numerator % input.denominator) * 10n ** BigInt(decimalPlaces) / input.denominator)
    .toString().padStart(decimalPlaces, "0").replace(/0+$/, "");
  const rendered = fraction ? integer + "." + fraction : integer.toString();
  return negative && numerator !== 0n ? "-" + rendered : rendered;
}

function output(input, decimalPlaces = OUTPUT_DECIMALS) {
  return {
    numerator: input.numerator.toString(),
    denominator: input.denominator.toString(),
    decimal: format(input, decimalPlaces),
    decimalPlaces,
    rounding: "toward-zero"
  };
}

function pointPrice(point, label = "price point") {
  const numerator = point?.priceUsd?.numerator;
  const denominator = point?.priceUsd?.denominator;
  if (!POSITIVE_INTEGER.test(numerator) || !POSITIVE_INTEGER.test(denominator)) {
    throw new Error(label + " must contain a positive rational price");
  }
  return value(BigInt(numerator), BigInt(denominator));
}

export function integerSquareRoot(input) {
  if (typeof input !== "bigint" || input < 0n) throw new Error("integer square root input must be a non-negative bigint");
  if (input < 2n) return input;
  let estimate = 1n << BigInt((input.toString(2).length + 1) >> 1);
  while (true) {
    const next = (estimate + input / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

function squareRootBounds(input) {
  if (input.numerator <= 0n) throw new Error("square root value must be positive");
  const scaledNumerator = input.numerator * INTERNAL_SCALE * INTERNAL_SCALE;
  const radicand = scaledNumerator / input.denominator;
  const root = integerSquareRoot(radicand);
  const exact = root * root * input.denominator === scaledNumerator;
  return {
    lower: value(root, INTERNAL_SCALE),
    upper: value(exact ? root : root + 1n, INTERNAL_SCALE)
  };
}

const ONE = Object.freeze(value(1n));
const TWO = Object.freeze(value(2n));
const HALF = Object.freeze(value(1n, 2n));
const SQRT_TWO = Object.freeze(squareRootBounds(TWO));

function coefficient(sqrtTwo) {
  return divide(add(ONE, sqrtTwo), TWO);
}

function insideRangeMultiplier(ratio, sqrtRatio, sqrtTwo) {
  // Algebraically equivalent to the audited formula after multiplying its
  // numerator and denominator by sqrt(2):
  // [2 sqrt(2) sqrt(r) - (r + 1)] / [2(sqrt(2) - 1)].
  return divide(
    subtract(multiply(TWO, multiply(sqrtTwo, sqrtRatio)), add(ratio, ONE)),
    multiply(TWO, subtract(sqrtTwo, ONE))
  );
}

function fixedFloor(input) {
  return floorPositive(multiply(input, value(INTERNAL_SCALE)));
}

function fixedCeil(input) {
  return ceilPositive(multiply(input, value(INTERNAL_SCALE)));
}

function fixedValue(raw) {
  return value(raw, INTERNAL_SCALE);
}

function calculateSegmentMultiplier(currentPrice, nextPrice) {
  const current = currentPrice?.numerator !== undefined ? value(BigInt(currentPrice.numerator), BigInt(currentPrice.denominator)) : null;
  const next = nextPrice?.numerator !== undefined ? value(BigInt(nextPrice.numerator), BigInt(nextPrice.denominator)) : null;
  if (!current || !next || current.numerator <= 0n || next.numerator <= 0n) throw new Error("segment prices must be positive rationals");
  const ratio = divide(next, current);
  let lower, upper, branch;
  if (compare(ratio, HALF) <= 0) {
    lower = multiply(multiply(coefficient(SQRT_TWO.lower), ratio), ONE);
    upper = multiply(multiply(coefficient(SQRT_TWO.upper), ratio), ONE);
    branch = "at_or_below_lower_bound";
  } else if (compare(ratio, TWO) >= 0) {
    lower = coefficient(SQRT_TWO.lower);
    upper = coefficient(SQRT_TWO.upper);
    branch = "at_or_above_upper_bound";
  } else {
    const sqrtRatio = squareRootBounds(ratio);
    lower = insideRangeMultiplier(ratio, sqrtRatio.lower, SQRT_TWO.lower);
    upper = insideRangeMultiplier(ratio, sqrtRatio.upper, SQRT_TWO.upper);
    branch = "inside_range";
  }
  if (lower.numerator <= 0n || compare(upper, lower) < 0) throw new Error("invalid V3 segment multiplier envelope");
  const lowerFixed = fixedFloor(lower);
  const upperFixed = fixedCeil(upper);
  const nominalFixed = (lowerFixed + upperFixed) / 2n;
  return {
    priceRatio: output(ratio),
    branch,
    multiplier: output(fixedValue(nominalFixed)),
    lowerBound: output(fixedValue(lowerFixed)),
    upperBound: output(fixedValue(upperFixed)),
    _fixed: { nominal: nominalFixed, lower: lowerFixed, upper: upperFixed }
  };
}

export function evaluateSegmentMultiplier(currentPrice, nextPrice) {
  const { _fixed, ...result } = calculateSegmentMultiplier(currentPrice, nextPrice);
  return result;
}

function validatePath(points) {
  if (!Array.isArray(points) || points.length < 2) throw new Error("price path must contain at least two points");
  const ids = new Set();
  let priorTimestamp = -Infinity;
  for (const [index, point] of points.entries()) {
    if (!point || typeof point.id !== "string" || !point.id) throw new Error("price point id is required");
    if (ids.has(point.id)) throw new Error("duplicate price point id: " + point.id);
    ids.add(point.id);
    const timestamp = Date.parse(point.timestamp);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== point.timestamp) {
      throw new Error("price point timestamp must be canonical UTC");
    }
    if (timestamp <= priorTimestamp) throw new Error("price point timestamps must be strictly increasing");
    priorTimestamp = timestamp;
    pointPrice(point, "price point " + index);
    if (point.estimated === true && (point.observed !== false
        || point.provenance?.method !== "linear_interpolation_elapsed_time")) {
      throw new Error("estimated price point provenance is invalid");
    }
  }
}

function multiplyFixedFloor(left, right) {
  return left * right / INTERNAL_SCALE;
}

function multiplyFixedCeil(left, right) {
  return (left * right + INTERNAL_SCALE - 1n) / INTERNAL_SCALE;
}

export function evaluateRebalancedPath(points) {
  validatePath(points);
  let nominal = 1000n * INTERNAL_SCALE;
  let lower = nominal;
  let upper = nominal;
  const branches = { inside_range: 0, at_or_below_lower_bound: 0, at_or_above_upper_bound: 0 };
  for (let index = 1; index < points.length; index += 1) {
    const segment = calculateSegmentMultiplier(pointPrice(points[index - 1]), pointPrice(points[index]));
    nominal = multiplyFixedFloor(nominal, segment._fixed.nominal);
    lower = multiplyFixedFloor(lower, segment._fixed.lower);
    upper = multiplyFixedCeil(upper, segment._fixed.upper);
    branches[segment.branch] += 1;
  }
  const nominalValue = fixedValue(nominal);
  const lowerValue = fixedValue(lower);
  const upperValue = fixedValue(upper);
  const errorBound = maximum(absolute(subtract(nominalValue, lowerValue)), absolute(subtract(upperValue, nominalValue)));
  return {
    endingPrincipalValueUsdc: output(nominalValue),
    lowerBoundUsdc: output(lowerValue),
    upperBoundUsdc: output(upperValue),
    numericalErrorBoundUsdc: output(errorBound, INTERNAL_DECIMALS),
    segmentCount: points.length - 1,
    branchCounts: branches,
    feesIncluded: false
  };
}

export function selectPeriodPath(dataset, period) {
  if (!dataset || dataset.schemaVersion !== 2 || dataset.kind !== "cypress-hold-vs-rebalanced-lp-price-path"
      || !Array.isArray(dataset.points)) throw new Error("Comparison Step 1 dataset contract mismatch");
  validatePath(dataset.points);
  for (const point of dataset.points) {
    if (!point.timestamp.endsWith("T00:00:00.000Z") || point.normalization?.utcDate !== point.timestamp.slice(0, 10)) {
      throw new Error("comparison price path must be normalized to one UTC-daily point");
    }
  }
  const selected = dataset.periods?.[period];
  if (!selected) throw new Error("unsupported or missing period: " + period);
  const hold = selected.strategyBoundaries?.holdCp;
  const lp = selected.strategyBoundaries?.rebalancedLp;
  if (!hold || !lp || hold.startPointId !== lp.startPointId || hold.endPointId !== lp.endPointId) {
    throw new Error("Hold and LP boundaries must be identical");
  }
  const byId = new Map(dataset.points.map((point, index) => [point.id, index]));
  const startIndex = byId.get(hold.startPointId);
  const endIndex = byId.get(hold.endPointId);
  if (startIndex === undefined || endIndex === undefined || startIndex >= endIndex) throw new Error("period boundary point references are invalid");
  if (selected.pointRange?.fromInclusive !== startIndex || selected.pointRange?.throughInclusive !== endIndex) {
    throw new Error("period point range does not match its boundaries");
  }
  const points = dataset.points.slice(startIndex, endIndex + 1);
  validatePath(points);
  return { selected, points, start: points[0], end: points.at(-1) };
}

function sourceCoverage(points) {
  const sources = {};
  for (const point of points) {
    if (point.normalization?.observations?.length) {
      for (const observation of point.normalization.observations) {
        const source = observation.source?.provider || "unknown";
        sources[source] = (sources[source] || 0) + 1;
      }
    } else {
      const source = point.carriedForward ? "carried_forward" : "estimated_interpolation";
      sources[source] = (sources[source] || 0) + 1;
    }
  }
  return sources;
}

export function comparePeriod(dataset, period) {
  const path = selectPeriodPath(dataset, period);
  const startPrice = pointPrice(path.start, "start price");
  const endPrice = pointPrice(path.end, "end price");
  const initialCp = divide(INITIAL_CAPITAL, startPrice);
  const holdEnding = multiply(initialCp, endPrice);
  const holdProfitLoss = subtract(holdEnding, INITIAL_CAPITAL);
  const holdReturn = multiply(divide(holdProfitLoss, INITIAL_CAPITAL), value(100n));
  const lpPath = evaluateRebalancedPath(path.points);
  const lpEnding = value(BigInt(lpPath.endingPrincipalValueUsdc.numerator), BigInt(lpPath.endingPrincipalValueUsdc.denominator));
  const lpProfitLoss = subtract(lpEnding, INITIAL_CAPITAL);
  const lpReturn = multiply(divide(lpProfitLoss, INITIAL_CAPITAL), value(100n));
  const difference = subtract(holdEnding, lpEnding);
  const estimatedPoints = path.points.filter(point => point.estimated === true);

  return {
    schemaVersion: STRATEGY_ENGINE_SCHEMA_VERSION,
    kind: "cypress-hold-vs-rebalanced-lp-comparison",
    period,
    strategyAssumptions: {
      lowerPriceMultiple: "0.5",
      upperPriceMultiple: "2",
      initialValueAllocation: { cpPercent: "50", usdcPercent: "50" },
      recentering: "once_per_normalized_utc_daily_price",
      rebalancingCosts: "excluded",
      fees: "excluded"
    },
    boundaries: {
      startPointId: path.start.id,
      endPointId: path.end.id,
      startTimestamp: path.start.timestamp,
      endTimestamp: path.end.timestamp,
      startPriceUsd: output(startPrice),
      endPriceUsd: output(endPrice)
    },
    initialCapitalUsdc: output(INITIAL_CAPITAL),
    holdCp: {
      initialCpQuantity: output(initialCp),
      endingValueUsdc: output(holdEnding),
      profitLossUsdc: output(holdProfitLoss),
      returnPercent: output(holdReturn)
    },
    rebalancedLpPrincipal: {
      endingValueUsdc: lpPath.endingPrincipalValueUsdc,
      profitLossUsdc: output(lpProfitLoss),
      returnPercent: output(lpReturn),
      numericalLowerBoundUsdc: lpPath.lowerBoundUsdc,
      numericalUpperBoundUsdc: lpPath.upperBoundUsdc,
      numericalErrorBoundUsdc: lpPath.numericalErrorBoundUsdc,
      feesIncluded: false
    },
    difference: {
      holdMinusLpUsdc: output(difference),
      leader: compare(difference, value(0n)) > 0 ? "hold_cp" : compare(difference, value(0n)) < 0 ? "rebalanced_lp" : "tie"
    },
    dataQuality: {
      includesEstimatedPrices: estimatedPoints.length > 0,
      estimatedPointCount: estimatedPoints.length,
      estimatedPointIds: estimatedPoints.map(point => point.id),
      disclosure: estimatedPoints.length > 0 ? dataset.disclosure : null,
      observationCount: path.points.length,
      segmentCount: lpPath.segmentCount,
      sourcePointCounts: sourceCoverage(path.points),
      sourceVersions: dataset.sourceVersions,
      datasetCoverage: dataset.coverage
    },
    numericalPolicy: {
      arithmetic: "BigInt rational accounting with directed fixed-point LP bounds",
      internalDecimalPlaces: INTERNAL_DECIMALS,
      outputDecimalPlaces: OUTPUT_DECIMALS,
      squareRoot: "integer square root with adjacent rational lower/upper bounds",
      intermediateRounding: "nominal toward-zero; bounds directed outward",
      outputRounding: "toward-zero",
      errorBound: "reported per result as the maximum distance from nominal to the directed bounds"
    }
  };
}

export function compareAllPeriods(dataset) {
  return Object.fromEntries(["7D", "30D", "6M", "1Y"].map(period => [period, comparePeriod(dataset, period)]));
}
