// ─── Database layer ──────────────────────────────────────────
// Everything here is optional at boot: if DATABASE_URL isn't set,
// isEnabled() returns false and every other function becomes a
// harmless no-op. That keeps the app bootable exactly as before
// for anyone who hasn't added Postgres yet — same defensive
// pattern the rest of this codebase already uses for GROQ_KEY /
// GEMINI_KEY (see ENV.* checks in src/index.js).

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      // Most managed Postgres (Railway included) sits behind a proxy with a
      // self-signed cert — this matches how Railway's own docs configure `pg`.
      ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    })
  : null;

const isEnabled = () => !!pool;
const getPool = () => pool; // exposed so express-session can share this exact connection pool

async function migrate() {
  if (!pool) {
    console.warn('[WARN] DATABASE_URL not set — billing/usage tracking disabled, app runs as before.');
    return;
  }
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('[OK]   Database schema ready');
}

// ── Users ────────────────────────────────────────────────────

async function upsertUserByGoogle({ googleId, email, displayName }) {
  if (!pool || !googleId || !email) return null;
  const { rows } = await pool.query(
    `INSERT INTO users (google_id, email, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (google_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
     RETURNING *`,
    [googleId, email, displayName || null]
  );
  const user = rows[0];
  // Every user gets a 'free' subscription row the moment they exist, so
  // limits are enforceable from message #1 — not just after they pay.
  await pool.query(
    `INSERT INTO subscriptions (user_id, tier) VALUES ($1, 'free') ON CONFLICT (user_id) DO NOTHING`,
    [user.id]
  );
  return user;
}

async function getUserById(id) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findUserByStripeCustomerId(customerId) {
  if (!pool || !customerId) return null;
  const { rows } = await pool.query(
    `SELECT u.* FROM users u JOIN subscriptions s ON s.user_id = u.id WHERE s.stripe_customer_id = $1`,
    [customerId]
  );
  return rows[0] || null;
}

// ── Subscriptions ────────────────────────────────────────────

async function getSubscription(userId) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM subscriptions WHERE user_id = $1`, [userId]);
  return rows[0] || null;
}

async function setSubscriptionFromStripe({ userId, tier, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO subscriptions (user_id, tier, stripe_customer_id, stripe_subscription_id, status, current_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id) DO UPDATE SET
       tier                    = EXCLUDED.tier,
       stripe_customer_id      = EXCLUDED.stripe_customer_id,
       stripe_subscription_id  = EXCLUDED.stripe_subscription_id,
       status                  = EXCLUDED.status,
       current_period_end      = EXCLUDED.current_period_end,
       updated_at              = now()
     RETURNING *`,
    [userId, tier, stripeCustomerId || null, stripeSubscriptionId || null, status || 'active', currentPeriodEnd || null]
  );
  return rows[0];
}

// ── Usage ────────────────────────────────────────────────────

function currentPeriodStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

async function getUsage(userId) {
  if (!pool) return { messagesUsed: 0, imagesUsed: 0 };
  const { rows } = await pool.query(
    `SELECT * FROM usage_counters WHERE user_id = $1 AND period_start = $2`,
    [userId, currentPeriodStart()]
  );
  if (!rows[0]) return { messagesUsed: 0, imagesUsed: 0 };
  return { messagesUsed: rows[0].messages_used, imagesUsed: rows[0].images_used };
}

async function incrementUsage(userId, kind) {
  if (!pool) return;
  const column = kind === 'images' ? 'images_used' : 'messages_used';
  await pool.query(
    `INSERT INTO usage_counters (user_id, period_start, ${column})
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, period_start) DO UPDATE SET ${column} = usage_counters.${column} + 1`,
    [userId, currentPeriodStart()]
  );
}

// ── Self-test helpers ────────────────────────────────────────
// Real checks against the live connection — not just "is the env var set."

async function ping() {
  if (!pool) throw new Error('DATABASE_URL not set');
  await pool.query('SELECT 1');
  return true;
}

async function schemaLoaded() {
  if (!pool) return false;
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [['users', 'subscriptions', 'usage_counters']]
  );
  return rows.length === 3;
}

// Historical evidence a real checkout → webhook → DB-update loop has ever
// completed. This is read from our own records, not inferred or simulated —
// it can say "yes, N times" but only ever that, never "probably."
async function getBillingEvidence() {
  if (!pool) return { linkedCount: 0, paidCount: 0, anySubscriptionLinked: false, anyPaidTier: false };
  const { rows: linked } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM subscriptions WHERE stripe_subscription_id IS NOT NULL`
  );
  const { rows: paid } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM subscriptions WHERE tier <> 'free'`
  );
  return {
    linkedCount: linked[0].count,
    paidCount: paid[0].count,
    anySubscriptionLinked: linked[0].count > 0,
    anyPaidTier: paid[0].count > 0,
  };
}

// ── Victus: adaptive learning ────────────────────────────────
// Real, simple mechanics: store thumbs up/down, store distilled
// preferences, read them back to personalize future prompts.
// No hidden model training happens here — this is a feedback loop,
// and it's described that way on purpose (see src/victus/adaptive.js).

