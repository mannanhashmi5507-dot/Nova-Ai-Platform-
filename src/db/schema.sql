-- Nova AI billing schema.
-- Runs automatically on server boot (see src/db/index.js: migrate()).
-- Safe to run repeatedly — every statement is idempotent.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  google_id     TEXT UNIQUE,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per user. tier defaults to 'free' the moment a user first logs in,
-- even before any Stripe interaction — this is what makes Free-tier limits
-- enforceable instead of just aspirational.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                       SERIAL PRIMARY KEY,
  user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier                     TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id       TEXT,
  stripe_subscription_id   TEXT,
  status                   TEXT NOT NULL DEFAULT 'active', -- active | past_due | canceled | incomplete
  current_period_end       TIMESTAMPTZ,
  addons                   JSONB NOT NULL DEFAULT '[]',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- One row per user per calendar month. Incremented after every successful
-- chat message / image generation; checked before the request is allowed.
CREATE TABLE IF NOT EXISTS usage_counters (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start    DATE NOT NULL,
  messages_used   INTEGER NOT NULL DEFAULT 0,
  images_used     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_usage_user_period ON usage_counters(user_id, period_start);

-- ── Conversation history ─────────────────────────────────────
-- UUIDs here (unlike the SERIAL ids above) since these may end up in
-- exports or shared links later; users/subscriptions stay internal-only.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'New conversation',
  starred     BOOLEAN NOT NULL DEFAULT false,
  archived    BOOLEAN NOT NULL DEFAULT false,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL, -- 'user' | 'assistant'
  provider        TEXT,
  model           TEXT,
  content         TEXT NOT NULL,
  tokens          INTEGER,
  latency_ms      INTEGER,
  cost_usd        NUMERIC(10, 6),
  attachments     JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_title_search ON conversations USING gin (to_tsvector('english', title));
CREATE INDEX IF NOT EXISTS idx_messages_content_search ON messages USING gin (to_tsvector('english', content));

-- ── Victus: adaptive learning ────────────────────────────────
-- Two small tables are enough for real adaptive behavior without
-- pretending this is anything more than what it is: a feedback +
-- preference loop, not a new trained model.

-- One row per thumbs up/down a user gives an assistant message.
CREATE TABLE IF NOT EXISTS message_feedback (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id    UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  rating        SMALLINT NOT NULL CHECK (rating IN (-1, 1)), -- -1 thumbs down, 1 thumbs up
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, message_id)
);

-- Learned facts/preferences about a user, distilled periodically from
-- their own conversations (e.g. "prefers short answers", "asks a lot
-- about Urdu customer support phrasing"). Re-injected into future
-- system prompts so responses adapt to the individual user over time.
CREATE TABLE IF NOT EXISTS user_preferences (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pref_key      TEXT NOT NULL,
  pref_value    TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, pref_key)
);

CREATE INDEX IF NOT EXISTS idx_feedback_user ON message_feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_preferences_user ON user_preferences(user_id);

-- ── Real adaptive ML: online-updating style model ────────────
-- Unlike user_preferences (text facts re-injected into a prompt), this is
-- an actual small linear model per user whose WEIGHTS update from real
-- feedback via gradient steps. This is genuine, if modest, machine
-- learning: a contextual bandit choosing between response styles.

