"use strict";

(function () {
  const marketPrice = document.querySelector("[data-cp-price]");
  const marketLiquidity = document.querySelector("[data-cp-liquidity]");
  const marketCap = document.querySelector("[data-cp-market-cap]");
  const marketPriceVnd = document.querySelector("[data-cp-price-vnd]");
  const marketLiquidityVnd = document.querySelector("[data-cp-liquidity-vnd]");
  const marketCapVnd = document.querySelector("[data-cp-market-cap-vnd]");
  const marketStatus = document.querySelector("[data-market-status]");

  if (!marketPrice || !marketLiquidity || !marketCap || !marketPriceVnd || !marketLiquidityVnd
      || !marketCapVnd || !marketStatus || !window.CpMarketData || !window.CpMarketMetrics) return;

  const refreshInterval = 5 * 60 * 1000;
  let refreshTimer;
  let lastRequestAt = 0;
  let requestInFlight = false;
  let latestMarketData = null;
  let latestMarketState = "fresh";
  let fxSnapshot = null;

  function render(data, state) {
    const language = document.documentElement.lang;
    const values = window.CpMarketMetrics.deriveMetrics(data, fxSnapshot);
    latestMarketData = data;
    latestMarketState = state;
    marketPrice.textContent = window.CpMarketMetrics.formatPrice(values.usd.price);
    marketLiquidity.textContent = window.CpMarketMetrics.formatCompactUsd(values.usd.liquidity);
    marketCap.textContent = window.CpMarketMetrics.formatCompactUsd(values.usd.marketCap);
    const unavailable = window.CpMarketMetrics.unavailableVnd(language);
    marketPriceVnd.textContent = values.vnd ? window.CpMarketMetrics.formatVnd(values.vnd.price, language) : unavailable;
    marketLiquidityVnd.textContent = values.vnd ? window.CpMarketMetrics.formatVnd(values.vnd.liquidity, language) : unavailable;
    marketCapVnd.textContent = values.vnd ? window.CpMarketMetrics.formatVnd(values.vnd.marketCap, language) : unavailable;
    marketStatus.textContent = window.CpMarketData.statusText(
      language, state, data.fetchedAt, Date.now()
    );
  }

  function showUnavailable() {
    const vi = document.documentElement.lang.toLowerCase().startsWith("vi");
    marketPrice.textContent = vi ? "Không khả dụng" : "Unavailable";
    marketLiquidity.textContent = marketPrice.textContent;
    marketCap.textContent = marketPrice.textContent;
    marketPriceVnd.textContent = window.CpMarketMetrics.unavailableVnd(document.documentElement.lang);
    marketLiquidityVnd.textContent = marketPriceVnd.textContent;
    marketCapVnd.textContent = marketPriceVnd.textContent;
    marketStatus.textContent = window.CpMarketData.statusText(
      document.documentElement.lang, "unavailable", 0, Date.now()
    );
  }

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    if (document.hidden) return;
    refreshTimer = window.setTimeout(loadMarketData, Math.max(0, refreshInterval - (Date.now() - lastRequestAt)));
  }

  async function loadMarketData() {
    if (requestInFlight) return;
    requestInFlight = true;
    lastRequestAt = Date.now();

    try {
      const contractElement = document.querySelector(".contract-address");
      const contractAddress = contractElement ? contractElement.textContent.trim().toLowerCase() : "";
      if (contractAddress !== window.CpMarketData.CONFIG.cp) {
        throw new Error("CP contract address is unavailable");
      }
      const data = await window.CpMarketData.readMarketData();
      window.CpMarketData.writeCache(window.localStorage, data);
      render(data, "fresh");
    } catch (error) {
      const cached = window.CpMarketData.readCache(window.localStorage, Date.now());
      if (cached) render(cached, "stale");
      else showUnavailable();
      console.warn("CP market data unavailable:", error instanceof Error ? error.message : "Unknown error");
    } finally {
      requestInFlight = false;
      scheduleRefresh();
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) window.clearTimeout(refreshTimer);
    else scheduleRefresh();
  });

  const cached = window.CpMarketData.readCache(window.localStorage, Date.now());
  if (cached) render(cached, "stale");
  window.CpMarketMetrics.fetchFxSnapshot().then(function (snapshot) {
    fxSnapshot = snapshot;
    if (latestMarketData) render(latestMarketData, latestMarketState);
  }).catch(function (error) {
    fxSnapshot = null;
    if (latestMarketData) render(latestMarketData, latestMarketState);
    console.warn("USD/VND data unavailable:", error instanceof Error ? error.message : "Unknown error");
  });
  loadMarketData();
})();
