# Rolling CCI1000 and VWAP storage design

## Status and safety boundary

This document and the pure indicator-state helpers are an isolated design/test step on the existing PR #7 branch. They do not connect to Neon, alter its schema or data, change the scanner's exchange list or strategy, or start live exchange requests. The PR remains unmerged.

## Retention model

- Keep complete raw OHLCV candles for the most recent 84 calendar days per exchange, symbol, and timeframe.
- For EMA500, initialize once from at least 500 verified, contiguous closed candles. Persist the latest EMA value, last close, last candle timestamp, timeframe interval, length, and processed-candle count per exchange/symbol/timeframe.
- Preserve timestamped EMA values as a compact, long-term history. The EMA state and EMA history are separate from raw OHLCV and are not subject to the 84-day raw-candle retention.
- For CCI1000, retain a compact rolling window of the latest 1,000 Typical Price values (plus timestamps/state metadata) per exchange, symbol, and timeframe. The project continues to require at least 1,001 verified closed candles when initializing/rebuilding this state.
- Store the computed CCI value and its candle timestamp as the historical indicator record. Do not store the full old OHLCV payload in the indicator archive.
- For session VWAP, retain the current UTC session's cumulative price-volume sum and volume sum. Store each completed candle's VWAP value and timestamp as the historical indicator record. Reset the two accumulators at the UTC date boundary.
- Keep compact state and historical indicator records separately from the 84-day raw OHLCV retention.

## Update algorithm

1. On first initialization or state recovery, fetch and validate enough history to satisfy the project's 1,001-closed-candle standard. Validate timestamps, interval continuity, duplicates, OHLCV, and closed-candle status.
2. Build the CCI state from the latest 1,000 Typical Prices. Calculate CCI using the latest 1,000 values and persist the compact state.
2a. Initialize EMA500 from verified closed-candle closes and persist the resulting EMA state plus its first timestamped EMA history point. This is a one-time history backfill for each exchange/symbol/timeframe.
3. Build VWAP state from all candles in the current UTC session only: sum(Typical Price × Volume) and sum(Volume).
4. Whenever a new candle closes for a timeframe, validate that it is exactly the next contiguous candle. Append its Typical Price, evict the oldest TP when the CCI window exceeds 1,000, and recalculate CCI from the window.
5. Add the new candle's Typical Price × Volume and Volume to the VWAP accumulators. If the candle belongs to a new UTC date, reset both accumulators before adding it.
5a. Advance EMA using only the newly closed candle close: EMA(new) = close × 2/(500+1) + EMA(previous) × 499/(500+1). Do not fetch old exchange history during normal updates.
6. Persist the new indicator point and compact state atomically. Only after successful persistence and verification may raw candles older than 84 days be compacted/deleted.
7. If a gap, duplicate, invalid candle, state mismatch, or persistence failure occurs, do not advance the state and do not delete raw data. Rebuild from exchange history or the retained raw window plus a fresh historical backfill.

## Important timing detail

The state must advance when each timeframe candle closes, not only once per calendar day. For example, 4h CCI changes on each newly closed 4h candle. The 84-day raw retention window can be cleaned up daily, independently of the indicator update cadence.

## Exactness and limitations

- CCI is not safely maintainable from only a rolling sum or average: its mean absolute deviation depends on the full current Typical Price window. The helper retains those 1,000 TP values and recomputes the CCI window exactly after each new candle.
- VWAP is exactly maintainable from the two session accumulators while the session is active.
- Historical CCI/VWAP/EMA output values are compact records, not enough to reconstruct all old OHLCV. If an old candle needs correction beyond the 84-day raw window, the affected range must be fetched again from the exchange and recalculated.
- EMA's persisted recursive state is sufficient for normal incremental updates without refetching its old seed candles. A lost/corrupt EMA state or a historical candle correction can require a fresh backfill; EMA history points alone do not recreate the original OHLCV.
- The 1,001-candle requirement is the project's operational coverage standard; the CCI formula itself uses 1,000 Typical Price observations.

## Tests included in this step

The pure helper tests compare rolling CCI and session VWAP against the existing full-history indicator functions, verify UTC session reset, reject gaps/unclosed candles, and verify the 1,001-style initialization requirement using a smaller test window. EMA tests verify EMA500 initialization against the reference calculation, exact incremental advancement from one new candle, and rejection of gaps, duplicates, invalid candles, and unclosed candles. No Neon integration or raw-data deletion is included in this step.
