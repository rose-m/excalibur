ALTER TABLE canvases ADD COLUMN comments_revision INTEGER NOT NULL DEFAULT 0 CHECK (comments_revision >= 0);

CREATE TABLE comments (
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  text TEXT NOT NULL,
  anchor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (canvas_id, id)
);
