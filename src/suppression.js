'use strict';

const { openDb, addToSuppressionList, DEFAULT_DB_PATH } = require('./lib/db');

// 配信停止・拒否・バウンス等をサプレッションリストに永久登録する。
// 用途（アポ獲得・採用・提携等）を問わず全アプリで共有・尊重する「事実」データのため、
// corp-lead-kit側の公開APIとして提供する（仕様書§0-1）。
function addToSuppression({ corporate_no, email, reason, dbPath = DEFAULT_DB_PATH } = {}) {
  if (!corporate_no && !email) {
    throw new Error('addToSuppression: corporate_no または email のいずれかが必要です');
  }
  const db = openDb(dbPath);
  try {
    return addToSuppressionList(db, { corporate_no, email, reason });
  } finally {
    db.close();
  }
}

module.exports = { addToSuppression };
