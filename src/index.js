const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const path       = require('path');
const https      = require('https');
const dns        = require('dns');
const rateLimit  = require('express-rate-limit');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const passport   = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

const db            = require('./db');
const victus         = require('./victus/adaptive');
const styleModel     = require('./victus/styleModel');
const contextCompression = require('./victus/contextCompression');
const toneFingerprint = require('./victus/styleFingerprint');
const orchestrator   = require('./victus/orchestrator');
const { makeTools }  = require('./agents/tools');
const { runPersonaAgent } = require('./agents/framework');
const agentRegistry = require('./agents/registry');
const { runCodingAgent, VALID_MODES, DESCRIPTION_MODES, MAX_CODE_LENGTH } = require('./devhub/codingAgent');
const { detectLanguage: detectCodingLanguage } = require('./devhub/codingIntelligence');
const githubIntegration = require('./devhub/github');
const terminalAssistant = require('./devhub/terminalAssistant');
const imagePrompts   = require('./creator/imagePrompts');
const replicate      = require('./creator/replicate');
const subtitles      = require('./creator/subtitles');
const contentGenerator = require('./social/contentGenerator');
const replyAssistant = require('./social/replyAssistant');
const billing       = require('./billing/stripe');
const billingRoutes = require('./billing/routes');
const conversationsRoutes = require('./conversations/routes');
const dashboardRoutes = require('./dashboard/routes');
const socialRoutes = require('./social/routes');
const businessRoutes = require('./business/routes');
const financeRoutes = require('./finance/routes');
const documentsRoutes = require('./documents/routes');
const productivityRoutes = require('./productivity/routes');
const automationRoutes = require('./automation/routes');
const teamsRoutes = require('./teams/routes');
const enterpriseRoutes = require('./enterprise/routes');
const { apiKeyAuth } = require('./enterprise/apiKeyAuth');
const { reportError } = require('./enterprise/errorReporting');
const sso = require('./enterprise/sso');
const automationJobQueue = require('./automation/jobQueue');
const { registerWorkflowJobHandlers } = require('./automation/orchestrator');
const emailWriter = require('./business/emailWriter');
const { generateTitle } = require('./conversations/titles');
const { logger, requestLogger } = require('./logging/logger');
const { selectProviderOrder, selectProviderOrderCostAware } = require('./aihub/router');
const { attachUser, usageGate } = require('./middleware/usageGate');
const { VictusEngine } = require('./victus/core/engine');
const { ToolBus } = require('./victus/core/toolBus');
const { PlanGraph } = require('./victus/core/planner');
const { createResearchService } = require('./victus/research/service');
const { createVictusSafety } = require('./victus/safety');
const { createVictusModelProvider } = require('./victus/model/openaiCompatible');
const { createUacl } = require('./victus/cloud/uacl');
const { mountUaclRoutes } = require('./victus/cloud/routes');
const { createWorldModel } = require('./victus/world/model');
const { mountWorldModelRoutes } = require('./victus/world/routes');
const { createMissionEngine } = require('./victus/mission/engine');
const { mountMissionRoutes } = require('./victus/mission/routes');
const { createInternetGateway, parseNodes } = require('./victus/internet/gateway');
const { mountInternetRoutes } = require('./victus/internet/routes');
const { createCloudMemory, parseCloudMemoryNodes } = require('./victus/memory/cloudMemory');
const { mountCloudMemoryRoutes } = require('./victus/memory/routes');

dns.setDefaultResultOrder('ipv4first');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Live Victus control plane for coding requests. The engine owns workflow
// selection, execution telemetry, and outcome learning; the coding agent
// remains responsible for the actual multi-pass model work.
const codingVictusToolBus = new ToolBus();
const worldModel = createWorldModel({ db, maxEntitiesPerTenant: 5000, maxEdgesPerTenant: 15000 });
const codingVictus = new VictusEngine({ toolBus: codingVictusToolBus, worldModel });

// Read-only Victus research plane. Web writes are impossible here: the fetcher
// only issues GET requests, follows only allowlisted redirects, and blocks
// private/reserved DNS targets to reduce SSRF risk.
let victusResearch = null;


// Victus safety control plane: kill switch, tamper-evident audit log, and the
// human-approval upgrade queue. Victus can propose; only an admin can approve.
const victusSafety = createVictusSafety();
if (victusSafety.killSwitch.isEngaged()) console.warn('[WARN] Victus kill switch is ENGAGED — research, internet, memory, coding, compute and proposals are stopped');
codingVictusToolBus.register({
  toolId: 'coding_agent',
  description: 'Run the safe, non-executing Victus coding agent.',
  actionType: 'EXECUTE',
  permissions: [],
  preconditions: [],
  postconditions: [],
  timeoutMs: 120000,
  execute: async (_input, context) => runCodingAgent({
    mode: context.mode,
    code: context.code,
    language: context.language,
    depth: context.depth,
    extra: context.extra || {},
  }, getAIReply, context.signal),
});


