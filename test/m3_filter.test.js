'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { openDb, upsertCompany, updateEnrichment, addToSuppressionList } = require('../src/lib/db');
const { filterCompliant } = require('../src/m3_filter');

function tmpDbPath() {
  return path.join(os.tmpdir(), `corp-lead-kit-test-m3-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

function seedEnrichedCompany(dbPath, overrides = {}) {
  const db = openDb(dbPath);
  let company = upsertCompany(db, {
    corporate_no: overrides.corporate_no || '1000000000001',
    name: overrides.name || 'サンプル株式会社',
    address: overrides.address || '東京都千代田区1-1-1',
    prefecture: overrides.prefecture || '東京都',
    source: 'houjin_csv',
    status: 'discovered',
  });
  company = updateEnrichment(db, company.id, {
    website_url: overrides.website_url !== undefined ? overrides.website_url : 'https://example.com/',
    email: overrides.email !== undefined ? overrides.email : 'info@example.com',
    contact_type: overrides.contact_type !== undefined ? overrides.contact_type : 'email',
    business_summary: overrides.business_summary || '事業内容の要約',
    optout_notice: overrides.optout_notice !== undefined ? overrides.optout_notice : false,
    status: 'enriched',
  });
  db.close();
  return { ...company, ...(overrides.patch || {}) };
}

test('正常系: emailありならmail_readyになる', async () => {
  const dbPath = tmpDbPath();
  const company = seedEnrichedCompany(dbPath);

  const results = filterCompliant([company], { dbPath });

  assert.equal(results[0].status, 'mail_ready');
  assert.equal(results[0].exclude_reason, null);
  fs.rmSync(dbPath, { force: true });
});

test('emailが無くform_onlyならcall_listになる', async () => {
  const dbPath = tmpDbPath();
  const company = seedEnrichedCompany(dbPath, { email: null, contact_type: 'form_only' });

  const results = filterCompliant([company], { dbPath });

  assert.equal(results[0].status, 'call_list');
  fs.rmSync(dbPath, { force: true });
});

test('emailが無くcontact_type=noneなら除外(no_contact)になる', async () => {
  const dbPath = tmpDbPath();
  const company = seedEnrichedCompany(dbPath, { email: null, contact_type: 'none' });

  const results = filterCompliant([company], { dbPath });

  assert.equal(results[0].status, 'excluded');
  assert.equal(results[0].exclude_reason, 'no_contact');
  fs.rmSync(dbPath, { force: true });
});

test('サプレッションリストにemailが一致する場合は除外(suppression_list)になる', async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  addToSuppressionList(db, { email: 'info@example.com', reason: '配信停止依頼' });
  db.close();
  const company = seedEnrichedCompany(dbPath);

  const results = filterCompliant([company], { dbPath });

  assert.equal(results[0].status, 'excluded');
  assert.equal(results[0].exclude_reason, 'suppression_list');
  fs.rmSync(dbPath, { force: true });
});

test('サプレッションリストに法人番号が一致する場合は除外(suppression_list)になる', async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  addToSuppressionList(db, { corporate_no: '1000000000001', reason: '過去に拒否' });
  db.close();
  const company = seedEnrichedCompany(dbPath);

  const results = filterCompliant([company], { dbPath });

  assert.equal(results[0].status, 'excluded');
  assert.equal(results[0].exclude_reason, 'suppression_list');
  fs.rmSync(dbPath, { force: true });
});

test('同一ドメインの重複はemailを持つ方を残し、他方はexcluded(duplicate_domain)になる', async () => {
  const dbPath = tmpDbPath();
  const companyA = seedEnrichedCompany(dbPath, {
    corporate_no: '2000000000001',
    name: 'A社',
    website_url: 'https://www.shared-group.co.jp/',
    email: null,
    contact_type: 'form_only',
  });
  const companyB = seedEnrichedCompany(dbPath, {
    corporate_no: '2000000000002',
    name: 'B社',
    website_url: 'https://shared-group.co.jp/', // www有無違いだが同一ドメインとして扱う
    email: 'info@shared-group.co.jp',
    contact_type: 'email',
  });

  const results = filterCompliant([companyA, companyB], { dbPath });

  const a = results.find((r) => r.corporate_no === '2000000000001');
  const b = results.find((r) => r.corporate_no === '2000000000002');
  assert.equal(b.status, 'mail_ready'); // emailを持つ方が生存
  assert.equal(a.status, 'excluded');
  assert.equal(a.exclude_reason, 'duplicate_domain');
  fs.rmSync(dbPath, { force: true });
});

test('同一法人番号の重複は1社のみ残し、他方はexcluded(duplicate_corporate_no)になる', async () => {
  const dbPath = tmpDbPath();
  const companyA = seedEnrichedCompany(dbPath, {
    corporate_no: '3000000000001',
    name: 'A社',
    website_url: 'https://a-corp.example.com/',
    email: 'info@a-corp.example.com',
    patch: { corporate_no: '9999999999999' }, // 同一法人番号のシナリオを模擬
  });
  const companyB = seedEnrichedCompany(dbPath, {
    corporate_no: '3000000000002',
    name: 'B社',
    website_url: 'https://b-corp.example.com/',
    email: 'info@b-corp.example.com',
    patch: { corporate_no: '9999999999999' },
  });

  const results = filterCompliant([companyA, companyB], { dbPath });

  const excludedCount = results.filter((r) => r.status === 'excluded' && r.exclude_reason === 'duplicate_corporate_no').length;
  const mailReadyCount = results.filter((r) => r.status === 'mail_ready').length;
  assert.equal(excludedCount, 1);
  assert.equal(mailReadyCount, 1);
  fs.rmSync(dbPath, { force: true });
});

test('status=enriched以外の会社はそのまま素通りする(M3の判定対象外)', async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const company = upsertCompany(db, {
    corporate_no: '4000000000001',
    name: 'まだ未巡回の会社',
    address: '東京都',
    prefecture: '東京都',
    source: 'houjin_csv',
    status: 'discovered',
  });
  db.close();

  const results = filterCompliant([company], { dbPath });

  assert.equal(results[0].status, 'discovered');
  fs.rmSync(dbPath, { force: true });
});

test('複数社を渡した場合、mail_ready/call_list/excludedに正しく仕分けられる', async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  addToSuppressionList(db, { corporate_no: '5000000000003', reason: '過去に拒否' });
  db.close();

  const mailReady = seedEnrichedCompany(dbPath, {
    corporate_no: '5000000000001',
    name: 'メール送信可能社',
    website_url: 'https://ok-corp.example.com/',
    email: 'info@ok-corp.example.com',
  });
  const callList = seedEnrichedCompany(dbPath, {
    corporate_no: '5000000000002',
    name: 'フォームのみ社',
    website_url: 'https://form-only.example.com/',
    email: null,
    contact_type: 'form_only',
  });
  const excluded = seedEnrichedCompany(dbPath, {
    corporate_no: '5000000000003',
    name: 'サプレッション対象社',
    website_url: 'https://no-thanks.example.com/',
  });

  const results = filterCompliant([mailReady, callList, excluded], { dbPath });

  assert.equal(results.find((r) => r.corporate_no === '5000000000001').status, 'mail_ready');
  assert.equal(results.find((r) => r.corporate_no === '5000000000002').status, 'call_list');
  assert.equal(results.find((r) => r.corporate_no === '5000000000003').status, 'excluded');
  fs.rmSync(dbPath, { force: true });
});
