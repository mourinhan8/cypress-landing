"use strict";

(function () {
  const marketPrice = document.querySelector("[data-cp-price]");
  const marketLiquidity = document.querySelector("[data-cp-liquidity]");
  const marketCap = document.querySelector("[data-cp-market-cap]");
  const marketStatus = document.querySelector("[data-market-status]");
  const marketData = marketStatus && marketStatus.closest(".market-data");
  const vietnamese = document.documentElement.lang.toLowerCase().startsWith("vi");

  if (!marketPrice || !marketLiquidity || !marketCap || !marketStatus
      || !window.CpMarketData || !window.CpMarketMetrics) return;

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
    const display = window.CpMarketMetrics.formatLocaleMetrics(values, language);
    latestMarketData = data;
    latestMarketState = state;
    if (marketData) marketData.dataset.state = state;
    marketPrice.textContent = display.price;
    marketLiquidity.textContent = display.liquidity;
    marketCap.textContent = display.marketCap;
    marketStatus.textContent = window.CpMarketData.statusText(
      language, state, data.fetchedAt, Date.now()
    );
  }

  function showUnavailable() {
    marketPrice.textContent = "—";
    marketLiquidity.textContent = "—";
    marketCap.textContent = "—";
    if (marketData) marketData.dataset.state = "unavailable";
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
  if (vietnamese) {
    window.CpMarketMetrics.fetchFxSnapshot().then(function (snapshot) {
      fxSnapshot = snapshot;
      if (latestMarketData) render(latestMarketData, latestMarketState);
    }).catch(function (error) {
      fxSnapshot = null;
      if (latestMarketData) render(latestMarketData, latestMarketState);
      console.warn("USD/VND data unavailable:", error instanceof Error ? error.message : "Unknown error");
    });
  }
  loadMarketData();
})();
