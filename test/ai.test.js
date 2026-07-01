'use strict';

// 注意：findOfficialWebsite / analyzeCompanyPage 自体（実際のAnthropic API呼び出し・Web検索）は
// ANTHROPIC_API_KEYと実サイトへのネットワークアクセスが必要なため、このテストでは検証していない。
// ここではAI応答の後処理（JSON抽出）という純粋ロジックのみを確認する。

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseJsonResponse } = require('../src/lib/ai');

test('parseJsonResponse: 前後に説明文が付いていてもJSON部分を抽出できる', () => {
  const text = '承知しました。\n{"business_summary": "テスト", "optout_notice": true, "contact_type": "email"}\n以上です。';
  const parsed = parseJsonResponse(text);
  assert.deepEqual(parsed, { business_summary: 'テスト', optout_notice: true, contact_type: 'email' });
});

test('parseJsonResponse: JSONが含まれない場合はエラーになる', () => {
  assert.throws(() => parseJsonResponse('JSONではない普通の文章です'), /JSON/);
});
