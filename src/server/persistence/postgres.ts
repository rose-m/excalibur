import { Pool, type PoolClient, type PoolConfig } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CanvasDocument, CanvasMetadata, Scene } from "../../shared/canvas.js";
import type { OperationContext } from "../auth/context.js";
import type { CanvasRepository, SceneCommit } from "./repository.js";
import type { CanvasComment, CommentState } from "../../shared/comments.js";
import { signature } from "../../shared/signature.js";

type Row = Record<string, unknown>;
const metadataColumns = "id, organization_id, creator_user_id, title, visibility, revision, created_at, updated_at";
function metadata(row: Row): CanvasMetadata {
  return {
    id: row.id as string, organizationId: row.organization_id as string,
    creatorUserId: row.creator_user_id as string, title: row.title as string,
    visibility: row.visibility as CanvasMetadata["visibility"], revision: row.revision as number,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
  };
}

export class PostgresCanvasRepository implements CanvasRepository {
  private constructor(private pool: Pool) {}

  static async open(config: string | PoolConfig, migrationsDirectory = resolve("migrations")) {
    const pool = new Pool({ connectionTimeoutMillis: 10_000, ...(typeof config === "string" ? { connectionString: config } : config) });
    pool.on("error", error => console.error("Postgres pool error", error.message));
    const repository = new PostgresCanvasRepository(pool);
    try {
      await repository.transaction(async client => {
        // Serialize schema setup across application instances.
        await client.query("SELECT pg_advisory_xact_lock(170238, 1)");
        await client.query("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)");
        for (const name of (await readdir(migrationsDirectory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
          if ((await client.query("SELECT name FROM migrations WHERE name = $1", [name])).rowCount) continue;
          await client.query(await readFile(resolve(migrationsDirectory, name), "utf8"));
          await client.query("INSERT INTO migrations (name) VALUES ($1)", [name]);
        }
      });
      return repository;
    } catch (error) { await pool.end(); throw error; }
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async list(context: OperationContext) {
    return (await this.pool.query(`SELECT ${metadataColumns} FROM canvases WHERE organization_id = $1
      AND (creator_user_id = $2 OR visibility = 'organization') ORDER BY updated_at DESC, id`,
    [context.organizationId, context.userId])).rows.map(metadata);
  }

  async create(canvas: CanvasDocument) {
    await this.pool.query(`INSERT INTO canvases
      (id, organization_id, creator_user_id, title, visibility, revision, created_at, updated_at, elements, shared_settings)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [canvas.id, canvas.organizationId, canvas.creatorUserId, canvas.title, canvas.visibility,
      canvas.revision, canvas.createdAt, canvas.updatedAt, JSON.stringify(canvas.scene.elements), JSON.stringify(canvas.scene.sharedSettings)]);
  }

  async get(id: string): Promise<CanvasDocument | undefined> {
    return this.transaction(async client => {
      const row = (await client.query("SELECT * FROM canvases WHERE id = $1", [id])).rows[0];
      if (!row) return undefined;
      const files = Object.create(null) as Scene["files"];
      for (const asset of (await client.query("SELECT * FROM assets WHERE canvas_id = $1", [id])).rows) {
        files[asset.asset_id] = {
          id: asset.asset_id, mimeType: asset.mime_type, created: asset.created,
          dataURL: `data:${asset.mime_type};base64,${(asset.content as Buffer).toString("base64")}`,
        };
      }
      return { ...metadata(row), scene: {
        elements: JSON.parse(row.elements) as Scene["elements"],
        sharedSettings: JSON.parse(row.shared_settings) as Scene["sharedSettings"], files: { ...files },
      } };
    }, true);
  }

  async commit(id: string, input: SceneCommit, updatedAt: string) {
    return this.transaction(async client => {
      const row = (await client.query(`UPDATE canvases SET elements = $1, shared_settings = $2,
        revision = revision + 1, updated_at = $3 WHERE id = $4 AND revision = $5 RETURNING ${metadataColumns}`,
      [JSON.stringify(input.scene.elements), JSON.stringify(input.scene.sharedSettings), updatedAt, id, input.expectedRevision])).rows[0];
      if (!row) return undefined;
      const files = Object.values(input.assets.upsert);
      const upsertIds = new Set(files.map(file => file.id));
      if (input.assets.remove.some(assetId => upsertIds.has(assetId))) {
        throw new Error("An asset cannot be upserted and removed in the same commit");
      }
      if (input.assets.remove.length) {
        await client.query("DELETE FROM assets WHERE canvas_id = $1 AND asset_id = ANY($2::text[])", [id, input.assets.remove]);
      }
      if (files.length) {
        // Ordinary scene edits execute no asset DML and transmit no blob bytes.
        // Multiple new assets share one round trip; redundant explicit upserts
        // do not update existing rows or rewrite their TOAST storage.
        await client.query(`INSERT INTO assets (canvas_id, asset_id, mime_type, content, created)
          SELECT $1, incoming.asset_id, incoming.mime_type, incoming.content, incoming.created
          FROM unnest($2::text[], $3::text[], $4::bytea[], $5::double precision[])
            AS incoming(asset_id, mime_type, content, created)
          ON CONFLICT (canvas_id, asset_id) DO UPDATE
            SET mime_type = EXCLUDED.mime_type, content = EXCLUDED.content, created = EXCLUDED.created
          WHERE (assets.mime_type, assets.content, assets.created)
            IS DISTINCT FROM (EXCLUDED.mime_type, EXCLUDED.content, EXCLUDED.created)`,
        [id, files.map(file => file.id), files.map(file => file.mimeType),
          files.map(file => Buffer.from(file.dataURL.split(",")[1]!, "base64")), files.map(file => file.created)]);
      }
      return metadata(row);
    });
  }

  async setVisibility(id: string, visibility: CanvasMetadata["visibility"], expectedRevision: number, updatedAt: string) {
    const row = (await this.pool.query(`UPDATE canvases SET visibility = $1, revision = revision + 1, updated_at = $2
      WHERE id = $3 AND revision = $4 RETURNING ${metadataColumns}`, [visibility, updatedAt, id, expectedRevision])).rows[0];
    return row ? metadata(row) : undefined;
  }

  async rename(id: string, title: string, expectedRevision: number, updatedAt: string) {
    const row = (await this.pool.query(`UPDATE canvases SET title = $1, revision = revision + 1, updated_at = $2
      WHERE id = $3 AND revision = $4 RETURNING ${metadataColumns}`, [title, updatedAt, id, expectedRevision])).rows[0];
    return row ? metadata(row) : undefined;
  }

  async delete(id: string, expectedRevision: number) {
    return (await this.pool.query("DELETE FROM canvases WHERE id = $1 AND revision = $2", [id, expectedRevision])).rowCount === 1;
  }

  private async readComments(client: PoolClient, id: string): Promise<CommentState> {
    const row = (await client.query("SELECT comments_revision FROM canvases WHERE id = $1", [id])).rows[0];
    if (!row) throw new Error("Canvas does not exist");
    const comments = (await client.query("SELECT * FROM comments WHERE canvas_id = $1 ORDER BY created_at, id", [id])).rows.map(row => ({
      id: row.id as string, text: row.text as string, anchor: JSON.parse(row.anchor as string) as CanvasComment["anchor"], createdAt: row.created_at as string,
    }));
    return { revision: row.comments_revision as number, comments };
  }

  async getComments(id: string) { return this.transaction(client => this.readComments(client, id), true); }

  private async changeComments<T>(id: string, run: (client: PoolClient, state: CommentState) => Promise<T>): Promise<T> {
    return this.transaction(async client => {
      // All comment writers lock the parent, including for the 500-comment limit.
      await client.query("SELECT id FROM canvases WHERE id = $1 FOR UPDATE", [id]);
      return run(client, await this.readComments(client, id));
    });
  }

  async addComment(id: string, comment: CanvasComment): Promise<CommentState | "limit" | "conflict"> {
    return this.changeComments(id, async (client, state) => {
      const existing = state.comments.find(item => item.id === comment.id);
      if (existing) return existing.text === comment.text && signature(existing.anchor) === signature(comment.anchor) ? state : "conflict";
      if (state.comments.length >= 500) return "limit";
      await client.query("INSERT INTO comments (canvas_id, id, text, anchor, created_at) VALUES ($1, $2, $3, $4, $5)",
        [id, comment.id, comment.text, JSON.stringify(comment.anchor), comment.createdAt]);
      await client.query("UPDATE canvases SET comments_revision = comments_revision + 1 WHERE id = $1", [id]);
      return this.readComments(client, id);
    });
  }

  async editComment(id: string, commentId: string, text: string, expectedText: string): Promise<CommentState | "missing" | "conflict"> {
    return this.changeComments(id, async (client, state) => {
      const existing = state.comments.find(comment => comment.id === commentId);
      if (!existing) return "missing";
      if (existing.text !== expectedText && existing.text !== text) return "conflict";
      if (existing.text !== text) {
        await client.query("UPDATE comments SET text = $1 WHERE canvas_id = $2 AND id = $3", [text, id, commentId]);
        await client.query("UPDATE canvases SET comments_revision = comments_revision + 1 WHERE id = $1", [id]);
      }
      return this.readComments(client, id);
    });
  }

  async deleteComment(id: string, commentId: string) {
    return this.changeComments(id, async client => {
      if ((await client.query("DELETE FROM comments WHERE canvas_id = $1 AND id = $2", [id, commentId])).rowCount) {
        await client.query("UPDATE canvases SET comments_revision = comments_revision + 1 WHERE id = $1", [id]);
      }
      return this.readComments(client, id);
    });
  }

  async close() { await this.pool.end(); }
}
