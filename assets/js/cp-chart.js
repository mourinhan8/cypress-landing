(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CpChart = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TIMEFRAMES = Object.freeze({
    "7D": { file: "7d.json", maximum: 168 },
    "1M": { file: "1m.json", maximum: 32 },
    "3M": { file: "3m.json", maximum: 32 },
    "1Y": { file: "1y.json", maximum: 55 },
    MAX: { file: "max.json", maximum: 240 }
  });
  const MAX_RESPONSE_BYTES = 196608;
  const ENDPOINT_BASE = "/api/chart/v1/";
  const COPY = {
    en: {
      loading: "Loading chart…", empty: "No candles are available for this timeframe.",
      error: "Chart data is temporarily unavailable.", stale: "Showing last-known-good chart data.",
      partial: "Available market history is partial.", fresh: "Chart data is current."
    },
    vi: {
      loading: "Đang tải biểu đồ…", empty: "Chưa có nến cho khung thời gian này.",
      error: "Dữ liệu biểu đồ tạm thời không khả dụng.", stale: "Đang hiển thị dữ liệu biểu đồ tốt gần nhất.",
      partial: "Lịch sử thị trường hiện có chưa đầy đủ.", fresh: "Dữ liệu biểu đồ đang cập nhật."
    }
  };

  function language(value) {
    return String(value || "").toLowerCase().startsWith("vi") ? "vi" : "en";
  }

  function policy(timeframe) {
    const selected = String(timeframe || "").toUpperCase();
    if (!TIMEFRAMES[selected]) throw new Error("Unsupported chart timeframe");
    return { timeframe: selected, ...TIMEFRAMES[selected] };
  }

  function exactDecimal(value, label) {
    if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || Number(value) <= 0) {
      throw new Error("Invalid chart " + label);
    }
    return value;
  }

  function compareDecimals(left, right) {
    const leftParts = left.split(".");
    const rightParts = right.split(".");
    const places = Math.max((leftParts[1] || "").length, (rightParts[1] || "").length);
    const leftValue = BigInt(leftParts[0] + (leftParts[1] || "").padEnd(places, "0"));
    const rightValue = BigInt(rightParts[0] + (rightParts[1] || "").padEnd(places, "0"));
    return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
  }

  function validateSnapshot(snapshot, requestedTimeframe) {
    const expected = policy(requestedTimeframe);
    if (!snapshot || snapshot.schema_version !== 1 || snapshot.timeframe !== expected.timeframe
        || !["ok", "unavailable"].includes(snapshot.status) || !Array.isArray(snapshot.candles)
        || snapshot.candles.length !== snapshot.candle_count || snapshot.candles.length > expected.maximum) {
      throw new Error("Chart response schema mismatch");
    }
    if (snapshot.status === "unavailable") {
      if (snapshot.candle_count !== 0) throw new Error("Unavailable chart response must be empty");
      return snapshot;
    }
    if (typeof snapshot.stale !== "boolean" || typeof snapshot.partial_history !== "boolean"
        || !Array.isArray(snapshot.sources) || !snapshot.freshness
        || !Number.isInteger(snapshot.freshness.stale_after_seconds)
        || snapshot.freshness.stale_after_seconds <= 0) throw new Error("Chart response metadata mismatch");
    let previous = -Infinity;
    snapshot.candles.forEach(function (candle) {
      const time = Date.parse(candle.time);
      const end = Date.parse(candle.interval_end);
      if (!Number.isFinite(time) || !Number.isFinite(end) || end <= time || time <= previous) {
        throw new Error("Chart candle time order mismatch");
      }
      const open = exactDecimal(candle.open, "open");
      const high = exactDecimal(candle.high, "high");
      const low = exactDecimal(candle.low, "low");
      const close = exactDecimal(candle.close, "close");
      if (compareDecimals(high, open) < 0 || compareDecimals(high, close) < 0 || compareDecimals(high, low) < 0
          || compareDecimals(low, open) > 0 || compareDecimals(low, close) > 0) {
        throw new Error("Chart candle OHLC mismatch");
      }
      if (candle.source === "coingecko_csv") {
        if (candle.source_kind !== "daily_close" || candle.methodology !== "synthetic_close_derived_ohlc"
            || "volume_usd" in candle) throw new Error("Historical chart provenance mismatch");
      } else if (candle.source === "geckoterminal") {
        if (candle.source_kind !== "real_ohlcv" || !candle.source_stream_version) {
          throw new Error("Current chart provenance mismatch");
        }
      } else throw new Error("Unknown chart provenance");
      previous = time;
    });
    return snapshot;
  }

  function endpointFor(timeframe) {
    return ENDPOINT_BASE + policy(timeframe).file;
  }

  async function fetchSnapshot(timeframe, options) {
    const settings = options || {};
    const fetchImpl = settings.fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, settings.timeoutMs || 8000);
    try {
      const response = await fetchImpl(endpointFor(timeframe), { credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw new Error("Chart endpoint returned HTTP " + response.status);
      const declared = Number(response.headers && response.headers.get && response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Chart response exceeds byte bound");
      const text = await response.text();
      if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new Error("Chart response exceeds byte bound");
      return validateSnapshot(JSON.parse(text), timeframe);
    } finally {
      clearTimeout(timer);
    }
  }

  function formatUsd(value) {
    const decimal = exactDecimal(String(value), "price");
    return formatDisplayUsd(Number(decimal));
  }

  function displayFractionDigits(value) {
    if (value >= 0.0001) return 6;
    if (value <= 0) return 6;
    return Math.min(12, Math.max(6, Math.floor(-Math.log10(value)) + 4));
  }

  function formatDisplayUsd(value) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid chart display price");
    return "$" + new Intl.NumberFormat("en-US", {
      maximumFractionDigits: displayFractionDigits(value),
      minimumFractionDigits: 0
    }).format(value);
  }

  function formatAxisUsd(value) {
    return formatDisplayUsd(value);
  }

  function tooltipText(candle, locale) {
    const date = new Intl.DateTimeFormat(language(locale) === "vi" ? "vi-VN" : "en-US", {
      dateStyle: "medium", timeStyle: "short", timeZone: "UTC"
    }).format(new Date(candle.time));
    return date + " UTC\nO " + formatUsd(candle.open) + "  H " + formatUsd(candle.high)
      + "  L " + formatUsd(candle.low) + "  C " + formatUsd(candle.close);
  }

  function renderSelection(selection, candle, locale) {
    const lines = tooltipText(candle, locale).split("\n");
    const date = document.createElement("span");
    const values = document.createElement("span");
    date.className = "chart-selection-date";
    values.className = "chart-selection-values";
    date.textContent = lines[0];
    values.textContent = lines[1];
    selection.replaceChildren(date, values);
    selection.hidden = false;
  }

  function nearestCandleIndex(candles, targetTime) {
    if (!Array.isArray(candles) || candles.length === 0) return -1;
    const target = Number(targetTime);
    if (!Number.isFinite(target)) return -1;
    const first = Math.floor(Date.parse(candles[0].time) / 1000);
    const lastIndex = candles.length - 1;
    const last = Math.floor(Date.parse(candles[lastIndex].time) / 1000);
    if (target <= first) return 0;
    if (target >= last) return lastIndex;
    let low = 0;
    let high = lastIndex;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      const middleTime = Math.floor(Date.parse(candles[middle].time) / 1000);
      if (middleTime <= target) low = middle;
      else high = middle;
    }
    const lowTime = Math.floor(Date.parse(candles[low].time) / 1000);
    const highTime = Math.floor(Date.parse(candles[high].time) / 1000);
    return target - lowTime <= highTime - target ? low : high;
  }

  function nearestLogicalIndex(logical, candleCount) {
    if (!Number.isFinite(logical) || !Number.isInteger(candleCount) || candleCount < 1) return -1;
    return Math.min(candleCount - 1, Math.max(0, Math.round(logical)));
  }

  function gestureAxis(deltaX, deltaY, threshold) {
    const minimum = threshold === undefined ? 6 : threshold;
    const horizontal = Math.abs(deltaX);
    const vertical = Math.abs(deltaY);
    if (Math.max(horizontal, vertical) < minimum) return "pending";
    return horizontal > vertical ? "horizontal" : "vertical";
  }

  function createSelectionModel(onChange) {
    let candles = [];
    let selectedIndex = -1;

    function selectIndex(index) {
      if (!candles.length) return null;
      const next = Math.min(candles.length - 1, Math.max(0, Math.round(index)));
      selectedIndex = next;
      onChange(candles[next], next);
      return candles[next];
    }

    function setCandles(nextCandles) {
      candles = nextCandles.slice();
      selectedIndex = -1;
      return candles.length ? selectIndex(candles.length - 1) : null;
    }

    function selectTime(targetTime) {
      const index = nearestCandleIndex(candles, targetTime);
      return index < 0 ? null : selectIndex(index);
    }

    return {
      setCandles,
      selectIndex,
      selectTime,
      selected: function () { return selectedIndex < 0 ? null : candles[selectedIndex]; },
      selectedIndex: function () { return selectedIndex; },
      size: function () { return candles.length; }
    };
  }

  function chartPoints(snapshot) {
    return snapshot.candles.map(function (candle) {
      return {
        time: Math.floor(Date.parse(candle.time) / 1000),
        open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close)
      };
    });
  }

  function snapshotIsStale(snapshot, now) {
    if (snapshot.stale === true) return true;
    const updated = Date.parse(snapshot.updated_at);
    if (!Number.isFinite(updated)) return true;
    return (now === undefined ? Date.now() : now) - updated > snapshot.freshness.stale_after_seconds * 1000;
  }

  function createCoordinator(dependencies) {
    const load = dependencies.load;
    const render = dependencies.render;
    const state = dependencies.state;
    const now = dependencies.now || Date.now;
    const requests = new Map();
    const lastKnownGood = new Map();
    let selection = 0;

    function request(timeframe) {
      if (requests.has(timeframe)) return requests.get(timeframe);
      const pending = Promise.resolve().then(function () { return load(timeframe); })
        .finally(function () { requests.delete(timeframe); });
      requests.set(timeframe, pending);
      return pending;
    }

    async function select(timeframe) {
      const selected = policy(timeframe).timeframe;
      const requestVersion = ++selection;
      state("loading", selected);
      try {
        const snapshot = await request(selected);
        if (requestVersion !== selection) return { discarded: true };
        if (snapshot.status === "unavailable" || snapshot.candle_count === 0) {
          state("empty", selected, snapshot);
          return { empty: true };
        }
        const stale = snapshotIsStale(snapshot, now());
        render(snapshot, { stale });
        lastKnownGood.set(selected, snapshot);
        state(stale ? "stale" : "ready", selected, snapshot);
        return { rendered: true };
      } catch (error) {
        if (requestVersion !== selection) return { discarded: true };
        const cached = lastKnownGood.get(selected);
        if (cached) {
          try {
            render(cached, { stale: true });
            state("stale", selected, cached);
            return { stale: true, error };
          } catch (_) {
            // Rendering failure is terminal even when valid cached data exists.
          }
        }
        state("error", selected, error);
        return { error };
      }
    }

    return { select, request, lastKnownGood };
  }

  function browserInit() {
    const rootElement = document.querySelector("[data-cp-chart]");
    if (!rootElement) return;
    const locale = rootElement.dataset.language || document.documentElement.lang;
    const copy = COPY[language(locale)];
    const canvas = rootElement.querySelector("[data-chart-canvas]");
    const selectionOutput = rootElement.querySelector("[data-chart-selection]");
    const status = rootElement.querySelector("[data-chart-status]");
    const buttons = Array.from(rootElement.querySelectorAll("[data-chart-timeframe]"));
    let chart;
    let series;
    let freshnessTimer;
    let pointerGesture;
    const selection = createSelectionModel(function (candle) {
      renderSelection(selectionOutput, candle, locale);
    });

    function palette() {
      const light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
      return light
        ? { text: "#4d5361", grid: "rgba(35, 40, 52, .08)", up: "#237b68", down: "#b4425c" }
        : { text: "#aeb5c4", grid: "rgba(255, 255, 255, .06)", up: "#4fae95", down: "#d8627a" };
    }

    function ensureChart() {
      if (chart) return;
      if (!window.LightweightCharts) throw new Error("Chart library is unavailable");
      const colors = palette();
      chart = window.LightweightCharts.createChart(canvas, {
        autoSize: true,
        height: canvas.clientHeight || 390,
        layout: { background: { type: "solid", color: "transparent" }, textColor: colors.text, attributionLogo: false },
        grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.12 } },
        timeScale: {
          borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 2,
          barSpacing: 10, minBarSpacing: 4, maxBarSpacing: 18
        },
        handleScroll: { horzTouchDrag: false, vertTouchDrag: false },
        crosshair: { mode: window.LightweightCharts.CrosshairMode.Normal },
        localization: { priceFormatter: formatAxisUsd }
      });
      series = chart.addSeries(window.LightweightCharts.CandlestickSeries, {
        upColor: colors.up, downColor: colors.down, borderVisible: false,
        wickUpColor: colors.up, wickDownColor: colors.down,
        priceFormat: { type: "price", precision: 8, minMove: 0.00000001 }
      });
      chart.subscribeCrosshairMove(function (parameter) {
        if (parameter.time !== undefined) selection.selectTime(Number(parameter.time));
      });

      function positionCrosshair(candle) {
        chart.setCrosshairPosition(Number(candle.close), Math.floor(Date.parse(candle.time) / 1000), series);
      }

      function selectAtPointer(event) {
        const bounds = canvas.getBoundingClientRect();
        const logical = chart.timeScale().coordinateToLogical(event.clientX - bounds.left);
        const index = nearestLogicalIndex(logical, selection.size());
        if (index < 0) return null;
        const candle = selection.selectIndex(index);
        positionCrosshair(candle);
        return candle;
      }

      canvas.addEventListener("pointerdown", function (event) {
        if (event.pointerType === "mouse") return;
        pointerGesture = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          axis: "pending"
        };
        selectAtPointer(event);
      });
      canvas.addEventListener("pointermove", function (event) {
        if (!pointerGesture || pointerGesture.id !== event.pointerId) return;
        if (pointerGesture.axis === "pending") {
          pointerGesture.axis = gestureAxis(
            event.clientX - pointerGesture.startX,
            event.clientY - pointerGesture.startY
          );
          if (pointerGesture.axis === "horizontal" && canvas.setPointerCapture) {
            canvas.setPointerCapture(event.pointerId);
          }
        }
        if (pointerGesture.axis !== "horizontal") return;
        if (event.cancelable) event.preventDefault();
        selectAtPointer(event);
      });
      function finishPointer(event) {
        if (!pointerGesture || pointerGesture.id !== event.pointerId) return;
        const shouldRetainCrosshair = event.type === "pointerup" && pointerGesture.axis !== "vertical";
        if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
          canvas.releasePointerCapture(event.pointerId);
        }
        pointerGesture = undefined;
        if (shouldRetainCrosshair && selection.selected()) positionCrosshair(selection.selected());
      }
      canvas.addEventListener("pointerup", finishPointer);
      canvas.addEventListener("pointercancel", finishPointer);
    }

    function render(snapshot, options) {
      ensureChart();
      series.setData(chartPoints(snapshot));
      chart.timeScale().fitContent();
      selection.setCandles(snapshot.candles);
      rootElement.classList.toggle("is-stale", options.stale);
      window.clearTimeout(freshnessTimer);
      if (!options.stale) {
        const staleAt = Date.parse(snapshot.updated_at) + snapshot.freshness.stale_after_seconds * 1000;
        freshnessTimer = window.setTimeout(function () {
          rootElement.classList.add("is-stale");
          renderState("stale", snapshot.timeframe, snapshot);
        }, Math.max(0, staleAt - Date.now() + 1));
      }
    }

    function renderState(name, selected, detail) {
      rootElement.dataset.state = name;
      if (name === "loading") window.clearTimeout(freshnessTimer);
      if (name === "loading" && series) series.setData([]);
      if (name === "loading") selectionOutput.hidden = true;
      buttons.forEach(function (button) {
        const active = button.dataset.chartTimeframe === selected;
        button.setAttribute("aria-selected", String(active));
        button.tabIndex = active ? 0 : -1;
      });
      if (name === "loading") status.textContent = copy.loading;
      else if (name === "empty") status.textContent = copy.empty;
      else if (name === "error") status.textContent = copy.error;
      else if (name === "stale") status.textContent = copy.stale;
      else status.textContent = detail && detail.partial_history ? copy.partial : copy.fresh;
      status.hidden = name === "ready";
    }

    const coordinator = createCoordinator({
      load: function (timeframe) { return fetchSnapshot(timeframe); }, render, state: renderState
    });
    buttons.forEach(function (button, index) {
      button.addEventListener("click", function () { coordinator.select(button.dataset.chartTimeframe); });
      button.addEventListener("keydown", function (event) {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        let target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[target].focus();
        buttons[target].click();
      });
    });
    coordinator.select("1Y");
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", browserInit);
    else browserInit();
  }

  return {
    TIMEFRAMES, MAX_RESPONSE_BYTES, ENDPOINT_BASE, COPY,
    endpointFor, validateSnapshot, fetchSnapshot, formatUsd, formatAxisUsd, compareDecimals,
    tooltipText, chartPoints, snapshotIsStale, createCoordinator, renderSelection,
    nearestCandleIndex, nearestLogicalIndex, gestureAxis, createSelectionModel
  };
});