async function saveFeedback(userId, messageId, rating) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO message_feedback (user_id, message_id, rating)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, message_id) DO UPDATE SET rating = EXCLUDED.rating
     RETURNING id, rating`,
    [userId, messageId, rating]
  );
  return rows[0] || null;
}

async function getFeedbackScore(userId) {
  if (!pool) return { total: 0, positive: 0, negative: 0 };
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE rating = 1)::int AS positive,
       COUNT(*) FILTER (WHERE rating = -1)::int AS negative
     FROM message_feedback WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || { total: 0, positive: 0, negative: 0 };
}

async function upsertPreference(userId, key, value) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO user_preferences (user_id, pref_key, pref_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, pref_key) DO UPDATE SET pref_value = EXCLUDED.pref_value, updated_at = now()
     RETURNING pref_key, pref_value`,
    [userId, key, value]
  );
  return rows[0] || null;
}

async function getPreferences(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT pref_key, pref_value FROM user_preferences WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 20`,
    [userId]
  );
  return rows;
}

// ── Victus real ML: style model (contextual bandit) ──────────

async function getStyleModel(userId) {
  if (!pool) return { concise: [0, 0, 0, 0], detailed: [0, 0, 0, 0] };
  const { rows } = await pool.query(
    `INSERT INTO victus_style_model (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING weights`,
    [userId]
  );
  return rows[0]?.weights || { concise: [0, 0, 0, 0], detailed: [0, 0, 0, 0] };
}

async function saveStyleModel(userId, weights) {
  if (!pool) return null;
  await pool.query(
    `UPDATE victus_style_model
     SET weights = $2, updates_count = updates_count + 1, updated_at = now()
     WHERE user_id = $1`,
    [userId, JSON.stringify(weights)]
  );
}

async function savePrediction(messageId, userId, features, style, predictedValue) {
  if (!pool) return null;
  await pool.query(
    `INSERT INTO victus_style_predictions (message_id, user_id, features, style, predicted_value)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, userId, JSON.stringify(features), style, predictedValue]
  );
}

async function getPrediction(messageId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT * FROM victus_style_predictions WHERE message_id = $1`,
    [messageId]
  );
  return rows[0] || null;
}

// ── Phase 2: Dashboard ────────────────────────────────────────

async function listFavoriteTools(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT tool_key, created_at FROM user_favorite_tools WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map(r => r.tool_key);
}

async function addFavoriteTool(userId, toolKey) {
  if (!pool) return null;
  await pool.query(
    `INSERT INTO user_favorite_tools (user_id, tool_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, toolKey]
  );
  return true;
}

async function removeFavoriteTool(userId, toolKey) {
  if (!pool) return null;
  await pool.query(`DELETE FROM user_favorite_tools WHERE user_id = $1 AND tool_key = $2`, [userId, toolKey]);
  return true;
}

async function listNotifications(userId, { limit = 20, unreadOnly = false } = {}) {
  if (!pool) return [];
  const clause = unreadOnly ? 'AND read = false' : '';
  const { rows } = await pool.query(
    `SELECT id, type, message, read, created_at FROM notifications
     WHERE user_id = $1 ${clause} ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function createNotification(userId, type, message) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, type, message) VALUES ($1, $2, $3) RETURNING *`,
    [userId, type, message]
  );
  return rows[0] || null;
}

async function markNotificationRead(userId, notificationId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING id`,
    [notificationId, userId]
  );
  return rows[0] || null;
}

// Real usage analytics: actual message counts per day for the last N days,
// computed from the real messages table — not placeholder/sample data.
async function getUsageAnalytics(userId, days = 7) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT date_trunc('day', m.created_at) AS day, COUNT(*)::int AS message_count
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.user_id = $1
       AND m.role = 'user'
       AND m.created_at >= now() - ($2 || ' days')::interval
     GROUP BY day
     ORDER BY day ASC`,
    [userId, days]
  );
  return rows.map(r => ({ date: r.day, messages: r.message_count }));
}

// ── Phase 4: Victus — context compression ────────────────────

async function getConversationContext(conversationId) {
  if (!pool) return { contextSummary: null, messagesSinceSummary: 0 };
  const { rows } = await pool.query(
    `SELECT context_summary, messages_since_summary FROM conversations WHERE id = $1`,
    [conversationId]
  );
  if (!rows[0]) return { contextSummary: null, messagesSinceSummary: 0 };
  return { contextSummary: rows[0].context_summary, messagesSinceSummary: rows[0].messages_since_summary };
}

async function updateContextSummary(conversationId, summary) {
  if (!pool) return null;
  await pool.query(
    `UPDATE conversations SET context_summary = $2, messages_since_summary = 0 WHERE id = $1`,
    [conversationId, summary]
  );
}

async function incrementMessagesSinceSummary(conversationId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE conversations SET messages_since_summary = messages_since_summary + 1
     WHERE id = $1 RETURNING messages_since_summary`,
    [conversationId]
  );
  return rows[0]?.messages_since_summary ?? 0;
}

// ── Phase 8: Social Media Studio ──────────────────────────────

async function saveSocialConnection(userId, platform, { platformAccountId, platformUsername, accessTokenEnc, refreshTokenEnc, expiresAt }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO social_connections (user_id, platform, platform_account_id, platform_username, access_token_enc, refresh_token_enc, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, platform) DO UPDATE SET
       platform_account_id = EXCLUDED.platform_account_id,
       platform_username = EXCLUDED.platform_username,
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       expires_at = EXCLUDED.expires_at,
       connected_at = now()
     RETURNING id, platform, platform_username, connected_at`,
    [userId, platform, platformAccountId || null, platformUsername || null, accessTokenEnc, refreshTokenEnc || null, expiresAt || null]
  );
  return rows[0] || null;
}

