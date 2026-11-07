import { randomUUID } from "node:crypto";

export async function persistScanResults(summary) {
  const connectionString=process.env.DATABASE_URL;
  if(!connectionString) return {status:"SKIPPED_NO_DATABASE_URL"};
  const { neon }=await import("@neondatabase/serverless");
  const sql=neon(connectionString);
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
  await sql`ALTER TABLE IF EXISTS daily_cci_states DROP COLUMN IF EXISTS ema500, DROP COLUMN IF EXISTS ema500_timestamp`;
  const id=randomUUID();
  await sql`INSERT INTO futures_scan_snapshots
    (id,generated_at,exchange_count,symbol_count,data_ready_count,partial_count,error_count,payload)
    VALUES (${id},${summary.generatedAt},${summary.exchanges.length},${summary.scanned},
      ${summary.dataReady},${summary.partialData},${summary.dataErrors},${JSON.stringify(summary)}::jsonb)`;
  return {status:"SAVED",id};
}
