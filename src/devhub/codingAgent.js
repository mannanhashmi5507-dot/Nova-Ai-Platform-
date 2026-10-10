// ─── Developer Hub: Victus Coding Agent ─────────────────────
// Multi-pass coding agent: deterministic preflight -> coding plan ->
// implementation/review -> optional verification pass. It still never
// executes user code on the server.

const {
  buildCodingContext,
  formatCodingContext,
} = require('./codingIntelligence');

const MAX_CODE_LENGTH = 30000;
const VALID_MODES = ['explain', 'fix', 'review', 'refactor', 'docs', 'generate', 'test', 'scaffold', 'architect', 'optimize', 'security', 'migrate'];
const DESCRIPTION_MODES = ['generate', 'scaffold'];
const MULTI_PASS_MODES = new Set(['fix', 'review', 'refactor', 'generate', 'test', 'architect', 'optimize', 'security', 'migrate']);

function truncate(code) {
  return code.length > MAX_CODE_LENGTH ? code.slice(0, MAX_CODE_LENGTH) + '\n\n// ...truncated (exceeds 30,000 char limit)' : code;
}

function codeBlock(code, language) {
  return `\`\`\`${language || ''}\n${truncate(code)}\n\`\`\``;
}

function buildPrompt(mode, code, language, extra, context = buildCodingContext({ code, language, mode, extra })) {
  const lang = context.language || language || 'unspecified — infer it from the code';
  const block = codeBlock(code, lang === 'unknown' ? language : lang);
  const preflight = formatCodingContext(context);
  const outputRule = '\nDo not claim that code was executed, tested, compiled, deployed, or benchmarked unless a real tool result is explicitly supplied.';

  switch (mode) {
    case 'explain':
      return [
        { role: 'system', content: `You are a senior software engineer. Explain real code precisely. Language: ${lang}. ${preflight}\nExplain data flow, control flow, important assumptions, failure paths, and likely maintenance hotspots. Reference real symbols. Separate observed behavior from inference.${outputRule}` },
        { role: 'user', content: `Explain this code:\n\n${block}` },
      ];
    case 'fix': {
      const errorNote = extra?.errorMessage ? `\n\nReported error/symptom:\n${extra.errorMessage}` : '';
      return [
        { role: 'system', content: `You are a senior debugging engineer. Find the highest-confidence root cause in this code. Language: ${lang}. ${preflight}\nReturn exactly: ROOT CAUSE, FIX, WHY IT WORKS, REGRESSION RISKS, TESTS TO ADD. Prefer the smallest correct patch. If evidence is insufficient, distinguish hypotheses from facts.${outputRule}` },
        { role: 'user', content: `Debug and fix this code:${errorNote}\n\n${block}` },
      ];
    }
    case 'review':
      return [
        { role: 'system', content: `Perform a senior-level code review. Language: ${lang}. ${preflight}\nFocus on correctness, security, reliability, performance, concurrency, API contracts, error handling, and maintainability. Do not invent issues. For each issue give severity, location/symbol, impact, evidence, and concrete fix. End with targeted tests that would prove the review findings.${outputRule}` },
        { role: 'user', content: `Review this code:\n\n${block}` },
      ];
    case 'refactor': {
      const goal = extra?.goal ? `Specific goal: ${extra.goal}` : 'Improve clarity, maintainability, and testability without changing intended behavior.';
      return [
        { role: 'system', content: `You are a refactoring specialist. Language: ${lang}. ${preflight}\n${goal}\nPreserve observable behavior and API contracts. Identify risks before the patch. Return: REFACTOR PLAN, REFACTORED CODE, BEHAVIORAL INVARIANTS, TEST PLAN.${outputRule}` },
        { role: 'user', content: `Refactor this code:\n\n${block}` },
      ];
    }
    case 'docs':
      return [
        { role: 'system', content: `Document the code accurately. Language: ${lang}. ${preflight}\nAdd only documentation supported by the implementation. Cover public APIs, parameters, return values, side effects, errors, and important invariants.${outputRule}` },
        { role: 'user', content: `Document this code:\n\n${block}` },
      ];
    case 'generate': {
      const langNote = language ? `Language/framework: ${language}.` : 'Choose a suitable production-ready language/framework and state the choice.';
      return [
        { role: 'system', content: `You are a senior software engineer writing new code from a description. ${langNote}\nThink in interfaces, data flow, failure modes, security, testability, and observability. Produce complete working code, then ASSUMPTIONS and TEST PLAN.${outputRule}` },
        { role: 'user', content: `Implement this request:\n\n${truncate(code)}` },
      ];
    }
    case 'test': {
      const framework = extra?.framework ? `using ${extra.framework}` : 'using an idiomatic test framework for the language';
      return [
        { role: 'system', content: `Write real tests ${framework}. Language: ${lang}. ${preflight}\nCover happy paths, boundaries, invalid input, failure behavior, async/concurrency cases when relevant, and regression cases suggested by the implementation. Never invent APIs not present in the code.${outputRule}` },
        { role: 'user', content: `Write tests for this code:\n\n${block}` },
      ];
    }
    case 'scaffold':
      return [
        { role: 'system', content: `Scaffold a small runnable project from the specification. This is a STARTING POINT, not a finished app. ${language ? `Primary stack: ${language}.` : ''}\nOutput architecture, file tree, dependency choices, starter code, setup steps, and first tests. Keep the scaffold genuinely runnable and clearly mark what is not implemented.${outputRule}` },
        { role: 'user', content: `Scaffold this project:\n\n${truncate(code)}` },
      ];
    case 'architect':
      return [
        { role: 'system', content: `Act as a principal software architect. ${language ? `Preferred stack: ${language}.` : ''}\nDesign a production architecture from the specification. Cover modules, interfaces, data model, API contracts, scaling, observability, security boundaries, failure recovery, testing strategy, and migration/rollout. Avoid overengineering. ${preflight}${outputRule}` },
        { role: 'user', content: `Architect this system:\n\n${truncate(code)}` },
      ];
    case 'optimize':
      return [
        { role: 'system', content: `Optimize this code without changing externally visible behavior. Language: ${lang}. ${preflight}\nPrioritize algorithmic complexity, I/O, allocations, database/network calls, async behavior, and hot paths. Return evidence-based changes, expected impact, tradeoffs, and a benchmark plan.${outputRule}` },
        { role: 'user', content: `Optimize this code:\n\n${block}` },
      ];
    case 'security':
      return [
        { role: 'system', content: `Perform an application-security review. Language: ${lang}. ${preflight}\nLook for secrets, injection, auth/authz flaws, unsafe deserialization, command execution, SSRF, path traversal, XSS, CSRF, dependency assumptions, and sensitive-data leakage where applicable. Give severity, evidence, exploit preconditions, and concrete remediation. Do not claim exploitability without evidence.${outputRule}` },
        { role: 'user', content: `Security-review this code:\n\n${block}` },
      ];
    case 'migrate':
      return [
        { role: 'system', content: `Plan and implement a safe code migration. Language: ${lang}. ${preflight}\nPreserve compatibility where possible. Return: MIGRATION PLAN, COMPATIBILITY RISKS, CODE CHANGES, DATA/CONFIG MIGRATION, ROLLBACK PLAN, TEST PLAN.${outputRule}` },
        { role: 'user', content: `Migrate this code as requested:\n${extra?.goal ? `\nTarget: ${extra.goal}\n` : ''}\n${block}` },
      ];
    default:
      throw new Error(`Unknown coding agent mode: ${mode}`);
  }
}

