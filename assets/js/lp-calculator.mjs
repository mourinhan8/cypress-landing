import { calculateV2ReferenceApr, projectAllPeriodFees } from "../../tools/comparison/reference-fee.mjs";

export const PERIODS = Object.freeze(["7D", "30D", "6M", "1Y"]);
export const PRICE_PATH_URL = "/data/comparison/price-path-v2.json";
export const REFERENCE_FEE_URL = "/data/comparison/reference-fee-window-v2.json";
export const MAX_DATASET_BYTES = 1_000_000;

const XYK_INTERNAL_DECIMALS = 72;
const XYK_INTERNAL_SCALE = 10n ** BigInt(XYK_INTERNAL_DECIMALS);
const XYK_OUTPUT_DECIMALS = 36;
const XYK_INITIAL_CAPITAL = Object.freeze({ numerator: 1000n, denominator: 1n });
const XYK_POSITIVE_INTEGER = /^[1-9]\d*$/;
const XYK_NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/;

export const XYK_REFERENCE_SCHEMA_VERSION = 1;

function xykGcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function xykRational(numerator, denominator = 1n) {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint" || denominator === 0n) {
    throw new Error("invalid rational value");
  }
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = xykGcd(numerator, denominator);
  return { numerator: numerator / divisor * sign, denominator: denominator / divisor * sign };
}

