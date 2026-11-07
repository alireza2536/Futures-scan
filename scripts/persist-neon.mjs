import { randomUUID } from "node:crypto";

export async function persistScanResults(summary) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return { status: "SKIPPED_NO_DATABASE_URL" };
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(connectionString);
  await sql`CREATE TABLE IF NOT EXISTS futures_scan_snapshots (
    id uuid PRIMARY KEY,
    generated_at timestamptz NOT NULL,
    exchange_count integer NOT NULL,
    symbol_count integer NOT NULL,
    data_ready_count integer NOT NULL,
    partial_count integer NOT NULL,
    error_count integer NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  const id = randomUUID();
  await sql`INSERT INTO futures_scan_snapshots
    (id, generated_at, exchange_count, symbol_count, data_ready_count, partial_count, error_count, payload)
    VALUES (${id}, ${summary.generatedAt}, ${summary.exchanges.length}, ${summary.scanned},
      ${summary.dataReady}, ${summary.partialData}, ${summary.dataErrors}, ${JSON.stringify(summary)}::jsonb)`;
  return { status: "SAVED", id };
}

let dailyCciSql;
let dailyCciTableReady;

async function getDailyCciSql() {
  if (!process.env.DATABASE_URL) return null;
  if (!dailyCciSql) {
    const { neon } = await import("@neondatabase/serverless");
    dailyCciSql = neon(process.env.DATABASE_URL);
  }
  if (!dailyCciTableReady) {
    dailyCciTableReady = dailyCciSql`CREATE TABLE IF NOT EXISTS daily_cci_states (
      exchange text NOT NULL,
      symbol text NOT NULL,
      last_timestamp bigint NOT NULL,
      typical_prices jsonb NOT NULL,
      recent_candles jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (exchange, symbol)
    )`;
  }
  await dailyCciTableReady;
  return dailyCciSql;
}

export async function loadDailyCCIState(exchange, symbol) {
  const sql = await getDailyCciSql();
  if (!sql) return null;
  const rows = await sql`SELECT last_timestamp, typical_prices, recent_candles
    FROM daily_cci_states
    WHERE exchange = ${exchange} AND symbol = ${symbol}
    LIMIT 1`;
  if (!rows.length) return null;
  return {
    lastTimestamp: Number(rows[0].last_timestamp),
    typicalPrices: rows[0].typical_prices,
    recentCandles: rows[0].recent_candles
  };
}

export async function saveDailyCCIState(exchange, symbol, state) {
  const sql = await getDailyCciSql();
  if (!sql) return { status: "SKIPPED_NO_DATABASE_URL" };
  await sql`INSERT INTO daily_cci_states
    (exchange, symbol, last_timestamp, typical_prices, recent_candles)
    VALUES (${exchange}, ${symbol}, ${state.lastTimestamp},
      ${JSON.stringify(state.typicalPrices)}::jsonb,
      ${JSON.stringify(state.recentCandles)}::jsonb)
    ON CONFLICT (exchange, symbol) DO UPDATE SET
      last_timestamp = EXCLUDED.last_timestamp,
      typical_prices = EXCLUDED.typical_prices,
      recent_candles = EXCLUDED.recent_candles,
      updated_at = now()`;
  return { status: "SAVED" };
}
