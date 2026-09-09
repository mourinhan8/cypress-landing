# Homepage USD/VND metrics

The homepage preserves the existing block-pinned CP market reader and liquidity
aggregation. `cp-market-metrics.js` derives fixed-supply market capitalization
from the exact same returned price object:

```text
market cap USD = CP price USD × 25,000,000 CP
VND value = USD value × one shared cached USD/VND rate
```

The browser requests `/api/fx/v1/usd-vnd.json` once per page load. It never calls
the upstream exchange-rate provider. Missing or invalid FX data affects only the
secondary VND lines; USD price, liquidity, market cap, chart, and LP features
continue normally.

## Refresh policy

`cypress-fx.timer` triggers once daily at 00:20 UTC with up to 30 minutes of
random delay. The one-shot updater checks the persistent cache's `checkedAt`
timestamp and never contacts ExchangeRate-API more than once in a rolling 24-hour
window. It requires a finite positive `rates.VND` value and writes atomically.

Run a manual refresh with:

```sh
npm run fx:refresh -- --cache api/fx/v1/usd-vnd.json
```

On refresh failure, the last valid rate and its `updatedAt` timestamp remain in
the cache while `checkedAt` records the attempt. On a first-run failure the
published snapshot has a null rate, which the browser displays as unavailable.
No API key or provider credential is used.
