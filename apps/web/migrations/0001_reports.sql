-- Hosted reports. Media and the manifest live in R2 under reports/<id>/.
CREATE TABLE reports (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	repo TEXT,
	pr TEXT,
	overall TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('uploading', 'ready')),
	bytes INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);
CREATE INDEX reports_created_at ON reports (created_at DESC);
