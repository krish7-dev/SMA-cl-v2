# SMA-Data-Engine

**Port:** 9005
**Base package:** `com.sma.dataengine`

## Responsibility

- Kite Connect SDK integration for live market data (ticks)
- Historical OHLCV candle fetching and storage
- Replay of historical data for backtesting
- Feed normalization and internal publication

## Boundaries (strict)

- Does NOT depend on Broker Engine for market data
- Kite SDK usage here is exclusively for market data — NOT for order placement or auth
- Broker Engine owns all broker auth; Data Engine accesses market data independently

## Status

**Skeleton** — package structure in place. Kite WebSocket integration and candle storage pending.
