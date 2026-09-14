#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { buildPricePathDataset } from "./price-path.mjs";

function argument(name) {
  const index = process.argv.indexOf("--" + name);
  if (index === -1 || !process.argv[index + 1]) throw new Error("--" + name + " is required");
  return process.argv[index + 1];
}

function optionalArgument(name) {
  const index = process.argv.indexOf("--" + name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonLines(file) {
  const content = fs.readFileSync(file, "utf8").trim();
  return content ? content.split("\n").map(line => JSON.parse(line)) : [];
}

function currentFromPreviousDataset(file) {
  const previous = readJson(file);
  if (previous.schemaVersion !== 1 || previous.kind !== "cypress-hold-vs-rebalanced-lp-price-path") {
    throw new Error("--current-price-path must be an approved schema-v1 comparison dataset");
  }
  const observations = previous.points.filter(point => point.observed === true
    && point.source?.provider === "geckoterminal").map(point => ({
    continuity_id: "cypress-cp",
    source: "geckoterminal",
    source_kind: "real_ohlcv",
    source_asset_id: previous.identity.baseAsset.address,
    network: "base",
    pool: previous.identity.pool,
    interval_start: point.source.intervalStart,
    interval_end: point.source.intervalEnd,
    close_usd: point.priceUsd.raw,
    source_stream_version: point.source.sourceStreamVersion,
    raw_record_hash: point.source.rawRecordHash,
    quality: point.source.quality,
    finalized: true
  }));
  return {
    metadata: {
      source: "geckoterminal",
      pool: previous.identity.pool,
      generation_id: previous.sourceVersions.currentGenerationId,
      source_stream_version: previous.sourceVersions.currentSourceStreamVersion,
      finalized_observation_count: previous.coverage.sourceFinalizedSwapHourObservations
    },
    observations
  };
}

const output = path.resolve(argument("output"));
const previousDataset = optionalArgument("current-price-path");
const current = previousDataset ? currentFromPreviousDataset(previousDataset) : {
  metadata: readJson(argument("current-metadata")),
  observations: readJsonLines(argument("current-observations"))
};
const dataset = buildPricePathDataset({
  generatedAt: argument("generated-at"),
  historical: {
    metadata: readJson(argument("historical-metadata")),
    observations: readJsonLines(argument("historical-observations")),
    auditRecords: readJsonLines(argument("historical-audit"))
  },
  current,
  lpHistory: readJson(argument("lp-history"))
});

fs.mkdirSync(path.dirname(output), { recursive: true });
const temporary = output + "." + process.pid + ".tmp";
fs.writeFileSync(temporary, JSON.stringify(dataset, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
fs.renameSync(temporary, output);
process.stdout.write(JSON.stringify({ output, coverage: dataset.coverage, sourceVersions: dataset.sourceVersions }, null, 2) + "\n");
