-- Upload sizes and the creation-order index only served the removed list endpoint.
ALTER TABLE reports DROP COLUMN bytes;
DROP INDEX IF EXISTS reports_created_at;
