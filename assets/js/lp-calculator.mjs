import { calculateReferenceApr, projectAllPeriodFees } from "../../tools/comparison/reference-fee.mjs";

export const PERIODS = Object.freeze(["7D", "30D", "6M", "1Y"]);
export const PRICE_PATH_URL = "/data/comparison/price-path-v2.json";
export const REFERENCE_FEE_URL = "/data/comparison/reference-fee-window-v1.json";
export const MAX_DATASET_BYTES = 1_000_000;

const TEXT = Object.freeze({
  en: {
    unavailable: "Comparison data is unavailable.",
    ready: "Comparison ready.",
    holdAhead: "Hold ahead by",
    liquidityAhead: "Liquidity ahead by",
    tie: "Hold and Liquidity finish equal",
    apr: "Reference fee APR",
    estimate: "estimate",
    window: "days observed"

  },
  vi: {
    unavailable: "Dữ liệu so sánh hiện không khả dụng.",
    ready: "Đã tải kết quả so sánh.",
    holdAhead: "Hold dẫn trước",
    liquidityAhead: "Thanh khoản dẫn trước",
    tie: "Hold và Thanh khoản có kết quả bằng nhau",
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
  const referenceApr = calculateReferenceApr(referenceFeeWindow);
  if (!referenceApr.available || referenceApr.status !== "available") throw new Error("Reference fee APR is unavailable");
  return { referenceApr, periods: projectAllPeriodFees(pricePath, referenceApr) };
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
  if (referenceApr.window.partial || numeric(referenceApr.window.durationDays.decimal) < 7) {
    const days = numeric(referenceApr.window.durationDays.decimal).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    rendered += " · " + days + " " + text.window;
  }
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
  setText(root, "lp-ending", formatUsd(result.rebalancedLp.endingValueIncludingEstimatedFeesUsdc.decimal));
  setText(root, "lp-pl", formatSignedUsd(result.rebalancedLp.profitLossIncludingEstimatedFeesUsdc.decimal));
  setText(root, "lp-return", formatSignedPercent(result.rebalancedLp.returnIncludingEstimatedFeesPercent.decimal));
  setText(root, "estimated-fees", formatUsd(result.rebalancedLp.estimatedFeesUsdc.decimal));
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
