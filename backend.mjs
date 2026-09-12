import { ProtocolFault } from './contract.mjs';
import { Database } from 'bun:sqlite';

export const STAGE = 2;
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
    verify(input) {
      if (input.store !== 'fixture') throw new ProtocolFault('UNSUPPORTED_STORE');
      const receipt = input.fixture?.receipt;
      if (typeof receipt !== 'string' || !receipt || receipt.length > 256) throw new ProtocolFault('INVALID_REQUEST');
      if (receipt === 'outage') throw new ProtocolFault('VERIFICATION_FAILED');
      const isValid = ['alice-monthly', 'bob-monthly'].includes(receipt);
      if (isValid) db.query("INSERT OR IGNORE INTO purchases VALUES (?, NULL, 'Active', ?, 1)").run(receipt, END);
      return { store: 'fixture', isValid, state: isValid ? 'ENTITLED' : 'INAUTHENTIC', ...(isValid ? { productId: PRODUCT } : {}), environment: 'sandbox' };
    },
    state() {
      return {
        stage: STAGE,
        now: db.query("SELECT value FROM settings WHERE key='clock'").get().value,
        purchases: db.query('SELECT count(*) AS count FROM purchases').get().count,
        access: null,
        message: 'Verification saves a valid receipt. It does not connect a customer or grant Premium; customer binding is the next build step.',
      };
    },
    close() { db.close(); },
  };
}
