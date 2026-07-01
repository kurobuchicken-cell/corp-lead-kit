'use strict';

const USER_AGENT_TOKEN = 'corp-lead-kit';

// robots.txtをパースし、指定パスがuserAgentTokenに許可されているか判定する。
// 取得失敗（robots.txtが存在しない等）は「規約なし＝許可」として扱う。
function parseRobots(text) {
  const groups = []; // { agents: string[], rules: { type: 'allow'|'disallow', path: string }[] }
  let current = null;

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sepIndex = line.indexOf(':');
    if (sepIndex === -1) continue;
    const field = line.slice(0, sepIndex).trim().toLowerCase();
    const value = line.slice(sepIndex + 1).trim();

    if (field === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (field === 'allow' || field === 'disallow') {
      if (!current) continue;
      current.rules.push({ type: field, path: value });
    }
  }
  return groups;
}

function findMatchingGroups(groups, userAgentToken) {
  const token = userAgentToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  if (specific.length > 0) return specific;
  return groups.filter((g) => g.agents.includes('*'));
}

// 最長一致したルールを採用する（robots.txt標準的な解釈）。マッチなしは許可。
function isPathAllowed(groups, pathname, userAgentToken) {
  const matching = findMatchingGroups(groups, userAgentToken);
  let bestRule = null;
  for (const group of matching) {
    for (const rule of group.rules) {
      if (rule.path === '') continue; // Disallow: （空）は「全許可」を意味する
      const pattern = rule.path;
      if (pathname.startsWith(pattern)) {
        if (!bestRule || pattern.length > bestRule.path.length) {
          bestRule = rule;
        }
      }
    }
  }
  if (!bestRule) return true;
  return bestRule.type === 'allow';
}

async function isAllowedByRobots(targetUrl, { userAgentToken = USER_AGENT_TOKEN, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const url = new URL(targetUrl);
  const robotsUrl = `${url.origin}/robots.txt`;

  let text;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchImpl(robotsUrl, {
      headers: { 'User-Agent': userAgentToken },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return true; // robots.txtが無い(404等) → 規約なしとして許可
    text = await res.text();
  } catch {
    return true; // 取得失敗 → 規約なしとして許可（安全側だが、規約が読めない場合まで止めない）
  }

  const groups = parseRobots(text);
  return isPathAllowed(groups, url.pathname || '/', userAgentToken);
}

module.exports = { isAllowedByRobots, parseRobots, isPathAllowed, USER_AGENT_TOKEN };
