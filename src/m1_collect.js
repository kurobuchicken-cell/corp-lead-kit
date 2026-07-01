'use strict';

const { openDb, upsertCompany, DEFAULT_DB_PATH } = require('./lib/db');
const { readCsvRows } = require('./lib/csvParser');
const {
  COL,
  DELETED_PROCESS_KBN,
  LATEST_HISTORY_FLAG,
  ALLOWED_KIND_CODES,
} = require('./lib/houjinCsvSchema');

const CORPORATE_NO_RE = /^\d{13}$/;
const PREF_CODE_RE = /^\d{1,2}$/;
const POSTAL_CODE_RE = /^\d{7}$/;

// 列がズレていないかの自己検証。不一致は即座にthrowして処理全体を中断する
// （列ズレはサイレントに壊れると気づきにくいため）。
function validateRow(fields, rowIndex) {
  const corporateNo = fields[COL.CORPORATE_NO];
  if (!CORPORATE_NO_RE.test(corporateNo)) {
    throw new Error(
      `CSV列定義がズレている可能性があります（${rowIndex}行目, 法人番号は13桁数字のはずが "${corporateNo}"）`
    );
  }
  const prefCode = fields[COL.PREF_CODE];
  if (prefCode && !PREF_CODE_RE.test(prefCode)) {
    throw new Error(
      `CSV列定義がズレている可能性があります（${rowIndex}行目, 都道府県コードは1〜2桁数字のはずが "${prefCode}"）`
    );
  }
  const postalCode = fields[COL.POSTAL_CODE];
  if (postalCode && !POSTAL_CODE_RE.test(postalCode)) {
    throw new Error(
      `CSV列定義がズレている可能性があります（${rowIndex}行目, 郵便番号は7桁数字のはずが "${postalCode}"）`
    );
  }
}

// 国税庁 法人番号CSV（基本3情報）を companies テーブルに取り込む（M1）。
// ZIP展開・OpenPGP署名検証は対象外。展開済みの.csvファイルを渡すこと。
async function collectFromCsv(options = {}) {
  const {
    file,
    pref,
    limit,
    source = 'houjin_csv',
    encoding = 'shift-jis',
    dbPath = DEFAULT_DB_PATH,
  } = options;

  if (!file) throw new Error('collectFromCsv: file は必須です');

  const db = openDb(dbPath);
  const results = [];

  db.exec('BEGIN');
  try {
    await readCsvRows(file, {
      encoding,
      shouldStop: () => Boolean(limit) && results.length >= limit,
      onRow: (fields, rowIndex) => {
        validateRow(fields, rowIndex);

        if (fields[COL.PROCESS_KBN] === DELETED_PROCESS_KBN) return;
        if (fields[COL.LATEST_HISTORY] !== LATEST_HISTORY_FLAG) return;
        if (!ALLOWED_KIND_CODES.includes(fields[COL.KIND])) return;
        if (pref && fields[COL.PREF] !== pref) return;

        const company = upsertCompany(db, {
          corporate_no: fields[COL.CORPORATE_NO],
          name: fields[COL.NAME],
          address: `${fields[COL.PREF]}${fields[COL.CITY]}${fields[COL.ADDR]}`,
          prefecture: fields[COL.PREF],
          source,
          status: 'discovered',
        });
        results.push(company);
      },
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }

  return results;
}

module.exports = { collectFromCsv };
