# LP historical population and dataset (B3)

B3 is a local, manually invoked workflow. It does not expose an HTTP route,
schedule work, run in a browser, or write production data.

The existing chart collector already runs hourly and requests sparse hourly
GeckoTerminal candles with `include_empty_intervals=false`. It remains unchanged.
Those timestamps may later help identify useful cache boundaries, but candle
prices are never converted into V3 state. The LP workflow asks B2 for exact
block-pinned `sqrtPriceX96` only when a required boundary is absent from its
separate cache. A no-swap boundary naturally returns the unchanged on-chain
`slot0`; B3 does not manufacture an empty candle or a synthetic price.

## Population command

Explicit timestamps:

```sh
npm run lp:populate-history -- \
  --timestamp 2026-09-06T05:36:17.000Z \
  --timestamp 2026-09-09T01:54:19.000Z \
  --cache .cache/lp/historical-states-v1.json \
  --export .cache/lp/lp-dataset-v1.json
```

Bounded UTC date sampling:

```sh
npm run lp:populate-history -- \
  --start-date 2026-09-06 \
  --end-date 2026-09-09 \
  --interval-seconds 86400 \
  --max-points 10 \
  --cache .cache/lp/historical-states-v1.json \
  --export .cache/lp/lp-dataset-v1.json
```

`--end latest` resolves the command's current UTC time through B2 and therefore
selects no block newer than the provider's finalized head. A private provider
may be supplied server-side as `LP_BASE_RPC_URL`; the URL is never copied into
the cache or export.

The command accepts at most 400 unique timestamps, processes exactly one at a
time, checks the cache first, and writes every successful snapshot immediately.
It reports `acquired`, `reused`, `unavailable`, and `failed` results. If a later
request fails, earlier cache entries remain valid and rerunning safely reuses
them. A nonzero failed/unavailable count gives the CLI a nonzero exit status.

## Dataset contract

The version-1 `cypress-lp-principal-history` JSON contract contains:

- exact Base chain, pool, factory, tokens, decimals, fee, spacing, and range;
- pool initialization boundary;
- canonical generation timestamp;
- latest included finalized block identity;
- available snapshot range;
- immutable B2 snapshots with decimal-string EVM integers;
- exact requested-timestamp-to-block resolutions;
- explicit failed or unavailable gaps;
- an explicit `fees: { included: false, status: "unavailable" }` marker.

Exports are capped at 400 snapshots. The entire new dataset and any existing
dataset are validated before an atomic same-directory replacement. A corrupt
existing export fails closed rather than being silently overwritten. A sample
is stored at `test/fixtures/lp-dataset-v1.json`.

## Resolution and coverage

The sample interval is a coverage choice, not an assertion about fee accuracy.
Each requested timestamp is independently resolved to the greatest finalized
Base block at or before it, and the export preserves both identities. Consumers
may use only an exact exported requested timestamp. They must not select a
nearest sample, interpolate, or substitute a chart candle or another pool.

Ordinary date selection starts at `2026-09-07T00:00:00.000Z`. September 6 is
the special initialization choice `2026-09-06T05:36:17.000Z`. A future UI may
use the latest included finalized block as the default end. Missing dates remain
unavailable until a separately authorized server-side resolution workflow is
available.

B3 covers principal and HODL inputs only. It contains no fee growth, swap replay,
APR, APY, public API, UI, scheduler, or deployment.