async function listSocialConnections(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, platform, platform_username, connected_at, expires_at FROM social_connections WHERE user_id = $1 ORDER BY connected_at DESC`,
    [userId]
  );
  return rows; // deliberately excludes token columns — never return encrypted tokens to the client
}

async function getSocialConnectionToken(userId, platform) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT access_token_enc, refresh_token_enc, expires_at FROM social_connections WHERE user_id = $1 AND platform = $2`,
    [userId, platform]
  );
  return rows[0] || null;
}

async function removeSocialConnection(userId, platform) {
  if (!pool) return null;
  await pool.query(`DELETE FROM social_connections WHERE user_id = $1 AND platform = $2`, [userId, platform]);
  return true;
}

async function createScheduledPost(userId, { platform, content, hashtags, scheduledFor }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO scheduled_posts (user_id, platform, content, hashtags, scheduled_for) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, platform, content, hashtags || null, scheduledFor]
  );
  return rows[0] || null;
}

async function listScheduledPosts(userId, { status } = {}) {
  if (!pool) return [];
  const clause = status ? 'AND status = $2' : '';
  const params = status ? [userId, status] : [userId];
  const { rows } = await pool.query(
    `SELECT * FROM scheduled_posts WHERE user_id = $1 ${clause} ORDER BY scheduled_for ASC`,
    params
  );
  return rows;
}

async function updateScheduledPost(id, userId, updates) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE scheduled_posts SET
       content = COALESCE($3, content),
       hashtags = COALESCE($4, hashtags),
       scheduled_for = COALESCE($5, scheduled_for),
       status = COALESCE($6, status),
       updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, updates.content || null, updates.hashtags || null, updates.scheduledFor || null, updates.status || null]
  );
  return rows[0] || null;
}

async function deleteScheduledPost(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM scheduled_posts WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

// ── Phase 9: Business Hub ─────────────────────────────────────

async function createCustomer(userId, { name, email, company, phone, stage, notes }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO customers (user_id, name, email, company, phone, stage, notes)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'lead'), $7) RETURNING *`,
    [userId, name, email || null, company || null, phone || null, stage || null, notes || null]
  );
  return rows[0] || null;
}

async function listCustomers(userId, { stage } = {}) {
  if (!pool) return [];
  const clause = stage ? 'AND stage = $2' : '';
  const params = stage ? [userId, stage] : [userId];
  const { rows } = await pool.query(`SELECT * FROM customers WHERE user_id = $1 ${clause} ORDER BY updated_at DESC`, params);
  return rows;
}

async function getCustomer(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM customers WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rows[0] || null;
}

async function updateCustomer(id, userId, updates) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE customers SET
       name = COALESCE($3, name), email = COALESCE($4, email), company = COALESCE($5, company),
       phone = COALESCE($6, phone), stage = COALESCE($7, stage), notes = COALESCE($8, notes),
       last_contact_at = COALESCE($9, last_contact_at), updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, updates.name || null, updates.email || null, updates.company || null, updates.phone || null, updates.stage || null, updates.notes || null, updates.lastContactAt || null]
  );
  return rows[0] || null;
}

async function deleteCustomer(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM customers WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

async function createInvoice(userId, invoice) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO invoices (user_id, customer_id, invoice_number, line_items, subtotal, discount_percent, tax_rate_percent, total, currency, status, issue_date, due_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,'draft'),$11,$12,$13) RETURNING *`,
    [userId, invoice.customerId || null, invoice.invoiceNumber, JSON.stringify(invoice.lineItems), invoice.subtotal,
     invoice.discountPercent || 0, invoice.taxRatePercent || 0, invoice.total, invoice.currency || 'USD',
     invoice.status || null, invoice.issueDate, invoice.dueDate || null, invoice.notes || null]
  );
  return rows[0] || null;
}

async function listInvoices(userId, { status } = {}) {
  if (!pool) return [];
  const clause = status ? 'AND status = $2' : '';
  const params = status ? [userId, status] : [userId];
  const { rows } = await pool.query(`SELECT * FROM invoices WHERE user_id = $1 ${clause} ORDER BY issue_date DESC`, params);
  return rows;
}

async function getInvoice(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM invoices WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rows[0] || null;
}

async function updateInvoiceStatus(id, userId, status) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE invoices SET status = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, status]
  );
  return rows[0] || null;
}

// Real business analytics — aggregated from actual CRM/invoice rows,
// nothing sampled or invented.
async function getBusinessAnalytics(userId) {
  if (!pool) return { customersByStage: {}, revenue: { paid: 0, outstanding: 0, overdue: 0 }, totalCustomers: 0, totalInvoices: 0 };

  const [stageRows, revenueRows] = await Promise.all([
    pool.query(`SELECT stage, COUNT(*)::int AS count FROM customers WHERE user_id = $1 GROUP BY stage`, [userId]),
    pool.query(
      `SELECT
         COALESCE(SUM(total) FILTER (WHERE status = 'paid'), 0) AS paid,
         COALESCE(SUM(total) FILTER (WHERE status IN ('sent', 'draft')), 0) AS outstanding,
         COALESCE(SUM(total) FILTER (WHERE status = 'overdue'), 0) AS overdue,
         COUNT(*)::int AS total_invoices
       FROM invoices WHERE user_id = $1`,
      [userId]
    ),
  ]);

  const customersByStage = {};
  let totalCustomers = 0;
  for (const row of stageRows.rows) { customersByStage[row.stage] = row.count; totalCustomers += row.count; }

  const rev = revenueRows.rows[0];
  return {
    customersByStage,
    totalCustomers,
    totalInvoices: rev.total_invoices,
    revenue: { paid: Number(rev.paid), outstanding: Number(rev.outstanding), overdue: Number(rev.overdue) },
  };
}

