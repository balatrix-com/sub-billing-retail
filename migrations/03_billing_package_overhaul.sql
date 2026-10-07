-- Recording-only billing package fields. Legacy columns remain for historical
-- compatibility but are no longer populated by the application.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS numbers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS monitoring_extensions INTEGER NOT NULL DEFAULT 0;

UPDATE plans
SET numbers = COALESCE(tfns, 0) + COALESCE(dids, 0)
WHERE numbers = 0;

UPDATE plans
SET monitoring_extensions = COALESCE(monitoring_per_user, 0)
WHERE monitoring_extensions = 0;

-- Legacy free-minute columns are retained unchanged for audit/history. New
-- application paths neither grant nor consume them.
