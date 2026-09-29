(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.CpMarketData = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CONFIG = Object.freeze({
    rpcUrl: "https://base-rpc.publicnode.com",
    cp: "0x934ef4bfffdce191ac4bcc351b2fe7892865b440",
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    weth: "0x4200000000000000000000000000000000000006",
    v3Pool: "0x962265593a7f6f5f0804b6a3ed203aa5d2e0d1e9",
    v3Factory: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
    v3Fee: 10000n,
    v3TickSpacing: 200n,
    v3Fee500Pool: "0x2ddcc7c2cc6ddf1e4f91894d4862c370827ed1a1",
    v3Fee500: 500n,
    v3Fee500TickSpacing: 10n,
    v2Pool: "0xa290c53cc25f0b857d21421b2f757f9a3434f80e",
    v2Factory: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6",
    cpDecimals: 18,
    usdcDecimals: 6,
    wethDecimals: 18
  });

  const SELECTOR = Object.freeze({
    token0: "0x0dfe1681",
    token1: "0xd21220a7",
    factory: "0xc45a0155",
    fee: "0xddca3f43",
    tickSpacing: "0xd0c93a7c",
    slot0: "0x3850c7bd",
    getReserves: "0x0902f1ac",
    balanceOf: "0x70a08231"
  });

  const CACHE_KEY = "cypress.cp-market-data.v3";
  const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
  const Q192 = 2n ** 192n;

  function assertHex(value, label) {
    if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
      throw new Error(label + " returned malformed data");
    }
    return value.slice(2);
  }

  function words(value, minimum, label) {
    const hex = assertHex(value, label);
    if (hex.length < minimum * 64 || hex.length % 64 !== 0) {
      throw new Error(label + " returned the wrong data length");
    }
    return Array.from({ length: hex.length / 64 }, (_, index) =>
      hex.slice(index * 64, (index + 1) * 64)
    );
  }

  function decodeAddress(value, label) {
    const first = words(value, 1, label)[0];
    return "0x" + first.slice(24).toLowerCase();
  }

  function decodeUint(value, label, index) {
    const wordIndex = index || 0;
    const allWords = words(value, wordIndex + 1, label);
    return BigInt("0x" + allWords[wordIndex]);
  }

  function balanceOfData(account) {
    return SELECTOR.balanceOf + account.toLowerCase().slice(2).padStart(64, "0");
  }

  function normalized(raw, decimals) {
    if (typeof raw !== "bigint" || raw < 0n) throw new Error("Invalid token amount");
    return Number(raw) / (10 ** decimals);
  }

  function ratioToNumber(numerator, denominator, precision) {
    if (numerator <= 0n || denominator <= 0n) throw new Error("Invalid price ratio");
    const scale = 10n ** BigInt(precision || 18);
    return Number((numerator * scale) / denominator) / Number(scale);
  }

  function cpPriceFromSqrtPriceX96(sqrtPriceX96) {
    if (typeof sqrtPriceX96 !== "bigint" || sqrtPriceX96 <= 0n) {
      throw new Error("V3 price is unavailable");
    }
    // token0 is 6-decimal USDC and token1 is 18-decimal CP. slot0 stores
    // sqrt(raw token1 / raw token0) * 2^96, so invert and adjust by 10^12.
    return ratioToNumber(
      Q192 * (10n ** BigInt(CONFIG.cpDecimals - CONFIG.usdcDecimals)),
      sqrtPriceX96 * sqrtPriceX96
    );
  }

  function requireAddress(actual, expected, label) {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(label + " identity mismatch");
    }
  }

  function deriveMarketData(state, fetchedAt) {
    requireAddress(state.v3.token0, CONFIG.usdc, "V3 token0");
    requireAddress(state.v3.token1, CONFIG.cp, "V3 token1");
    requireAddress(state.v3.factory, CONFIG.v3Factory, "V3 factory");
    requireAddress(state.v3Fee500.token0, CONFIG.usdc, "V3 0.05% token0");
    requireAddress(state.v3Fee500.token1, CONFIG.cp, "V3 0.05% token1");
    requireAddress(state.v3Fee500.factory, CONFIG.v3Factory, "V3 0.05% factory");
    requireAddress(state.v2.token0, CONFIG.weth, "V2 token0");
    requireAddress(state.v2.token1, CONFIG.cp, "V2 token1");
    requireAddress(state.v2.factory, CONFIG.v2Factory, "V2 factory");

    if (state.v3.fee !== CONFIG.v3Fee) throw new Error("V3 fee identity mismatch");
    if (state.v3.tickSpacing !== CONFIG.v3TickSpacing) {
      throw new Error("V3 tick spacing identity mismatch");
    }
    if (state.v3Fee500.fee !== CONFIG.v3Fee500) {
      throw new Error("V3 0.05% fee identity mismatch");
    }
    if (state.v3Fee500.tickSpacing !== CONFIG.v3Fee500TickSpacing) {
      throw new Error("V3 0.05% tick spacing identity mismatch");
    }
    if (typeof state.v3.sqrtPriceX96 !== "bigint" || state.v3.sqrtPriceX96 <= 0n) {
      throw new Error("V3 fallback price is unavailable");
    }
    if (state.v3.usdcBalance <= 0n || state.v3.cpBalance <= 0n) {
      throw new Error("V3 token balances are unavailable");
    }
    if (state.v3Fee500.usdcBalance <= 0n || state.v3Fee500.cpBalance <= 0n) {
      throw new Error("V3 0.05% token balances are unavailable");
    }
    if (state.v2.reserveWeth <= 0n || state.v2.reserveCp <= 0n) {
      throw new Error("V2 reserves are unavailable");
    }

    const preferredPriceUsable = typeof state.v3Fee500.sqrtPriceX96 === "bigint"
      && state.v3Fee500.sqrtPriceX96 > 0n;
    const cpPriceSourcePool = preferredPriceUsable ? CONFIG.v3Fee500Pool : CONFIG.v3Pool;
    const cpPriceSourceFee = preferredPriceUsable ? Number(CONFIG.v3Fee500) : Number(CONFIG.v3Fee);
    const cpPriceUsd = cpPriceFromSqrtPriceX96(
      preferredPriceUsable ? state.v3Fee500.sqrtPriceX96 : state.v3.sqrtPriceX96
    );
    const v3Usdc = normalized(state.v3.usdcBalance, CONFIG.usdcDecimals);
    const v3Cp = normalized(state.v3.cpBalance, CONFIG.cpDecimals);
    const v3Fee500Usdc = normalized(state.v3Fee500.usdcBalance, CONFIG.usdcDecimals);
    const v3Fee500Cp = normalized(state.v3Fee500.cpBalance, CONFIG.cpDecimals);
    const v2Weth = normalized(state.v2.reserveWeth, CONFIG.wethDecimals);
    const v2Cp = normalized(state.v2.reserveCp, CONFIG.cpDecimals);

    // CP/USDC is the sole USD price reference. The V2 reserve ratio converts
    // that price to an implied WETH/USD value so both actual reserve sides are
    // valued without adding another price provider.
    const impliedWethUsd = (v2Cp * cpPriceUsd) / v2Weth;
    const v3LiquidityUsd = v3Usdc + (v3Cp * cpPriceUsd);
    const v3Fee500LiquidityUsd = v3Fee500Usdc + (v3Fee500Cp * cpPriceUsd);
    const v2LiquidityUsd = (v2Weth * impliedWethUsd) + (v2Cp * cpPriceUsd);
    const totalLiquidityUsd = v3LiquidityUsd + v2LiquidityUsd + v3Fee500LiquidityUsd;

    for (const [label, value] of Object.entries({
      cpPriceUsd,
      impliedWethUsd,
      v3LiquidityUsd,
      v3Fee500LiquidityUsd,
      v2LiquidityUsd,
      totalLiquidityUsd
    })) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(label + " is invalid");
    }

    return {
      cpPriceUsd,
      cpPriceSourcePool,
      cpPriceSourceFee,
      totalLiquidityUsd,
      v3LiquidityUsd,
      v3Fee500LiquidityUsd,
      v2LiquidityUsd,
      liquidityPoolCount: 3,
      impliedWethUsd,
      blockNumber: state.blockNumber,
      fetchedAt: fetchedAt || Date.now()
    };
  }

  async function rpcRequest(url, payload, options) {
    const settings = options || {};
    const fetchImpl = settings.fetchImpl || fetch;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, settings.timeoutMs || 8000);

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) throw new Error("Base RPC returned HTTP " + response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function resultById(response, id) {
    const entries = Array.isArray(response) ? response : [response];
    const entry = entries.find(function (candidate) { return candidate && candidate.id === id; });
    if (!entry || entry.error || typeof entry.result !== "string") {
      throw new Error("Base RPC call " + id + " failed");
    }
    return entry.result;
  }

  function optionalUintById(response, id, label) {
    const entries = Array.isArray(response) ? response : [response];
    const entry = entries.find(function (candidate) { return candidate && candidate.id === id; });
    if (!entry || entry.error || typeof entry.result !== "string") return null;
    try {
      return decodeUint(entry.result, label);
    } catch (_) {
      return null;
    }
  }

  function call(id, to, data, block) {
    return { jsonrpc: "2.0", id, method: "eth_call", params: [{ to, data }, block] };
  }

  async function readMarketData(options) {
    const settings = options || {};
    const url = settings.rpcUrl || CONFIG.rpcUrl;
    const requestOptions = { fetchImpl: settings.fetchImpl, timeoutMs: settings.timeoutMs };
    const blockResponse = await rpcRequest(url, {
      jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: []
    }, requestOptions);
    const block = resultById(blockResponse, 1);
    if (!/^0x[0-9a-f]+$/i.test(block)) throw new Error("Base RPC returned an invalid block");

    const identityAndState = await rpcRequest(url, [
      call(2, CONFIG.v3Pool, SELECTOR.token0, block),
      call(3, CONFIG.v3Pool, SELECTOR.token1, block),
      call(4, CONFIG.v3Pool, SELECTOR.factory, block),
      call(5, CONFIG.v3Pool, SELECTOR.fee, block),
      call(6, CONFIG.v3Pool, SELECTOR.tickSpacing, block),
      call(7, CONFIG.v3Pool, SELECTOR.slot0, block),
      call(8, CONFIG.v2Pool, SELECTOR.token0, block),
      call(9, CONFIG.v2Pool, SELECTOR.token1, block),
      call(10, CONFIG.v2Pool, SELECTOR.factory, block),
      call(11, CONFIG.v2Pool, SELECTOR.getReserves, block),
      call(14, CONFIG.v3Fee500Pool, SELECTOR.token0, block),
      call(15, CONFIG.v3Fee500Pool, SELECTOR.token1, block),
      call(16, CONFIG.v3Fee500Pool, SELECTOR.factory, block),
      call(17, CONFIG.v3Fee500Pool, SELECTOR.fee, block),
      call(18, CONFIG.v3Fee500Pool, SELECTOR.tickSpacing, block),
      call(21, CONFIG.v3Fee500Pool, SELECTOR.slot0, block)
    ], requestOptions);
    const balances = await rpcRequest(url, [
      call(12, CONFIG.usdc, balanceOfData(CONFIG.v3Pool), block),
      call(13, CONFIG.cp, balanceOfData(CONFIG.v3Pool), block),
      call(19, CONFIG.usdc, balanceOfData(CONFIG.v3Fee500Pool), block),
      call(20, CONFIG.cp, balanceOfData(CONFIG.v3Fee500Pool), block)
    ], requestOptions);

    const state = {
      blockNumber: Number(BigInt(block)),
      v3: {
        token0: decodeAddress(resultById(identityAndState, 2), "V3 token0"),
        token1: decodeAddress(resultById(identityAndState, 3), "V3 token1"),
        factory: decodeAddress(resultById(identityAndState, 4), "V3 factory"),
        fee: decodeUint(resultById(identityAndState, 5), "V3 fee"),
        tickSpacing: decodeUint(resultById(identityAndState, 6), "V3 tick spacing"),
        sqrtPriceX96: decodeUint(resultById(identityAndState, 7), "V3 slot0"),
        usdcBalance: decodeUint(resultById(balances, 12), "V3 USDC balance"),
        cpBalance: decodeUint(resultById(balances, 13), "V3 CP balance")
      },
      v2: {
        token0: decodeAddress(resultById(identityAndState, 8), "V2 token0"),
        token1: decodeAddress(resultById(identityAndState, 9), "V2 token1"),
        factory: decodeAddress(resultById(identityAndState, 10), "V2 factory"),
        reserveWeth: decodeUint(resultById(identityAndState, 11), "V2 reserves", 0),
        reserveCp: decodeUint(resultById(identityAndState, 11), "V2 reserves", 1)
      },
      v3Fee500: {
        token0: decodeAddress(resultById(identityAndState, 14), "V3 0.05% token0"),
        token1: decodeAddress(resultById(identityAndState, 15), "V3 0.05% token1"),
        factory: decodeAddress(resultById(identityAndState, 16), "V3 0.05% factory"),
        fee: decodeUint(resultById(identityAndState, 17), "V3 0.05% fee"),
        tickSpacing: decodeUint(resultById(identityAndState, 18), "V3 0.05% tick spacing"),
        sqrtPriceX96: optionalUintById(identityAndState, 21, "V3 0.05% slot0"),
        usdcBalance: decodeUint(resultById(balances, 19), "V3 0.05% USDC balance"),
        cpBalance: decodeUint(resultById(balances, 20), "V3 0.05% CP balance")
      }
    };

    return deriveMarketData(state, settings.now ? settings.now() : Date.now());
  }

  function writeCache(storage, data) {
    try {
      storage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (_) {
      // Fresh data remains usable when browser storage is disabled or full.
    }
  }

  function readCache(storage, now, maxAgeMs) {
    try {
      const parsed = JSON.parse(storage.getItem(CACHE_KEY));
      const age = (now || Date.now()) - parsed.fetchedAt;
      if (age < 0 || age > (maxAgeMs || MAX_CACHE_AGE_MS)) return null;
      if (!Number.isFinite(parsed.cpPriceUsd) || parsed.cpPriceUsd <= 0 ||
          !Number.isFinite(parsed.totalLiquidityUsd) || parsed.totalLiquidityUsd <= 0 ||
          !Number.isFinite(parsed.v3LiquidityUsd) || parsed.v3LiquidityUsd <= 0 ||
          !Number.isFinite(parsed.v2LiquidityUsd) || parsed.v2LiquidityUsd <= 0 ||
          !Number.isFinite(parsed.v3Fee500LiquidityUsd) || parsed.v3Fee500LiquidityUsd <= 0 ||
          ![CONFIG.v3Fee500Pool, CONFIG.v3Pool].includes(parsed.cpPriceSourcePool) ||
          ![Number(CONFIG.v3Fee500), Number(CONFIG.v3Fee)].includes(parsed.cpPriceSourceFee) ||
          (parsed.cpPriceSourcePool === CONFIG.v3Fee500Pool && parsed.cpPriceSourceFee !== Number(CONFIG.v3Fee500)) ||
          (parsed.cpPriceSourcePool === CONFIG.v3Pool && parsed.cpPriceSourceFee !== Number(CONFIG.v3Fee)) ||
          parsed.liquidityPoolCount !== 3 ||
          !Number.isInteger(parsed.blockNumber)) return null;
      const poolSum = parsed.v3LiquidityUsd + parsed.v2LiquidityUsd + parsed.v3Fee500LiquidityUsd;
      if (Math.abs(parsed.totalLiquidityUsd - poolSum) > parsed.totalLiquidityUsd * 1e-12) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function statusText(language, state, fetchedAt, now) {
    const vi = String(language || "").toLowerCase().startsWith("vi");
    if (state === "unavailable") {
      return vi ? "Dữ liệu thị trường tạm thời không khả dụng." : "Market data temporarily unavailable.";
    }
    const minutes = Math.max(0, Math.floor(((now || Date.now()) - fetchedAt) / 60000));
    if (state === "stale") {
      return vi ? "Đang dùng dữ liệu thị trường gần nhất · Cập nhật lần cuối " + minutes + " phút trước" :
        "Using last-known market data · Last updated " + minutes + " min ago";
    }
    return vi ? "Tổng hợp từ các pool Uniswap trên Base · vừa cập nhật" :
      "Aggregated from Uniswap pools on Base · updated just now";
  }

  return {
    CACHE_KEY,
    CONFIG,
    MAX_CACHE_AGE_MS,
    deriveMarketData,
    cpPriceFromSqrtPriceX96,
    readCache,
    readMarketData,
    rpcRequest,
    statusText,
    writeCache
  };
});
