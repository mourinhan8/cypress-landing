# Homepage CP market data

The English and Vietnamese homepages calculate two read-only figures directly
from the verified CP pools on Base. They do not use the Swap or TestSwap
applications and do not submit transactions.

## Sources and formulas

- CP is `0x934ef4bfffdce191ac4bcc351b2fe7892865b440` (18 decimals).
- USDC is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals).
- WETH is `0x4200000000000000000000000000000000000006` (18 decimals).
- Uniswap V3 CP/USDC is `0x962265593a7F6f5F0804b6A3eD203AA5d2E0D1E9`, fee 1%.
- Uniswap V2 WETH/CP is `0xA290c53cc25f0B857d21421B2F757f9a3434f80E`, adapter fee 0.30%.

Every refresh obtains a Base block number, then pins every `eth_call` to that
block. Token order, factory, V3 fee, and tick spacing are validated before any
value is displayed.

**CP Price** is the V3 CP/USDC spot price in USD, treating USDC as the USD
reference. For token0 USDC and token1 CP, `slot0.sqrtPriceX96` represents the
square root of the raw CP/USDC ratio. The calculation inverts that ratio and
applies the 12-decimal token difference. The V2 pool is not averaged into the
headline price because doing so would require an additional independent WETH
USD provider. Instead, its reserve ratio converts the V3 CP price to an implied
WETH USD value solely for V2 TVL valuation.

**Total Liquidity** is the sum of the USD values held by these two pools only.
V2 uses normalized `getReserves()` amounts and values both sides. V3 uses the
actual USDC and CP ERC-20 `balanceOf(pool)` amounts; the V3 global liquidity
scalar is not TVL. Each pool balance is included exactly once.

## Requests, refresh, and failure policy

The static browser client makes three bounded read-only JSON-RPC requests per
refresh (block number, ten identity/state calls, and two V3 balance calls), with
an eight-second timeout per request. It refreshes at most once every five
minutes while the page is visible. There is no wallet, secret, backend job,
server cache, signing, or transaction path.

A successful result is saved to browser local storage. On an RPC failure, a
last-known-good result no older than 24 hours remains visible and is explicitly
labelled stale with its age. Older, malformed, zero, or missing data produces
an explicit unavailable state.

The deployment review must allow `https://base-rpc.publicnode.com` in the
homepage Nginx `connect-src` policy when changing the current report-only CSP,
and must preserve the previous immutable landing commit for rollback.
