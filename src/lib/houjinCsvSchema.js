'use strict';

// 国税庁 法人番号システム「基本3情報ダウンロード」CSV の列定義（一次情報：リソース定義書 4.1版）。
// ヘッダー行なし、以下30列がこの順で並ぶ（0始まりインデックス）。
const COLUMNS = [
  '一連番号', // 0
  '法人番号', // 1
  '処理区分', // 2
  '訂正区分', // 3
  '更新年月日', // 4
  '変更年月日', // 5
  '商号又は名称', // 6
  '商号又は名称イメージID', // 7
  '法人種別', // 8
  '国内所在地(都道府県)', // 9
  '国内所在地(市区町村)', // 10
  '国内所在地(丁目番地等)', // 11
  '国内所在地イメージID', // 12
  '都道府県コード', // 13
  '市区町村コード', // 14
  '郵便番号', // 15
  '国外所在地', // 16
  '国外所在地イメージID', // 17
  '登記記録の閉鎖等年月日', // 18
  '登記記録の閉鎖等の事由', // 19
  '承継先法人番号', // 20
  '変更事由の詳細', // 21
  '法人番号指定年月日', // 22
  '最新履歴', // 23
  '商号又は名称(英語)', // 24
  '都道府県(英語)', // 25
  '市区町村丁目番地等(英語)', // 26
  '国外所在地(英語)', // 27
  'フリガナ', // 28
  '検索対象除外', // 29
];

const COL = {
  SERIAL: 0,
  CORPORATE_NO: 1,
  PROCESS_KBN: 2,
  CORRECTION_KBN: 3,
  UPDATE_DATE: 4,
  CHANGE_DATE: 5,
  NAME: 6,
  NAME_IMAGE_ID: 7,
  KIND: 8,
  PREF: 9,
  CITY: 10,
  ADDR: 11,
  ADDR_IMAGE_ID: 12,
  PREF_CODE: 13,
  CITY_CODE: 14,
  POSTAL_CODE: 15,
  FOREIGN_ADDR: 16,
  FOREIGN_ADDR_IMAGE_ID: 17,
  CLOSE_DATE: 18,
  CLOSE_REASON: 19,
  SUCCESSOR_NO: 20,
  CHANGE_DETAIL: 21,
  ASSIGN_DATE: 22,
  LATEST_HISTORY: 23,
  NAME_EN: 24,
  PREF_EN: 25,
  ADDR_EN: 26,
  FOREIGN_ADDR_EN: 27,
  FURIGANA: 28,
  EXCLUDE_FLAG: 29,
};

// 処理区分=99（削除）は除外。営業対象として残すのは 301〜305・399（株式会社〜その他設立登記法人）のみ。
// 101(国の機関)・201(地方公共団体)・401(外国会社等)等は営業対象外として除外する。
const DELETED_PROCESS_KBN = '99';
const LATEST_HISTORY_FLAG = '1';
const ALLOWED_KIND_CODES = ['301', '302', '303', '304', '305', '399'];

module.exports = {
  COLUMNS,
  COL,
  DELETED_PROCESS_KBN,
  LATEST_HISTORY_FLAG,
  ALLOWED_KIND_CODES,
};