// ── Phase 10: Finance Hub ──────────────────────────────────────

async function addAsset(userId, { name, category, value }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO financial_assets (user_id, name, category, value) VALUES ($1,$2,COALESCE($3,'other'),$4) RETURNING *`,
    [userId, name, category || null, value]
  );
  return rows[0] || null;
}
async function listAssets(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM financial_assets WHERE user_id = $1 ORDER BY recorded_at DESC`, [userId]);
  return rows;
}
async function deleteAsset(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM financial_assets WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

async function addLiability(userId, { name, category, value }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO financial_liabilities (user_id, name, category, value) VALUES ($1,$2,COALESCE($3,'other'),$4) RETURNING *`,
    [userId, name, category || null, value]
  );
  return rows[0] || null;
}
async function listLiabilities(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM financial_liabilities WHERE user_id = $1 ORDER BY recorded_at DESC`, [userId]);
  return rows;
}
async function deleteLiability(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM financial_liabilities WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

async function createFinancialGoal(userId, { name, targetAmount, currentAmount, targetDate }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO financial_goals (user_id, name, target_amount, current_amount, target_date) VALUES ($1,$2,$3,COALESCE($4,0),$5) RETURNING *`,
    [userId, name, targetAmount, currentAmount || null, targetDate || null]
  );
  return rows[0] || null;
}
async function listFinancialGoals(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM financial_goals WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return rows;
}
async function updateFinancialGoal(id, userId, updates) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE financial_goals SET
       name = COALESCE($3, name), target_amount = COALESCE($4, target_amount),
       current_amount = COALESCE($5, current_amount), target_date = COALESCE($6, target_date), updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, updates.name || null, updates.targetAmount || null, updates.currentAmount ?? null, updates.targetDate || null]
  );
  return rows[0] || null;
}
async function deleteFinancialGoal(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM financial_goals WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

// ── Phase 11: Documents / Knowledge Base ──────────────────────

async function createDocument(userId, { filename, format, extractedText }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO documents (user_id, filename, format, extracted_text, char_count) VALUES ($1,$2,$3,$4,$5) RETURNING id, filename, format, char_count, indexed, created_at`,
    [userId, filename, format, extractedText, extractedText.length]
  );
  return rows[0] || null;
}