// ─── ENV (must be defined first — session/passport/limiters use it) ──
const ENV = {
  GROQ_KEY:             (process.env.GROQ_API_KEY          || '').trim(),
  GEMINI_KEY:           (process.env.GEMINI_API_KEY         || '').trim(),
  OPENAI_KEY:           (process.env.OPENAI_API_KEY         || '').trim(),
  ANTHROPIC_KEY:        (process.env.ANTHROPIC_API_KEY      || '').trim(), // Claude — console.anthropic.com
  GROK_KEY:             (process.env.GROK_API_KEY           || '').trim(), // xAI — console.x.ai (OpenAI-compatible API)
  DEEPSEEK_KEY:         (process.env.DEEPSEEK_API_KEY        || '').trim(), // platform.deepseek.com (OpenAI-compatible API)
  LOCAL_MODEL_URL:      (process.env.LOCAL_MODEL_URL         || '').trim(),
  VICTUS_MODEL_URL:      (process.env.VICTUS_MODEL_URL         || '').trim(),
  VICTUS_MODEL_NAME:     (process.env.VICTUS_MODEL_NAME        || 'victus-lm').trim(),
  VICTUS_MODEL_KEY:      (process.env.VICTUS_MODEL_KEY         || '').trim(), // e.g. bearer token for a self-hosted Victus model server
  UACL_ENABLED:           (process.env.UACL_ENABLED || 'true').trim().toLowerCase() !== 'false',
  UACL_WORKER_KEY:        (process.env.UACL_WORKER_KEY || '').trim(),
  UACL_ADMIN_KEY:         (process.env.UACL_ADMIN_KEY || '').trim(),
  UACL_MAX_QUEUE:         (() => { const n = Math.floor(Number(process.env.UACL_MAX_QUEUE)); return Number.isFinite(n) ? Math.max(50, Math.min(5000, n)) : 1000; })(), // invalid values fall back to 1000 (never unlimited)
  UACL_ALLOW_INSECURE_DEV: (process.env.UACL_ALLOW_INSECURE_DEV || '').trim().toLowerCase() === 'true', // dev only; ignored in production
  COST_AWARE_ROUTING:   (process.env.COST_AWARE_ROUTING || '').trim() === 'true', // opt-in, default OFF — see src/aihub/router.js
  MY_MODEL_URL:         (process.env.MY_MODEL_URL           || '').trim(), // e.g. https://api-inference.huggingface.co/models/your-username/your-model-name
  MY_MODEL_KEY:         (process.env.MY_MODEL_KEY           || '').trim(), // Hugging Face access token (starts with hf_)
  GOOGLE_CLIENT_ID:     (process.env.GOOGLE_CLIENT_ID       || '').trim(),
  GOOGLE_CLIENT_SECRET: (process.env.GOOGLE_CLIENT_SECRET   || '').trim(),
  SESSION_SECRET:       (process.env.SESSION_SECRET         || ''),
  BASE_URL:             (process.env.BASE_URL               || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:5000')),
  VICTUS_INTERNET_ALLOWLIST: (process.env.VICTUS_INTERNET_ALLOWLIST || '').trim(),
  VICTUS_INTERNET_ALLOW_PUBLIC: (process.env.VICTUS_INTERNET_ALLOW_PUBLIC || '').trim().toLowerCase() === 'true',
  VICTUS_INTERNET_NODES: (process.env.VICTUS_INTERNET_NODES || '').trim(),
  VICTUS_INTERNET_ADMIN_KEY: (process.env.VICTUS_INTERNET_ADMIN_KEY || '').trim(),
  VICTUS_INTERNET_LOCAL_ENABLED: (process.env.VICTUS_INTERNET_LOCAL_ENABLED || 'true').trim().toLowerCase() !== 'false',
  VICTUS_INTERNET_CACHE_TTL_MS: Number(process.env.VICTUS_INTERNET_CACHE_TTL_MS) || 30000,
  VICTUS_INTERNET_STALE_TTL_MS: Number(process.env.VICTUS_INTERNET_STALE_TTL_MS) || 300000,
  VICTUS_INTERNET_MAX_BYTES: Number(process.env.VICTUS_INTERNET_MAX_BYTES) || (2 * 1024 * 1024),
  VICTUS_INTERNET_MAX_ATTEMPTS: Number(process.env.VICTUS_INTERNET_MAX_ATTEMPTS) || 4,
  NODE_ENV:             (process.env.NODE_ENV               || 'development'),
  VICTUS_CLOUD_MEMORY_ENABLED: (process.env.VICTUS_CLOUD_MEMORY_ENABLED || 'true').trim().toLowerCase() !== 'false',
  VICTUS_CLOUD_MEMORY_KEY: (process.env.VICTUS_CLOUD_MEMORY_KEY || '').trim(),
  VICTUS_CLOUD_MEMORY_NODES: (process.env.VICTUS_CLOUD_MEMORY_NODES || '').trim(),
  VICTUS_CLOUD_MEMORY_REPLICAS: Number(process.env.VICTUS_CLOUD_MEMORY_REPLICAS) || 1,
  VICTUS_CLOUD_MEMORY_REMOTE_REQUIRED: (process.env.VICTUS_CLOUD_MEMORY_REMOTE_REQUIRED || '').trim().toLowerCase() === 'true',
  VICTUS_CLOUD_MEMORY_LOCAL_TTL_MS: Number(process.env.VICTUS_CLOUD_MEMORY_LOCAL_TTL_MS) || 60000,
  VICTUS_CLOUD_MEMORY_STALE_TTL_MS: Number(process.env.VICTUS_CLOUD_MEMORY_STALE_TTL_MS) || 300000,
  VICTUS_CLOUD_MEMORY_MAX_LOCAL_ENTRIES: Number(process.env.VICTUS_CLOUD_MEMORY_MAX_LOCAL_ENTRIES) || 2000,
  VICTUS_CLOUD_MEMORY_MAX_LOCAL_BYTES: Number(process.env.VICTUS_CLOUD_MEMORY_MAX_LOCAL_BYTES) || (64 * 1024 * 1024),
  VICTUS_CLOUD_MEMORY_MAX_VALUE_BYTES: Number(process.env.VICTUS_CLOUD_MEMORY_MAX_VALUE_BYTES) || (2 * 1024 * 1024),
  VICTUS_CLOUD_MEMORY_NODE_TIMEOUT_MS: Number(process.env.VICTUS_CLOUD_MEMORY_NODE_TIMEOUT_MS) || 5000,
  VICTUS_CLOUD_MEMORY_NODE_MAX_ATTEMPTS: Number(process.env.VICTUS_CLOUD_MEMORY_NODE_MAX_ATTEMPTS) || 3,
};

(function validateEnv() {
  const checks = [
    { val: ENV.GROQ_KEY,             prefix: 'gsk_',   label: 'Groq',              key: 'GROQ_API_KEY'          },
    { val: ENV.GEMINI_KEY,           prefix: 'AIzaSy', label: 'Gemini',            key: 'GEMINI_API_KEY'        },
    { val: ENV.OPENAI_KEY,           prefix: 'sk-',    label: 'OpenAI (ChatGPT)',  key: 'OPENAI_API_KEY'        },
    { val: ENV.ANTHROPIC_KEY,        prefix: 'sk-ant-',label: 'Claude',            key: 'ANTHROPIC_API_KEY'     },
    { val: ENV.GROK_KEY,             prefix: 'xai-',   label: 'Grok',              key: 'GROK_API_KEY'          },
    { val: ENV.DEEPSEEK_KEY,         prefix: 'sk-',    label: 'DeepSeek',          key: 'DEEPSEEK_API_KEY'      },
    { val: ENV.MY_MODEL_KEY,         prefix: 'hf_',    label: 'My Model (HF)',     key: 'MY_MODEL_KEY'          },
    { val: (process.env.REPLICATE_API_TOKEN || '').trim(), prefix: 'r8_', label: 'Replicate (Creator Studio: upscale/bg-removal/video)', key: 'REPLICATE_API_TOKEN' },
    { val: (process.env.SOCIAL_TOKEN_ENC_KEY || '').trim(), prefix: '', label: 'Social token encryption key', key: 'SOCIAL_TOKEN_ENC_KEY' },
    { val: (process.env.ADMIN_EMAILS || '').trim(), prefix: '', label: 'Admin emails (error log access)', key: 'ADMIN_EMAILS' },
    { val: (process.env.SENTRY_DSN || '').trim(), prefix: 'https://', label: 'Sentry (error forwarding)', key: 'SENTRY_DSN' },
    { val: (process.env.SAML_ENTRY_POINT || '').trim(), prefix: '', label: 'SAML SSO', key: 'SAML_ENTRY_POINT' },
    { val: ENV.GOOGLE_CLIENT_ID,     prefix: '',       label: 'Google OAuth ID',   key: 'GOOGLE_CLIENT_ID'      },
    { val: ENV.GOOGLE_CLIENT_SECRET, prefix: '',       label: 'Google OAuth Secret', key: 'GOOGLE_CLIENT_SECRET'},
    { val: ENV.SESSION_SECRET,       prefix: '',       label: 'Session Secret',    key: 'SESSION_SECRET'        },
    { val: (process.env.DATABASE_URL      || '').trim(), prefix: '',    label: 'Database (Postgres)', key: 'DATABASE_URL'      },
    { val: (process.env.STRIPE_SECRET_KEY || '').trim(), prefix: 'sk_', label: 'Stripe',               key: 'STRIPE_SECRET_KEY' },
  ];

  let hasAnyAiProvider = false;
  const fatalErrors = [];

  for (const { val, prefix, label, key } of checks) {
    if (!val) {
      console.warn(`[WARN] ${key} not set — ${label} disabled`);
    } else if (prefix && !val.startsWith(prefix)) {
      // A wrong-looking key is worse than a missing one: it passes startup,
      // then fails confusingly on the first real request. Surface it loudly now.
      console.error(`[ERR]  ${key} looks wrong — expected prefix "${prefix}". Check for pasted quotes/whitespace.`);
      if (['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROK_API_KEY', 'DEEPSEEK_API_KEY', 'STRIPE_SECRET_KEY'].includes(key)) {
        fatalErrors.push(`${key} is set but malformed (wrong prefix)`);
      }
    } else {
      console.log(`[OK]   ${key} loaded (${label})`);
      if (['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROK_API_KEY', 'DEEPSEEK_API_KEY'].includes(key)) hasAnyAiProvider = true;
    }
  }

  // Session secret: missing is a hard security problem in production, not
  // just a warning — insecure sessions silently expose logged-in users.
  if (!ENV.SESSION_SECRET) {
    const msg = 'SESSION_SECRET missing — sessions would be insecure/predictable.';
    if (ENV.NODE_ENV === 'production') fatalErrors.push(msg);
    else console.error(`[ERR]  ${msg} Add to Railway Variables before deploying!`);
  } else if (ENV.SESSION_SECRET.length < 32) {
    console.warn('[WARN] SESSION_SECRET is short — use a longer random value (32+ chars) in production.');
  }

  if (!hasAnyAiProvider) {
    console.warn('[WARN] No Groq/Gemini/OpenAI key configured — chat will only have the free Pollinations fallback available.');
  }

  console.log('[OK]   Image: Pollinations flux-schnell → flux → picsum fallback');

  // Fail fast, loudly, instead of booting into a broken/insecure state and
  // failing confusingly on the first real request or webhook.
  if (fatalErrors.length > 0) {
    console.error('\n========================================');
    console.error('  STARTUP BLOCKED — fix these first:');
    fatalErrors.forEach(e => console.error(`  ✗ ${e}`));
    console.error('========================================\n');
    if (ENV.NODE_ENV === 'production') process.exit(1);
  }
})();

// Universal AI Compute Layer (UACL): a scheduler/broker that exposes compute
// as a capability rather than as a specific GPU vendor. Jobs are structured
// workloads; workers execute them and report lifecycle events. No shell or
// arbitrary command execution exists in this layer.
const uacl = createUacl({
  maxQueueSize: ENV.UACL_MAX_QUEUE,
  workerSecret: ENV.UACL_WORKER_KEY,
  // The kill switch is enforced inside the scheduler too, so no code path can start new compute while stopped.
  isHalted: () => victusSafety.killSwitch.isEngaged('compute'),
});
if (ENV.UACL_ENABLED) uacl.start();
const missionEngine = createMissionEngine({
  db,
  worldModel,
  toolBus: codingVictusToolBus,
  killSwitch: victusSafety.killSwitch,
  maxMissionsPerTenant: 100,
  maxTasksPerMission: 100,
  maxConcurrentRuns: 4,
});

let victusInternet = null;
try {
  const internetNodes = parseNodes(ENV.VICTUS_INTERNET_NODES);
  if (ENV.VICTUS_INTERNET_LOCAL_ENABLED) {
    internetNodes.unshift({ id: 'local-egress', type: 'direct', provider: 'local-egress', region: 'global', weight: 10 });
  }
  victusInternet = createInternetGateway({
    fetchImpl: fetch,
    lookup: dns.promises.lookup,
    allowedDomains: ENV.VICTUS_INTERNET_ALLOWLIST.split(',').map(v => v.trim()).filter(Boolean),
    allowPublicInternet: ENV.VICTUS_INTERNET_ALLOW_PUBLIC,
    cacheTtlMs: ENV.VICTUS_INTERNET_CACHE_TTL_MS,
    staleTtlMs: ENV.VICTUS_INTERNET_STALE_TTL_MS,
    maxBytes: ENV.VICTUS_INTERNET_MAX_BYTES,
    maxAttempts: ENV.VICTUS_INTERNET_MAX_ATTEMPTS,
    nodes: internetNodes,
  });
  if (victusInternet.status().enabled) {
    console.log(`[OK]   Victus Internet Layer: ${victusInternet.status().mode}, ${victusInternet.status().nodes.length} node(s), cache ${ENV.VICTUS_INTERNET_CACHE_TTL_MS}ms`);
  } else {
    console.warn('[WARN] Victus Internet Layer configured but disabled — set VICTUS_INTERNET_ALLOWLIST or VICTUS_INTERNET_ALLOW_PUBLIC=true');
  }
} catch (err) {
  console.error(`[ERR]  Victus Internet Layer initialization failed: ${err.message}`);
}

let victusCloudMemory = null;
if (ENV.VICTUS_CLOUD_MEMORY_ENABLED) {
  try {
    const memoryNodes = parseCloudMemoryNodes(ENV.VICTUS_CLOUD_MEMORY_NODES, { production: ENV.NODE_ENV === 'production' });
    if (memoryNodes.length && !ENV.VICTUS_CLOUD_MEMORY_KEY) {
      console.warn('[WARN] Victus Cloud Memory remote nodes configured but VICTUS_CLOUD_MEMORY_KEY is missing — remote tier is disabled for safety');
    }
    victusCloudMemory = createCloudMemory({
      fetchImpl: fetch,
      encryptionKey: ENV.VICTUS_CLOUD_MEMORY_KEY || null,
      nodes: memoryNodes,
      production: ENV.NODE_ENV === 'production',
      localTtlMs: ENV.VICTUS_CLOUD_MEMORY_LOCAL_TTL_MS,
      staleTtlMs: ENV.VICTUS_CLOUD_MEMORY_STALE_TTL_MS,
      maxLocalEntries: ENV.VICTUS_CLOUD_MEMORY_MAX_LOCAL_ENTRIES,
      maxLocalBytes: ENV.VICTUS_CLOUD_MEMORY_MAX_LOCAL_BYTES,
      maxValueBytes: ENV.VICTUS_CLOUD_MEMORY_MAX_VALUE_BYTES,
      nodeTimeoutMs: ENV.VICTUS_CLOUD_MEMORY_NODE_TIMEOUT_MS,
      maxAttempts: ENV.VICTUS_CLOUD_MEMORY_NODE_MAX_ATTEMPTS,
      replicas: ENV.VICTUS_CLOUD_MEMORY_REPLICAS,
      remoteRequired: ENV.VICTUS_CLOUD_MEMORY_REMOTE_REQUIRED,
    });
    console.log(`[OK]   Victus Cloud Memory: ${memoryNodes.length} remote node(s), local ${ENV.VICTUS_CLOUD_MEMORY_MAX_LOCAL_BYTES} bytes, replicas ${ENV.VICTUS_CLOUD_MEMORY_REPLICAS}`);
  } catch (err) {
    console.error(`[ERR]  Victus Cloud Memory initialization failed: ${err.message}`);
  }
}

const app = express();

try {
  if (process.env.VICTUS_RESEARCH_ALLOWLIST) {
    victusResearch = createResearchService({ fetchImpl: fetch, lookup: dns.promises.lookup, aiReply: getAIReply });
    console.log(`[OK]   Victus research allowlist: ${victusResearch.allowedDomains.join(', ')}`);
  } else {
    console.warn('[WARN] VICTUS_RESEARCH_ALLOWLIST not set — Victus web research disabled');
  }
} catch (err) {
  console.error(`[ERR]  Victus research initialization failed: ${err.message}`);
}


// FIX: trust proxy so Railway IP-based rate limiting works correctly
// Without this, all requests look like they come from the same proxy IP
app.set('trust proxy', 1);

// Structured logging: every request gets an ID (returned as X-Request-Id)
// and a JSON log line on completion with status/duration. Placed early
// so req.id is available to every downstream handler and error path.
app.use(requestLogger);

// Phase 15: real security headers via helmet. CSP disabled deliberately —
// this app serves a mix of JSON and an HTML frontend (public/index.html)
// with inline scripts; a strict default CSP would need hand-tuning
// against that file to avoid breaking it, so the headers with no
// compatibility risk ship now rather than a CSP that silently breaks
// the frontend.
app.use(helmet({ contentSecurityPolicy: false }));

// FIX: restrict CORS to your own domain in production, allow all in dev
app.use(cors({
  origin: ENV.NODE_ENV === 'production'
    ? [ENV.BASE_URL, 'https://nova-ai-production-5ad8.up.railway.app']
    : '*',
  credentials: true
}));
// Stripe needs the RAW request body to verify webhook signatures — this must
// be registered before express.json() below, or signature checks will fail.
billingRoutes.mountWebhook(app);

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ─── Session ───────────────────────────────────────────────
// FIX: sessions used to live only in the default MemoryStore, which means
// every Railway restart/redeploy silently logged out every logged-in user
// (their account data in Postgres was fine — just their active login was
// wiped). Sessions now persist in Postgres itself, using the same pool
// db/index.js already manages, so no second database/service is needed.
const sessionStore = db.isEnabled()
  ? new pgSession({
      pool: db.getPool(),
      tableName: 'user_sessions',
      createTableIfMissing: true, // auto-creates on first boot, no manual migration needed
    })
  : undefined; // falls back to express-session's default MemoryStore

if (!sessionStore) {
  console.warn('[WARN] DATABASE_URL not set — sessions will use in-memory store and reset on every restart.');
}

app.use(session({
  store: sessionStore,
  secret: ENV.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: ENV.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000   // 7 days
  }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(apiKeyAuth); // Phase 15: Authorization: Bearer nova_... — sets req.dbUser/req.tier for programmatic callers
app.use(attachUser); // resolves req.dbUser / req.subscription / req.tier when logged in

// ─── Rate limiters (Fix #4 — ChatGPT) ─────────────────────
// Chat: 30 requests / minute per IP — protects Groq/Gemini quotas
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '⚠️ Too many messages. Please wait a moment.' }
});
// Image: 10 requests / minute — image gen is slower & more expensive
const imageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: '⚠️ Too many image requests. Please wait a moment.' }
});
// Agent: 8 requests / minute — each agent request can internally trigger
// up to maxSteps AI provider calls plus tool calls, so it costs several
// times more than one normal chat message. A shared 30/min limiter with
// /api/chat would let this multiply into 100+ provider calls/min from a
// single client. Keep this stricter than chatLimiter.
const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '⚠️ Too many agent requests. Please wait a moment — each agent run costs more than a normal message.' }
});
// General API: 120 requests / minute
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: '⚠️ Too many requests.' }
});
app.use('/api/', apiLimiter);

