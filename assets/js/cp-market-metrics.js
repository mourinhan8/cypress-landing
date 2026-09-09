(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CpMarketMetrics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TOTAL_SUPPLY_CP = 25_000_000;
  const FX_DATA_URL = "/api/fx/v1/usd-vnd.json";
  const MAX_FX_BYTES = 32 * 1024;

  function validateFxSnapshot(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.base !== "USD" || snapshot.quote !== "VND"
        || snapshot.provider !== "ExchangeRate-API" || typeof snapshot.rate !== "number"
        || !Number.isFinite(snapshot.rate) || snapshot.rate <= 0
        || !Number.isFinite(Date.parse(snapshot.updatedAt))) throw new Error("USD/VND data is invalid");
    return snapshot;
  }

  async function fetchFxSnapshot(options) {
    const settings = options || {};
    const fetchImpl = settings.fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, settings.timeoutMs || 8000);
    try {
      const response = await fetchImpl(settings.url || FX_DATA_URL, { credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw new Error("USD/VND data returned HTTP " + response.status);
      const length = Number(response.headers && response.headers.get && response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_FX_BYTES) throw new Error("USD/VND data exceeds its byte bound");
      const body = await response.text();
      if (body.length > MAX_FX_BYTES) throw new Error("USD/VND data exceeds its byte bound");
      return validateFxSnapshot(JSON.parse(body));
    } finally {
      clearTimeout(timer);
    }
  }

  function deriveMetrics(marketData, fxSnapshot) {
    if (!marketData || !Number.isFinite(marketData.cpPriceUsd) || marketData.cpPriceUsd <= 0
        || !Number.isFinite(marketData.totalLiquidityUsd) || marketData.totalLiquidityUsd <= 0) {
      throw new Error("market data is invalid");
    }
    const usd = {
      price: marketData.cpPriceUsd,
      liquidity: marketData.totalLiquidityUsd,
      marketCap: marketData.cpPriceUsd * TOTAL_SUPPLY_CP
    };
    if (!fxSnapshot) return { usd, vnd: null, rate: null };
    const rate = validateFxSnapshot(fxSnapshot).rate;
    return {
      usd,
      vnd: { price: usd.price * rate, liquidity: usd.liquidity * rate, marketCap: usd.marketCap * rate },
      rate
    };
  }

  function formatPrice(value) {
    let options;
    if (value >= 1) options = { maximumFractionDigits: 4 };
    else if (value >= 0.01) options = { maximumFractionDigits: 6 };
    else options = { maximumFractionDigits: 20, maximumSignificantDigits: 6 };
    return "$" + new Intl.NumberFormat("en-US", options).format(value);
  }

  function formatCompactUsd(value) {
    if (value < 1000) return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
    if (value < 1000000) return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value / 1000) + "K";
    return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value / 1000000) + "M";
  }

  function formatVnd(value, language) {
    const locale = String(language || "").toLowerCase().startsWith("vi") ? "vi-VN" : "en-US";
    return "≈ " + new Intl.NumberFormat(locale, { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value);
  }

  function unavailableVnd(language) {
    return String(language || "").toLowerCase().startsWith("vi") ? "≈ VND không khả dụng" : "≈ VND unavailable";
  }

  return {
    FX_DATA_URL, MAX_FX_BYTES, TOTAL_SUPPLY_CP, deriveMetrics, fetchFxSnapshot,
    formatCompactUsd, formatPrice, formatVnd, unavailableVnd, validateFxSnapshot
  };
});