async function listDocuments(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, filename, format, char_count, indexed, created_at FROM documents WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function getDocument(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM documents WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rows[0] || null;
}

async function deleteDocument(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM documents WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

async function markDocumentIndexed(id) {
  if (!pool) return null;
  await pool.query(`UPDATE documents SET indexed = true WHERE id = $1`, [id]);
}

async function saveDocumentChunks(documentId, userId, chunks) {
  // chunks: [{ chunkIndex, text, embedding }]
  if (!pool || chunks.length === 0) return 0;
  const values = [];
  const params = [];
  chunks.forEach((c, i) => {
    const base = i * 5;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    params.push(documentId, userId, c.chunkIndex, c.text, JSON.stringify(c.embedding));
  });
  await pool.query(
    `INSERT INTO document_chunks (document_id, user_id, chunk_index, chunk_text, embedding) VALUES ${values.join(',')}`,
    params
  );
  return chunks.length;
}

async function getDocumentChunks(documentId, userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, chunk_index, chunk_text, embedding FROM document_chunks WHERE document_id = $1 AND user_id = $2 ORDER BY chunk_index ASC`,
    [documentId, userId]
  );
  return rows.map(r => ({ id: r.id, chunkIndex: r.chunk_index, text: r.chunk_text, embedding: r.embedding }));
}

async function getAllUserChunks(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT dc.id, dc.document_id, dc.chunk_text, dc.embedding, d.filename
     FROM document_chunks dc JOIN documents d ON d.id = dc.document_id
     WHERE dc.user_id = $1`,
    [userId]
  );
  return rows.map(r => ({ id: r.id, documentId: r.document_id, text: r.chunk_text, embedding: r.embedding, filename: r.filename }));
}

// ── Phase 12: Productivity ────────────────────────────────────

// Calendar
async function createEvent(userId, { title, description, location, startTime, endTime }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO calendar_events (user_id, title, description, location, start_time, end_time) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, title, description || null, location || null, startTime, endTime || null]
  );
  return rows[0] || null;
}
async function listEvents(userId, { from, to } = {}) {
  if (!pool) return [];
  const clauses = [];
  const params = [userId];
  if (from) { params.push(from); clauses.push(`AND start_time >= $${params.length}`); }
  if (to)   { params.push(to);   clauses.push(`AND start_time <= $${params.length}`); }
  const { rows } = await pool.query(`SELECT * FROM calendar_events WHERE user_id = $1 ${clauses.join(' ')} ORDER BY start_time ASC`, params);
  return rows;
}
async function deleteEvent(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM calendar_events WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

// Notes
async function createNote(userId, { title, content, tags }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO notes (user_id, title, content, tags) VALUES ($1,$2,$3,COALESCE($4,'{}')) RETURNING *`,
    [userId, title, content || '', tags || null]
  );
  return rows[0] || null;
}
async function listNotes(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM notes WHERE user_id = $1 ORDER BY updated_at DESC`, [userId]);
  return rows;
}
async function getNote(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM notes WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rows[0] || null;
}
async function updateNote(id, userId, updates) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE notes SET title = COALESCE($3,title), content = COALESCE($4,content), tags = COALESCE($5,tags), updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, updates.title || null, updates.content ?? null, updates.tags || null]
  );
  return rows[0] || null;
}
async function deleteNote(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM notes WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

// Projects & Tasks
async function createProject(userId, { name, description }) {
  if (!pool) return null;
  const { rows } = await pool.query(`INSERT INTO projects (user_id, name, description) VALUES ($1,$2,$3) RETURNING *`, [userId, name, description || null]);
  return rows[0] || null;
}
async function listProjects(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return rows;
}
async function deleteProject(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM projects WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

async function createTask(userId, { projectId, title, description, priority, dueDate }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO tasks (user_id, project_id, title, description, priority, due_date) VALUES ($1,$2,$3,$4,COALESCE($5,'medium'),$6) RETURNING *`,
    [userId, projectId || null, title, description || null, priority || null, dueDate || null]
  );
  return rows[0] || null;
}
async function listTasks(userId, { projectId, completed } = {}) {
  if (!pool) return [];
  const clauses = [];
  const params = [userId];
  if (projectId !== undefined) { params.push(projectId); clauses.push(`AND project_id = $${params.length}`); }
  if (completed !== undefined) { params.push(completed); clauses.push(`AND completed = $${params.length}`); }
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE user_id = $1 ${clauses.join(' ')} ORDER BY due_date ASC NULLS LAST, created_at DESC`, params);
  return rows;
}
async function updateTask(id, userId, updates) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE tasks SET title = COALESCE($3,title), description = COALESCE($4,description), priority = COALESCE($5,priority),
       due_date = COALESCE($6,due_date), completed = COALESCE($7,completed), updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, updates.title || null, updates.description ?? null, updates.priority || null, updates.dueDate || null, updates.completed ?? null]
  );
  return rows[0] || null;
}
async function deleteTask(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM tasks WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

// Goals
async function createGoal(userId, { name, targetValue, currentValue, targetDate }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO goals (user_id, name, target_value, current_value, target_date) VALUES ($1,$2,COALESCE($3,100),COALESCE($4,0),$5) RETURNING *`,
    [userId, name, targetValue || null, currentValue || null, targetDate || null]
  );
  return rows[0] || null;
}
async function listGoals(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM goals WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return rows;
}
async function updateGoal(id, userId, updates) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE goals SET name = COALESCE($3,name), target_value = COALESCE($4,target_value),
       current_value = COALESCE($5,current_value), target_date = COALESCE($6,target_date), updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, updates.name || null, updates.targetValue ?? null, updates.currentValue ?? null, updates.targetDate || null]
  );
  return rows[0] || null;
}
async function deleteGoal(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM goals WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}

// Habits
async function createHabit(userId, { name, frequency }) {
  if (!pool) return null;
  const { rows } = await pool.query(`INSERT INTO habits (user_id, name, frequency) VALUES ($1,$2,COALESCE($3,'daily')) RETURNING *`, [userId, name, frequency || null]);
  return rows[0] || null;
}
async function listHabits(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM habits WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return rows;
}
async function deleteHabit(id, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM habits WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rowCount > 0;
}
async function logHabitCompletion(habitId, userId, date) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO habit_logs (habit_id, user_id, completed_date) VALUES ($1,$2,$3) ON CONFLICT (habit_id, completed_date) DO NOTHING RETURNING *`,
    [habitId, userId, date]
  );
  return rows[0] || null;
}
async function getHabitLogs(habitId, userId) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT completed_date FROM habit_logs WHERE habit_id = $1 AND user_id = $2 ORDER BY completed_date ASC`, [habitId, userId]);
  return rows.map(r => r.completed_date);
}

// Reminders
async function createReminder(userId, { title, dueAt, recurrence, originalInput }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO reminders (user_id, title, due_at, recurrence, original_input) VALUES ($1,$2,$3,COALESCE($4,'none'),$5) RETURNING *`,
    [userId, title, dueAt, recurrence || null, originalInput || null]
  );
  return rows[0] || null;
}
async function listReminders(userId, { includeDismissed = false } = {}) {
  if (!pool) return [];
  const clause = includeDismissed ? '' : 'AND dismissed = false';
  const { rows } = await pool.query(`SELECT * FROM reminders WHERE user_id = $1 ${clause} ORDER BY due_at ASC`, [userId]);
  return rows;
}
async function dismissReminder(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(`UPDATE reminders SET dismissed = true WHERE id = $1 AND user_id = $2 RETURNING *`, [id, userId]);
  return rows[0] || null;
}

// ── Phase 13: Automation — job queue ───────────────────────────

async function enqueueJob({ userId, type, payload, runAt, maxAttempts, workflowRunId }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO jobs (user_id, type, payload, run_at, max_attempts, workflow_run_id)
     VALUES ($1,$2,$3,COALESCE($4, now()),COALESCE($5,3),$6) RETURNING *`,
    [userId || null, type, JSON.stringify(payload || {}), runAt || null, maxAttempts || null, workflowRunId || null]
  );
  return rows[0] || null;
}

// The core of the queue: atomically claims ONE due, pending job for
// processing. `FOR UPDATE SKIP LOCKED` is what makes this safe with
// multiple workers running concurrently — a locked (already-claimed)
// row is simply skipped rather than causing a worker to block waiting
// for it, so workers never double-process the same job.
async function claimNextJob() {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'pending' AND run_at <= now()
       ORDER BY run_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  return rows[0] || null;
}

async function completeJob(id, result) {
  if (!pool) return null;
  await pool.query(`UPDATE jobs SET status = 'completed', completed_at = now(), payload = payload || $2 WHERE id = $1`, [id, JSON.stringify({ result: result || null })]);
}

// Failure with real retry logic: if attempts haven't exhausted
// max_attempts, the job goes back to 'pending' with a backoff delay
// (not an immediate retry-storm); otherwise it's marked permanently failed.
async function failJob(id, errorMessage, backoffSeconds = 30) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT attempts, max_attempts FROM jobs WHERE id = $1`, [id]);
  const job = rows[0];
  if (!job) return null;

  if (job.attempts < job.max_attempts) {
    await pool.query(
      `UPDATE jobs SET status = 'pending', last_error = $2, run_at = now() + ($3 || ' seconds')::interval WHERE id = $1`,
      [id, errorMessage, backoffSeconds * job.attempts] // linear backoff: longer wait each retry
    );
    return { retried: true };
  } else {
    await pool.query(`UPDATE jobs SET status = 'failed', last_error = $2, completed_at = now() WHERE id = $1`, [id, errorMessage]);
    return { retried: false };
  }
}

