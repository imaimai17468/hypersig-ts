import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export function createMemoStore(db: Database, initialText: string) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memo (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      text TEXT NOT NULL,
      revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memo_outbox (
      revision INTEGER PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS memo_operations (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY (session_id, id)
    );
  `);
  db.run("INSERT OR IGNORE INTO memo VALUES (1, ?, 1)", [initialText]);
  const read = db.query<{ text: string; revision: number }, []>(
    "SELECT text, revision FROM memo WHERE id = 1"
  );
  const readRevision = db.query<{ revision: number }, []>(
    "SELECT revision FROM memo WHERE id = 1"
  );
  const update = db.query<{ revision: number }, [string, number]>(
    "UPDATE memo SET text = ?, revision = revision + 1 WHERE id = 1 AND revision = ? RETURNING revision"
  );
  const enqueue = db.query("INSERT INTO memo_outbox VALUES (?)");
  const latest = db.query<{ revision: number | null }, []>(
    "SELECT MAX(revision) AS revision FROM memo_outbox"
  );
  const acknowledge = db.query("DELETE FROM memo_outbox WHERE revision <= ?");
  const readOperation = db.query<
    { fingerprint: string; revision: number },
    [string, string]
  >(
    "SELECT fingerprint, revision FROM memo_operations WHERE session_id = ? AND id = ?"
  );
  const recordOperation = db.query(
    "INSERT INTO memo_operations VALUES (?, ?, ?, ?)"
  );
  const save = db.transaction(
    (
      text: string,
      baseRevision: number,
      operation: { sessionId: string; id: string }
    ) => {
      const { sessionId, id } = operation;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([baseRevision, text]))
        .digest("hex");
      const previous = readOperation.get(sessionId, id);
      if (previous)
        return previous.fingerprint === fingerprint
          ? { type: "saved" as const, revision: previous.revision }
          : { type: "mismatch" as const };
      const saved = update.get(text, baseRevision);
      if (!saved) return { type: "stale" as const };
      enqueue.run(saved.revision);
      recordOperation.run(sessionId, id, fingerprint, saved.revision);
      return { type: "saved" as const, revision: saved.revision };
    }
  );

  let pending: Promise<void> | undefined;
  async function drain(publish: () => Promise<void>) {
    for (;;) {
      const revision = latest.get()?.revision;
      if (revision == null) return;
      await publish();
      // A later commit may have arrived while notification was in flight.
      acknowledge.run(revision);
    }
  }

  return {
    read() {
      const memo = read.get();
      if (!memo) throw new Error("Memo row not initialized");
      return memo;
    },
    readRevision() {
      const row = readRevision.get();
      if (!row) throw new Error("Memo row not initialized");
      return row.revision;
    },
    save: save.immediate,
    flush(publish: () => Promise<void>) {
      pending ??= drain(publish).finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
