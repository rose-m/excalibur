import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CanvasDocument, CanvasMetadata, SaveScene, Scene } from "../../shared/canvas.js";
import type { OperationContext } from "../auth/context.js";
import type { CanvasRepository } from "./repository.js";
import type { CanvasComment, CommentState } from "../../shared/comments.js";
import { signature } from "../../shared/signature.js";

type Row = Record<string, unknown>;

function metadata(row: Row): CanvasMetadata {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    creatorUserId: row.creator_user_id as string,
    title: row.title as string,
    visibility: row.visibility as CanvasMetadata["visibility"],
    revision: row.revision as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class SqliteCanvasRepository implements CanvasRepository {
  private db: DatabaseSync;

  constructor(filename: string, migrationsDirectory = resolve("migrations")) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)");
    for (const name of readdirSync(migrationsDirectory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      if (this.db.prepare("SELECT name FROM migrations WHERE name = ?").get(name)) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(readFileSync(resolve(migrationsDirectory, name), "utf8"));
        this.db.prepare("INSERT INTO migrations (name) VALUES (?)").run(name);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        this.db.close();
        throw error;
      }
    }
  }

  list(context: OperationContext): CanvasMetadata[] {
    return this.db.prepare(`SELECT * FROM canvases WHERE organization_id = ?
      AND (creator_user_id = ? OR visibility = 'organization') ORDER BY updated_at DESC, id`)
      .all(context.organizationId, context.userId).map(metadata);
  }

  create(canvas: CanvasDocument) {
    this.db.prepare(`INSERT INTO canvases
      (id, organization_id, creator_user_id, title, visibility, revision, created_at, updated_at, elements, shared_settings)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(canvas.id, canvas.organizationId, canvas.creatorUserId, canvas.title,
        canvas.visibility, canvas.revision, canvas.createdAt, canvas.updatedAt,
        JSON.stringify(canvas.scene.elements), JSON.stringify(canvas.scene.sharedSettings));
  }

  get(id: string): CanvasDocument | undefined {
    const row = this.db.prepare("SELECT * FROM canvases WHERE id = ?").get(id);
    if (!row) return undefined;
    const files = Object.create(null) as Scene["files"];
    for (const asset of this.db.prepare("SELECT * FROM assets WHERE canvas_id = ?").all(id)) {
      const assetId = asset.asset_id as string;
      files[assetId] = {
        id: assetId,
        mimeType: asset.mime_type as Scene["files"][string]["mimeType"],
        created: asset.created as number,
        dataURL: `data:${asset.mime_type as string};base64,${Buffer.from(asset.content as Uint8Array).toString("base64")}`,
      };
    }
    return {
      ...metadata(row),
      scene: {
        elements: JSON.parse(row.elements as string) as Scene["elements"],
        sharedSettings: JSON.parse(row.shared_settings as string) as Scene["sharedSettings"],
        files: { ...files },
      },
    };
  }

  commit(id: string, input: SaveScene, updatedAt: string): CanvasMetadata | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`UPDATE canvases SET elements = ?, shared_settings = ?,
        revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
        .run(JSON.stringify(input.scene.elements), JSON.stringify(input.scene.sharedSettings),
          updatedAt, id, input.expectedRevision);
      if (result.changes === 0) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const upsert = this.db.prepare(`INSERT INTO assets (canvas_id, asset_id, mime_type, content, created)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (canvas_id, asset_id)
        DO UPDATE SET mime_type = excluded.mime_type, content = excluded.content, created = excluded.created`);
      this.db.prepare("DELETE FROM assets WHERE canvas_id = ?").run(id);
      for (const file of Object.values(input.scene.files)) {
        upsert.run(id, file.id, file.mimeType, Buffer.from(file.dataURL.split(",")[1]!, "base64"), file.created);
      }
      const row = this.db.prepare("SELECT * FROM canvases WHERE id = ?").get(id)!;
      this.db.exec("COMMIT");
      return metadata(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() { this.db.close(); }

  setVisibility(id: string, visibility: CanvasMetadata["visibility"], expectedRevision: number, updatedAt: string): CanvasMetadata | undefined {
    const row = this.db.prepare(`UPDATE canvases SET visibility = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? RETURNING *`).get(visibility, updatedAt, id, expectedRevision);
    return row ? metadata(row) : undefined;
  }

  getComments(id: string): CommentState {
    const row = this.db.prepare("SELECT comments_revision FROM canvases WHERE id = ?").get(id);
    if (!row) throw new Error("Canvas does not exist");
    const comments = this.db.prepare("SELECT * FROM comments WHERE canvas_id = ? ORDER BY created_at, id").all(id).map(row => ({
      id: row.id as string, text: row.text as string, anchor: JSON.parse(row.anchor as string) as CanvasComment["anchor"], createdAt: row.created_at as string,
    }));
    return { revision: row.comments_revision as number, comments };
  }

  addComment(id: string, comment: CanvasComment): CommentState | "limit" | "conflict" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.getComments(id);
      const existing = state.comments.find(item => item.id === comment.id);
      if (existing) {
        this.db.exec("COMMIT");
        return existing.text === comment.text && signature(existing.anchor) === signature(comment.anchor) ? state : "conflict";
      }
      if (state.comments.length >= 500) { this.db.exec("ROLLBACK"); return "limit"; }
      this.db.prepare("INSERT INTO comments (canvas_id, id, text, anchor, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, comment.id, comment.text, JSON.stringify(comment.anchor), comment.createdAt);
      this.db.prepare("UPDATE canvases SET comments_revision = comments_revision + 1 WHERE id = ?").run(id);
      const result = this.getComments(id);
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  editComment(id: string, commentId: string, text: string, expectedText: string): CommentState | "missing" | "conflict" {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.getComments(id);
      const existing = state.comments.find(comment => comment.id === commentId);
      if (!existing || (existing.text !== expectedText && existing.text !== text)) {
        this.db.exec("ROLLBACK");
        return existing ? "conflict" : "missing";
      }
      if (existing.text !== text) {
        this.db.prepare("UPDATE comments SET text = ? WHERE canvas_id = ? AND id = ?").run(text, id, commentId);
        this.db.prepare("UPDATE canvases SET comments_revision = comments_revision + 1 WHERE id = ?").run(id);
      }
      const result = this.getComments(id);
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  deleteComment(id: string, commentId: string): CommentState {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const deleted = this.db.prepare("DELETE FROM comments WHERE canvas_id = ? AND id = ?").run(id, commentId);
      if (deleted.changes) this.db.prepare("UPDATE canvases SET comments_revision = comments_revision + 1 WHERE id = ?").run(id);
      const state = this.getComments(id);
      this.db.exec("COMMIT");
      return state;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
