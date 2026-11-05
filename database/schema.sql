CREATE TABLE IF NOT EXISTS futures_scan_snapshots (
  id uuid PRIMARY KEY,
  generated_at timestamptz NOT NULL,
  exchange_count integer NOT NULL,
  symbol_count integer NOT NULL,
  data_ready_count integer NOT NULL,
  partial_count integer NOT NULL,
  error_count integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS futures_scan_snapshots_generated_at_idx
  ON futures_scan_snapshots (generated_at DESC);