-- One row per user: their learned weight vectors (JSON arrays of floats),
-- one vector per candidate style, updated after every rated response.
CREATE TABLE IF NOT EXISTS victus_style_model (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  weights       JSONB NOT NULL DEFAULT '{"concise": [0,0,0,0], "detailed": [0,0,0,0]}',
  updates_count INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per assistant reply generated under this system: the feature
-- vector and style chosen at generation time, so that when feedback
-- arrives later (keyed by message_id) we know exactly what to update.
CREATE TABLE IF NOT EXISTS victus_style_predictions (
  message_id      UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  features        JSONB NOT NULL,
  style           TEXT NOT NULL,
  predicted_value NUMERIC NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Phase 2: Dashboard ────────────────────────────────────────

-- A user's pinned/favorite tools (e.g. "agent", "dev.review", "chat.victor").
-- Just a tool_key string, not a foreign key to anything — the set of tools
-- is defined in code (src/dashboard/tools.js), not in the database.
CREATE TABLE IF NOT EXISTS user_favorite_tools (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_key    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, tool_key)
);

-- Real, minimal notifications: generated by the system (e.g. "you're at
-- 90% of your monthly message limit", "payment failed"), not a chat/social
-- feature. Kept simple on purpose — a type + message + read flag.
CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL, -- e.g. 'usage_warning', 'billing', 'system'
  message     TEXT NOT NULL,
  read        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_favorite_tools_user ON user_favorite_tools(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

-- ── Phase 4: Victus — context compression ────────────────────
-- ALTER (not CREATE TABLE) because `conversations` already exists on
-- deployed databases — migrate() just re-runs this whole file on every
-- boot, so new columns need IF NOT EXISTS to stay idempotent and safe
-- against existing data.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS context_summary TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS messages_since_summary INTEGER NOT NULL DEFAULT 0;

-- ── Phase 8: Social Media Studio ──────────────────────────────

-- Connected social accounts. Tokens are stored ENCRYPTED (see
-- src/social/oauth.js encryptToken/decryptToken) — never plaintext.
CREATE TABLE IF NOT EXISTS social_connections (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL,
  platform_account_id TEXT,
  platform_username   TEXT,
  access_token_enc    TEXT NOT NULL,
  refresh_token_enc   TEXT,
  expires_at          TIMESTAMPTZ,
  connected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, platform)
);

-- Content calendar: a PLANNING tool. Rows here represent posts the user
-- intends to publish — this table does not itself publish anything
-- (no background job/worker exists yet to do that automatically; see
-- Phase 13 Automation in the roadmap for where that would live).
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform       TEXT NOT NULL,
  content        TEXT NOT NULL,
  hashtags       TEXT,
  scheduled_for  TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL DEFAULT 'planned', -- planned | published | canceled
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_social_connections_user ON social_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_user ON scheduled_posts(user_id, scheduled_for);

-- ── Phase 9: Business Hub ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS customers (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  email          TEXT,
  company        TEXT,
  phone          TEXT,
  stage          TEXT NOT NULL DEFAULT 'lead', -- lead | contacted | negotiating | customer | lost
  notes          TEXT,
  last_contact_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  invoice_number  TEXT NOT NULL,
  line_items      JSONB NOT NULL, -- [{description, quantity, unitPrice, lineTotal}]
  subtotal        NUMERIC(12,2) NOT NULL,
  discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  tax_rate_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  total           NUMERIC(12,2) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  status          TEXT NOT NULL DEFAULT 'draft', -- draft | sent | paid | overdue | canceled
  issue_date      DATE NOT NULL,
  due_date        DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_customers_user ON customers(user_id, stage);
CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);

-- ── Phase 10: Finance Hub ──────────────────────────────────────
-- Pure bookkeeping — the user enters their own numbers, nothing here
-- recommends what to buy/sell. See src/finance/planners.js for the math.

CREATE TABLE IF NOT EXISTS financial_assets (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other', -- cash | investments | property | other
  value       NUMERIC(14,2) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_liabilities (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other', -- loan | credit_card | mortgage | other
  value       NUMERIC(14,2) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_goals (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  target_amount   NUMERIC(14,2) NOT NULL,
  current_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
  target_date     DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_financial_assets_user ON financial_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_financial_liabilities_user ON financial_liabilities(user_id);
CREATE INDEX IF NOT EXISTS idx_financial_goals_user ON financial_goals(user_id);

-- ── Phase 11: Documents / Knowledge Base ──────────────────────
-- Only extracted TEXT is stored, not original file bytes — no object
-- storage (S3 etc.) is wired up yet to retain raw uploads.

CREATE TABLE IF NOT EXISTS documents (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  format         TEXT NOT NULL, -- pdf | docx | xlsx | pptx | csv | text
  extracted_text TEXT NOT NULL,
  char_count     INTEGER NOT NULL DEFAULT 0,
  indexed        BOOLEAN NOT NULL DEFAULT false, -- true once chunks+embeddings exist for RAG
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Embeddings stored as JSONB arrays (not pgvector) — see embeddings.js
-- for why: keeps this working on any standard Postgres, application
-- code does the cosine similarity math instead of a vector index.
CREATE TABLE IF NOT EXISTS document_chunks (
  id            SERIAL PRIMARY KEY,
  document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_text    TEXT NOT NULL,
  embedding     JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_chunks_document ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_user ON document_chunks(user_id);

-- ── Phase 12: Productivity ────────────────────────────────────

CREATE TABLE IF NOT EXISTS calendar_events (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  location    TEXT,
  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  tags        TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  description TEXT,
  priority    TEXT NOT NULL DEFAULT 'medium', -- low | medium | high
  due_date    DATE,
  completed   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goals (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  target_value   NUMERIC(14,2) NOT NULL DEFAULT 100,
  current_value  NUMERIC(14,2) NOT NULL DEFAULT 0,
  target_date    DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS habits (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  frequency   TEXT NOT NULL DEFAULT 'daily', -- daily | weekly
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS habit_logs (
  id             SERIAL PRIMARY KEY,
  habit_id       INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_date DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(habit_id, completed_date)
);

-- Real, stored reminders — see reminderParser.js for the honest note
-- that nothing currently delivers these at their due time.
CREATE TABLE IF NOT EXISTS reminders (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  due_at      TIMESTAMPTZ NOT NULL,
  recurrence  TEXT NOT NULL DEFAULT 'none', -- none | daily | weekly | monthly
  original_input TEXT,
  dismissed   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_user ON calendar_events(user_id, start_time);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, completed);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id);
CREATE INDEX IF NOT EXISTS idx_habit_logs_habit ON habit_logs(habit_id);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id, due_at);

-- ── Phase 13: Automation ───────────────────────────────────────
-- HONEST INFRASTRUCTURE CHOICE: a real job queue, backed by Postgres
-- rather than Redis/BullMQ (the tech stack in the original roadmap
-- suggested Redis+BullMQ). This app already runs on Postgres for
-- everything else (see Phase 1's session-storage decision for the same
-- reasoning) — adding Redis here would mean provisioning and paying for
-- a second infrastructure service just for this. Postgres's
-- `SELECT ... FOR UPDATE SKIP LOCKED` (used in jobQueue.js) is a real,
-- production-proven pattern for building a job queue on a relational
-- database — this is genuinely safe for concurrent workers, not a toy.
-- Tradeoff, stated plainly: polling-based, not push-based — jobs are
-- picked up on the next poll interval (a few seconds), not instantly.
-- That's the right tradeoff for reminders/workflows; it would NOT be
-- the right choice for something needing sub-second latency.
CREATE TABLE IF NOT EXISTS jobs (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | failed
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  last_error    TEXT,
  workflow_run_id INTEGER, -- groups jobs that belong to one workflow execution, see below
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

-- Tracks one execution of a multi-step workflow (e.g. "PDF → Extract
-- actions → Calendar"), so a user can see the status/result of a run
-- without digging through individual job rows.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_type TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
  result        JSONB,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at ON jobs(status, run_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_user ON workflow_runs(user_id, created_at DESC);

-- ── Phase 14: Team Features ────────────────────────────────────
-- Everything here is ADDITIVE — no existing table's meaning changes.
-- A user/conversation/subscription with no organization involved
-- behaves exactly as before this phase.

CREATE TABLE IF NOT EXISTS organizations (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, user_id)
);

CREATE TABLE IF NOT EXISTS teams (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

-- Shared workspaces: a conversation explicitly shared with an org.
-- Deliberately a SEPARATE table rather than adding an org_id column to
-- `conversations` — keeps the existing personal-conversation queries
-- (Phase 0-era code) completely untouched; sharing is purely additive.
CREATE TABLE IF NOT EXISTS conversation_shares (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id          INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shared_by_user_id INTEGER NOT NULL REFERENCES users(id),
  shared_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, org_id)
);

-- Shared AI memory: org-level facts/preferences (e.g. "our brand voice
-- is casual", "prefer metric units") injected into EVERY member's
-- Victus context alongside their personal preferences — see
-- victus/adaptive.js for how this is wired in, additively.
CREATE TABLE IF NOT EXISTS organization_preferences (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pref_key    TEXT NOT NULL,
  pref_value  TEXT NOT NULL,
  set_by_user_id INTEGER REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, pref_key)
);

-- Team billing: an organization can carry its OWN subscription,
-- separate from any individual member's personal subscription. Tier
-- resolution (see middleware/usageGate.js) checks this FIRST for a
-- member of an org with an active org subscription, and only falls
-- back to the member's personal `subscriptions` row otherwise — a user
-- with no organization is completely unaffected by this table's
-- existence.
CREATE TABLE IF NOT EXISTS organization_subscriptions (
  id                     SERIAL PRIMARY KEY,
  org_id                 INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tier                   TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL DEFAULT 'active',
  current_period_end     TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(org_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(org_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_shares_org ON conversation_shares(org_id);
CREATE INDEX IF NOT EXISTS idx_org_preferences_org ON organization_preferences(org_id);

-- ── Phase 15: Enterprise ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS api_keys (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  key_preview   TEXT NOT NULL,
  revoked       BOOLEAN NOT NULL DEFAULT false,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  org_id      INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS error_logs (
  id          SERIAL PRIMARY KEY,
  request_id  TEXT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message     TEXT NOT NULL,
  stack       TEXT,
  path        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs(created_at DESC);

-- ── Victus OS core: claims, memory, plans, tools and evolution ───────
-- These tables form the durable system-of-record for Victus intelligence state.
CREATE TABLE IF NOT EXISTS victus_knowledge_claims (
  claim_id            TEXT PRIMARY KEY,
  subject             TEXT NOT NULL,
  predicate           TEXT NOT NULL,
  object              TEXT NOT NULL,
  source              TEXT NOT NULL,
  source_type         TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence          NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  valid_from          TIMESTAMPTZ,
  valid_until         TIMESTAMPTZ,
  version             INTEGER NOT NULL DEFAULT 1,
  provenance          JSONB NOT NULL DEFAULT '{}',
  derivation          JSONB NOT NULL DEFAULT '[]',
  UNIQUE(subject, predicate, object, source)
);
CREATE INDEX IF NOT EXISTS idx_victus_claim_sp ON victus_knowledge_claims(subject, predicate);
CREATE INDEX IF NOT EXISTS idx_victus_claim_validity ON victus_knowledge_claims(valid_until);

CREATE TABLE IF NOT EXISTS victus_memory_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            TEXT,
  tier                 TEXT NOT NULL CHECK (tier IN ('WORKING','EPISODIC','SEMANTIC','PROCEDURAL','USER')),
  subject              TEXT,
  predicate             TEXT,
  object                TEXT,
  content               TEXT,
  source                TEXT,
  confidence            NUMERIC(5,4) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from            TIMESTAMPTZ,
  valid_until           TIMESTAMPTZ,
  version               INTEGER NOT NULL DEFAULT 1,
  metadata              JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_victus_memory_tenant_tier ON victus_memory_items(tenant_id, tier, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_victus_memory_subject ON victus_memory_items(subject, predicate);

CREATE TABLE IF NOT EXISTS victus_plans (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT,
  goal                TEXT NOT NULL,
  constraints         JSONB NOT NULL DEFAULT '[]',
  plan_json           JSONB NOT NULL,
  status               TEXT NOT NULL DEFAULT 'PENDING',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_victus_plans_tenant ON victus_plans(tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS victus_evolution_records (
  version_id           TEXT PRIMARY KEY,
  parent_version       TEXT NOT NULL,
  description          TEXT NOT NULL,
  reason               TEXT,
  files_changed       JSONB NOT NULL DEFAULT '[]',
  tests                JSONB NOT NULL DEFAULT '[]',
  benchmarks           JSONB NOT NULL DEFAULT '[]',
  security_results     JSONB NOT NULL DEFAULT '[]',
  deployment_result    JSONB,
  rollback_info        JSONB,
  outcome              TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_victus_evolution_outcome ON victus_evolution_records(outcome, created_at DESC);

-- ── Victus Mission Engine (v13) ───────────────────────────────────────────
-- Bounded, tenant-scoped mission state. Tasks are stored as JSONB because the
-- engine owns a small bounded DAG (max 100 tasks) and updates are transactional.
CREATE TABLE IF NOT EXISTS victus_missions (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  goal          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('DRAFT','READY','RUNNING','PAUSED','SUCCEEDED','FAILED','CANCELLED')),
  constraints   JSONB NOT NULL DEFAULT '{}',
  metadata      JSONB NOT NULL DEFAULT '{}',
  tasks         JSONB NOT NULL DEFAULT '[]',
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_victus_missions_status ON victus_missions(tenant_id, status, updated_at DESC);

-- ── Victus World Model (v12) ─────────────────────────────────────────────
-- A typed, tenant-scoped graph of users, projects, tasks, knowledge,
-- resources, tools, dependencies, events, and results. The world model is
-- descriptive state only: it does not grant permissions or execute actions.
CREATE TABLE IF NOT EXISTS victus_world_entities (
  id            TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  entity_type   TEXT NOT NULL CHECK (entity_type IN ('USER','PROJECT','TASK','KNOWLEDGE','RESOURCE','TOOL','DEPENDENCY','EVENT','RESULT')),
  name          TEXT NOT NULL,
  status        TEXT,
  confidence    NUMERIC(5,4) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  attributes    JSONB NOT NULL DEFAULT '{}',
  version       INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_victus_world_entities_type ON victus_world_entities(tenant_id, entity_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_victus_world_entities_status ON victus_world_entities(tenant_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS victus_world_edges (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  relation      TEXT NOT NULL CHECK (relation IN ('OWNS','MEMBER_OF','CONTAINS','DEPENDS_ON','BLOCKS','USES','PRODUCES','DERIVED_FROM','REFERENCES','TRIGGERS','PART_OF','ASSIGNED_TO','RELATED_TO','SUPPORTS','INVALIDATES','SUCCEEDED_BY','FAILED_BY','PRECEDES','FOLLOWS')),
  attributes    JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_id, to_id, relation),
  FOREIGN KEY (tenant_id, from_id) REFERENCES victus_world_entities(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, to_id) REFERENCES victus_world_entities(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_victus_world_edges_from ON victus_world_edges(tenant_id, from_id, relation);
CREATE INDEX IF NOT EXISTS idx_victus_world_edges_to ON victus_world_edges(tenant_id, to_id, relation);
