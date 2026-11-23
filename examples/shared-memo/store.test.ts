/// <reference types="bun" />
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoStore } from "./store.js";

test("rolls back the memo if recording its notification fails", async () => {
  const db = new Database(":memory:");
  try {
    const store = createMemoStore(db, "initial");
    const operation = { sessionId: "editor", id: "save-1" };
    db.exec(`
      CREATE TRIGGER fail_outbox BEFORE INSERT ON memo_outbox
      BEGIN
        SELECT RAISE(ABORT, 'outbox unavailable');
      END
    `);

    expect(() => store.save("changed", 1, operation)).toThrow(
      "outbox unavailable"
    );
    expect(store.read()).toEqual({ text: "initial", revision: 1 });
    await store.flush(() =>
      Promise.reject(new Error("unexpected notification"))
    );

    db.exec("DROP TRIGGER fail_outbox");
    expect(store.save("changed", 1, operation)).toEqual({
      type: "saved",
      revision: 2,
    });
    let deliveries = 0;
    await store.flush(async () => {
      deliveries++;
    });
    expect(deliveries).toBe(1);
  } finally {
    db.close();
  }
});

test("retries from durable storage after a committed change could not be published", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hypersig-memo-"));
  const path = join(directory, "memo.sqlite");
  const operation = { sessionId: "editor", id: "save-1" };
  try {
    const first = new Database(path);
    try {
      const writer = createMemoStore(first, "initial");
      expect(writer.save("saved", 1, operation)).toEqual({
        type: "saved",
        revision: 2,
      });
      expect(
        writer.save("stale", 1, { ...operation, sessionId: "other" })
      ).toEqual({ type: "stale" });
      await rejects(
        writer.flush(() => Promise.reject(new Error("offline"))),
        /offline/
      );
    } finally {
      first.close();
    }

    const restarted = new Database(path);
    try {
      const reader = createMemoStore(restarted, "initial");
      expect(reader.read()).toEqual({ text: "saved", revision: 2 });
      expect(reader.save("saved", 1, operation)).toEqual({
        type: "saved",
        revision: 2,
      });
      expect(reader.save("different", 1, operation)).toEqual({
        type: "mismatch",
      });
      let deliveries = 0;
      const publish = () => {
        if (++deliveries === 1)
          expect(
            reader.save("newer", 2, { ...operation, id: "save-2" })
          ).toEqual({ type: "saved", revision: 3 });
        return Promise.resolve();
      };
      await reader.flush(publish);
      await reader.flush(publish);
      expect(deliveries).toBe(2);
      expect(reader.read()).toEqual({ text: "newer", revision: 3 });
      expect(reader.readRevision()).toBe(3);
    } finally {
      restarted.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
