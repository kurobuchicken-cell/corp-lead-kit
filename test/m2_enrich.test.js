'use strict';

// 注意：実際のWeb検索(findOfficialWebsite)・実サイト巡回は ANTHROPIC_API_KEY と実サイトへの
// ネットワークアクセスが必要なため、ここでは findWebsite / fetchPage / isAllowed をすべて
// 注入(フェイク)してオーケストレーションのロジックのみを検証している。
// M2は事業内容・業種・営業お断り判定・痛みの手がかりの取得は行わない（AIを使わず無料化しており、
// それらは対象を絞った後段のqualifyCompanies（m2b_qualify.js）が担当する）。
// Playwrightの実起動はsrc/lib/scrape.js側で手動スモークテスト済み（別途確認済み）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cheerio = require('cheerio');

const { openDb, upsertCompany } = require('../src/lib/db');
const { enrichSites } = require('../src/m2_enrich');

function tmpDbPath() {
  return path.join(os.tmpdir(), `corp-lead-kit-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

function seedCompany(dbPath, overrides = {}) {
  const db = openDb(dbPath);
  const company = upsertCompany(db, {
    corporate_no: overrides.corporate_no || '1000000000001',
    name: overrides.name || 'サンプル株式会社',
    address: overrides.address || '東京都千代田区1-1-1',
    prefecture: overrides.prefecture || '東京都',
    source: 'houjin_csv',
    status: 'discovered',
  });
  db.close();
  return { ...company, ...overrides.patch };
}

function fakePage(html, url = 'https://example.com/') {
  return { html, text: cheerio.load(html)('body').text().replace(/\s+/g, ' ').trim(), finalUrl: url, $: cheerio.load(html) };
}

test('公式サイトが見つからない場合はexcluded(website_not_found)になる', async () => {
  const dbPath = tmpDbPath();
  const company = seedCompany(dbPath);

  const results = await enrichSites([company], {
    dbPath,
    delayMs: 0,
    findWebsite: async () => null,
    fetchPage: async () => fakePage('<html><body>ok</body></html>'),
    isAllowed: async () => true,
  });

  assert.equal(results[0].status, 'excluded');
  assert.equal(results[0].exclude_reason, 'website_not_found');
  fs.rmSync(dbPath, { force: true });
});

test('robots.txtで禁止されている場合はexcluded(robots_disallowed)になり本文取得は行わない', async () => {
  const dbPath = tmpDbPath();
  const company = seedCompany(dbPath);
  let fetchCalled = false;

  const results = await enrichSites([company], {
    dbPath,
    delayMs: 0,
    findWebsite: async () => 'https://example.com/',
    fetchPage: async () => {
      fetchCalled = true;
      return fakePage('<html><body>ok</body></html>');
    },
    isAllowed: async () => false,
  });

  assert.equal(results[0].status, 'excluded');
  assert.equal(results[0].exclude_reason, 'robots_disallowed');
  assert.equal(results[0].website_url, 'https://example.com/');
  assert.equal(fetchCalled, false);
  fs.rmSync(dbPath, { force: true });
});

test('サイト取得に失敗した場合はexcludedにせずdiscoveredのまま残す(再試行可能にする)', async () => {
  const dbPath = tmpDbPath();
  const company = seedCompany(dbPath);

  const results = await enrichSites([company], {
    dbPath,
    delayMs: 0,
    findWebsite: async () => 'https://example.com/',
    fetchPage: async () => {
      throw new Error('timeout');
    },
    isAllowed: async () => true,
  });

  assert.equal(results[0].status, 'discovered');
  assert.match(results[0].exclude_reason, /fetch_error/);
  fs.rmSync(dbPath, { force: true });
});

test('正常系: 本文からメールが取れればcontact_type=emailになり、statusはenrichedになる（業種等はまだ取得しない）', async () => {
  const dbPath = tmpDbPath();
  const company = seedCompany(dbPath);

  const results = await enrichSites([company], {
    dbPath,
    delayMs: 0,
    findWebsite: async () => 'https://sample-corp.co.jp/',
    fetchPage: async () => fakePage('<html><body>お問い合わせ: info@sample-corp.co.jp</body></html>'),
    isAllowed: async () => true,
  });

  const r = results[0];
  assert.equal(r.status, 'enriched');
  assert.equal(r.email, 'info@sample-corp.co.jp');
  assert.equal(r.contact_type, 'email');
  assert.equal(r.business_summary, null);
  assert.equal(r.industry, null);
  assert.equal(r.website_url, 'https://sample-corp.co.jp/');
  fs.rmSync(dbPath, { force: true });
});

test('メールが無くても「お問い合わせ」リンクがあればcontact_type=form_onlyになる', async () => {
  const dbPath = tmpDbPath();
  const company = seedCompany(dbPath);

  const results = await enrichSites([company], {
    dbPath,
    delayMs: 0,
    findWebsite: async () => 'https://sample-corp.example.com/',
    fetchPage: async () => fakePage('<html><body><a href="/contact">お問い合わせ</a></body></html>'),
    isAllowed: async () => true,
  });

  assert.equal(results[0].contact_type, 'form_only');
  assert.equal(results[0].email, null);
  fs.rmSync(dbPath, { force: true });
});

test('メールも問い合わせリンクも無ければcontact_type=noneになる', async () => {
  const dbPath = tmpDbPath();
  const company = seedCompany(dbPath);

  const results = await enrichSites([company], {
    dbPath,
    delayMs: 0,
    findWebsite: async () => 'https://sample-corp.example.com/',
    fetchPage: async () => fakePage('<html><body>会社概要のみ記載</body></html>'),
    isAllowed: async () => true,
  });

  assert.equal(results[0].contact_type, 'none');
  fs.rmSync(dbPath, { force: true });
});

test('すでにwebsite_urlを持つ会社はfindWebsiteを呼ばない', async () => {
  const dbPath = tmpDbPath();
  const db = openDb(dbPath);
  const { updateEnrichment } = require('../src/lib/db');
  let company = upsertCompany(db, {
    corporate_no: '1000000000002',
    name: 'テスト2',
    address: '東京都',
    prefecture: '東京都',
    source: 'houjin_csv',
    status: 'discovered',
  });
  company = updateEnrichment(db, company.id, { website_url: 'https://already-known.example.com/' });
  db.close();

  let findWebsiteCalled = false;
  const results = await enrichSites([company], {
    dbPath,
    delayMs: 0,
    findWebsite: async () => {
      findWebsiteCalled = true;
      return 'https://should-not-be-used.example.com/';
    },
    fetchPage: async () => fakePage('<html><body>ok</body></html>'),
    isAllowed: async () => true,
  });

  assert.equal(findWebsiteCalled, false);
  assert.equal(results[0].website_url, 'https://already-known.example.com/');
  fs.rmSync(dbPath, { force: true });
});

test('複数社を渡した場合、全件が処理される(concurrency指定時も)', async () => {
  const dbPath = tmpDbPath();
  const companies = [
    seedCompany(dbPath, { corporate_no: '2000000000001', name: 'A社' }),
    seedCompany(dbPath, { corporate_no: '2000000000002', name: 'B社' }),
    seedCompany(dbPath, { corporate_no: '2000000000003', name: 'C社' }),
  ];

  const results = await enrichSites(companies, {
    dbPath,
    delayMs: 0,
    concurrency: 2,
    findWebsite: async (_client, { name }) => `https://${name}.co.jp/`,
    fetchPage: async () => fakePage('<html><body>ok</body></html>'),
    isAllowed: async () => true,
  });

  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.status === 'enriched'));
  fs.rmSync(dbPath, { force: true });
});