const ipv4Agent = new https.Agent({ family: 4 });

function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

class RateLimitError extends Error {
  constructor(provider) {
    super(`${provider} rate limit reached`);
    this.name     = 'RateLimitError';
    this.provider = provider;
  }
}

async function safeJson(res) {
  const text = await res.text();
  try   { return JSON.parse(text); }
  catch { throw new Error(`Non-JSON response: ${text.slice(0, 120)}`); }
}

// ─── In-memory user store (session identity only) ──────────
// Still used for passport serialize/deserialize within one server process —
// this is unrelated to billing. Persisted accounts, tiers, and usage now
// live in Postgres via src/db (see attachUser in src/middleware/usageGate.js),
// populated from this same Google profile on every authenticated request.
const users = new Map();   // googleId → { id, name, email, picture }

// ─── Passport: Google OAuth ────────────────────────────────
if (ENV.GOOGLE_CLIENT_ID && ENV.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy(
    {
      clientID:     ENV.GOOGLE_CLIENT_ID,
      clientSecret: ENV.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${ENV.BASE_URL}/auth/google/callback`,
    },
    (_accessToken, _refreshToken, profile, done) => {
      const user = {
        id:      profile.id,
        name:    profile.displayName,
        email:   profile.emails?.[0]?.value || '',
        picture: profile.photos?.[0]?.value || '',
      };
      users.set(profile.id, user);
      return done(null, user);
    }
  ));
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => done(null, users.get(id) || false));
}

// ─── Auth routes ───────────────────────────────────────────
// GET /auth/google        → redirect to Google consent screen
// GET /auth/google/callback → Google returns here after login
// GET /api/me             → frontend polls this to check login state
// GET /logout             → clear session

app.get('/auth/google', (req, res, next) => {
  if (!ENV.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: 'Google login not configured on this server.' });
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?auth=failed' }),
  (req, res) => res.redirect('/?auth=success')
);

app.get('/api/me', async (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    const payload = { loggedIn: true, user: req.user };
    if (req.dbUser && req.tier) {
      payload.billing = {
        tier:     req.tier.id,
        tierName: req.tier.name,
        status:   req.subscription?.status || 'active',
        limits:   req.tier.limits,
        features: req.tier.features,
        usage:    await db.getUsage(req.dbUser.id),
      };
    }
    return res.json(payload);
  }
  res.json({ loggedIn: false });
});

app.get('/logout', (req, res) => {
  req.logout?.(() => {});
  req.session?.destroy?.();
  res.redirect('/');
});

// ─── Health ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status:    'healthy',
    providers: {
      groq:         !!ENV.GROQ_KEY,
      gemini:       !!ENV.GEMINI_KEY,
      chatgpt:      !!ENV.OPENAI_KEY,
      claude:       !!ENV.ANTHROPIC_KEY,
      grok:         !!ENV.GROK_KEY,
      deepseek:     !!ENV.DEEPSEEK_KEY,
      localModel:   !!ENV.LOCAL_MODEL_URL,
      myModel:      !!(ENV.MY_MODEL_URL && ENV.MY_MODEL_KEY),
      pollinations: true,
      victor:       true,
      uacl:          ENV.UACL_ENABLED,
      googleAuth:   !!(ENV.GOOGLE_CLIENT_ID && ENV.GOOGLE_CLIENT_SECRET),
      database:     db.isEnabled(),
      billing:      billing.isEnabled(),
    },
    timestamp: new Date().toISOString()
  });
});

// ─── Models list (for model-picker UI) ──────────────────────
app.get('/api/models', (req, res) => {
  res.json({
    models: [
      { id: 'auto',         name: 'Auto',              description: 'Fastest reliable answer — tries providers in order',          available: true },
      { id: 'victor',       name: 'Victor',            description: 'Multi-agent: routes → drafts → validates → refines',           available: true },
      { id: 'groq',         name: 'Groq · Llama 3.3',  description: 'Fast and high quality',                                        available: !!ENV.GROQ_KEY },
      { id: 'gemini',       name: 'Gemini 2.0',        description: "Google's flash model",                                         available: !!ENV.GEMINI_KEY },
      { id: 'chatgpt',      name: 'ChatGPT · GPT-5.4 mini', description: "OpenAI's fast, cost-efficient model",                      available: !!ENV.OPENAI_KEY },
      { id: 'claude',       name: 'Claude · Sonnet 4.6', description: "Anthropic's model, strong at reasoning and writing",         available: !!ENV.ANTHROPIC_KEY },
      { id: 'grok',         name: 'Grok 4',             description: "xAI's model",                                                  available: !!ENV.GROK_KEY },
      { id: 'deepseek',     name: 'DeepSeek',           description: 'Strong reasoning, cost-efficient',                             available: !!ENV.DEEPSEEK_KEY },
      { id: 'localmodel',   name: 'Local Model',        description: 'Self-hosted model on your own server (Ollama-compatible)',     available: !!ENV.LOCAL_MODEL_URL },
      { id: 'victus-cloud', name: 'Victus Cloud UACL',   description: 'Universal compute layer for remote/local accelerators',       available: ENV.UACL_ENABLED },
      { id: 'mymodel',      name: 'My Model',          description: 'Your custom fine-tuned model',                                 available: !!(ENV.MY_MODEL_URL && ENV.MY_MODEL_KEY) },
      { id: 'pollinations', name: 'Pollinations',      description: 'Free, always available',                                       available: true }
    ]
  });
});

// ─── Billing (Stripe checkout / customer portal / public tier list) ──
app.use('/api/billing', billingRoutes.router);
app.use('/api/conversations', conversationsRoutes.router);
app.use('/api/dashboard', dashboardRoutes.router);
app.use('/api/social', socialRoutes.router);
app.use('/api/business', businessRoutes.router);
app.use('/api/finance', financeRoutes.router);
app.use('/api/documents', documentsRoutes.router);
app.use('/api/productivity', productivityRoutes.router);
app.use('/api/automation', automationRoutes.router);
app.use('/api/teams', teamsRoutes.router);
app.use('/api/enterprise', enterpriseRoutes.router);
app.locals.fetchWithTimeout = fetchWithTimeout;
app.locals.safeJson = safeJson;
app.locals.getAIReply = getAIReply;
app.locals.env = ENV;
app.use('/api/search', conversationsRoutes.searchRouter);
app.use('/api/export', conversationsRoutes.exportRouter);

// ─── Guest login ───────────────────────────────────────────
app.post('/api/guest', (req, res) => {
  const token = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  res.json({ success: true, token, username: 'Guest' });
});

// ─── Image generation ──────────────────────────────────────
// Strategy:
//   1. Pollinations flux-schnell  (fast model, ~5s)
//   2. Pollinations flux          (standard model, ~15s)
//   3. Pollinations default       (bare endpoint fallback)
//   4. picsum.photos              (always works — random photo, never fails)
//
// Key fixes vs old version:
//   - flux-schnell first (5x faster than flux)
//   - Per-attempt AbortController so one slow attempt doesn't block next
//   - Buffer fully read before checking content-type (Railway streaming quirk)
//   - Picsum guaranteed fallback so users NEVER see a blank error

// Extracted so Creator Studio's specialized modes (logo/poster/product/
// thumbnail) can reuse this exact, already-battle-tested fallback chain
// instead of duplicating it. Same behavior as before this refactor —
// pure extraction, not a logic change.
async function generateImageViaPollinations(prompt, size) {
  const seed = Math.floor(Math.random() * 999999);
  const enc  = encodeURIComponent(prompt.slice(0, 500));
  const sz   = parseInt(size, 10) || 512;

  const pollinationsAttempts = [
    { url: `https://image.pollinations.ai/prompt/${enc}?width=${sz}&height=${sz}&model=flux-schnell&nologo=true&seed=${seed}`, label: 'flux-schnell', timeout: 25000 },
    { url: `https://image.pollinations.ai/prompt/${enc}?width=${sz}&height=${sz}&model=flux&nologo=true&seed=${seed}`,         label: 'flux',         timeout: 45000 },
    { url: `https://image.pollinations.ai/prompt/${enc}?width=${sz}&height=${sz}&nologo=true&seed=${seed}`,                   label: 'default',      timeout: 45000 },
  ];

  for (const attempt of pollinationsAttempts) {
    try {
      console.log(`🎨 Trying Pollinations ${attempt.label}…`);
      const response = await fetchWithTimeout(
        attempt.url,
        { agent: ipv4Agent, headers: { 'Accept': 'image/*' } },
        attempt.timeout
      );

      if (!response.ok) { console.warn(`   ✗ HTTP ${response.status}`); continue; }

      const ct = response.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) { console.warn(`   ✗ Wrong content-type: ${ct}`); continue; }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1000) { console.warn(`   ✗ Buffer too small (${buffer.length} bytes) — likely an error page`); continue; }

      const ext = ct.includes('png') ? 'png' : 'jpeg';
      console.log(`✅ Pollinations ${attempt.label} succeeded (${buffer.length} bytes)`);
      return { imageUrl: `data:image/${ext};base64,${buffer.toString('base64')}`, source: `pollinations-${attempt.label}` };
    } catch (err) {
      console.warn(`   ✗ Pollinations ${attempt.label} error: ${err.message}`);
    }
  }

  console.log('⚠️  All Pollinations attempts failed — using picsum fallback');
  try {
    const picsumUrl = `https://picsum.photos/seed/${seed}/${sz}/${sz}`;
    const picsumRes = await fetchWithTimeout(picsumUrl, { agent: ipv4Agent }, 10000);
    if (picsumRes.ok) {
      const buf = Buffer.from(await picsumRes.arrayBuffer());
      console.log('✅ Picsum fallback succeeded');
      return {
        imageUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
        source: 'picsum',
        note: '⚠️ AI generation is slow right now — showing a stock photo instead. Try again in a minute for AI art.'
      };
    }
  } catch (err) {
    console.warn(`   ✗ Picsum fallback error: ${err.message}`);
  }

  throw new Error('🖼️ Image generation is temporarily unavailable on this server. Please try again in 1–2 minutes.');
}

