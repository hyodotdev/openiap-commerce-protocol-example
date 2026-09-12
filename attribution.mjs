// Attribution belongs to the host product; these fields are not protocol fields.
export function openAttribution(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS attribution (
    project_id TEXT NOT NULL, store TEXT NOT NULL, environment TEXT NOT NULL,
    chain TEXT NOT NULL, user_id TEXT NOT NULL, experiment TEXT NOT NULL, variant TEXT NOT NULL,
    PRIMARY KEY(project_id,store,environment,chain)
  )`);
  return {
    assign(sample) {
      db.query("INSERT OR IGNORE INTO attribution VALUES (?,?,?,?,?,?,?)").run(
        "fresh-example",
        sample.id,
        "sandbox",
        sample.chain,
        sample.userId,
        "onboarding",
        sample.variant,
      );
    },
    report() {
      const events = db
        .query("SELECT body FROM inbox ORDER BY rowid")
        .all()
        .map((row) => JSON.parse(row.body));
      const rows = events.map((event) => {
        const match = db
          .query(
            "SELECT experiment,variant FROM attribution WHERE project_id=? AND store=? AND environment=? AND chain=? AND user_id=?",
          )
          .get(
            event.projectId,
            event.store,
            event.environment,
            event.originalTransactionId ?? "",
            event.userId ?? "",
          );
        const charge = [
          "subscription.started",
          "subscription.renewed",
        ].includes(event.eventType);
        const known = charge && event.price?.provenance === "store";
        return {
          eventId: event.eventId,
          eventType: event.eventType,
          store: event.store,
          customer: event.userId ?? null,
          transactionId: event.transactionId ?? null,
          experiment: match?.experiment ?? null,
          variant: match?.variant ?? null,
          amount: known ? event.price : null,
          treatment: charge
            ? known
              ? "known purchase amount"
              : "amount unknown"
            : ["subscription.refunded", "subscription.recovered"].includes(
                  event.eventType,
                )
              ? "reconcile with store"
              : "lifecycle only",
        };
      });
      const totals = [];
      for (const row of rows.filter((row) => row.amount)) {
        let total = totals.find(
          (item) =>
            item.currency === row.amount.currency &&
            item.experiment === row.experiment &&
            item.variant === row.variant,
        );
        if (!total) {
          total = {
            currency: row.amount.currency,
            experiment: row.experiment,
            variant: row.variant,
            amountMicros: 0,
          };
          totals.push(total);
        }
        total.amountMicros += row.amount.amountMicros;
      }
      return {
        events: rows,
        totals,
        unknownAmounts: rows.filter((row) => row.treatment === "amount unknown")
          .length,
        reconciliation: rows.filter(
          (row) => row.treatment === "reconcile with store",
        ).length,
      };
    },
  };
}

export function eraseAttribution(db, userId) {
  db.query("DELETE FROM attribution WHERE user_id=?").run(userId);
}
