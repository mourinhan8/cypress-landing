const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const UINT160_MAX = (1n << 160n) - 1n;

export const POOL = Object.freeze({
  chainId: 8453,
  address: "0x962265593a7f6f5f0804b6a3ed203aa5d2e0d1e9",
  token0: Object.freeze({ address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 }),
  token1: Object.freeze({ address: "0x934ef4bfffdce191ac4bcc351b2fe7892865b440", symbol: "CP", decimals: 18 }),
  fee: 10_000,
  tickSpacing: 200,
  tickLower: -887_200,
  tickUpper: 887_200,
  initializationBlock: 50_941_815n,
  initializationTime: "2026-09-06T05:36:17.000Z"
});

export const INITIAL_CAPITAL_USDC_RAW = 1_000_000_000n;
export const INITIAL_USDC_BUDGET_RAW = 500_000_000n;
export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;
export const MIN_SQRT_RATIO = 4_295_128_739n;
export const MAX_SQRT_RATIO = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n;

function requireUnsigned(value, label) {
  if (typeof value !== "bigint" || value < 0n) throw new Error(label + " must be a non-negative bigint");
  return value;
}

function requirePositive(value, label) {
  requireUnsigned(value, label);
  if (value === 0n) throw new Error(label + " must be positive");
  return value;
}

function orderedRatios(a, b) {
  requirePositive(a, "sqrtRatioAX96");
  requirePositive(b, "sqrtRatioBX96");
  const lower = a < b ? a : b;
  const upper = a < b ? b : a;
  if (lower === upper) throw new Error("sqrt ratio bounds must differ");
  return [lower, upper];
}

export function mulDiv(a, b, denominator) {
  requireUnsigned(a, "mulDiv a");
  requireUnsigned(b, "mulDiv b");
  requirePositive(denominator, "mulDiv denominator");
  return (a * b) / denominator;
}

export function mulDivRoundingUp(a, b, denominator) {
  const result = mulDiv(a, b, denominator);
  return (a * b) % denominator === 0n ? result : result + 1n;
}

export function divRoundingUp(numerator, denominator) {
  requireUnsigned(numerator, "division numerator");
  requirePositive(denominator, "division denominator");
  const result = numerator / denominator;
  return numerator % denominator === 0n ? result : result + 1n;
}

// Canonical port of Uniswap V3 core TickMath.getSqrtRatioAtTick.
export function getSqrtRatioAtTick(tick) {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error("tick is outside the Uniswap V3 TickMath bounds");
  }
  const absTick = BigInt(tick < 0 ? -tick : tick);
  let ratio = absTick & 0x1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const factors = [
    [0x2n, 0xfff97272373d413259a46990580e213aen], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n]
  ];
  for (const [mask, factor] of factors) if (absTick & mask) ratio = (ratio * factor) >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

export const FULL_RANGE_SQRT_LOWER_X96 = getSqrtRatioAtTick(POOL.tickLower);
export const FULL_RANGE_SQRT_UPPER_X96 = getSqrtRatioAtTick(POOL.tickUpper);

export function getLiquidityForAmount0(a, b, amount0) {
  const [lower, upper] = orderedRatios(a, b);
  requireUnsigned(amount0, "amount0");
  return mulDiv(amount0, mulDiv(lower, upper, Q96), upper - lower);
}

export function getLiquidityForAmount1(a, b, amount1) {
  const [lower, upper] = orderedRatios(a, b);
  requireUnsigned(amount1, "amount1");
  return mulDiv(amount1, Q96, upper - lower);
}

export function getLiquidityForAmounts(current, a, b, amount0, amount1) {
  requirePositive(current, "sqrtRatioX96");
  requireUnsigned(amount0, "amount0");
  requireUnsigned(amount1, "amount1");
  const [lower, upper] = orderedRatios(a, b);
  if (current <= lower) return getLiquidityForAmount0(lower, upper, amount0);
  if (current < upper) {
    const liquidity0 = getLiquidityForAmount0(current, upper, amount0);
    const liquidity1 = getLiquidityForAmount1(lower, current, amount1);
    return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  }
  return getLiquidityForAmount1(lower, upper, amount1);
}

export function getAmount0Delta(a, b, liquidity, roundUp = false) {
  const [lower, upper] = orderedRatios(a, b);
  requireUnsigned(liquidity, "liquidity");
  const numerator1 = liquidity << 96n;
  if (roundUp) return divRoundingUp(mulDivRoundingUp(numerator1, upper - lower, upper), lower);
  return mulDiv(numerator1, upper - lower, upper) / lower;
}

export function getAmount1Delta(a, b, liquidity, roundUp = false) {
  const [lower, upper] = orderedRatios(a, b);
  requireUnsigned(liquidity, "liquidity");
  return roundUp ? mulDivRoundingUp(liquidity, upper - lower, Q96) : mulDiv(liquidity, upper - lower, Q96);
}

