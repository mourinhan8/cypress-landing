# Read-only LP Calculator (B5)

The homepage calculator consumes `/api/lp/v1/history.json` as a same-origin
static file. It never calls an RPC provider, reads chart candle prices, connects
a wallet, or changes on-chain state. The browser imports the existing B1 engine
and B2 snapshot adapter, so the displayed calculation does not duplicate the
liquidity formulas.

## Current validated coverage

The bounded B5 population was generated at `2026-09-09T06:15:51.521Z` and
contains five finalized snapshots with no gaps:

- initialization: block `50941815`, `2026-09-06T05:36:17.000Z`;
- September 7 selection: block `50974926`, `2026-09-06T23:59:59.000Z`;
- September 8 selection: block `51018126`, `2026-09-07T23:59:59.000Z`;
- September 9 selection: block `51061326`, `2026-09-08T23:59:59.000Z`;
- latest finalized: block `51072166`, `2026-09-09T06:01:19.000Z`.

Each date resolves to the greatest finalized block at or before its requested
UTC boundary, which is why the ordinary midnight selections currently display
`23:59:59Z` block timestamps. The UI discloses the exact timestamp and block.

The live run also corrected one verified fixture error: block-pinned `slot0` at
the initialization block is
`638407101806347576136442032642785978`. The earlier value was replaced in the
B1/B2 golden fixture and dependent expected results; no formula changed.

## Local refresh

Refresh the date boundaries and latest finalized state manually with:

```sh
npm run lp:populate-history -- \
  --timestamp 2026-09-06T05:36:17.000Z \
  --timestamp 2026-09-07T00:00:00.000Z \
  --timestamp 2026-09-08T00:00:00.000Z \
  --start 2026-09-09T00:00:00.000Z \
  --end latest \
  --interval-seconds 86400 \
  --max-points 5 \
  --cache .local/cypress-lp/historical-states-v1.json \
  --export api/lp/v1/history.json
```

For additional calendar dates, add exact UTC-midnight timestamps or advance the
bounded date range and `--max-points`. The private cache is ignored by Git; only
the validated static export is a homepage asset. Successful states are saved
before the next request, so a throttled run can be resumed without refetching
completed boundaries. Each export contains only the current command's successful
requested boundaries, while older snapshots remain in the private cache for safe
reuse. No scheduler is activated in B5.

The atomic writer creates the local export with mode `0600`. Deployment publishes
the validated file with mode `0644` beneath the read-only web root. The dedicated
Nginx location serves only `GET` requests with a five-minute public cache; the UI
labels data older than 26 hours as stale and continues to fail closed.

## UI behavior

“Provide liquidity” opens the verified Uniswap V3 CP/USDC 1% create-position
link. “LP Calculator” opens a native accessible dialog in English or Vietnamese.
The first available state is the default start and the latest included finalized
state is the default end. Explicit gaps appear disabled. Missing, malformed,
oversized, or stale data is clearly labeled; no nearby snapshot is substituted.

Results include the fixed capital and allocation, start/end price, ending token
amounts including dust, asset value and pre-fee P/L/return, HODL value, and LP
versus HODL. Fees remain unavailable and the risk note distinguishes full range
from narrower strategies.
