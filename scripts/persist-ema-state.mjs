// Neon persistence for compact EMA state and its timestamped value history.
// This module performs no database work until persistEmaState is explicitly called.
export async function persistEmaState({ exchange, symbol, timeframe, state, mode = "advance" }) {
  if (!process.env.DATABASE_URL) return { status: "SKIPPED_NO_DATABASE_URL" };
  if (!exchange || !symbol || !timeframe || !state || !Number.isFinite(state.value)) {
    throw new Error("exchange, symbol, timeframe and a valid EMA state are required");
  }
  if (!["initialize", "advance"].includes(mode)) throw new Error("mode must be initialize or advance");
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  await sql`CREATE TABLE IF NOT EXISTS ema_indicator_state (
    exchange text NOT NULL, symbol text NOT NULL, timeframe text NOT NULL,
    length integer NOT NULL, timeframe_ms bigint NOT NULL, last_timestamp bigint NOT NULL,
    last_close double precision NOT NULL, ema_value double precision NOT NULL,
    candles_processed bigint NOT NULL, state_version integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (exchange, symbol, timeframe, length)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS ema_indicator_history (
    exchange text NOT NULL, symbol text NOT NULL, timeframe text NOT NULL,
    length integer NOT NULL, candle_timestamp bigint NOT NULL,
    close double precision NOT NULL, ema_value double precision NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (exchange, symbol, timeframe, length, candle_timestamp)
  )`;
  // One data-modifying CTE keeps the state update and historical point atomic.
  // Advance is accepted only for the immediately next candle; initialization
  // never overwrites an existing state.
  const rows = mode === "initialize"
    ? await sql`WITH saved AS (
        INSERT INTO ema_indicator_state
          (exchange,symbol,timeframe,length,timeframe_ms,last_timestamp,last_close,ema_value,candles_processed,state_version)
        VALUES
          (${exchange},${symbol},${timeframe},${state.length},${state.timeframeMs},${state.lastTimestamp},${state.lastClose},${state.value},${state.candlesProcessed},${state.version})
        ON CONFLICT (exchange,symbol,timeframe,length) DO NOTHING
        RETURNING exchange,symbol,timeframe,length,last_timestamp,last_close,ema_value
      )
      INSERT INTO ema_indicator_history (exchange,symbol,timeframe,length,candle_timestamp,close,ema_value)
      SELECT saved.exchange,saved.symbol,saved.timeframe,saved.length,
        points.candle_timestamp,points.close,points.ema_value
      FROM saved CROSS JOIN jsonb_to_recordset(${JSON.stringify(state.history ?? [])}::jsonb)
        AS points(candle_timestamp bigint, close double precision, ema_value double precision)
      ON CONFLICT DO NOTHING
      RETURNING candle_timestamp`
    : await sql`WITH saved AS (
        INSERT INTO ema_indicator_state
          (exchange,symbol,timeframe,length,timeframe_ms,last_timestamp,last_close,ema_value,candles_processed,state_version)
        VALUES
          (${exchange},${symbol},${timeframe},${state.length},${state.timeframeMs},${state.lastTimestamp},${state.lastClose},${state.value},${state.candlesProcessed},${state.version})
        ON CONFLICT (exchange,symbol,timeframe,length) DO UPDATE SET
          last_timestamp=EXCLUDED.last_timestamp, last_close=EXCLUDED.last_close,
          ema_value=EXCLUDED.ema_value, candles_processed=EXCLUDED.candles_processed,
          updated_at=now()
        WHERE ema_indicator_state.last_timestamp + ema_indicator_state.timeframe_ms = EXCLUDED.last_timestamp
        RETURNING exchange,symbol,timeframe,length,last_timestamp,last_close,ema_value
      )
      INSERT INTO ema_indicator_history (exchange,symbol,timeframe,length,candle_timestamp,close,ema_value)
      SELECT exchange,symbol,timeframe,length,last_timestamp,last_close,ema_value FROM saved
      ON CONFLICT DO NOTHING
      RETURNING candle_timestamp`;
  if (!rows.length) throw new Error("EMA state was not persisted: duplicate, out-of-order, missing initial state, or candle gap");
  return { status: "SAVED", timestamp: state.lastTimestamp, value: state.value };
}
