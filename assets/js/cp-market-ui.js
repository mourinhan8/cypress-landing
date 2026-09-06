"use strict";

(function () {
  const marketPrice = document.querySelector("[data-cp-price]");
  const marketLiquidity = document.querySelector("[data-cp-liquidity]");
  const marketStatus = document.querySelector("[data-market-status]");

  if (!marketPrice || !marketLiquidity || !marketStatus || !window.CpMarketData) return;

  const refreshInterval = 5 * 60 * 1000;
  let refreshTimer;
  let lastRequestAt = 0;
  let requestInFlight = false;

  function formatPrice(value) {
    let options;
    if (value >= 1) options = { maximumFractionDigits: 4 };
    else if (value >= 0.01) options = { maximumFractionDigits: 6 };
    else options = { maximumFractionDigits: 20, maximumSignificantDigits: 6 };
    return "$" + new Intl.NumberFormat("en-US", options).format(value);
  }

  function formatLiquidity(value) {
    if (value < 1000) {
      return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
    }
    if (value < 1000000) {
      return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value / 1000) + "K";
    }
    return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value / 1000000) + "M";
  }

  function render(data, state) {
    marketPrice.textContent = formatPrice(data.cpPriceUsd);
    marketLiquidity.textContent = formatLiquidity(data.totalLiquidityUsd);
    marketStatus.textContent = window.CpMarketData.statusText(
      document.documentElement.lang, state, data.fetchedAt, Date.now()
    );
  }

  function showUnavailable() {
    const vi = document.documentElement.lang.toLowerCase().startsWith("vi");
    marketPrice.textContent = vi ? "Không khả dụng" : "Unavailable";
    marketLiquidity.textContent = marketPrice.textContent;
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
  loadMarketData();
})();
