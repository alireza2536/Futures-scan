# Rolling CCI1000 and VWAP storage design

## Status and safety boundary

This document and the pure rolling-state helper are an isolated design/test step on the existing PR #7 branch. They do not connect to Neon, alter its schema or data, change the scanner's exchange list or strategy, or start live exchange requests. The PR remains unmerged.

## Retention model

- Keep complete raw OHLCV candles for the most recent 14 calendar days per exchange, symbol, and timeframe.
- For CCI1000, retain a compact rolling window of the latest 1,000 Typical Price values (plus timestamps/state metadata) per exchange, symbol, and timeframe. The project continues to require at least 1,001 verified closed candles when initializing/rebuilding this state.
- Store the computed CCI value and its candle timestamp as the historical indicator record. Do not store the full old OHLCV payload in the indicator archive.
- For session VWAP, retain the current UTC session's cumulative price-volume sum and volume sum. Store each completed candle's VWAP value and timestamp as the historical indicator record. Reset the two accumulators at the UTC date boundary.
- Keep compact state and historical indicator records separately from the 14-day raw OHLCV retention.

## Update algorithm

1. On first initialization or state recovery, fetch and validate enough history to satisfy the project's 1,001-closed-candle standard. Validate timestamps, interval continuity, duplicates, OHLCV, and closed-candle status.
2. Build the CCI state from the latest 1,000 Typical Prices. Calculate CCI using the latest 1,000 values and persist the compact state.
3. Build VWAP state from all candles in the current UTC session only: sum(Typical Price × Volume) and sum(Volume).
4. Whenever a new candle closes for a timeframe, validate that it is exactly the next contiguous candle. Append its Typical Price, evict the oldest TP when the CCI window exceeds 1,000, and recalculate CCI from the window.
5. Add the new candle's Typical Price × Volume and Volume to the VWAP accumulators. If the candle belongs to a new UTC date, reset both accumulators before adding it.
6. Persist the new indicator point and compact state atomically. Only after successful persistence and verification may raw candles older than 14 days be compacted/deleted.
7. If a gap, duplicate, invalid candle, state mismatch, or persistence failure occurs, do not advance the state and do not delete raw data. Rebuild from exchange history or the retained raw window plus a fresh historical backfill.

## Important timing detail

The state must advance when each timeframe candle closes, not only once per calendar day. For example, 4h CCI changes on each newly closed 4h candle. The 14-day raw retention window can be cleaned up daily, independently of the indicator update cadence.

## Exactness and limitations

- CCI is not safely maintainable from only a rolling sum or average: its mean absolute deviation depends on the full current Typical Price window. The helper retains those 1,000 TP values and recomputes the CCI window exactly after each new candle.
- VWAP is exactly maintainable from the two session accumulators while the session is active.
- Historical CCI/VWAP output values are compact records, not enough to reconstruct all old OHLCV. If an old candle needs correction beyond the 14-day raw window, the affected range must be fetched again from the exchange and recalculated.
- The 1,001-candle requirement is the project's operational coverage standard; the CCI formula itself uses 1,000 Typical Price observations.

## Tests included in this step

The pure helper tests compare rolling CCI and session VWAP against the existing full-history indicator functions, verify UTC session reset, reject gaps/unclosed candles, and verify the 1,001-style initialization requirement using a smaller test window. No Neon integration or raw-data deletion is included in this step.