function xykAdd(left, right) {
  return xykRational(left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function xykSubtract(left, right) {
  return xykRational(left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function xykMultiply(left, right) {
  return xykRational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function xykDivide(left, right) {
  if (right.numerator === 0n) throw new Error("division by zero");
  return xykRational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function xykCompare(left, right) {
  const result = left.numerator * right.denominator - right.numerator * left.denominator;
  return result === 0n ? 0 : result < 0n ? -1 : 1;
}

function xykParse(input, label, allowZero = false) {
  const numerator = input?.numerator;
  const denominator = input?.denominator;
  if (!(allowZero ? XYK_NON_NEGATIVE_INTEGER : XYK_POSITIVE_INTEGER).test(numerator)
      || !XYK_POSITIVE_INTEGER.test(denominator)) throw new Error(label + " must be a valid rational");
  return xykRational(BigInt(numerator), BigInt(denominator));
}

function xykFormat(input, decimalPlaces = XYK_OUTPUT_DECIMALS) {
  const negative = input.numerator < 0n;
  const numerator = negative ? -input.numerator : input.numerator;
  const integer = numerator / input.denominator;
  const fraction = decimalPlaces === 0 ? "" : ((numerator % input.denominator) * 10n ** BigInt(decimalPlaces) / input.denominator)
    .toString().padStart(decimalPlaces, "0").replace(/0+$/, "");
  const rendered = fraction ? integer + "." + fraction : integer.toString();
  return negative && numerator !== 0n ? "-" + rendered : rendered;
}

function xykOutput(input, decimalPlaces = XYK_OUTPUT_DECIMALS) {
  return {
    numerator: input.numerator.toString(),
    denominator: input.denominator.toString(),
    decimal: xykFormat(input, decimalPlaces),
    decimalPlaces,
    rounding: "toward-zero"
  };
}

function xykIntegerSquareRoot(input) {
  if (typeof input !== "bigint" || input < 0n) throw new Error("integer square root input must be non-negative");
  if (input < 2n) return input;
  let estimate = 1n << BigInt((input.toString(2).length + 1) >> 1);
  while (true) {
    const next = (estimate + input / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

function xykSquareRoot(input) {
  if (input.numerator <= 0n) throw new Error("price ratio must be positive");
  const radicand = input.numerator * XYK_INTERNAL_SCALE * XYK_INTERNAL_SCALE / input.denominator;
  return xykRational(xykIntegerSquareRoot(radicand), XYK_INTERNAL_SCALE);
}

export function calculateXyk50_50(startPrice, endPrice, estimatedFees) {
  const start = xykParse(startPrice, "start price");
  const end = xykParse(endPrice, "end price");
  const fees = xykParse(estimatedFees, "estimated fees", true);
  const priceRatio = xykDivide(end, start);
  const holdEnding = xykMultiply(XYK_INITIAL_CAPITAL, priceRatio);
  const xykBeforeFees = xykMultiply(XYK_INITIAL_CAPITAL, xykSquareRoot(priceRatio));
  const xykFinal = xykAdd(xykBeforeFees, fees);
  const holdProfitLoss = xykSubtract(holdEnding, XYK_INITIAL_CAPITAL);
  const xykProfitLoss = xykSubtract(xykFinal, XYK_INITIAL_CAPITAL);
  const difference = xykSubtract(holdEnding, xykFinal);
  return {
    priceRatio: xykOutput(priceRatio),
    initialCapitalUsdc: xykOutput(XYK_INITIAL_CAPITAL),
    holdCp: {
      endingValueUsdc: xykOutput(holdEnding),
      profitLossUsdc: xykOutput(holdProfitLoss),
      returnPercent: xykOutput(xykDivide(holdProfitLoss, xykRational(10n)))
    },
    xykLp: {
      principalEndingValueUsdc: xykOutput(xykBeforeFees),
      estimatedFeesUsdc: xykOutput(fees),
      endingValueIncludingEstimatedFeesUsdc: xykOutput(xykFinal),
      profitLossIncludingEstimatedFeesUsdc: xykOutput(xykProfitLoss),
      returnIncludingEstimatedFeesPercent: xykOutput(xykDivide(xykProfitLoss, xykRational(10n))),
      feeProjectionIncluded: true,
      feesReinvested: false
    },
    differenceIncludingEstimatedFees: {
      holdMinusLpUsdc: xykOutput(difference),
      leader: xykCompare(difference, xykRational(0n)) > 0 ? "hold_cp" : xykCompare(difference, xykRational(0n)) < 0 ? "xyk_lp" : "tie"
    }
  };
}

function selectXykBoundaries(dataset, period) {
  if (!dataset || dataset.schemaVersion !== 2 || dataset.kind !== "cypress-hold-vs-rebalanced-lp-price-path"
      || !Array.isArray(dataset.points)) throw new Error("Step 3A price-path contract mismatch");
  const selected = dataset.periods?.[period];
  const hold = selected?.strategyBoundaries?.holdCp;
  const lp = selected?.strategyBoundaries?.rebalancedLp;
  if (!hold || !lp || hold.startPointId !== lp.startPointId || hold.endPointId !== lp.endPointId) {
    throw new Error("Hold and LP boundaries must be identical");
  }
  const byId = new Map(dataset.points.map(point => [point.id, point]));
  const start = byId.get(hold.startPointId);
  const end = byId.get(hold.endPointId);
  if (!start || !end || Date.parse(start.timestamp) >= Date.parse(end.timestamp)) throw new Error("period boundaries are invalid");
  return { start, end };
}

export function comparePeriodXyk50_50(dataset, period, estimatedFees) {
  const { start, end } = selectXykBoundaries(dataset, period);
  const calculated = calculateXyk50_50(start.priceUsd, end.priceUsd, estimatedFees);
  return {
    schemaVersion: XYK_REFERENCE_SCHEMA_VERSION,
    kind: "cypress-hold-vs-xyk-50-50-reference",
    period,
    model: {
      name: "xyk_50_50_reference",
      initialValueAllocation: { cpPercent: "50", usdcPercent: "50" },
      principalFormula: "initial_capital_times_square_root_end_price_over_start_price",
      concentratedLiquidity: false,
      exactUniswapV3Simulation: false,
      impermanentLossDeduction: "not_separate_formula_already_captures_relative_xyk_behavior"
    },
    boundaries: {
      startPointId: start.id,
      endPointId: end.id,
      startTimestamp: start.timestamp,
      endTimestamp: end.timestamp,
      startPriceUsd: structuredClone(start.priceUsd),
      endPriceUsd: structuredClone(end.priceUsd)
    },
    ...calculated,
    numericalPolicy: {
      arithmetic: "BigInt rational accounting",
      squareRootDecimalPlaces: XYK_INTERNAL_DECIMALS,
      outputDecimalPlaces: XYK_OUTPUT_DECIMALS,
      squareRootRounding: "toward-zero",
      outputRounding: "toward-zero"
    }
  };
}

export function compareAllPeriodsXyk50_50(dataset, estimatedFeesByPeriod) {
  return Object.fromEntries(PERIODS.map(period => {
    const fees = estimatedFeesByPeriod?.[period];
    if (!fees) throw new Error("estimated fees missing for " + period);
    return [period, comparePeriodXyk50_50(dataset, period, fees)];
  }));
}

const TEXT = Object.freeze({
  en: {
    unavailable: "Comparison data is unavailable.",
    ready: "Comparison ready.",
    holdAhead: "Holding Cypress is better by",
    liquidityAhead: "LP 50/50 is better by",
    tie: "Hold and LP 50/50 finish equal",
    apr: "Reference fee APR",
    estimate: "estimate",
    window: "days observed"

  },
  vi: {
    unavailable: "Dữ liệu so sánh hiện không khả dụng.",
    ready: "Đã tải kết quả so sánh.",
    holdAhead: "Giữ Cypress tốt hơn",
    liquidityAhead: "LP 50/50 tốt hơn",
    tie: "Hold và LP 50/50 có kết quả bằng nhau",
    apr: "APR phí tham chiếu",
    estimate: "ước tính",
    window: "ngày quan sát"

  }
});

function numeric(decimal) {
  const value = Number(decimal);
  if (!Number.isFinite(value)) throw new Error("Invalid decimal result");
  return value;
}

export function formatUsd(decimal, options = {}) {
  const value = numeric(decimal);
  const fractionDigits = options.price ? 8 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: options.price ? 2 : 2,
    maximumFractionDigits: fractionDigits
  }).format(value);
}

export function formatSignedUsd(decimal) {
  const value = numeric(decimal);
  if (value === 0) return formatUsd("0");
  return (value > 0 ? "+" : "−") + formatUsd(String(Math.abs(value)));
}

export function formatSignedPercent(decimal) {
  const value = numeric(decimal);
  if (value === 0) return "0.00%";
  return (value > 0 ? "+" : "−") + Math.abs(value).toFixed(2) + "%";
}

async function fetchJson(url, fetchImpl, signal) {
  const response = await fetchImpl(url, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error("Comparison dataset returned HTTP " + response.status);
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > MAX_DATASET_BYTES) throw new Error("Comparison dataset exceeds its byte bound");
  const body = await response.text();
  if (body.length > MAX_DATASET_BYTES) throw new Error("Comparison dataset exceeds its byte bound");
  return JSON.parse(body);
}

export async function fetchComparisonData(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8_000);
  try {
    const [pricePath, referenceFeeWindow] = await Promise.all([
      fetchJson(options.pricePathUrl || PRICE_PATH_URL, fetchImpl, controller.signal),
      fetchJson(options.referenceFeeUrl || REFERENCE_FEE_URL, fetchImpl, controller.signal)
    ]);
    return { pricePath, referenceFeeWindow };
  } finally {
    clearTimeout(timer);
  }
}

export function buildComparisonResults(pricePath, referenceFeeWindow) {
  const referenceApr = calculateV2ReferenceApr(referenceFeeWindow);
  if (!referenceApr.available || referenceApr.status !== "available") throw new Error("Reference fee APR is unavailable");
  const existingFeeProjection = projectAllPeriodFees(pricePath, referenceApr);
  const estimatedFees = Object.fromEntries(PERIODS.map(period => [period,
    existingFeeProjection[period].rebalancedLp.estimatedFeesUsdc]));
  return { referenceApr, periods: compareAllPeriodsXyk50_50(pricePath, estimatedFees) };
}

function setText(root, key, value) {
  const element = root.querySelector('[data-lp-result="' + key + '"]');
  if (element) element.textContent = value;
}

export function conclusionText(result, language) {
  const text = TEXT[language === "vi" ? "vi" : "en"];
  const difference = result.differenceIncludingEstimatedFees;
  if (difference.leader === "tie") return text.tie;
  const leader = difference.leader === "hold_cp" ? text.holdAhead : text.liquidityAhead;
  return leader + " " + formatUsd(String(Math.abs(numeric(difference.holdMinusLpUsdc.decimal))));
}

export function referenceAprText(referenceApr, language) {
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const text = TEXT[language === "vi" ? "vi" : "en"];
  const apr = numeric(referenceApr.lpNetAprPercent.decimal).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let rendered = text.apr + ": " + apr + "% (" + text.estimate + ")";
  const days = numeric(referenceApr.window.durationDays.decimal).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  rendered += " · " + days + " " + text.window;
  return rendered;
}

export function renderPeriod(root, comparison, period, language = "en") {
  if (!PERIODS.includes(period) || !comparison.periods[period]) throw new Error("Unsupported comparison period");
  const result = comparison.periods[period];
  setText(root, "start-price", formatUsd(result.boundaries.startPriceUsd.decimal, { price: true }));
  setText(root, "end-price", formatUsd(result.boundaries.endPriceUsd.decimal, { price: true }));
  setText(root, "hold-ending", formatUsd(result.holdCp.endingValueUsdc.decimal));
  setText(root, "hold-pl", formatSignedUsd(result.holdCp.profitLossUsdc.decimal));
  setText(root, "hold-return", formatSignedPercent(result.holdCp.returnPercent.decimal));
  setText(root, "lp-ending", formatUsd(result.xykLp.endingValueIncludingEstimatedFeesUsdc.decimal));
  setText(root, "lp-pl", formatSignedUsd(result.xykLp.profitLossIncludingEstimatedFeesUsdc.decimal));
  setText(root, "lp-return", formatSignedPercent(result.xykLp.returnIncludingEstimatedFeesPercent.decimal));
  setText(root, "estimated-fees", formatUsd(result.xykLp.estimatedFeesUsdc.decimal));
  setText(root, "conclusion", conclusionText(result, language));
  root.querySelector("[data-lp-reference-apr]").textContent = referenceAprText(comparison.referenceApr, language);
  for (const button of root.querySelectorAll("[data-lp-period]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lpPeriod === period));
  }
  root.dataset.activePeriod = period;
  root.querySelector("[data-lp-results]").hidden = false;
  return result;
}

export async function initializeCalculator(root, options = {}) {
  const language = root.dataset.language === "vi" ? "vi" : "en";
  const status = root.querySelector("[data-lp-status]");
  try {
    const datasets = options.datasets || await fetchComparisonData(options);
    const comparison = buildComparisonResults(datasets.pricePath, datasets.referenceFeeWindow);
    const buttons = Array.from(root.querySelectorAll("[data-lp-period]"));
    const select = period => renderPeriod(root, comparison, period, language);
    for (const [index, button] of buttons.entries()) {
      button.addEventListener("click", () => select(button.dataset.lpPeriod));
      button.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const targetIndex = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[targetIndex].focus();
        select(buttons[targetIndex].dataset.lpPeriod);
      });
    }
    select("7D");
    status.textContent = TEXT[language].ready;
    status.hidden = true;
    return comparison;
  } catch (error) {
    status.textContent = TEXT[language].unavailable;
    status.dataset.state = "error";
    root.querySelectorAll("[data-lp-period]").forEach(button => { button.disabled = true; });
    throw error;
  }
}

if (typeof document !== "undefined") {
  const dialog = document.querySelector("[data-lp-dialog]");
  const root = document.querySelector("[data-lp-calculator]");
  let initialization;
  document.querySelector("[data-lp-open]")?.addEventListener("click", () => {
    dialog.showModal();
    if (root && !initialization) initialization = initializeCalculator(root).catch(() => {});
  });
  dialog?.querySelector("[data-lp-close]")?.addEventListener("click", () => dialog.close());
  dialog?.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
}