async function listJobs(userId, { status } = {}) {
  if (!pool) return [];
  const clause = status ? 'AND status = $2' : '';
  const params = status ? [userId, status] : [userId];
  const { rows } = await pool.query(`SELECT * FROM jobs WHERE user_id = $1 ${clause} ORDER BY created_at DESC LIMIT 100`, params);
  return rows;
}

async function createWorkflowRun(userId, workflowType) {
  if (!pool) return null;
  const { rows } = await pool.query(`INSERT INTO workflow_runs (user_id, workflow_type) VALUES ($1,$2) RETURNING *`, [userId, workflowType]);
  return rows[0] || null;
}
async function completeWorkflowRun(id, result) {
  if (!pool) return null;
  await pool.query(`UPDATE workflow_runs SET status = 'completed', result = $2, completed_at = now() WHERE id = $1`, [id, JSON.stringify(result)]);
}
async function failWorkflowRun(id, errorMessage) {
  if (!pool) return null;
  await pool.query(`UPDATE workflow_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`, [id, errorMessage]);
}
async function getWorkflowRun(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM workflow_runs WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rows[0] || null;
}
async function listWorkflowRuns(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM workflow_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]);
  return rows;
}

// ── Phase 14: Team Features ────────────────────────────────────

async function createOrganization(ownerUserId, name) {
  if (!pool) return null;
  // Real transaction: creating the org and adding its owner as a member
  // must be atomic — a partial failure (org created, membership insert
  // fails) would leave an organization with no owner, which every
  // permission check in permissions.js assumes can't happen.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`INSERT INTO organizations (name, owner_user_id) VALUES ($1,$2) RETURNING *`, [name, ownerUserId]);
    const org = rows[0];
    await client.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1,$2,'owner')`, [org.id, ownerUserId]);
    await client.query('COMMIT');
    return org;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
async function getOrganization(id) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM organizations WHERE id = $1`, [id]);
  return rows[0] || null;
}
async function listUserOrganizations(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT o.*, om.role FROM organizations o JOIN organization_members om ON om.org_id = o.id WHERE om.user_id = $1 ORDER BY o.created_at DESC`,
    [userId]
  );
  return rows;
}
async function deleteOrganization(id) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM organizations WHERE id = $1`, [id]);
  return rowCount > 0;
}

async function getOrgMembership(orgId, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM organization_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  return rows[0] || null;
}
async function listOrgMembers(orgId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT om.user_id, om.role, om.joined_at, u.email, u.display_name FROM organization_members om JOIN users u ON u.id = om.user_id WHERE om.org_id = $1 ORDER BY om.joined_at ASC`,
    [orgId]
  );
  return rows;
}
async function addOrgMember(orgId, userId, role = 'member') {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (org_id, user_id) DO NOTHING RETURNING *`,
    [orgId, userId, role]
  );
  return rows[0] || null;
}
async function updateOrgMemberRole(orgId, userId, role) {
  if (!pool) return null;
  const { rows } = await pool.query(`UPDATE organization_members SET role = $3 WHERE org_id = $1 AND user_id = $2 RETURNING *`, [orgId, userId, role]);
  return rows[0] || null;
}
async function removeOrgMember(orgId, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  return rowCount > 0;
}
async function findUserByEmail(email) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT id, email, display_name FROM users WHERE email = $1`, [email]);
  return rows[0] || null;
}

async function createTeam(orgId, name) {
  if (!pool) return null;
  const { rows } = await pool.query(`INSERT INTO teams (org_id, name) VALUES ($1,$2) RETURNING *`, [orgId, name]);
  return rows[0] || null;
}
async function listOrgTeams(orgId) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM teams WHERE org_id = $1 ORDER BY created_at ASC`, [orgId]);
  return rows;
}
async function deleteTeam(id, orgId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM teams WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return rowCount > 0;
}
async function addTeamMember(teamId, userId) {
  if (!pool) return null;
  await pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [teamId, userId]);
  return true;
}
async function removeTeamMember(teamId, userId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [teamId, userId]);
  return rowCount > 0;
}
async function listTeamMembers(teamId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT tm.user_id, u.email, u.display_name FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = $1`,
    [teamId]
  );
  return rows;
}

// Shared workspaces
async function shareConversation(conversationId, orgId, sharedByUserId) {
  if (!pool) return null;
  await pool.query(
    `INSERT INTO conversation_shares (conversation_id, org_id, shared_by_user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [conversationId, orgId, sharedByUserId]
  );
  return true;
}
async function unshareConversation(conversationId, orgId) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM conversation_shares WHERE conversation_id = $1 AND org_id = $2`, [conversationId, orgId]);
  return rowCount > 0;
}
async function listSharedConversations(orgId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.created_at, c.updated_at, cs.shared_by_user_id, cs.shared_at, u.display_name AS shared_by_name
     FROM conversation_shares cs
     JOIN conversations c ON c.id = cs.conversation_id
     JOIN users u ON u.id = cs.shared_by_user_id
     WHERE cs.org_id = $1 AND c.deleted_at IS NULL
     ORDER BY cs.shared_at DESC`,
    [orgId]
  );
  return rows;
}

