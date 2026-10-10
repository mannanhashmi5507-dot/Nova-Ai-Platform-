// ─── Enterprise: Data Export ("Backups") ──────────────────────
// Phase 15. HONEST SCOPE CHOICE, consistent with Phase 6's terminal
// decision: running pg_dump from an HTTP handler via child_process is
// a meaningful attack-surface increase, same reasoning as declining a
// real shell-command executor. What ships instead: a real, complete
// export of a USER'S OWN data as structured JSON. For actual
// full-database disaster-recovery backups, this app relies on the
// hosting provider's managed backup service (e.g. Railway's automatic
// Postgres backups).

const db = require('../db');

async function exportUserData(userId) {
  const [conversations, notes, tasks, projects, customers, invoices, goals, financialGoals] = await Promise.all([
    db.listConversations(userId, { limit: 1000 }).then(r => r.items),
    db.listNotes(userId),
    db.listTasks(userId, {}),
    db.listProjects(userId),
    db.listCustomers(userId, {}),
    db.listInvoices(userId, {}),
    db.listGoals(userId),
    db.listFinancialGoals(userId),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    userId,
    data: { conversations, notes, tasks, projects, customers, invoices, goals, financialGoals },
    note: 'This is a personal data export (conversations, notes, tasks, and related records), not a full database backup. Full-database backups are handled by the hosting provider\u2019s managed backup service.',
  };
}

module.exports = { exportUserData };