app.post('/api/image', imageLimiter, usageGate('images'), async (req, res) => {
  const { prompt, size = '512' } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Prompt is required' });
  }
  try {
    const result = await generateImageViaPollinations(prompt, size);
    res.json(result);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// ─── Video (disabled) ──────────────────────────────────────
// ─── Creator Studio: specialized image modes (free, real, today) ──
// Wraps the idea in a mode-specific prompt template, then reuses the
// exact same Pollinations pipeline as /api/image. Honest framing in
// imagePrompts.js: this is prompt engineering, not a dedicated logo/
// poster tool — no vector output, no guaranteed transparent background.
app.post('/api/creator/image', imageLimiter, usageGate('images'), async (req, res) => {
  try {
    const { style = 'general', idea, size = '512' } = req.body;
    const prompt = imagePrompts.buildImagePrompt(style, idea);
    const result = await generateImageViaPollinations(prompt, size);
    res.json({ ...result, style, promptUsed: prompt });
  } catch (err) {
    const isValidationError = /style must be|is required/.test(err.message);
    res.status(isValidationError ? 400 : 503).json({ error: err.message });
  }
});

// ─── Creator Studio: upscale / background removal (Replicate slot) ──
// Real integration, gated behind REPLICATE_API_TOKEN — same pattern as
// the Claude/Grok/DeepSeek chat providers. Honestly reports "not
// configured" rather than faking a result when the token is missing.
app.post('/api/creator/upscale', imageLimiter, usageGate('images'), async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });
    const output = await replicate.upscaleImage(imageUrl, fetchWithTimeout, safeJson);
    res.json({ imageUrl: output });
  } catch (err) {
    logger.warn('creator.upscale_failed', { requestId: req.id, error: err.message });
    res.status(replicate.isConfigured() ? 503 : 501).json({ error: err.message });
  }
});

app.post('/api/creator/remove-background', imageLimiter, usageGate('images'), async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });
    const output = await replicate.removeBackground(imageUrl, fetchWithTimeout, safeJson);
    res.json({ imageUrl: output });
  } catch (err) {
    logger.warn('creator.remove_background_failed', { requestId: req.id, error: err.message });
    res.status(replicate.isConfigured() ? 503 : 501).json({ error: err.message });
  }
});

// ─── Creator Studio: video generation (Replicate slot) ──────
// Genuinely functional once REPLICATE_API_TOKEN is set — replaces the
// unconditional "disabled" stub above with a real attempt when a token
// exists, same honest "not configured" message otherwise. The original
// /api/generate-video stub is left untouched (not removed) so nothing
// pointed at it breaks; this is an additive, more capable alternative.
app.post('/api/creator/video', agentLimiter, usageGate('images'), async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt is required' });
    const output = await replicate.generateVideo(prompt, fetchWithTimeout, safeJson);
    res.json({ videoUrl: output });
  } catch (err) {
    logger.warn('creator.video_failed', { requestId: req.id, error: err.message });
    res.status(replicate.isConfigured() ? 503 : 501).json({ error: err.message });
  }
});

// ─── Creator Studio: auto subtitles (real, via Whisper) ─────
// Reuses ENV.OPENAI_KEY — if ChatGPT is already configured, this works
// with no extra setup. Accepts base64 audio (see subtitles.js for why,
// given no file-upload infra exists yet).
app.post('/api/creator/subtitles', agentLimiter, usageGate('messages'), async (req, res) => {
  try {
    const { audioBase64, filename, language, format = 'json' } = req.body;
    const result = await subtitles.transcribeAudio({ audioBase64, filename, language }, ENV.OPENAI_KEY, fetchWithTimeout, safeJson);
    if (format === 'srt') {
      res.setHeader('Content-Type', 'text/plain');
      return res.send(subtitles.toSRT(result.segments));
    }
    res.json(result);
  } catch (err) {
    logger.warn('creator.subtitles_failed', { requestId: req.id, error: err.message });
    res.status(subtitles.isConfigured(ENV.OPENAI_KEY) ? 503 : 501).json({ error: err.message });
  }
});

