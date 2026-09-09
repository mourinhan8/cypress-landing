# LP historical state acquisition (B2)

This layer acquires immutable, finalized block-boundary state for only the Base
Uniswap V3 CP/USDC 1% pool. It does not use chart candles, other pools, price
interpolation, swaps, or synthetic history.

## Frozen B1 contract

`simulateFullRange({ start, end })` remains pure and receives validated pool
states containing BigInt `blockNumber` and `sqrtPriceX96` values. Token amounts,
liquidity, Q96 math, and rational valuations remain BigInt-only. Liquidity is
floored, mint token deltas round up, withdrawal deltas round down, and unused
atomic token dust remains part of ending assets. The TickMath and liquidity
golden vectors are unchanged.

B2 stores JSON-safe decimal integer strings. `toSimulatorState(snapshot)` is the
only adapter into B1's BigInt input contract. Historical RPC access is not
imported by the simulator.

## APIs and policy

- `createRpcClient(options)` provides bounded timeouts and exponential retry for
  network errors, timeouts, HTTP 429/5xx, and provider rate-limit errors.
- `resolveFinalizedBlockAtOrBefore(client, timestamp)` uses a bounded binary
  search from pool initialization through the provider's `finalized` block and
  returns the greatest block timestamp less than or equal to the requested UTC
  timestamp.
- `acquirePoolSnapshot(client, block)` pins every contract call to the resolved
  block number and verifies the block hash and timestamp before and after calls.
- `HistoricalStateCache` atomically stores immutable snapshots and timestamp
  resolutions. A different hash or payload for an existing block fails closed.
- `createHistoricalStateService({ client, cache })` checks the cache before RPC
  resolution/acquisition and returns both the raw snapshot and B1 state.

Only canonical UTC ISO timestamps are accepted. Requests before
`2026-09-06T05:36:17.000Z` are rejected. An end timestamp cannot precede its
start. Future/current targets clamp to the latest finalized block. Ordinary
date-only selection begins at `2026-09-07T00:00:00.000Z`; September 6 can only
be exposed later as an explicit initialization-date choice resolving to the
initialization timestamp. No UI is implemented in B2.

## Snapshot and cache contract

Snapshots contain schema version, chain/pool/factory identity, block number,
hash and timestamp, token identities and decimals, fee, spacing,
`sqrtPriceX96`, signed current tick, active liquidity, and finality. All EVM
integers persisted in the cache are decimal strings. Cache files are separate
from chart Price/TVL data, use mode 0600 where supported, and are replaced by an
atomic same-directory rename. The caller chooses the cache path; B2 creates no
always-running process and performs no browser-side archive calls.

The default endpoint is the official `https://mainnet.base.org`. It served the
verified historical fixtures during B2 but returned rate-limit errors during a
small burst, so availability and SLA are not assumed. The repository's existing
`https://base-rpc.publicnode.com` endpoint rejected historical state without a
personal token. Production callers may inject a credentialed archive URL, but
must keep it server-side and out of source, logs, and browser payloads.

Protocol references: [Base RPC overview](https://docs.base.org/base-chain/api-reference/rpc-overview),
[Base `eth_call`](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_call),
[Ethereum JSON-RPC block semantics](https://ethereum.org/developers/docs/apis/json-rpc/),
and [EIP-1898 block identity](https://eips.ethereum.org/EIPS/eip-1898).

## Verified fixtures

The deterministic fixture file is `test/fixtures/lp-pool-states.json`.

- Block 50,941,815, hash
  `0x748bf3c1a7db6485324676b7480bee436a226c2cf12e20f7c62c3f8a7d7f6918`,
  timestamp `2026-09-06T05:36:17.000Z`, sqrt price
  `638407101806347576136442032642785978`, tick `318059`.
- Block 51,064,756, hash
  `0xb2986e84b63d28890a77d9eb007daf51a528c707f3af6000dc98fa98efc381aa`,
  timestamp `2026-09-09T01:54:19.000Z`, sqrt price
  `637434091718179387822692496724259019`, tick `318028`.

Both reported active liquidity `151230679965619705`. Block-pinned calls also
verified chain 8453, pool/token ordering, factory
`0x33128a8fc17869897dce68ed026d694621f6fdfd`, fee 10000, and spacing 200.

## Operational and fee limits

Resolution performs logarithmic block reads, followed by a fixed number of
sequential state calls. There is no unbounded scan. Missing blocks, malformed
quantities, wrong identities, archive errors, timeouts, rate limits, reorg/hash
conflicts, locked/uninitialized state, and partial snapshots fail explicitly.

B2 does not acquire or calculate fees. A later fee checkpoint would require
fee-growth state, active-liquidity history, protocol-fee changes, and swap/event
history under a separately reviewed model. B1 continues to report fees as
unavailable.