export function getAmountsForLiquidity(current, a, b, liquidity, roundUp = false) {
  requirePositive(current, "sqrtRatioX96");
  requireUnsigned(liquidity, "liquidity");
  const [lower, upper] = orderedRatios(a, b);
  if (current <= lower) return { amount0: getAmount0Delta(lower, upper, liquidity, roundUp), amount1: 0n };
  if (current < upper) return {
    amount0: getAmount0Delta(current, upper, liquidity, roundUp),
    amount1: getAmount1Delta(lower, current, liquidity, roundUp)
  };
  return { amount0: 0n, amount1: getAmount1Delta(lower, upper, liquidity, roundUp) };
}

export function formatUnits(raw, decimals) {
  requireUnsigned(raw, "raw token amount");
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error("token decimals must be a non-negative integer");
  if (decimals === 0) return raw.toString();
  const scale = 10n ** BigInt(decimals);
  const integer = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? integer + "." + fraction : integer.toString();
}

export function formatFraction(numerator, denominator, decimalPlaces = 36) {
  if (typeof numerator !== "bigint") throw new Error("fraction numerator must be a bigint");
  requirePositive(denominator, "fraction denominator");
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 100) throw new Error("fraction decimal places are invalid");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const integer = absolute / denominator;
  if (decimalPlaces === 0) return (negative && absolute !== 0n ? "-" : "") + integer;
  const fraction = mulDiv(absolute % denominator, 10n ** BigInt(decimalPlaces), denominator)
    .toString().padStart(decimalPlaces, "0").replace(/0+$/, "");
  const value = fraction ? integer + "." + fraction : integer.toString();
  return negative && absolute !== 0n ? "-" + value : value;
}

function tokenAmount(raw, token) {
  return Object.freeze({ raw, rawString: raw.toString(), decimal: formatUnits(raw, token.decimals) });
}

function rationalAmount(numerator, denominator, decimalPlaces = 24) {
  return Object.freeze({
    numerator,
    denominator,
    numeratorString: numerator.toString(),
    denominatorString: denominator.toString(),
    decimal: formatFraction(numerator, denominator, decimalPlaces),
    decimalPlaces,
    rounding: "toward-zero"
  });
}

function canonicalAddress(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(label + " is invalid");
  return value.toLowerCase();
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new Error(label + " is invalid");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) throw new Error(label + " must be canonical UTC ISO");
  return timestamp;
}

export function validatePoolState(state, label = "pool state") {
  if (!state || typeof state !== "object") throw new Error(label + " is required");
  if (state.chainId !== POOL.chainId) throw new Error(label + " chain identity mismatch");
  if (canonicalAddress(state.pool, label + " pool") !== POOL.address) throw new Error(label + " pool identity mismatch");
  if (!state.token0 || canonicalAddress(state.token0.address, label + " token0") !== POOL.token0.address
      || state.token0.decimals !== POOL.token0.decimals) throw new Error(label + " token0 identity mismatch");
  if (!state.token1 || canonicalAddress(state.token1.address, label + " token1") !== POOL.token1.address
      || state.token1.decimals !== POOL.token1.decimals) throw new Error(label + " token1 identity mismatch");
  if (state.fee !== POOL.fee) throw new Error(label + " fee identity mismatch");
  if (state.tickSpacing !== POOL.tickSpacing) throw new Error(label + " tick spacing identity mismatch");
  if (typeof state.blockNumber !== "bigint" || state.blockNumber < POOL.initializationBlock) throw new Error(label + " predates pool initialization");
  const timestampMs = canonicalTimestamp(state.timestamp, label + " timestamp");
  if (timestampMs < Date.parse(POOL.initializationTime)) throw new Error(label + " predates pool initialization");
  if (typeof state.sqrtPriceX96 !== "bigint" || state.sqrtPriceX96 < MIN_SQRT_RATIO
      || state.sqrtPriceX96 >= MAX_SQRT_RATIO || state.sqrtPriceX96 > UINT160_MAX) {
    throw new Error(label + " sqrtPriceX96 is outside the initialized V3 range");
  }
  return Object.freeze({ ...state, timestampMs });
}

function poolStateOutput(state) {
  const numerator = Q192 * 10n ** BigInt(POOL.token1.decimals - POOL.token0.decimals);
  const denominator = state.sqrtPriceX96 * state.sqrtPriceX96;
  return Object.freeze({
    blockNumber: state.blockNumber,
    blockNumberString: state.blockNumber.toString(),
    timestamp: state.timestamp,
    sqrtPriceX96: state.sqrtPriceX96,
    sqrtPriceX96String: state.sqrtPriceX96.toString(),
    cpPriceUsdc: rationalAmount(numerator, denominator, 36)
  });
}

function valueInUsdc(usdcRaw, cpRaw, sqrtPriceX96) {
  const square = sqrtPriceX96 * sqrtPriceX96;
  return {
    rawUsdcNumerator: usdcRaw * square + cpRaw * Q192,
    humanDenominator: square * 10n ** BigInt(POOL.token0.decimals)
  };
}