// ─── Social Media Studio: content generation (free, stateless) ──
// No platform connection needed — pure AI text generation, real and
// working today. Platform-aware in the ways that actually matter:
// real character limits so a caption doesn't silently blow past what
// the platform allows.
app.post('/api/social/caption', agentLimiter, usageGate('messages'), async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    const { platform, description, tone } = req.body;
    const result = await contentGenerator.generateCaption(platform, description, getAIReply, reqController.signal, { tone });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/social/titles', agentLimiter, usageGate('messages'), async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    const { platform, description } = req.body;
    const result = await contentGenerator.generateTitles(platform, description, getAIReply, reqController.signal);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/social/hashtags', agentLimiter, usageGate('messages'), async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    const { platform, description } = req.body;
    const result = await contentGenerator.generateHashtags(platform, description, getAIReply, reqController.signal);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/social/reply-suggestions', agentLimiter, usageGate('messages'), async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    const { comment, tone, context } = req.body;
    const result = await replyAssistant.generateReplySuggestions(comment, getAIReply, reqController.signal, { tone, context });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Business Hub: email writer (free, stateless) ───────────
// Drafts real, ready-to-send business emails. Does NOT send anything —
// this app has no outbound email/SMTP integration; the user copies the
// draft into their own email client.
app.post('/api/business/write-email', agentLimiter, usageGate('messages'), async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    const { type, brief, recipientName, tone, senderName } = req.body;
    const result = await emailWriter.writeEmail(type, brief, getAIReply, reqController.signal, { recipientName, tone, senderName });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// equivalent) plus persistent file storage for uploaded/processed video
// — neither exists in this app yet. Rather than fake these, they return
// a clear, honest explanation, same pattern as the original
// /api/generate-video stub already in this codebase.
const VIDEO_PROCESSING_UNAVAILABLE = {
  error: 'This feature needs real video-processing infrastructure (ffmpeg + file storage) that isn\u2019t set up yet — it\u2019s more than an API key away. Image-based Creator Studio features (generation, upscale, background removal, subtitles) work today.'
};
app.post('/api/creator/video/edit',            (_req, res) => res.status(501).json(VIDEO_PROCESSING_UNAVAILABLE));
app.post('/api/creator/video/remove-background', (_req, res) => res.status(501).json(VIDEO_PROCESSING_UNAVAILABLE));
app.post('/api/creator/video/clip',            (_req, res) => res.status(501).json(VIDEO_PROCESSING_UNAVAILABLE));

app.post('/api/generate-video', (_req, res) => res.status(503).json({
  error: '🎬 Video generation requires a paid API. Use the Image tab for free AI visuals.'
}));
app.get('/api/video-status/:jobId', (_req, res) => res.status(410).json({ error: 'Disabled.' }));

// ─── Chat providers ────────────────────────────────────────
function fixGeminiHistory(historyOnly) {
  const turns  = [];
  let lastRole = null;
  for (const msg of historyOnly) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    if (role === lastRole) {
      turns[turns.length - 1].parts[0].text += '\n' + msg.content;
    } else {
      turns.push({ role, parts: [{ text: msg.content }] });
      lastRole = role;
    }
  }
  return turns;
}

const providerCooldowns = new Map();

const victusModelProvider = createVictusModelProvider({
  url: ENV.VICTUS_MODEL_URL,
  model: ENV.VICTUS_MODEL_NAME,
  apiKey: ENV.VICTUS_MODEL_KEY,
  fetchImpl: fetch,
});

const AI_PROVIDERS = [
  {
    name: 'Victus',
    available: () => !!ENV.VICTUS_MODEL_URL,
    call: (messages, signal) => victusModelProvider.call(messages, signal),
  },
  {
    name:      'Groq',
    available: () => !!ENV.GROQ_KEY,
    call:      async (messages, signal) => {
      const res = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ENV.GROQ_KEY}` },
          body: JSON.stringify({ model: (process.env.GROQ_MODEL || 'llama-3.1-8b-instant').trim(), messages, max_tokens: 2048, temperature: 0.7 }),
          signal
        },
        20000
      );
      if (res.status === 429) throw new RateLimitError('Groq');
      if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      // FIX (Bug #4): optional chaining — Groq can return empty choices on edge cases
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Groq returned empty response');
      return text.trim();
    }
  },
  {
    name:      'Gemini',
    available: () => !!ENV.GEMINI_KEY,
    call:      async (messages, signal) => {
      const systemMsg  = messages.find(m => m.role === 'system')?.content || '';
      const fixedTurns = fixGeminiHistory(messages.filter(m => m.role !== 'system').slice(0, -1));
      const lastMsg    = messages[messages.length - 1];
      fixedTurns.push({ role: 'user', parts: [{ text: lastMsg.content }] });
      const body = { contents: fixedTurns, generationConfig: { maxOutputTokens: 2048, temperature: 0.7 } };
      if (systemMsg.trim()) body.system_instruction = { parts: [{ text: systemMsg }] };
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${ENV.GEMINI_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal },
        20000
      );
      if (res.status === 429) throw new RateLimitError('Gemini');
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini returned empty or blocked response');
      return text.trim();
    }
  },
  {
    name:      'ChatGPT',
    available: () => !!ENV.OPENAI_KEY,
    call:      async (messages, signal) => {
      const res = await fetchWithTimeout(
        'https://api.openai.com/v1/chat/completions',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ENV.OPENAI_KEY}` },
          body: JSON.stringify({ model: 'gpt-5.4-mini', messages, max_tokens: 2048, temperature: 0.7 }),
          signal
        },
        20000
      );
      if (res.status === 429) throw new RateLimitError('ChatGPT');
      if (!res.ok) throw new Error(`ChatGPT ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('ChatGPT returned empty response');
      return text.trim();
    }
  },
  {
    name:      'Claude',
    available: () => !!ENV.ANTHROPIC_KEY,
    call:      async (messages, signal) => {
      // Anthropic's Messages API is NOT OpenAI-shaped: the system prompt is
      // a separate top-level field, not a message with role: 'system'.
      // Every other provider here uses the OpenAI convention internally,
      // so this is the one provider that needs real translation, not just
      // a different URL/model name.
      const systemMessages = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const conversationMessages = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));

      const res = await fetchWithTimeout(
        'https://api.anthropic.com/v1/messages',
        {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ENV.ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2048,
            system: systemMessages || undefined,
            messages: conversationMessages
          }),
          signal
        },
        20000
      );
      if (res.status === 429) throw new RateLimitError('Claude');
      if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      const text = data?.content?.find(block => block.type === 'text')?.text;
      if (!text) throw new Error('Claude returned empty response');
      return text.trim();
    }
  },
  {
    name:      'Grok',
    available: () => !!ENV.GROK_KEY,
    call:      async (messages, signal) => {
      // xAI's API is deliberately OpenAI-compatible — same request/response
      // shape as ChatGPT above, just a different base URL, key, and model.
      const res = await fetchWithTimeout(
        'https://api.x.ai/v1/chat/completions',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ENV.GROK_KEY}` },
          body: JSON.stringify({ model: 'grok-4', messages, max_tokens: 2048, temperature: 0.7 }),
          signal
        },
        20000
      );
      if (res.status === 429) throw new RateLimitError('Grok');
      if (!res.ok) throw new Error(`Grok ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Grok returned empty response');
      return text.trim();
    }
  },
  {
    name:      'DeepSeek',
    available: () => !!ENV.DEEPSEEK_KEY,
    call:      async (messages, signal) => {
      // Also OpenAI-compatible — same pattern as Grok/ChatGPT.
      const res = await fetchWithTimeout(
        'https://api.deepseek.com/v1/chat/completions',
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ENV.DEEPSEEK_KEY}` },
          body: JSON.stringify({ model: 'deepseek-chat', messages, max_tokens: 2048, temperature: 0.7 }),
          signal
        },
        20000
      );
      if (res.status === 429) throw new RateLimitError('DeepSeek');
      if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('DeepSeek returned empty response');
      return text.trim();
    }
  },
  {
    name:      'LocalModel',
    available: () => !!ENV.LOCAL_MODEL_URL,
    call:      async (messages, signal) => {
      // Optional, self-hosted: points at a local Ollama server (or anything
      // implementing Ollama's /api/chat shape). Off by default — only
      // activates if you set LOCAL_MODEL_URL, e.g. http://localhost:11434.
      // No API key: this is assumed to be on your own machine/network.
      const res = await fetchWithTimeout(
        `${ENV.LOCAL_MODEL_URL}/api/chat`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: process.env.LOCAL_MODEL_NAME || 'llama3', messages, stream: false }),
          signal
        },
        30000 // local models on modest hardware can be slower than hosted APIs
      );
      if (!res.ok) throw new Error(`LocalModel ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      const text = data?.message?.content;
      if (!text) throw new Error('LocalModel returned empty response');
      return text.trim();
    }
  },
  {
    name:      'MyModel',
    available: () => !!(ENV.MY_MODEL_URL && ENV.MY_MODEL_KEY),
    call:      async (messages, signal) => {
      // Formats the chat history into a single prompt the way most
      // Hugging Face text-generation models expect. Adjust this
      // formatting to match whatever template you fine-tuned with.
      const prompt = messages
        .map(m => {
          if (m.role === 'system')    return `### System:\n${m.content}`;
          if (m.role === 'assistant') return `### Response:\n${m.content}`;
          return `### Instruction:\n${m.content}`;
        })
        .join('\n\n') + '\n\n### Response:\n';

      const res = await fetchWithTimeout(
        ENV.MY_MODEL_URL,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ENV.MY_MODEL_KEY}` },
          body: JSON.stringify({
            inputs: prompt,
            parameters: { max_new_tokens: 512, temperature: 0.7, return_full_text: false }
          }),
          signal
        },
        30000 // fine-tuned models on free HF inference can be slower to cold-start
      );
      if (res.status === 429) throw new RateLimitError('MyModel');
      if (!res.ok) throw new Error(`MyModel ${res.status}: ${(await res.text()).slice(0, 100)}`);
      const data = await safeJson(res);
      // Hugging Face Inference API returns [{ generated_text: "..." }]
      const text = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text;
      if (!text) throw new Error('MyModel returned empty response');
      return text.trim();
    }
  },
  {
    name:      'Pollinations',
    available: () => true,
    call:      async (messages, signal) => {
      const res = await fetchWithTimeout(
        'https://text.pollinations.ai/openai',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'openai', messages }), signal },
        25000
      );
      if (res.status === 429) throw new RateLimitError('Pollinations');
      if (!res.ok) throw new Error(`Pollinations ${res.status}`);
      const data = await safeJson(res);
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Pollinations returned empty response');
      return text.trim();
    }
  }
];

async function getAIReply(messages, preferred, signal, rawUserMessage = null) {
  // Cost-aware routing is opt-in (ENV.COST_AWARE_ROUTING) and only takes
  // effect when a raw message string is passed in — existing call sites
  // that don't pass it get EXACTLY the previous routing behavior, so
  // this is additive, not a default behavior change.
  const providers = (ENV.COST_AWARE_ROUTING && rawUserMessage)
    ? selectProviderOrderCostAware(AI_PROVIDERS, preferred, providerCooldowns, rawUserMessage)
    : selectProviderOrder(AI_PROVIDERS, preferred, providerCooldowns);

  if (providers.length === 0) throw new Error('All AI providers unavailable or in cooldown');
  let lastError = null;
  for (const provider of providers) {
    // Don't start a new provider call if the client already disconnected
    if (signal?.aborted) throw new Error('Client disconnected');
    const attemptStarted = Date.now();
    try {
      const reply = await provider.call(messages, signal);
      logger.info('provider.success', { provider: provider.name, durationMs: Date.now() - attemptStarted });
      providerCooldowns.delete(provider.name);
      return { reply, provider: provider.name };
    } catch (err) {
      if (err.name === 'AbortError') throw err; // propagate disconnect immediately
      logger.warn('provider.failed', { provider: provider.name, error: err.message, durationMs: Date.now() - attemptStarted, willRetryNextProvider: true });
      if (err instanceof RateLimitError || err.name === 'RateLimitError') providerCooldowns.set(provider.name, Date.now() + 60_000);
      lastError = err;
    }
  }
  logger.error('provider.all_failed', { attempted: providers.map(p => p.name), lastError: lastError?.message });
  throw new Error('All providers failed. Last error: ' + lastError?.message);
}

// ─── Victor: multi-agent reasoning pipeline ─────────────────
// Not a separate AI — it's a 5-stage process built ON TOP of
// the providers above: Router (classify intent) → Processor
// (draft via real AI) → Validator (score the draft) →
// Optimizer (re-prompt AI to improve, up to 2x if needed) →
// Executor (return final text). This is what makes "Victor"
// a genuinely different model option, not a relabeled Groq call.

function victorRoute(userMessage) {
  const lower = userMessage.toLowerCase();
  let intent = 'general';
  if (/code|function|bug|debug|script|programming/.test(lower)) intent = 'code';
  else if (/write|essay|article|story|email|draft/.test(lower)) intent = 'writing';
  else if (/analy[sz]e|compare|pros and cons|evaluate|research/.test(lower)) intent = 'analysis';
  return { agent: 'Router', intent };
}

function victorValidate(text) {
  const checks = [
    { name: 'length',    passed: text.trim().length >= 20 },
    { name: 'no-refusal', passed: !/^(error|sorry, i (can't|cannot))/i.test(text.trim()) },
    { name: 'clean',     passed: !text.includes('undefined') && !text.includes('[object Object]') }
  ];
  const score = Math.round((checks.filter(c => c.passed).length / checks.length) * 100);
  return { agent: 'Validator', score, isValid: score >= 70 };
}

async function victorOptimize(messages, draft, signal) {
  const refineMessages = [
    ...messages,
    { role: 'assistant', content: draft },
    { role: 'user', content: 'Improve and tighten your previous answer — fix gaps, keep it accurate and well-structured. Reply with only the improved answer, nothing else.' }
  ];
  return getAIReply(refineMessages, 'auto', signal);
}

async function runVictorPipeline(messages, signal) {
  const userMessage = messages[messages.length - 1].content;
  const route = victorRoute(userMessage);

  let { reply: text, provider } = await getAIReply(messages, 'auto', signal);
  let validation = victorValidate(text);
  let attempts = 0;

  while (!validation.isValid && attempts < 2) {
    if (signal?.aborted) break;
    attempts++;
    try {
      const opt = await victorOptimize(messages, text, signal);
      text = opt.reply;
      provider = opt.provider;
    } catch {
      break;
    }
    validation = victorValidate(text);
  }

  return {
    reply: text,
    provider: `Victor · ${route.intent} · via ${provider} · ${validation.score}%`
  };
}

// ─── Agent: tool-using AI (calculator + live web search) ────
// Unlike Victor (which only refines text), this agent can take
// ACTIONS: it decides whether to answer directly or call a tool,
// reads the tool's real result, and loops until it has a final
// answer. This is what makes it a genuine "agent" and not a
// relabeled chat call.
//
// Tool implementations now live in src/agents/tools.js — extracted so
// the Phase 5 persona agents can share the exact same tools instead of
// a duplicated (and potentially diverging) copy.
const agentTools = makeTools(fetchWithTimeout, safeJson);

const AGENT_SYSTEM_PROMPT = `You are Nova Agent, a tool-using AI assistant. You can use tools to help answer the user's goal.