function buildPlanningPrompt(mode, code, language, extra, context) {
  return [
    {
      role: 'system',
      content: `You are the planning pass of Victus, a senior coding agent. Create a compact, evidence-based coding plan before implementation. Mode: ${mode}. ${formatCodingContext(context)}\nReturn: OBJECTIVE, OBSERVATIONS, PLAN (numbered), RISKS, VERIFICATION. Do not write the final code in this pass.`,
    },
    { role: 'user', content: `Task:\n${truncate(code)}\n\n${extra?.errorMessage ? `Error:\n${extra.errorMessage}` : ''}${extra?.goal ? `\nGoal:\n${extra.goal}` : ''}` },
  ];
}

function buildVerificationPrompt(mode, original, draft, context) {
  return [
    {
      role: 'system',
      content: `You are the verification pass of Victus. Review the proposed coding result against the original request. Mode: ${mode}. ${formatCodingContext(context)}\nCheck correctness, missing requirements, regressions, security issues, and unsupported claims. Return PASS or REVISE, then exact corrections. Never say tests passed unless an actual test result is provided.`,
    },
    { role: 'user', content: `ORIGINAL:\n${truncate(original)}\n\nPROPOSED RESULT:\n${truncate(draft)}` },
  ];
}

async function runCodingAgent({ mode, code, language, extra = {}, depth = 'fast' }, getAIReply, signal) {
  if (!VALID_MODES.includes(mode)) throw new Error(`mode must be one of: ${VALID_MODES.join(', ')}`);
  if (!code || typeof code !== 'string' || !code.trim()) throw new Error(DESCRIPTION_MODES.includes(mode) ? 'description is required' : 'code is required');
  if (code.length > MAX_CODE_LENGTH) throw new Error(`input too long (max ${MAX_CODE_LENGTH.toLocaleString()} characters)`);

  const context = buildCodingContext({ code, language, mode, extra });
  const deep = depth !== 'fast' && MULTI_PASS_MODES.has(mode);
  const trace = [{ stage: 'preflight', result: context }];

  let planning = null;
  if (deep) {
    planning = await getAIReply(buildPlanningPrompt(mode, code, language, extra, context), 'auto', signal);
    trace.push({ stage: 'plan', provider: planning.provider, result: planning.reply });
  }

  const primaryMessages = buildPrompt(mode, code, language || context.language, extra, context);
  if (planning?.reply) {
    primaryMessages.push({ role: 'system', content: `Victus planning pass:\n${planning.reply}\nUse this plan, but correct it if the source disproves an assumption.` });
  }
  const primary = await getAIReply(primaryMessages, 'auto', signal);
  trace.push({ stage: 'implementation', provider: primary.provider, result: primary.reply });

  let finalResult = primary.reply;
  let verification = null;
  if (deep) {
    verification = await getAIReply(buildVerificationPrompt(mode, code, primary.reply, context), 'auto', signal);
    trace.push({ stage: 'verification', provider: verification.provider, result: verification.reply });

    if (/^\s*REVISE\b/i.test(verification.reply)) {
      const revisionMessages = [
        ...primaryMessages,
        { role: 'assistant', content: primary.reply },
        { role: 'user', content: `Verification found issues:\n${verification.reply}\nReturn a corrected final result only.` },
      ];
      const revision = await getAIReply(revisionMessages, 'auto', signal);
      trace.push({ stage: 'revision', provider: revision.provider, result: revision.reply });
      finalResult = revision.reply;

      // A revision is not itself proof of correctness. Re-verify the final
      // result so Victus learns from the outcome that actually reaches the user.
      const finalVerification = await getAIReply(
        buildVerificationPrompt(mode, code, finalResult, context),
        'auto',
        signal,
      );
      verification = finalVerification;
      trace.push({ stage: 'final-verification', provider: finalVerification.provider, result: finalVerification.reply });
    }
  }

  return {
    mode,
    result: finalResult,
    provider: primary.provider,
    language: context.language,
    analysis: context,
    verification: verification ? verification.reply : null,
    trace,
  };
}

module.exports = {
  runCodingAgent,
  VALID_MODES,
  DESCRIPTION_MODES,
  MAX_CODE_LENGTH,
  buildPrompt,
};