export function simulateFullRange(input) {
  if (!input || typeof input !== "object") throw new Error("simulation input is required");
  const start = validatePoolState(input.start, "start state");
  const end = validatePoolState(input.end, "end state");
  if (end.blockNumber < start.blockNumber || end.timestampMs < start.timestampMs) throw new Error("end state must not precede start state");

  const startSquare = start.sqrtPriceX96 * start.sqrtPriceX96;
  const initialCpRaw = mulDiv(INITIAL_USDC_BUDGET_RAW, startSquare, Q192);
  const liquidity = getLiquidityForAmounts(
    start.sqrtPriceX96,
    FULL_RANGE_SQRT_LOWER_X96,
    FULL_RANGE_SQRT_UPPER_X96,
    INITIAL_USDC_BUDGET_RAW,
    initialCpRaw
  );
  if (liquidity === 0n) {
    throw new Error("the fixed initial budgets produce zero mintable liquidity at this start price");
  }
  const consumed = getAmountsForLiquidity(
    start.sqrtPriceX96,
    FULL_RANGE_SQRT_LOWER_X96,
    FULL_RANGE_SQRT_UPPER_X96,
    liquidity,
    true
  );
  if (consumed.amount0 > INITIAL_USDC_BUDGET_RAW || consumed.amount1 > initialCpRaw) {
    throw new Error("canonical mint rounding exceeds the initial budget");
  }
  const unused0 = INITIAL_USDC_BUDGET_RAW - consumed.amount0;
  const unused1 = initialCpRaw - consumed.amount1;
  const principal = getAmountsForLiquidity(
    end.sqrtPriceX96,
    FULL_RANGE_SQRT_LOWER_X96,
    FULL_RANGE_SQRT_UPPER_X96,
    liquidity,
    false
  );
  const total0 = principal.amount0 + unused0;
  const total1 = principal.amount1 + unused1;
  const assetValue = valueInUsdc(total0, total1, end.sqrtPriceX96);
  const endSquare = end.sqrtPriceX96 * end.sqrtPriceX96;
  const pnlNumerator = assetValue.rawUsdcNumerator - INITIAL_CAPITAL_USDC_RAW * endSquare;
  const hodlNumerator = INITIAL_USDC_BUDGET_RAW * endSquare + initialCpRaw * Q192;
  const lpVsHodlNumerator = assetValue.rawUsdcNumerator - hodlNumerator;
  const denominator = assetValue.humanDenominator;

  return Object.freeze({
    schemaVersion: 1,
    pool: POOL,
    range: Object.freeze({
      tickLower: POOL.tickLower,
      tickUpper: POOL.tickUpper,
      sqrtRatioLowerX96: FULL_RANGE_SQRT_LOWER_X96,
      sqrtRatioLowerX96String: FULL_RANGE_SQRT_LOWER_X96.toString(),
      sqrtRatioUpperX96: FULL_RANGE_SQRT_UPPER_X96,
      sqrtRatioUpperX96String: FULL_RANGE_SQRT_UPPER_X96.toString()
    }),
    start: poolStateOutput(start),
    end: poolStateOutput(end),
    initial: Object.freeze({
      capitalUsdc: tokenAmount(INITIAL_CAPITAL_USDC_RAW, POOL.token0),
      usdcBudget: tokenAmount(INITIAL_USDC_BUDGET_RAW, POOL.token0),
      cpBudget: tokenAmount(initialCpRaw, POOL.token1),
      initialCpQuantity: tokenAmount(initialCpRaw, POOL.token1)
    }),
    position: Object.freeze({
      liquidity,
      liquidityString: liquidity.toString(),
      consumed: Object.freeze({
        usdc: tokenAmount(consumed.amount0, POOL.token0),
        cp: tokenAmount(consumed.amount1, POOL.token1)
      }),
      unused: Object.freeze({
        usdc: tokenAmount(unused0, POOL.token0),
        cp: tokenAmount(unused1, POOL.token1)
      })
    }),
    ending: Object.freeze({
      lpPrincipal: Object.freeze({
        usdc: tokenAmount(principal.amount0, POOL.token0),
        cp: tokenAmount(principal.amount1, POOL.token1)
      }),
      totalAssetsIncludingDust: Object.freeze({
        usdc: tokenAmount(total0, POOL.token0),
        cp: tokenAmount(total1, POOL.token1)
      }),
      assetValueUsdc: rationalAmount(assetValue.rawUsdcNumerator, denominator),
      assetPnlUsdc: rationalAmount(pnlNumerator, denominator),
      periodReturnPercent: rationalAmount(pnlNumerator * 100n, INITIAL_CAPITAL_USDC_RAW * endSquare, 18),
      hodlValueUsdc: rationalAmount(hodlNumerator, denominator),
      lpVsHodlUsdc: rationalAmount(lpVsHodlNumerator, denominator)
    }),
    fees: Object.freeze({ status: "unavailable", reason: "historical fee accounting is outside LP Step B1" })
  });
}

export const MATH_CONSTANTS = Object.freeze({ Q96, Q192 });