// Shared AI memory (org-level preferences)
async function setOrgPreference(orgId, key, value, setByUserId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO organization_preferences (org_id, pref_key, pref_value, set_by_user_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, pref_key) DO UPDATE SET pref_value = EXCLUDED.pref_value, set_by_user_id = EXCLUDED.set_by_user_id, updated_at = now()
     RETURNING *`,
    [orgId, key, value, setByUserId]
  );
  return rows[0] || null;
}
async function listOrgPreferences(orgId) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT pref_key, pref_value FROM organization_preferences WHERE org_id = $1 ORDER BY updated_at DESC`, [orgId]);
  return rows;
}
async function deleteOrgPreference(orgId, key) {
  if (!pool) return null;
  const { rowCount } = await pool.query(`DELETE FROM organization_preferences WHERE org_id = $1 AND pref_key = $2`, [orgId, key]);
  return rowCount > 0;
}
// Used by Victus (adaptive.js) to fold shared org memory into a
// member's context — returns [] for a user in no organization, so this
// is a pure no-op addition for anyone not using team features.
async function getUserOrgPreferences(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT op.pref_key, op.pref_value FROM organization_preferences op
     JOIN organization_members om ON om.org_id = op.org_id
     WHERE om.user_id = $1 ORDER BY op.updated_at DESC LIMIT 10`,
    [userId]
  );
  return rows;
}

// Team billing
async function getOrgSubscription(orgId) {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT * FROM organization_subscriptions WHERE org_id = $1`, [orgId]);
  return rows[0] || null;
}
async function setOrgSubscription(orgId, { tier, status, stripeCustomerId, stripeSubscriptionId, currentPeriodEnd }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO organization_subscriptions (org_id, tier, status, stripe_customer_id, stripe_subscription_id, current_period_end)
     VALUES ($1,$2,COALESCE($3,'active'),$4,$5,$6)
     ON CONFLICT (org_id) DO UPDATE SET tier = EXCLUDED.tier, status = EXCLUDED.status,
       stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       current_period_end = EXCLUDED.current_period_end, updated_at = now()
     RETURNING *`,
    [orgId, tier, status || null, stripeCustomerId || null, stripeSubscriptionId || null, currentPeriodEnd || null]
  );
  return rows[0] || null;
}
// Used by usageGate.js tier resolution — returns null for a user in no
// organization (or whose org has no active org subscription), meaning
// tier resolution falls through to the existing personal-subscription
// lookup exactly as it did before this phase.
async function getActiveOrgSubscriptionForUser(userId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT os.* FROM organization_subscriptions os
     JOIN organization_members om ON om.org_id = os.org_id
     WHERE om.user_id = $1 AND os.status = 'active'
     ORDER BY os.updated_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

// ── Phase 15: Enterprise ───────────────────────────────────────

async function createApiKey(userId, name, keyHash, keyPreview) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO api_keys (user_id, name, key_hash, key_preview) VALUES ($1,$2,$3,$4) RETURNING id, name, key_preview, created_at`,
    [userId, name, keyHash, keyPreview]
  );
  return rows[0] || null;
}
async function listApiKeys(userId) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, name, key_preview, revoked, last_used_at, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}
async function revokeApiKey(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(`UPDATE api_keys SET revoked = true WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  return rows[0] || null;
}
async function getUserByApiKeyHash(keyHash) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE api_keys SET last_used_at = now()
     WHERE key_hash = $1 AND revoked = false
     RETURNING user_id`,
    [keyHash]
  );
  if (!rows[0]) return null;
  return getUserById(rows[0].user_id);
}

