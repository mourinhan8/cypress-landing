import { POOL, simulateFullRange } from "../../tools/lp/full-range-simulator.mjs";
import { toSimulatorState } from "../../tools/lp/historical-state.mjs";

export const DATASET_URL = "/api/lp/v1/history.json";
export const MAX_DATASET_BYTES = 512_000;
export const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

const TEXT = Object.freeze({
  en: {
    unavailable: "LP data is unavailable.", stale: "The latest LP snapshot is stale.", ready: "Exact finalized pool states loaded.",
    latest: "Latest finalized", block: "Block", calculate: "Calculate", loading: "Loading exact pool states…",
    init: "Initialization", dateUnavailable: "Unavailable"
  },
  vi: {
    unavailable: "Dữ liệu LP hiện không khả dụng.", stale: "Ảnh chụp LP mới nhất đã cũ.", ready: "Đã tải trạng thái pool finalized chính xác.",
    latest: "Finalized mới nhất", block: "Khối", calculate: "Tính toán", loading: "Đang tải trạng thái pool chính xác…",
    init: "Khởi tạo", dateUnavailable: "Không khả dụng"
  }
});

function canonicalTimestamp(value, label) {
  const milliseconds = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error(label + " is invalid");
  return milliseconds;
}

export function validateDataset(dataset) {
  if (!dataset || dataset.schemaVersion !== 1 || dataset.kind !== "cypress-lp-principal-history") throw new Error("LP dataset schema is invalid");
  if (dataset.identity?.chainId !== POOL.chainId || dataset.identity?.pool !== POOL.address
      || dataset.identity?.token0?.address !== POOL.token0.address || dataset.identity?.token0?.decimals !== POOL.token0.decimals
      || dataset.identity?.token1?.address !== POOL.token1.address || dataset.identity?.token1?.decimals !== POOL.token1.decimals
      || dataset.identity?.fee !== String(POOL.fee) || dataset.identity?.tickSpacing !== String(POOL.tickSpacing)) {
    throw new Error("LP dataset identity is invalid");
  }
  canonicalTimestamp(dataset.generatedAt, "generation timestamp");
  if (!Array.isArray(dataset.snapshots) || dataset.snapshots.length === 0 || dataset.snapshots.length > 400
      || !Array.isArray(dataset.resolutions) || !Array.isArray(dataset.gaps)
      || dataset.fees?.included !== false || dataset.fees?.status !== "unavailable"
      || dataset.resolutionPolicy?.interpolation !== false || dataset.resolutionPolicy?.exactRequestedTimestampsOnly !== true) {
    throw new Error("LP dataset bounds or policy are invalid");
  }
  let previous = -1n;
  const blocks = new Map();
  for (const snapshot of dataset.snapshots) {
    toSimulatorState(snapshot);
    const number = BigInt(snapshot.blockNumber);
    if (number <= previous) throw new Error("LP snapshots are not ordered");
    previous = number;
    blocks.set(snapshot.blockNumber, snapshot);
  }
  for (const resolution of dataset.resolutions) {
    canonicalTimestamp(resolution.requestedTimestamp, "requested timestamp");
    const snapshot = blocks.get(resolution.blockNumber);
    if (!snapshot || snapshot.blockHash !== resolution.blockHash) throw new Error("LP resolution is inconsistent");
  }
  for (const gap of dataset.gaps) canonicalTimestamp(gap.requestedTimestamp, "gap timestamp");
  const latest = blocks.get(dataset.latestIncludedFinalizedBlock?.blockNumber);
  if (!latest || latest.blockHash !== dataset.latestIncludedFinalizedBlock.blockHash) throw new Error("latest LP snapshot is inconsistent");
  return dataset;
}

export async function fetchDataset(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8_000);
  try {
    const response = await fetchImpl(options.url || DATASET_URL, { credentials: "same-origin", signal: controller.signal });
    if (!response.ok) throw new Error("LP dataset returned HTTP " + response.status);
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > MAX_DATASET_BYTES) throw new Error("LP dataset exceeds its byte bound");
    const body = await response.text();
    if (body.length > MAX_DATASET_BYTES) throw new Error("LP dataset exceeds its byte bound");
    return validateDataset(JSON.parse(body));
  } finally { clearTimeout(timer); }
}

function datePart(timestamp) { return timestamp.slice(0, 10); }

export function boundaryOptions(dataset) {
  validateDataset(dataset);
  const blocks = new Map(dataset.snapshots.map(snapshot => [snapshot.blockNumber, snapshot]));
  const output = dataset.resolutions.map(resolution => ({
    key: resolution.blockNumber,
    requestedTimestamp: resolution.requestedTimestamp,
    snapshot: blocks.get(resolution.blockNumber),
    latest: false,
    unavailable: false
  }));
  const latestBlock = dataset.latestIncludedFinalizedBlock.blockNumber;
  if (!output.some(option => option.key === latestBlock)) {
    output.push({ key: latestBlock, requestedTimestamp: blocks.get(latestBlock).timestamp, snapshot: blocks.get(latestBlock), latest: true, unavailable: false });
  } else {
    output.find(option => option.key === latestBlock).latest = true;
  }
  for (const gap of dataset.gaps) {
    if (!output.some(option => datePart(option.requestedTimestamp) === datePart(gap.requestedTimestamp))) {
      output.push({ key: "gap:" + gap.requestedTimestamp, requestedTimestamp: gap.requestedTimestamp, latest: false, unavailable: true });
    }
  }
  return output.sort((left, right) => Date.parse(left.requestedTimestamp) - Date.parse(right.requestedTimestamp));
}