Available tools:
- calculator(expression): evaluates a math expression
- webSearch(query): searches the web for current information

On EVERY turn, respond with ONLY ONE of these two formats, nothing else:
TOOL: toolName | input text
FINAL: your complete final answer to the user

Use a tool when you need a real calculation or current information you don't already know.
Use FINAL as soon as you can fully answer the user's goal.
Never fabricate a tool result — always wait for the real result before continuing.`;

async function runAgent(userGoal, signal, maxSteps = 3) {
  const steps = [];
  const messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: userGoal }
  ];

  for (let i = 0; i < maxSteps; i++) {
    if (signal?.aborted) throw new Error('Client disconnected');

    const { reply, provider } = await getAIReply(messages, 'auto', signal);
    const trimmed = reply.trim();

    const finalMatch = trimmed.match(/^FINAL:\s*([\s\S]*)/i);
    if (finalMatch) {
      steps.push({ type: 'final', content: finalMatch[1].trim() });
      return { answer: finalMatch[1].trim(), steps, provider };
    }

    const toolMatch = trimmed.match(/^TOOL:\s*(\w+)\s*\|\s*([\s\S]*)/i);
    if (toolMatch) {
      const [, toolName, toolInput] = toolMatch;
      const tool = agentTools[toolName.trim()];
      if (!tool) {
        messages.push({ role: 'assistant', content: trimmed });
        messages.push({ role: 'user', content: `Tool "${toolName}" does not exist. Available tools: ${Object.keys(agentTools).join(', ')}. Try again.` });
        steps.push({ type: 'error', content: `Unknown tool: ${toolName}` });
        continue;
      }
      const result = await tool.run(toolInput.trim(), signal);
      steps.push({ type: 'tool', tool: toolName.trim(), input: toolInput.trim(), result });
      messages.push({ role: 'assistant', content: trimmed });
      messages.push({ role: 'user', content: `Tool result: ${result}` });
      continue;
    }

    // Model didn't follow the format — treat its raw reply as the final answer
    steps.push({ type: 'final', content: trimmed });
    return { answer: trimmed, steps, provider };
  }

  return { answer: 'Reached max steps without a final answer. Try a more specific goal.', steps, provider: 'Agent' };
}

// ─── Agent endpoint ────────────────────────────────────────
app.post('/api/agent', agentLimiter, usageGate('messages'), async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());

  try {
    const goal = req.body.goal;
    if (!goal || typeof goal !== 'string') return res.status(400).json({ error: 'goal is required' });
    if (goal.length > 2000) return res.status(400).json({ error: 'goal too long (max 2000 chars)' });

    const { answer, steps, provider } = await runAgent(goal, reqController.signal);
    res.json({ answer, steps, provider });
  } catch (err) {
    logger.error('agent.failed', { requestId: req.id, error: err.message, userId: req.dbUser?.id || null });
    res.status(503).json({ error: 'Nova Agent is temporarily busy. Please try again.' });
  }
});

// ─── Developer Hub: Coding Agent endpoint ───────────────────
// Real modes over real pasted code: explain / fix / review / refactor / docs.
// Uses the same provider chain as chat (Groq/Gemini/ChatGPT/fallback) —
// no separate model, just a purpose-built prompt per mode.
// ─── Victus: Agent Orchestration endpoint ───────────────────
// Phase 4. A single entrypoint that decides which capability a message
// actually needs — chat, Nova Agent (tool use), or the coding agent —
// instead of the caller having to know which endpoint to hit. See
// src/victus/orchestrator.js for the (deterministic, testable) routing
// logic. Existing dedicated endpoints (/api/chat, /api/agent,
// /api/dev/code) are untouched — this sits alongside them, not in
// place of them.
// ─── Phase 5: AI Agents (persona layer) ─────────────────────
// GET /api/agents — list the 8 personas and whether each has real tool
// access, so a frontend can render this honestly (not implying every
// agent can "do" everything).
app.get('/api/agents', (req, res) => {
  res.json({ agents: agentRegistry.listPersonas() });
});

// POST /api/agents/:agentKey — run a specific persona.
// Supports two modes:
//  - ?stream=true (or Accept: text/event-stream): real SSE, same
//    mechanism /api/chat already uses — start/tool_call/tool_result/
//    final events as they happen, not buffered until the end.
//  - default: single JSON response once the agent finishes.
// MEMORY: Victus adaptive context is loaded for logged-in users, same
// as /api/chat. RETRIES: getAIReply's existing multi-provider fallback.
// LOGGING: structured events via src/agents/framework.js. TOOL CALLING:
// the shared ReAct loop, scoped to each persona's real tool subset.
app.post('/api/agents/:agentKey', agentLimiter, usageGate('messages'), async (req, res) => {
  const persona = agentRegistry.getPersona(req.params.agentKey);
  if (!persona) {
    return res.status(404).json({ error: `Unknown agent: ${req.params.agentKey}`, available: agentRegistry.listPersonas().map(p => p.key) });
  }

  const { message } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'message too long (max 2000 characters)' });
  }

  const wantsStream = req.query.stream === 'true' || (req.headers.accept || '').includes('text/event-stream');
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());

  const tools = {};
  for (const toolKey of persona.tools) {
    tools[toolKey] = agentTools[toolKey];
  }

  const adaptiveContext = req.dbUser ? await victus.buildAdaptiveContext(req.dbUser.id, message).catch(() => '') : '';

  if (wantsStream) {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const onEvent = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      await runPersonaAgent({
        persona, userMessage: message, tools, adaptiveContext, getAIReply,
        signal: reqController.signal, onEvent, requestId: req.id, userId: req.dbUser?.id,
      });
    } catch (err) {
      logger.error('agent.persona.failed', { requestId: req.id, agent: persona.key, error: err.message });
      onEvent({ type: 'error', message: 'Agent failed. Please try again.' });
    }
    res.end();
    return;
  }

  try {
    const result = await runPersonaAgent({
      persona, userMessage: message, tools, adaptiveContext, getAIReply,
      signal: reqController.signal, requestId: req.id, userId: req.dbUser?.id,
    });
    res.json({ agent: persona.key, ...result });
  } catch (err) {
    logger.error('agent.persona.failed', { requestId: req.id, agent: persona.key, error: err.message });
    res.status(503).json({ error: `${persona.name} is temporarily busy. Please try again.` });
  }
});


async function runCodingThroughVictus({ mode, code, language, errorMessage, goal, framework, depth, signal }) {
  victusSafety.killSwitch.assertRunning('coding');
  const requestedDepth = depth === 'fast' ? 'fast' : 'deep';
  const workflows = requestedDepth === 'fast'
    ? [`coding:${mode}:fast`]
    : [`coding:${mode}:deep`, `coding:${mode}:fast`];

  const plan = new PlanGraph(`coding ${mode}`);
  plan.addStep({
    id: 'coding',
    action: 'coding_agent',
    description: `Execute ${mode} coding workflow`,
  });

  const requestGoal = goal;
  const codingLanguage = String(detectCodingLanguage(code, language) || 'unknown').toLowerCase().replace(/[^a-z0-9#+.-]/g, '');
  const victusGoal = `${mode} coding request`;
  const experienceFamily = `coding:${codingLanguage}:${mode}`;
  const result = await codingVictus.runGoal({
    goal: victusGoal,
    workflows,
    plan,
    context: {
      mode,
      code,
      language,
      depth: requestedDepth,
      extra: { errorMessage, goal: requestGoal, framework },
      signal,
      experienceFamily,
    },
    verify: async ({ results }) => {
      const coding = results[0]?.output?.result;
      const verification = coding?.verification;
      // Fast mode has no verifier: report the outcome as unknown instead of crediting a success.
      if (!verification) return { verified: true, confidence: null, learn: false, source: 'coding-agent-no-verifier' };
      const passed = /^\s*PASS\b/i.test(String(verification));
      return { verified: passed, confidence: passed ? 0.92 : 0.35, source: 'coding-agent-verifier' };
    },
  });

  const coding = result.results[0]?.output?.result;
  if (!coding) throw new Error('Victus coding workflow returned no coding result');
  return {
    ...coding,
    victus: {
      workflow: result.workflow,
      success: result.success,
      verification: result.verification,
      telemetry: codingVictus.telemetry.summarize({ type: 'goal' }),
    },
  };
}

app.post('/api/orchestrate', agentLimiter, usageGate('messages'), async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());

  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const routing = orchestrator.routeMessage(message);
    logger.info('orchestrate.routed', { requestId: req.id, target: routing.target, reason: routing.reason });

    if (routing.target === 'coding_agent') {
      const result = await runCodingThroughVictus({
        mode: routing.codingMode, code: message, language: null, depth: 'deep', extra: {},
        signal: reqController.signal,
      });
      return res.json({ ...result, routing });
    }

    if (routing.target === 'agent') {
      const { answer, steps, provider } = await runAgent(message, reqController.signal);
      return res.json({ answer, steps, provider, routing });
    }

    // Default: plain chat, no history (this endpoint is stateless by
    // design — for a full conversation with memory, use /api/chat).
    const { reply, provider } = await getAIReply(
      [{ role: 'system', content: 'You are Nova AI, a helpful assistant.' }, { role: 'user', content: message }],
      'auto',
      reqController.signal,
      message
    );
    res.json({ result: reply, provider, routing });
  } catch (err) {
    logger.error('orchestrate.failed', { requestId: req.id, error: err.message });
    res.status(503).json({ error: 'Could not process that request right now.' });
  }
});

// ─── Developer Hub: GitHub integration (read-only) ──────────
// Phase 6. Fetch a real file or repo tree from GitHub, to feed into the
// coding agent modes above without the user needing to copy-paste code
// manually. No write access — see src/devhub/github.js for why.
app.post('/api/dev/github/file', agentLimiter, async (req, res) => {
  try {
    const { repo, path, ref } = req.body;
    if (!repo || !path) return res.status(400).json({ error: 'repo and path are required' });
    const parsed = githubIntegration.parseRepoInput(repo);
    if (!parsed) return res.status(400).json({ error: 'repo must be "owner/repo" or a github.com URL' });

    const result = await githubIntegration.fetchFileContent({ ...parsed, path, ref }, process.env.GITHUB_TOKEN, fetchWithTimeout, safeJson);
    res.json(result);
  } catch (err) {
    logger.warn('devhub.github.file_failed', { requestId: req.id, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/dev/github/tree', agentLimiter, async (req, res) => {
  try {
    const { repo, ref } = req.body;
    if (!repo) return res.status(400).json({ error: 'repo is required' });
    const parsed = githubIntegration.parseRepoInput(repo);
    if (!parsed) return res.status(400).json({ error: 'repo must be "owner/repo" or a github.com URL' });

    const result = await githubIntegration.listRepoTree({ ...parsed, ref }, process.env.GITHUB_TOKEN, fetchWithTimeout, safeJson);
    res.json(result);
  } catch (err) {
    logger.warn('devhub.github.tree_failed', { requestId: req.id, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

// ─── Developer Hub: Terminal Assistant ──────────────────────
// Explains and safety-checks a shell command — does NOT execute it.
// See src/devhub/terminalAssistant.js for why "AI terminal" stops here.
app.post('/api/dev/terminal/explain', agentLimiter, usageGate('messages'), async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    const { command } = req.body;
    const result = await terminalAssistant.explainCommand(command, getAIReply, reqController.signal);
    res.json(result);
  } catch (err) {
    logger.warn('devhub.terminal.explain_failed', { requestId: req.id, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/dev/code', agentLimiter, usageGate('messages'), async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());

  try {
    const { mode, code, language, errorMessage, goal, framework, depth } = req.body;
    if (!mode || !VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: `mode is required and must be one of: ${VALID_MODES.join(', ')}` });
    }
    if (!code || typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: DESCRIPTION_MODES.includes(mode) ? 'description is required' : 'code is required' });
    }
    if (code.length > MAX_CODE_LENGTH) {
      return res.status(400).json({ error: `input too long (max ${MAX_CODE_LENGTH.toLocaleString()} characters)` });
    }

    const result = await runCodingThroughVictus({
      mode, code, language, depth: depth || 'deep', errorMessage, goal, framework,
      signal: reqController.signal,
    });
    res.json(result);
  } catch (err) {
    logger.error('coding_agent.failed', { requestId: req.id, error: err.message, mode: req.body?.mode, userId: req.dbUser?.id || null });
    res.status(503).json({ error: 'Coding agent is temporarily busy. Please try again.' });
  }
});

// ─── Victus feedback endpoint ────────────────────────────────
// Thumbs up/down on a specific assistant message. This is the input
// side of the adaptive loop — combined with buildAdaptiveContext()
// above, it's what makes responses actually shift over time instead
// of "adaptive" being just a name.
app.post('/api/victus/feedback', chatLimiter, async (req, res) => {
  try {
    if (!req.dbUser) return res.status(401).json({ error: 'Sign in to leave feedback' });
    const { messageId, rating } = req.body;
    if (!messageId || ![1, -1].includes(rating)) {
      return res.status(400).json({ error: 'messageId and rating (1 or -1) are required' });
    }
    const result = await victus.recordFeedback(req.dbUser.id, messageId, rating);

    // Real ML step: nudge the style model's weights based on this
    // specific rating. Independent of the text-memory feedback above —
    // this is the part that's genuinely a learning algorithm, not just
    // storage. Never let it block the response to the user.
    const learning = await styleModel.learnFromRating(messageId, req.dbUser.id, rating).catch(err => {
      console.warn('[Victus styleModel] learning step skipped:', err.message);
      return { updated: false };
    });

    res.json({ ...result, styleModelUpdated: learning.updated });
  } catch (err) {
    logger.error('feedback.failed', { requestId: req.id, error: err.message, userId: req.dbUser?.id || null });
    res.status(503).json({ error: 'Could not save feedback right now.' });
  }
});

// ─── Chat endpoint ─────────────────────────────────────────
app.post('/api/chat', chatLimiter, usageGate('messages'), async (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const sendError = (msg) => { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); res.end(); };

  // FIX (Bug #8): cancel provider fetch if browser disconnects mid-stream
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());

  try {
    const userMessage = req.body.message;
    const history     = req.body.history || [];
    const model       = (req.body.model || 'auto').toLowerCase();
    let   conversationId = req.body.conversationId || null;
    if (!userMessage || typeof userMessage !== 'string') return sendError('Message is required');
    if (userMessage.length > 12000) return sendError('Message too long (max 12000 chars)');

    // FIX (Bug #1): strip any injected system roles from client-supplied history
    const safeHistory = history
      .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
      .slice(-10);

    // Victus: adaptive personalization. Reads back preferences/feedback
    // learned from THIS user's past sessions. UPGRADED (Phase 4): now
    // retrieves only preferences relevant to the CURRENT message instead
    // of dumping everything stored — see src/victus/memoryRetrieval.js.
    const adaptiveContext = req.dbUser ? await victus.buildAdaptiveContext(req.dbUser.id, userMessage) : '';

    // Victus Style Model: the actual small ML component — a per-user
    // contextual bandit picks "concise" vs "detailed" based on learned
    // weights, not just stored text. See src/victus/styleModel.js for
    // exactly what this is and isn't.
    const stylePrediction = await styleModel.chooseStyle(req.dbUser?.id, userMessage, safeHistory.length);
    const styleInstruction = styleModel.styleInstruction(stylePrediction.style);

    // Victus Writing Style Fingerprint (Phase 4): deterministic analysis
    // of how THIS user writes (formality, verbosity, emoji use) so
    // replies can mirror their tone instead of one generic voice.
    const writingStyleInstruction = toneFingerprint.toInstruction(toneFingerprint.analyzeMessages(safeHistory));

    // Victus Context Compression (Phase 4): for long conversations, use
    // a stored summary of older turns + only the most recent raw
    // messages, instead of re-sending the entire history every time.
    // Best-effort: if conversationId is missing/invalid/DB is down, this
    // just falls back to the raw safeHistory with no summary — never
    // blocks the chat from working.
    let promptHistory = safeHistory;
    let existingContextSummary = null;
    let messagesSinceSummary = 0;
    if (db.isEnabled() && conversationId) {
      try {
        const ctx = await db.getConversationContext(conversationId);
        existingContextSummary = ctx.contextSummary;
        messagesSinceSummary = ctx.messagesSinceSummary;
        if (existingContextSummary) {
          const compressed = contextCompression.buildPromptContext(existingContextSummary, safeHistory);
          promptHistory = compressed.recentMessages;
        }
      } catch (err) {
        console.warn('[WARN] Could not load context summary (non-fatal):', err.message);
      }
    }
    const compressionNote = existingContextSummary
      ? contextCompression.buildPromptContext(existingContextSummary, safeHistory).contextNote
      : null;

    const baseSystemPrompt = 'You are Nova AI, a futuristic, intelligent, and helpful AI assistant. Be concise, friendly, and insightful. When the user sends file contents, read them carefully and answer based on that content. Refuse harmful or illegal requests politely.';
    const systemContent = [baseSystemPrompt, compressionNote, adaptiveContext, styleInstruction, writingStyleInstruction].filter(Boolean).join('\n\n');

    const messages = [
      { role: 'system', content: systemContent },
      ...promptHistory,
      { role: 'user', content: userMessage }
    ];

    // Pass abort signal so fetch is cancelled if user disconnects
    const { reply, provider } = model === 'victor'
      ? await runVictorPipeline(messages, reqController.signal)
      : await getAIReply(messages, model, reqController.signal, userMessage);

    // Persist to Postgres for logged-in users only — guests keep working
    // exactly as before, just unpersisted. Never let a save failure break
    // an otherwise-successful reply, same fail-open pattern as usageGate.
    let assistantMessageId = null;
    if (db.isEnabled() && req.dbUser) {
      try {
        if (conversationId) {
          const owned = await db.getConversation(conversationId, req.dbUser.id);
          if (!owned) conversationId = null; // not theirs (or doesn't exist) — start fresh instead of trusting client input
        }
        if (!conversationId) {
          const conversation = await db.createConversation(req.dbUser.id, generateTitle(userMessage));
          conversationId = conversation.id;
        }
        await db.addMessage(conversationId, { role: 'user', content: userMessage });
        const savedAssistantMsg = await db.addMessage(conversationId, { role: 'assistant', content: reply, provider });
        assistantMessageId = savedAssistantMsg?.id || null;

        // Record which style the bandit chose for THIS message, so that
        // when a rating arrives later, learnFromRating() knows exactly
        // what to update.
        if (assistantMessageId && stylePrediction.features) {
          await styleModel.recordPrediction(
            assistantMessageId, req.dbUser.id, stylePrediction.features, stylePrediction.style, stylePrediction.predictedValue
          );
        }

        // Victus: distill durable preferences every ~4 turns. Fire-and-forget —
        // never delays the reply, never breaks it if it fails.
        if (safeHistory.length % 4 === 0) {
          victus.learnFromConversation(
            req.dbUser.id,
            [...safeHistory, { role: 'user', content: userMessage }, { role: 'assistant', content: reply }],
            getAIReply
          ).catch(() => {});
        }

        // Victus Context Compression (Phase 4): once this conversation has
        // accumulated enough messages since the last summary, compress the
        // older turns in the background. Never blocks the current reply —
        // the summary becomes available starting with the NEXT message.
        const newCount = await db.incrementMessagesSinceSummary(conversationId);
        if (contextCompression.shouldCompress(newCount)) {
          db.listMessages(conversationId, { limit: 100 })
            .then(({ items }) => {
              const fullHistory = items.map(m => ({ role: m.role, content: m.content }));
              return contextCompression.generateSummary(fullHistory, existingContextSummary, getAIReply);
            })
            .then(summary => summary && db.updateContextSummary(conversationId, summary))
            .catch(err => console.warn('[WARN] context compression skipped (non-fatal):', err.message));
        }
      } catch (err) {
        console.warn('[WARN] Failed to persist conversation history:', err.message);
      }
    }

    const words = reply.split(' ');
    const CHUNK_SIZE = 8;
    for (let i = 0; i < words.length; i += CHUNK_SIZE) {
      const chunk = words.slice(i, i + CHUNK_SIZE).join(' ') + ' ';
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      await new Promise(r => setTimeout(r, 30));
    }
    res.write(`data: ${JSON.stringify({ done: true, provider, conversationId, assistantMessageId })}\n\n`);
    res.end();
  } catch (err) {
    logger.error('chat.failed', { requestId: req.id, error: err.message, userId: req.dbUser?.id || null });
    sendError('Nova AI is temporarily busy. Please try again in a moment.');
  }
});


// ─── Victus: safe read-only research ─────────────────────────
// Sources are fetched with a server-side domain allowlist, SSRF checks,
// redirect validation, response-size/time limits, and prompt-injection
// filtering. No fetched content is ever executed, uploaded, or written back.
app.post('/api/victus/research', agentLimiter, usageGate('messages'), async (req, res) => {
  const reqController = new AbortController();
  req.on('close', () => reqController.abort());
  try {
    if (!victusResearch) {
      return res.status(503).json({ error: 'Victus research is disabled. Configure VICTUS_RESEARCH_ALLOWLIST first.' });
    }
    if (victusSafety.killSwitch.isEngaged('research')) {
      victusSafety.audit.append({ actor: req.dbUser?.email || 'user', action: 'research.request', outcome: 'blocked', metadata: { reason: 'kill switch engaged' } });
      return res.status(503).json({ error: 'Victus research is stopped by the kill switch.', code: 'KILL_SWITCH_ENGAGED' });
    }
    const { query, urls, domains, maxSources } = req.body || {};
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    if (query.length > 1000) return res.status(400).json({ error: 'query too long (max 1000 characters)' });
    if (urls != null && (!Array.isArray(urls) || urls.some(u => typeof u !== 'string'))) {
      return res.status(400).json({ error: 'urls must be an array of strings' });
    }
    if (domains != null && (!Array.isArray(domains) || domains.some(d => typeof d !== 'string'))) {
      return res.status(400).json({ error: 'domains must be an array of strings' });
    }
    const result = await victusResearch.research({
      goal: query.trim(),
      urls,
      domains,
      maxDocuments: Math.min(6, Math.max(1, Number(maxSources) || 6)),
      signal: reqController.signal,
    });
    victusSafety.audit.append({ actor: req.dbUser?.email || 'user', action: 'research.completed', metadata: { query: query.trim().slice(0, 200), sources: result.sources?.length || 0, claims: result.claims?.length || 0, promptInjectionDetected: result.security?.promptInjectionDetected === true } });
    res.json(result);
  } catch (err) {
    victusSafety.audit.append({ actor: req.dbUser?.email || 'user', action: 'research.failed', outcome: 'error', metadata: { code: err.code || null, error: err.message } });
    logger.warn('victus.research.failed', { requestId: req.id, error: err.message, code: err.code || null });
    const status = err.code === 'DOMAIN_NOT_ALLOWLISTED' || err.code === 'SSRF_BLOCKED' || err.code === 'BAD_PROTOCOL' ? 403 : 400;
    res.status(status).json({ error: err.message, code: err.code || 'RESEARCH_FAILED' });
  }
});

// ─── Victus: self-monitoring status ─────────────────────────
// Operational state only. This endpoint exposes health, bounded autonomous
// decisions, active coding tasks, and recent outcomes — never prompts, API
// keys, model secrets, or fetched page contents.
app.get('/api/victus/self-monitor', agentLimiter, async (req, res) => {
  try {
    const status = codingVictus.selfMonitor.status();
    res.json({
      mode: 'operational-self-monitoring',
      consciousnessClaim: false,
      ...status,
      recent: codingVictus.selfMonitor.recent(20),
      telemetry: codingVictus.telemetry.summarize({ type: 'goal' }),
    });
  } catch (err) {
    logger.warn('victus.self_monitor.failed', { requestId: req.id, error: err.message });
    res.status(503).json({ error: 'Victus self-monitor is temporarily unavailable.' });
  }
});

// ─── Victus World Model ─────────────────────────────────────
// Descriptive, tenant-scoped graph only. It stores structured context but
// does not grant permissions, mutate safety policy, or execute tools.
mountWorldModelRoutes(app, worldModel, { limiter: agentLimiter });
mountMissionRoutes(app, missionEngine, { limiter: agentLimiter });

// ─── Victus Internet Layer ──────────────────────────────────
// Provider-independent, read-only web access. The gateway can route requests
// through local egress or configured relay nodes, cache successful responses,
// and fail over across nodes. It never grants arbitrary write access to the web.
if (victusInternet) {
  mountInternetRoutes(app, victusInternet, { limiter: agentLimiter, adminKey: ENV.VICTUS_INTERNET_ADMIN_KEY, killSwitch: victusSafety.killSwitch });
}

// ─── Victus Cloud Memory ────────────────────────────────────
// Tiered application memory: local hot cache plus optional encrypted remote
// memory nodes. Remote memory is never treated as physical RAM.
if (victusCloudMemory) {
  mountCloudMemoryRoutes(app, victusCloudMemory, {
    limiter: agentLimiter,
    killSwitch: victusSafety.killSwitch,
    isAdmin: req => !!victusSafety.routes.authenticateAdmin(req),
  });
}

// ─── Victus Cloud: Universal AI Compute Layer ───────────────
// All routes are defined in one place (src/victus/cloud/routes.js) so there is no
// second path that could bypass authentication or the compute kill switch.
if (ENV.UACL_ENABLED) {
  const insecureDev = ENV.UACL_ALLOW_INSECURE_DEV && ENV.NODE_ENV !== 'production';
  if (!ENV.UACL_ADMIN_KEY || !ENV.UACL_WORKER_KEY) {
    console.warn(`[WARN] UACL_ADMIN_KEY / UACL_WORKER_KEY not set — ${insecureDev ? 'INSECURE DEV MODE: admin and worker endpoints are open' : 'admin/worker endpoints will refuse requests (503)'}`);
  }
  mountUaclRoutes(app, uacl, {
    adminSecret: ENV.UACL_ADMIN_KEY,
    workerSecret: ENV.UACL_WORKER_KEY,
    killSwitch: victusSafety.killSwitch,
    allowInsecureDev: insecureDev,
    logger,
  }, { limiter: agentLimiter, clientGate: usageGate('messages') });
}


// ─── Victus: safety control plane (admin only) ───────────────
// Kill switch, audit log, and the upgrade proposal queue. Admin = an email in
// ADMIN_EMAILS (logged in) or the x-victus-admin-token header matching
// VICTUS_ADMIN_TOKEN (min 24 chars) — the latter works even if login/DB is down.
{
  const r = victusSafety.routes;
  app.get('/api/victus/safety/status',            agentLimiter, r.status);
  app.post('/api/victus/safety/kill-switch',      agentLimiter, r.engage);
  app.post('/api/victus/safety/release',          agentLimiter, r.release);
  app.get('/api/victus/audit',                    agentLimiter, r.auditList);
  app.get('/api/victus/audit/verify',             agentLimiter, r.auditVerify);
  app.get('/api/victus/proposals',                agentLimiter, r.proposalsList);
  app.post('/api/victus/proposals',               agentLimiter, r.proposalCreate);
  app.get('/api/victus/proposals/:id',            agentLimiter, r.proposalGet);
  app.post('/api/victus/proposals/:id/approve',   agentLimiter, r.proposalApprove);
  app.post('/api/victus/proposals/:id/reject',    agentLimiter, r.proposalReject);
  app.post('/api/victus/proposals/:id/applied',   agentLimiter, r.proposalApplied);
}

// ─── Catch-all (MUST stay after every other route, or it shadows them) ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});


// ─── Global error handler ────────────────────────────────────
// Must be registered after all routes (Express requires this exact
// position for error middleware — a 4-arg function is treated
// specially only when it's last). Primarily here to give multer errors
// (oversized/malformed file uploads, added in Phase 11) a clean JSON
// response instead of falling through to Express's default HTML error
// page.
app.use((err, req, res, next) => {
  if (err?.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 20MB).' : `Upload error: ${err.message}`;
    logger.warn('upload.multer_error', { requestId: req.id, code: err.code });
    return res.status(413).json({ error: message });
  }
  logger.error('unhandled_error', { requestId: req?.id, error: err?.message, stack: ENV.NODE_ENV !== 'production' ? err?.stack : undefined });
  reportError(err, { requestId: req?.id, userId: req?.dbUser?.id, path: req?.path }, db, fetchWithTimeout).catch(() => {});
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const PORT = process.env.PORT || 5000;

(async function start() {
  try {
    await db.migrate();
  } catch (err) {
    console.error('[ERR]  Database migration failed — billing/usage tracking disabled:', err.message);
  }

  // Phase 13: start the real background job worker. Registers the
  // available workflows as job handlers, then begins polling for due
  // jobs. Safe to call even when DB isn't configured — startWorker()
  // checks db.isEnabled() itself and no-ops with a clear log line.
  registerWorkflowJobHandlers(automationJobQueue, { getAIReply });

  // Phase 15: SSO — genuinely activates only if a real IdP is configured; safe no-op otherwise.
  sso.setupSSO(app, passport, logger);
  automationJobQueue.startWorker({ pollIntervalMs: 5000 });

  const server = app.listen(PORT, () => {
    console.log(`[OK]   Nova AI v2.0 running on port ${PORT}`);
    console.log(`[OK]   Environment: ${ENV.NODE_ENV}`);
    console.log(`[OK]   Base URL: ${ENV.BASE_URL}`);
    console.log(`[OK]   Database: ${db.isEnabled() ? 'connected' : 'not configured — running message-limit-free, as before'}`);
    console.log(`[OK]   Billing:  ${billing.isEnabled() ? 'connected' : 'not configured — checkout/portal routes return 503'}`);
    console.log(`[OK]   UACL:     ${ENV.UACL_ENABLED ? 'enabled — universal compute scheduler ready' : 'disabled'}`);
  }).on('error', (err) => {
    console.error(`[ERR]  Server failed to start: ${err.message}`);
    process.exit(1);
  });

  // Graceful shutdown: stop the UACL sweeper and background workers, stop accepting
  // connections, and force-exit if something hangs. UACL state is in memory, so
  // workers re-register after the next start (see docs/UACL.md).
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[INFO] ${signal} received — shutting down`);
    try { uacl.stop(); } catch { /* ignore */ }
    try { automationJobQueue.stopWorker?.(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
