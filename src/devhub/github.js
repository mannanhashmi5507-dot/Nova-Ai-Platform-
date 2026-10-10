// ─── Developer Hub: GitHub Integration ───────────────────────
// Phase 6. HONEST SCOPE: read-only. Fetches real file content and repo
// trees from GitHub's public REST API — no write access (no commits, no
// PRs, no pushing). Adding write access means handling OAuth scopes,
// commit signing, and the security surface of an app that can modify a
// user's real repositories — a meaningfully bigger and riskier feature
// than "let the coding agent read your actual code instead of pasted
// code." Read-only ships real value now without that risk.
//
// Works for public repos with NO token at all (GitHub allows this,
// rate-limited to 60 requests/hour per IP). Set GITHUB_TOKEN for higher
// rate limits (5,000/hour) and access to private repos the token can see.

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}`, 'User-Agent': 'nova-ai' } : { 'User-Agent': 'nova-ai' };
}

function parseRepoInput(input) {
  // Accepts "owner/repo" or a full github.com URL.
  const urlMatch = input.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, '') };
  const shortMatch = input.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };
  return null;
}

async function fetchFileContent({ owner, repo, path, ref }, token, fetchWithTimeout, safeJson) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  const res = await fetchWithTimeout(url, { headers: authHeaders(token) }, 15000);

  if (res.status === 404) throw new Error(`File not found: ${owner}/${repo}/${path}`);
  if (res.status === 403) throw new Error('GitHub API rate limit hit or access denied — set GITHUB_TOKEN for higher limits or private repo access');
  if (!res.ok) throw new Error(`GitHub API error ${res.status}`);

  const data = await safeJson(res);
  if (Array.isArray(data)) throw new Error(`"${path}" is a directory, not a file — use listRepoTree instead`);
  if (data.type !== 'file') throw new Error(`"${path}" is not a regular file`);
  if (data.encoding !== 'base64') throw new Error(`Unexpected encoding: ${data.encoding}`);

  const content = Buffer.from(data.content, 'base64').toString('utf8');
  return { path: data.path, content, sizeBytes: data.size, sha: data.sha };
}

async function listRepoTree({ owner, repo, ref }, token, fetchWithTimeout, safeJson) {
  const branchRef = ref || 'HEAD';
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branchRef)}?recursive=1`;
  const res = await fetchWithTimeout(url, { headers: authHeaders(token) }, 15000);

  if (res.status === 404) throw new Error(`Repo or ref not found: ${owner}/${repo}@${branchRef}`);
  if (res.status === 403) throw new Error('GitHub API rate limit hit or access denied — set GITHUB_TOKEN for higher limits or private repo access');
  if (!res.ok) throw new Error(`GitHub API error ${res.status}`);

  const data = await safeJson(res);
  const files = (data.tree || []).filter(item => item.type === 'blob').map(item => ({ path: item.path, sizeBytes: item.size }));
  return { truncated: !!data.truncated, files };
}

module.exports = { parseRepoInput, fetchFileContent, listRepoTree };
