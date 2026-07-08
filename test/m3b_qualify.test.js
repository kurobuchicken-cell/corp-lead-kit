'use strict';

// 注意：実際のAI呼び出し(checkOptOut/qualifyFromPage)・実サイト巡回は ANTHROPIC_API_KEY と実サイトへの
// ネットワークアクセスが必要なため、ここでは checkOptOut / qualify / fetchPage をすべて注入(フェイク)して
// オーケストレーションのロジックのみを検証している。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { openDb, upsertCompany, updateEnrichment } = require('../src/lib/db');
const { qualifyCompanies } = require('../src/m3b_qualify');

function tmpDbPath() {
  return path.join(os.tmpdir(), `corp-lead-kit-test-qualify-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

function seedMailReadyCompany(dbPath, overrides = {}) {
  const db = openDb(dbPath);
  let company = upsertCompany(db, {
    corporate_no: overrides.corporate_no || '1000000000001',
    name: overrides.name || 'サンプル株式会社',
    address: '東京都千代田区1-1-1',
    prefecture: '東京都',
    source: 'houjin_csv',
    status: 'discovered',
  });
  company = updateEnrichment(db, company.id, {
    website_url: 'https://example.com/',
    email: 'info@example.com',
    contact_type: 'email',
    status: overrides.status || 'mail_ready',
  });
  db.close();
  return company;
}

const passOptOut = async () => ({ optOut: false });

test('正常系: 業務内容・業種・痛みの手がかりを取得し、statusはqualifiedになる', async () => {
  const dbPath = tmpDbPath();
  const company = seedMailReadyCompany(dbPath);

  const results = await qualifyCompanies([company], {
    dbPath,
    delayMs: 0,
    fetchPage: async () => ({ text: 'ITコンサルティングを行う会社です。' }),
    checkOptOut: passOptOut,
    qualify: async () => ({
      business_summary: 'ITコンサルティングを行う会社です。',
      industry: 'ITコンサルティング',
      pain_hint: '見積書を手作業で作成していそう',
    }),
    findPainHint: async () => {
      throw new Error('should not be called');
    },
  });

  const r = results[0];
  assert.equal(r.status, 'qualified');
  assert.equal(r.business_summary, 'ITコンサルティングを行う会社です。');
  assert.equal(r.industry, 'ITコンサルティング');
  assert.equal(r.pain_hint, '見積書を手作業で作成していそう');
  fs.rmSync(dbPath, { force: true });
});

test('①でお断り表示ありと判定された場合はexcluded(optout_notice)になり②は呼ばれない', async () => {
  const dbPath = tmpDbPath();
  const company = seedMailReadyCompany(dbPath);
  let qualifyCalled = false;

  const results = await qualifyCompanies([company], {
    dbPath,
    delayMs: 0,
    fetchPage: async () => ({ text: '営業目的のご連絡はお断りしております。' }),
    checkOptOut: async () => ({ optOut: true }),
    qualify: async () => {
      qualifyCalled = true;
      return { business_summary: null, industry: null, pain_hint: null };
    },
    findPainHint: async () => {
      throw new Error('should not be called');
    },
  });

  assert.equal(results[0].status, 'excluded');
  assert.equal(results[0].exclude_reason, 'optout_notice');
  assert.equal(qualifyCalled, false);
  fs.rmSync(dbPath, { force: true });
});

test('サイト取得に失敗した場合はstatusを変えず再試行可能にする', async () => {
  const dbPath = tmpDbPath();
  const company = seedMailReadyCompany(dbPath);

  const results = await qualifyCompanies([company], {
    dbPath,
    delayMs: 0,
    fetchPage: async () => {
      throw new Error('timeout');
    },
    checkOptOut: async () => {
      throw new Error('should not be called');
    },
    qualify: async () => {
      throw new Error('should not be called');
    },
    findPainHint: async () => {
      throw new Error('should not be called');
    },
  });

  assert.equal(results[0].status, 'mail_ready');
  assert.match(results[0].exclude_reason, /qualify_fetch_error/);
  fs.rmSync(dbPath, { force: true });
});

test('call_list(フォームのみ)の会社も対象にできる', async () => {
  const dbPath = tmpDbPath();
  const company = seedMailReadyCompany(dbPath, { corporate_no: '2000000000001', status: 'call_list' });

  const results = await qualifyCompanies([company], {
    dbPath,
    delayMs: 0,
    fetchPage: async () => ({ text: 'x' }),
    checkOptOut: passOptOut,
    qualify: async () => ({
      business_summary: '製造業を営む会社です。',
      industry: '製造業',
      pain_hint: null,
    }),
    findPainHint: async () => ({ hint: null }),
  });

  assert.equal(results[0].status, 'qualified');
  assert.equal(results[0].industry, '製造業');
  fs.rmSync(dbPath, { force: true });
});

test('複数社を渡した場合、全件が処理される', async () => {
  const dbPath = tmpDbPath();
  const companies = [
    seedMailReadyCompany(dbPath, { corporate_no: '3000000000001', name: 'A社' }),
    seedMailReadyCompany(dbPath, { corporate_no: '3000000000002', name: 'B社' }),
  ];

  const results = await qualifyCompanies(companies, {
    dbPath,
    delayMs: 0,
    fetchPage: async () => ({ text: 'x' }),
    checkOptOut: passOptOut,
    qualify: async () => ({ business_summary: 'x', industry: null, pain_hint: null }),
    findPainHint: async () => ({ hint: null }),
  });

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.status === 'qualified'));
  fs.rmSync(dbPath, { force: true });
});

test('②でpain_hintがnullの場合、専用呼び出し(findPainHint)でフォールバックする', async () => {
  const dbPath = tmpDbPath();
  const company = seedMailReadyCompany(dbPath);
  let findPainHintCalled = false;

  const results = await qualifyCompanies([company], {
    dbPath,
    delayMs: 0,
    fetchPage: async () => ({ text: 'x' }),
    checkOptOut: passOptOut,
    qualify: async () => ({ business_summary: 'x', industry: null, pain_hint: null }),
    findPainHint: async () => {
      findPainHintCalled = true;
      return { hint: '請求書を手作業で発行していそう' };
    },
  });

  assert.equal(findPainHintCalled, true);
  assert.equal(results[0].pain_hint, '請求書を手作業で発行していそう');
  fs.rmSync(dbPath, { force: true });
});

test('②でpain_hintが取得できた場合は専用呼び出し(findPainHint)を呼ばない（無駄打ちしない）', async () => {
  const dbPath = tmpDbPath();
  const company = seedMailReadyCompany(dbPath);
  let findPainHintCalled = false;

  const results = await qualifyCompanies([company], {
    dbPath,
    delayMs: 0,
    fetchPage: async () => ({ text: 'x' }),
    checkOptOut: passOptOut,
    qualify: async () => ({ business_summary: 'x', industry: null, pain_hint: '見積書を手作業で作成' }),
    findPainHint: async () => {
      findPainHintCalled = true;
      return { hint: 'should not be used' };
    },
  });

  assert.equal(findPainHintCalled, false);
  assert.equal(results[0].pain_hint, '見積書を手作業で作成');
  fs.rmSync(dbPath, { force: true });
});
