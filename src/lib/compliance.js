'use strict';

// website_urlからドメインを取り出す（wwwは同一視して正規化）。不正なURLはnullを返す。
function extractDomain(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// email/contact_typeだけを見て mail_ready / call_list / excluded(no_contact) を決める。
// optout・サプレッション・重複の判定は呼び出し側（m3_filter.js）で別途行う。
function classifyContact(company) {
  if (company.email) return { status: 'mail_ready', exclude_reason: null };
  if (company.contact_type === 'form_only') return { status: 'call_list', exclude_reason: null };
  return { status: 'excluded', exclude_reason: 'no_contact' };
}

// 重複グループの中から残す1社を選ぶ。email保有 > form_only > none の順に優先し、
// 同順位なら配列内で先に出てきた方を残す（安全側＝より連絡手段の質が高い方を残す）。
function pickSurvivorIndex(indices, companies) {
  const rank = (c) => (c.email ? 0 : c.contact_type === 'form_only' ? 1 : 2);
  return indices.reduce((best, i) => (rank(companies[i]) < rank(companies[best]) ? i : best), indices[0]);
}

// keyFnが同じ値を返す会社同士をグルーピングし、生存者以外にreasonを立てて
// decisions配列（companiesと同じ長さ、要素は{status, exclude_reason}|null）を書き換える。
// 既にexcluded扱い（またはM3の対象外＝decisionがnull）の会社はグルーピング対象から外す。
function dedupeByKey(companies, decisions, keyFn, reason) {
  const groups = new Map();
  companies.forEach((c, i) => {
    if (!decisions[i] || decisions[i].status === 'excluded') return;
    const key = keyFn(c);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });

  for (const indices of groups.values()) {
    if (indices.length <= 1) continue;
    const survivor = pickSurvivorIndex(indices, companies);
    for (const i of indices) {
      if (i !== survivor) decisions[i] = { status: 'excluded', exclude_reason: reason };
    }
  }
}

module.exports = { extractDomain, classifyContact, pickSurvivorIndex, dedupeByKey };
