'use strict';

const { openDb, updateEnrichment, isSuppressed, DEFAULT_DB_PATH } = require('./lib/db');
const { extractDomain, classifyContact, dedupeByKey } = require('./lib/compliance');

// enriched状態のcompaniesを mail_ready / call_list / excluded(理由付き) に仕分ける（M3・特電法フィルタ）。
// ここは事業の生命線のため、迷ったら安全側（除外）に倒す：
//   1. サプレッションリスト（過去の配信停止・拒否・バウンス）に一致 → 除外
//   2. 同一法人番号／同一ドメインの重複 → 名寄せして1社のみ残す
//   3. email無し かつ form_only → 架電リスト／それ以外は除外
// 営業お断り表示の判定は、対象を絞った後段（qualifyCompanies、②業務内容確認）で行う
// （M2ではAIを使わず無料化しているため、この時点ではoptout_noticeは分からない）。
// status='enriched'以外の会社（M2で既にexcluded等になっているもの）はここでは判定せずそのまま返す。
function filterCompliant(companies, options = {}) {
  const { dbPath = DEFAULT_DB_PATH } = options;
  const db = openDb(dbPath);

  try {
    const decisions = companies.map((company) => {
      if (company.status !== 'enriched') return null;

      if (isSuppressed(db, { corporate_no: company.corporate_no, email: company.email })) {
        return { status: 'excluded', exclude_reason: 'suppression_list' };
      }
      return classifyContact(company);
    });

    dedupeByKey(companies, decisions, (c) => c.corporate_no || null, 'duplicate_corporate_no');
    dedupeByKey(companies, decisions, (c) => extractDomain(c.website_url), 'duplicate_domain');

    return companies.map((company, i) => {
      const decision = decisions[i];
      if (!decision) return company;
      return updateEnrichment(db, company.id, {
        status: decision.status,
        exclude_reason: decision.exclude_reason,
      });
    });
  } finally {
    db.close();
  }
}

module.exports = { filterCompliant };
