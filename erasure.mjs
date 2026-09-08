import { createHmac, randomBytes, randomUUID } from "node:crypto";

// Retain a stable retry marker without storing the user ID verbatim.
export function createErasureLedger(db) {
  db.exec(`
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS erasure_key (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS erased_users (user_hash TEXT PRIMARY KEY, job_id TEXT NOT NULL);
  `);
  db.query("INSERT OR IGNORE INTO erasure_key VALUES (1, ?)").run(
    randomBytes(32).toString("hex"),
  );
  const key = db
    .query("SELECT value FROM erasure_key WHERE id = 1")
    .get().value;
  const hash = (userId) =>
    createHmac("sha256", key).update(userId).digest("hex");
  return {
    has: (userId) =>
      Boolean(
        db
          .query("SELECT 1 FROM erased_users WHERE user_hash = ?")
          .get(hash(userId)),
      ),
    remember(userId) {
      const userHash = hash(userId);
      db.query("INSERT OR IGNORE INTO erased_users VALUES (?, ?)").run(
        userHash,
        randomUUID(),
      );
      return db
        .query("SELECT job_id FROM erased_users WHERE user_hash = ?")
        .get(userHash).job_id;
    },
  };
}
