CREATE TABLE canvases (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  creator_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'organization')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  elements TEXT NOT NULL,
  shared_settings TEXT NOT NULL
);

CREATE INDEX canvases_organization_updated ON canvases (organization_id, updated_at DESC);

CREATE TABLE assets (
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  content BYTEA NOT NULL,
  -- Excalidraw file.created: client-provided Unix milliseconds, preserved verbatim.
  created DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (canvas_id, asset_id)
);
