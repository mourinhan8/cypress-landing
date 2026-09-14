#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRpcClient,
  parseBlock,
  resolveFinalizedBlockAtOrBefore
} from "../lp/historical-state.mjs";

const POOL = "0x962265593a7f6f5f0804b6a3ed203aa5d2e0d1e9";
const TOKEN0 = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TOKEN1 = "0x934ef4bfffdce191ac4bcc351b2fe7892865b440";
const INITIALIZATION = "2026-09-06T05:36:17.000Z";
const INITIALIZATION_BLOCK = 50_941_815n;
const Q192 = 1n << 192n;
const SET_FEE_PROTOCOL_TOPIC = "0x973d8d92bb299f4af6ce49b52a8adb85ae46b9f214c4c4fc06ac77401237b133";
const SLOT0_SELECTOR = "0x3850c7bd";
const BALANCE_OF_SELECTOR = "0x70a08231";
const MAX_POINTS = 200;
const MAX_LOG_RANGE = 10_000n;
const ACQUISITION_CONCURRENCY = 4;

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function rational(numerator, denominator = 1n) {
  if (denominator <= 0n) throw new Error("invalid rational denominator");
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function add(left, right) {
  return rational(left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator);
}

function multiply(left, right) {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function decimal(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(label + " is invalid");
  const [integer, fraction = ""] = value.split(".");
  return rational(BigInt(integer + fraction), 10n ** BigInt(fraction.length));
}

function serialized(input) {
  return { numerator: input.numerator.toString(), denominator: input.denominator.toString() };
}

function canonicalTimestamp(value, label) {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error(label + " must be canonical UTC");
  return milliseconds;
}

function blockHex(value) {
  return "0x" + value.toString(16);
}

function uintResult(value, label, index = 0) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value) || (value.length - 2) % 64 !== 0) {
    throw new Error(label + " result is malformed");
  }
  const words = value.slice(2).match(/.{64}/g) || [];
  if (words.length <= index) throw new Error(label + " result is incomplete");
  return BigInt("0x" + words[index]);
}

function balanceCallData(account) {
  return BALANCE_OF_SELECTOR + account.slice(2).padStart(64, "0");
}

function priceFromSqrt(sqrtPriceX96) {
  return rational(Q192 * 10n ** 12n, sqrtPriceX96 * sqrtPriceX96);
}

function calculateTvl(balance0, balance1, sqrtPriceX96) {
  const usdc = rational(balance0, 10n ** 6n);
  const cp = rational(balance1, 10n ** 18n);
  return add(usdc, multiply(cp, priceFromSqrt(sqrtPriceX96)));
}

export function hourlyBoundaries(startTimestamp, endTimestamp) {
  const startMs = canonicalTimestamp(startTimestamp, "window start");
  const endMs = canonicalTimestamp(endTimestamp, "window end");
  if (endMs <= startMs) throw new Error("window end must follow start");
  const output = [startTimestamp];
  let current = Math.ceil(startMs / 3_600_000) * 3_600_000;
  while (current < endMs) {
    output.push(new Date(current).toISOString());
    if (output.length >= MAX_POINTS) throw new Error("reference-fee window exceeds bounded point count");
    current += 3_600_000;
  }
  output.push(endTimestamp);
  return [...new Set(output)];
}