export function calculateFromDataset(dataset, startBlock, endBlock) {
  validateDataset(dataset);
  const blocks = new Map(dataset.snapshots.map(snapshot => [snapshot.blockNumber, snapshot]));
  const start = blocks.get(String(startBlock));
  const end = blocks.get(String(endBlock));
  if (!start || !end) throw new Error("Selected LP boundary is unavailable");
  return { result: simulateFullRange({ start: toSimulatorState(start), end: toSimulatorState(end) }), start, end };
}

export function formatDecimal(value, maximumFractionDigits = 6) {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error("decimal value is invalid");
  const negative = value.startsWith("-");
  const [wholeRaw, fractionRaw = ""] = (negative ? value.slice(1) : value).split(".");
  const whole = wholeRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = fractionRaw.slice(0, maximumFractionDigits).replace(/0+$/, "");
  return (negative ? "−" : "") + whole + (fraction ? "." + fraction : "");
}

function optionLabel(option, language) {
  const text = TEXT[language];
  const date = datePart(option.requestedTimestamp);
  if (option.unavailable) return date + " — " + text.dateUnavailable;
  if (option.latest) return text.latest + " — " + option.snapshot.timestamp.replace(".000Z", "Z");
  if (option.snapshot.blockNumber === POOL.initializationBlock.toString()) return date + " — " + text.init;
  return date + " — 00:00 UTC";
}

function setText(root, key, value) {
  const element = root.querySelector('[data-lp-result="' + key + '"]');
  if (element) element.textContent = value;
}

function renderResult(root, calculated, language) {
  const { result, start, end } = calculated;
  setText(root, "capital", formatDecimal(result.initial.capitalUsdc.decimal, 2) + " USDC");
  setText(root, "initial-cp", formatDecimal(result.initial.initialCpQuantity.decimal, 6) + " CP");
  setText(root, "start-price", formatDecimal(result.start.cpPriceUsdc.decimal, 8) + " USDC");
  setText(root, "end-price", formatDecimal(result.end.cpPriceUsdc.decimal, 8) + " USDC");
  setText(root, "ending-cp", formatDecimal(result.ending.totalAssetsIncludingDust.cp.decimal, 6) + " CP");
  setText(root, "ending-usdc", formatDecimal(result.ending.totalAssetsIncludingDust.usdc.decimal, 6) + " USDC");
  setText(root, "asset-value", formatDecimal(result.ending.assetValueUsdc.decimal, 6) + " USDC");
  setText(root, "asset-pnl", formatDecimal(result.ending.assetPnlUsdc.decimal, 6) + " USDC");
  setText(root, "return", formatDecimal(result.ending.periodReturnPercent.decimal, 4) + "%");
  setText(root, "hodl", formatDecimal(result.ending.hodlValueUsdc.decimal, 6) + " USDC");
  setText(root, "lp-vs-hodl", formatDecimal(result.ending.lpVsHodlUsdc.decimal, 6) + " USDC");
  setText(root, "start-resolution", start.timestamp.replace(".000Z", "Z") + " · " + TEXT[language].block + " " + start.blockNumber);
  setText(root, "end-resolution", end.timestamp.replace(".000Z", "Z") + " · " + TEXT[language].block + " " + end.blockNumber);
  root.querySelector("[data-lp-results]").hidden = false;
}

export async function initializeCalculator(root, options = {}) {
  const language = root.dataset.language === "vi" ? "vi" : "en";
  const text = TEXT[language];
  const status = root.querySelector("[data-lp-status]");
  const calculateButton = root.querySelector("[data-lp-calculate]");
  status.textContent = text.loading;
  calculateButton.disabled = true;
  try {
    const dataset = await fetchDataset(options);
    const choices = boundaryOptions(dataset);
    const usable = choices.filter(choice => !choice.unavailable);
    for (const select of root.querySelectorAll("[data-lp-boundary]")) {
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice.key;
        option.textContent = optionLabel(choice, language);
        option.disabled = choice.unavailable;
        select.append(option);
      }
    }
    root.querySelector('[data-lp-boundary="start"]').value = usable[0].key;
    root.querySelector('[data-lp-boundary="end"]').value = usable.at(-1).key;
    const stale = Date.now() - canonicalTimestamp(dataset.generatedAt, "generation timestamp") > STALE_AFTER_MS;
    status.textContent = stale ? text.stale : text.ready;
    status.dataset.state = stale ? "stale" : "ready";
    calculateButton.disabled = usable.length < 1;
    calculateButton.addEventListener("click", () => {
      try {
        const start = root.querySelector('[data-lp-boundary="start"]').value;
        const end = root.querySelector('[data-lp-boundary="end"]').value;
        renderResult(root, calculateFromDataset(dataset, start, end), language);
      } catch (error) {
        status.textContent = error.message;
        status.dataset.state = "error";
      }
    });
    if (usable.length) calculateButton.click();
    return dataset;
  } catch (error) {
    status.textContent = text.unavailable;
    status.dataset.state = "error";
    root.querySelectorAll("select, button[data-lp-calculate]").forEach(element => { element.disabled = true; });
    throw error;
  }
}

if (typeof document !== "undefined") {
  const dialog = document.querySelector("[data-lp-dialog]");
  const root = document.querySelector("[data-lp-calculator]");
  document.querySelector("[data-lp-open]")?.addEventListener("click", () => dialog.showModal());
  dialog?.querySelector("[data-lp-close]")?.addEventListener("click", () => dialog.close());
  dialog?.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
  if (root) initializeCalculator(root).catch(() => {});
}