async function recordAuditLog({ userId, orgId, action, targetType, targetId, metadata }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO audit_logs (user_id, org_id, action, target_type, target_id, metadata) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId || null, orgId || null, action, targetType || null, targetId ? String(targetId) : null, JSON.stringify(metadata || {})]
  );
  return rows[0] || null;
}
async function listAuditLogs(orgId, { limit = 100 } = {}) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT al.*, u.email AS user_email FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
     WHERE al.org_id = $1 ORDER BY al.created_at DESC LIMIT $2`,
    [orgId, limit]
  );
  return rows;
}

async function recordErrorLog({ requestId, userId, message, stack, path }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO error_logs (request_id, user_id, message, stack, path) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [requestId || null, userId || null, message, stack || null, path || null]
  );
  return rows[0] || null;
}
async function listErrorLogs({ limit = 50 } = {}) {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT * FROM error_logs ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows;
}

module.exports = {
  isEnabled,
  getPool,
  migrate,
  upsertUserByGoogle,
  getUserById,
  findUserByStripeCustomerId,
  getSubscription,
  setSubscriptionFromStripe,
  getUsage,
  incrementUsage,
  ping,
  schemaLoaded,
  getBillingEvidence,
  createConversation,
  listConversations,
  getConversation,
  updateConversation,
  softDeleteConversation,
  addMessage,
  listMessages,
  searchConversations,
  saveFeedback,
  getFeedbackScore,
  upsertPreference,
  getPreferences,
  getStyleModel,
  saveStyleModel,
  savePrediction,
  getPrediction,
  listFavoriteTools,
  addFavoriteTool,
  removeFavoriteTool,
  listNotifications,
  createNotification,
  markNotificationRead,
  getUsageAnalytics,
  getConversationContext,
  updateContextSummary,
  incrementMessagesSinceSummary,
  saveSocialConnection,
  listSocialConnections,
  getSocialConnectionToken,
  removeSocialConnection,
  createScheduledPost,
  listScheduledPosts,
  updateScheduledPost,
  deleteScheduledPost,
  createCustomer,
  listCustomers,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  createInvoice,
  listInvoices,
  getInvoice,
  updateInvoiceStatus,
  getBusinessAnalytics,
  addAsset,
  listAssets,
  deleteAsset,
  addLiability,
  listLiabilities,
  deleteLiability,
  createFinancialGoal,
  listFinancialGoals,
  updateFinancialGoal,
  deleteFinancialGoal,
  createDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  markDocumentIndexed,
  saveDocumentChunks,
  getDocumentChunks,
  getAllUserChunks,
  createEvent,
  listEvents,
  deleteEvent,
  createNote,
  listNotes,
  getNote,
  updateNote,
  deleteNote,
  createProject,
  listProjects,
  deleteProject,
  createTask,
  listTasks,
  updateTask,
  deleteTask,
  createGoal,
  listGoals,
  updateGoal,
  deleteGoal,
  createHabit,
  listHabits,
  deleteHabit,
  logHabitCompletion,
  getHabitLogs,
  createReminder,
  listReminders,
  dismissReminder,
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  listJobs,
  createWorkflowRun,
  completeWorkflowRun,
  failWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  createOrganization,
  getOrganization,
  listUserOrganizations,
  deleteOrganization,
  getOrgMembership,
  listOrgMembers,
  addOrgMember,
  updateOrgMemberRole,
  removeOrgMember,
  findUserByEmail,
  createTeam,
  listOrgTeams,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
  listTeamMembers,
  shareConversation,
  unshareConversation,
  listSharedConversations,
  setOrgPreference,
  listOrgPreferences,
  deleteOrgPreference,
  getUserOrgPreferences,
  getOrgSubscription,
  setOrgSubscription,
  getActiveOrgSubscriptionForUser,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  getUserByApiKeyHash,
  recordAuditLog,
  listAuditLogs,
  recordErrorLog,
  listErrorLogs,
};

// ── Conversations ─────────────────────────────────────────────

async function createConversation(userId, title) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING *`,
    [userId, title || 'New conversation']
  );
  return rows[0];
}

async function listConversations(userId, { limit = 50, cursor = null, archived = false } = {}) {
  if (!pool) return { items: [], nextCursor: null };
  const params = [userId, archived, limit + 1];
  let cursorClause = '';
  if (cursor) {
    params.push(cursor);
    cursorClause = `AND updated_at < $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT id, title, starred, archived, created_at, updated_at
     FROM conversations
     WHERE user_id = $1 AND archived = $2 AND deleted_at IS NULL ${cursorClause}
     ORDER BY updated_at DESC
     LIMIT $3`,
    params
  );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].updated_at : null };
}

async function getConversation(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT * FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId]
  );
  return rows[0] || null;
}

async function updateConversation(id, userId, { title, starred, archived }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE conversations SET
       title = COALESCE($3, title),
       starred = COALESCE($4, starred),
       archived = COALESCE($5, archived),
       updated_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [id, userId, title ?? null, starred ?? null, archived ?? null]
  );
  return rows[0] || null;
}

// Soft delete only — never a real DELETE, per spec.
async function softDeleteConversation(id, userId) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `UPDATE conversations SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
    [id, userId]
  );
  return rows[0] || null;
}

// ── Messages ─────────────────────────────────────────────────

async function addMessage(conversationId, { role, provider = null, model = null, content, tokens = null, latencyMs = null, costUsd = null, attachments = [] }) {
  if (!pool) return null;
  const { rows } = await pool.query(
    `INSERT INTO messages (conversation_id, role, provider, model, content, tokens, latency_ms, cost_usd, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [conversationId, role, provider, model, content, tokens, latencyMs, costUsd, JSON.stringify(attachments || [])]
  );
  await pool.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
  return rows[0];
}

async function listMessages(conversationId, { limit = 50, cursor = null } = {}) {
  if (!pool) return { items: [], nextCursor: null };
  const params = [conversationId, limit + 1];
  let cursorClause = '';
  if (cursor) {
    params.push(cursor);
    cursorClause = `AND created_at > $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE conversation_id = $1 ${cursorClause} ORDER BY created_at ASC LIMIT $2`,
    params
  );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].created_at : null };
}

// Partial-match search across conversation titles and message content,
// scoped to the requesting user's own conversations only.
async function searchConversations(userId, query, { limit = 50, cursor = null } = {}) {
  if (!pool || !query) return { items: [], nextCursor: null };
  const like = `%${query}%`;
  const params = [userId, like, limit + 1];
  let cursorClause = '';
  if (cursor) {
    params.push(cursor);
    cursorClause = `AND c.updated_at < $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT c.id, c.title, c.starred, c.archived, c.created_at, c.updated_at
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id
     WHERE c.user_id = $1 AND c.deleted_at IS NULL
       AND (c.title ILIKE $2 OR m.content ILIKE $2) ${cursorClause}
     ORDER BY c.updated_at DESC
     LIMIT $3`,
    params
  );
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].updated_at : null };
}