async function mapWithConcurrency(values, concurrency, operation) {
  const output = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      output[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

async function getBlock(client, number) {
  return parseBlock(await client.request("eth_getBlockByNumber", [blockHex(number), false]), "hourly block");
}

async function resolveHourlyBlock(client, targetTimestamp, initializationBlock, latestBlock) {
  const targetSeconds = BigInt(Math.floor(canonicalTimestamp(targetTimestamp, "hourly target") / 1000));
  const initializationSeconds = initializationBlock.timestampSeconds;
  let estimate = initializationBlock.number + (targetSeconds - initializationSeconds) / 2n;
  if (estimate > latestBlock.number) estimate = latestBlock.number;
  if (estimate < initializationBlock.number) estimate = initializationBlock.number;
  const candidate = await getBlock(client, estimate);
  const next = candidate.number < latestBlock.number ? await getBlock(client, candidate.number + 1n) : null;
  if (candidate.timestampSeconds <= targetSeconds && (!next || next.timestampSeconds > targetSeconds)) return candidate;
  return resolveFinalizedBlockAtOrBefore(client, targetTimestamp);
}

async function pinnedPoolMetrics(client, block) {
  const tag = blockHex(block.number);
  const balance0Result = await client.request("eth_call", [{ to: TOKEN0, data: balanceCallData(POOL) }, tag]);
  const balance1Result = await client.request("eth_call", [{ to: TOKEN1, data: balanceCallData(POOL) }, tag]);
  const slot0Result = await client.request("eth_call", [{ to: POOL, data: SLOT0_SELECTOR }, tag]);
  const balance0 = uintResult(balance0Result, "token0 balance");
  const balance1 = uintResult(balance1Result, "token1 balance");
  const sqrtPriceX96 = uintResult(slot0Result, "slot0", 0);
  const encodedProtocolFee = Number(uintResult(slot0Result, "slot0", 5));
  if (sqrtPriceX96 === 0n || encodedProtocolFee < 0 || encodedProtocolFee > 255) throw new Error("pool metrics are invalid");
  return {
    blockNumber: block.numberString,
    blockHash: block.hash,
    timestamp: block.timestamp,
    token0BalanceRaw: balance0.toString(),
    token1BalanceRaw: balance1.toString(),
    sqrtPriceX96: sqrtPriceX96.toString(),
    tvlUsd: serialized(calculateTvl(balance0, balance1, sqrtPriceX96)),
    feeProtocolEncoded: encodedProtocolFee,
    token0ProtocolFeeDenominator: encodedProtocolFee & 0x0f,
    token1ProtocolFeeDenominator: encodedProtocolFee >> 4
  };
}

async function poolLogs(client, startBlock, endBlock) {
  const logs = [];
  for (let from = startBlock; from <= endBlock; from += MAX_LOG_RANGE) {
    const through = from + MAX_LOG_RANGE - 1n < endBlock ? from + MAX_LOG_RANGE - 1n : endBlock;
    const page = await client.request("eth_getLogs", [{
      address: POOL,
      fromBlock: blockHex(from),
      toBlock: blockHex(through)
    }]);
    if (!Array.isArray(page)) throw new Error("pool log response is invalid");
    logs.push(...page);
  }
  for (const log of logs) if (log.removed === true || log.address?.toLowerCase() !== POOL) {
    throw new Error("pool log identity mismatch");
  }
  return logs;
}

function protocolFeeEvents(logs, blocks) {
  const events = [];
  for (const log of logs.filter(item => item.topics?.[0]?.toLowerCase() === SET_FEE_PROTOCOL_TOPIC)) {
    if (log.topics.length !== 1) throw new Error("protocol-fee event identity mismatch");
    const block = blocks.get(BigInt(log.blockNumber).toString());
    if (!block) throw new Error("protocol-fee event block is missing");
    events.push({
      blockNumber: block.numberString,
      blockHash: block.hash,
      timestamp: block.timestamp,
      transactionHash: log.transactionHash,
      logIndex: String(BigInt(log.logIndex)),
      token0OldDenominator: Number(uintResult(log.data, "SetFeeProtocol", 0)),
      token1OldDenominator: Number(uintResult(log.data, "SetFeeProtocol", 1)),
      token0NewDenominator: Number(uintResult(log.data, "SetFeeProtocol", 2)),
      token1NewDenominator: Number(uintResult(log.data, "SetFeeProtocol", 3))
    });
  }
  return events.sort((left, right) => Number(BigInt(left.blockNumber) - BigInt(right.blockNumber)) || Number(BigInt(left.logIndex) - BigInt(right.logIndex)));
}

function boundarySnapshot(boundaryBlock, state) {
  return {
    ...state,
    blockNumber: boundaryBlock.numberString,
    blockHash: boundaryBlock.hash,
    timestamp: boundaryBlock.timestamp,
    stateSourceBlockNumber: state.blockNumber,
    stateSourceBlockHash: state.blockHash,
    stateSourceTimestamp: state.timestamp,
    carriedForwardNoPoolEvents: state.blockNumber !== boundaryBlock.numberString
  };
}

function protocolSegments(startTimestamp, endTimestamp, firstSnapshot, events) {
  const segments = [];
  let cursor = startTimestamp;
  let token0 = firstSnapshot.token0ProtocolFeeDenominator;
  let token1 = firstSnapshot.token1ProtocolFeeDenominator;
  for (const event of events) {
    if (event.token0OldDenominator !== token0 || event.token1OldDenominator !== token1) {
      throw new Error("protocol-fee event continuity mismatch");
    }
    if (Date.parse(event.timestamp) > Date.parse(cursor)) {
      segments.push({ startTimestamp: cursor, endTimestamp: event.timestamp, token0Denominator: token0, token1Denominator: token1 });
    }
    cursor = event.timestamp;
    token0 = event.token0NewDenominator;
    token1 = event.token1NewDenominator;
  }
  segments.push({ startTimestamp: cursor, endTimestamp, token0Denominator: token0, token1Denominator: token1 });
  return segments;
}

function normalizedVolume(observations, startTimestamp, endTimestamp) {
  const startMs = Date.parse(startTimestamp);
  const endMs = Date.parse(endTimestamp);
  return observations.filter(observation => observation.finalized === true
      && Date.parse(observation.interval_start) >= startMs && Date.parse(observation.interval_end) <= endMs)
    .sort((left, right) => Date.parse(left.interval_start) - Date.parse(right.interval_start))
    .map(observation => {
      if (observation.source !== "geckoterminal" || observation.pool?.toLowerCase() !== POOL
          || observation.source_kind !== "real_ohlcv" || observation.quality !== "real_ohlcv") {
        throw new Error("volume observation identity mismatch");
      }
      const volume = decimal(observation.volume_usd ?? "0", "volume_usd");
      return {
        startTimestamp: observation.interval_start,
        endTimestamp: observation.interval_end,
        volumeUsd: serialized(volume),
        finalized: true,
        rawRecordHash: observation.raw_record_hash
      };
    });
}

export async function collectReferenceFeeWindow({ client, volumeMetadata, volumeObservations, generatedAt }) {
  canonicalTimestamp(generatedAt, "generatedAt");
  if (volumeMetadata?.source !== "geckoterminal" || volumeMetadata.pool?.toLowerCase() !== POOL
      || !Array.isArray(volumeObservations)) throw new Error("volume source contract mismatch");
  const coverageEnd = volumeMetadata.finalized_before;
  canonicalTimestamp(coverageEnd, "volume finalized_before");
  const latestBlock = await resolveFinalizedBlockAtOrBefore(client, coverageEnd);
  const endTimestamp = latestBlock.timestamp;
  const sevenDaysBefore = Date.parse(endTimestamp) - 7 * 86_400_000;
  const startTimestamp = new Date(Math.max(Date.parse(INITIALIZATION), sevenDaysBefore)).toISOString();
  const initializationBlock = parseBlock({
    number: blockHex(INITIALIZATION_BLOCK),
    hash: "0x748bf3c1a7db6485324676b7480bee436a226c2cf12e20f7c62c3f8a7d7f6918",
    timestamp: blockHex(BigInt(Date.parse(INITIALIZATION) / 1000))
  }, "pool initialization block");
  const startBlock = startTimestamp === INITIALIZATION ? initializationBlock
    : await resolveFinalizedBlockAtOrBefore(client, startTimestamp);
  const logs = await poolLogs(client, startBlock.number + 1n, latestBlock.number);
  const stateBlockNumbers = [...new Set([
    startBlock.numberString,
    ...logs.map(log => BigInt(log.blockNumber).toString()),
    latestBlock.numberString
  ])].map(BigInt).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const blocks = new Map([[startBlock.numberString, startBlock], [latestBlock.numberString, latestBlock]]);
  const states = new Map();
  for (const number of stateBlockNumbers) {
    const block = blocks.get(number.toString()) || await getBlock(client, number);
    blocks.set(number.toString(), block);
    states.set(number.toString(), await pinnedPoolMetrics(client, block));
  }
  const boundaries = hourlyBoundaries(startTimestamp, endTimestamp);
  const boundaryBlocks = await mapWithConcurrency(boundaries, ACQUISITION_CONCURRENCY, async boundary => {
    const block = boundary === endTimestamp ? latestBlock
      : await resolveHourlyBlock(client, boundary, initializationBlock, latestBlock);
    blocks.set(block.numberString, block);
    return block;
  });
  const snapshots = boundaryBlocks.map(block => {
    const sourceBlock = [...stateBlockNumbers].reverse().find(number => number <= block.number);
    return boundarySnapshot(block, states.get(sourceBlock.toString()));
  });
  const events = protocolFeeEvents(logs, blocks);
  const segments = protocolSegments(startTimestamp, endTimestamp, snapshots[0], events);
  const content = {
    schemaVersion: 1,
    kind: "cypress-reference-fee-window",
    generatedAt,
    identity: {
      chainId: 8453, pool: POOL, token0: TOKEN0, token1: TOKEN1,
      feeTier: "10000", feeTierFraction: { numerator: "1", denominator: "100" }
    },
    window: {
      requestedDays: 7,
      initializationTimestamp: INITIALIZATION,
      startTimestamp,
      endTimestamp,
      partial: Date.parse(endTimestamp) - Date.parse(startTimestamp) < 7 * 86_400_000,
      latestFinalizedBlock: { blockNumber: latestBlock.numberString, blockHash: latestBlock.hash, timestamp: latestBlock.timestamp }
    },
    volume: {
      source: "geckoterminal",
      generationId: volumeMetadata.generation_id,
      sourceStreamVersion: volumeMetadata.source_stream_version,
      coverageStart: startTimestamp,
      coverageEnd: volumeMetadata.finalized_before,
      sparseIntervalsMeanZeroVolume: true,
      intervals: normalizedVolume(volumeObservations, startTimestamp, endTimestamp)
    },
    tvl: {
      method: "hourly_block_pinned_balances_trapezoidal",
      tokenBalanceMethod: "ERC20_balanceOf_pool_at_pinned_block",
      priceMethod: "exact_pool_sqrtPriceX96_USDC_equals_USD",
      carryForwardProof: "all pool logs scanned; state carried only across boundaries with no intervening pool event",
      snapshots
    },
    protocolFee: {
      eventTopic: SET_FEE_PROTOCOL_TOPIC,
      historyVerified: true,
      fromBlock: (BigInt(snapshots[0].blockNumber) + 1n).toString(),
      throughBlock: latestBlock.numberString,
      events,
      segments
    }
  };
  const digest = crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return { ...content, cacheVersion: "schema1-" + digest.slice(0, 16) };
}

function readJsonLines(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  return text ? text.split("\n").map(line => JSON.parse(line)) : [];
}

export async function runCollectorCli(argv, dependencies = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) options[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  for (const name of ["volume-metadata", "volume-observations", "output", "generated-at"]) {
    if (!options[name]) throw new Error("--" + name + " is required");
  }
  const client = dependencies.client || createRpcClient({ rpcUrl: dependencies.rpcUrl || process.env.LP_BASE_RPC_URL,
    timeoutMs: 12_000, maxAttempts: 5 });
  const cache = await collectReferenceFeeWindow({
    client,
    volumeMetadata: JSON.parse(fs.readFileSync(options["volume-metadata"], "utf8")),
    volumeObservations: readJsonLines(options["volume-observations"]),
    generatedAt: options["generated-at"]
  });
  const output = path.resolve(options.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = output + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(cache, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
  fs.renameSync(temporary, output);
  return { output, cacheVersion: cache.cacheVersion, window: cache.window, snapshots: cache.tvl.snapshots.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runCollectorCli(process.argv.slice(2)).then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}).catch(error => {
  process.stderr.write("Reference fee collection failed: " + error.message + "\n");
  process.exitCode = 1;
});
