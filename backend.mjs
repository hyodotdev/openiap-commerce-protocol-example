import { Database } from 'bun:sqlite';

export const STAGE = 1;
export const START = Date.UTC(2026, 8, 13);
export const END = Date.UTC(2026, 9, 13);
export const PRODUCT = 'premium.monthly';
export function openBackend(path) {
  const db = new Database(path, { create: true });
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS purchases (
      evidence TEXT PRIMARY KEY, user_id TEXT, state TEXT NOT NULL,
      expires_at INTEGER NOT NULL, will_renew INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('clock', ${START});`);
  return {
    db,
    state() {
      return {
        stage: STAGE,
        now: db.query("SELECT value FROM settings WHERE key='clock'").get().value,
        purchases: db.query('SELECT count(*) AS count FROM purchases').get().count,
        access: null,
        message: 'The HTTP server and empty database are running. Purchase verification is the next build step.',
      };
    },
    close() { db.close(); },
  };
}
