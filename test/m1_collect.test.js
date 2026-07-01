'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const { collectFromCsv } = require('../src/m1_collect');

const FIXTURE = path.join(__dirname, 'fixtures', 'sample_houjin.csv');
const INVALID_FIXTURE = path.join(__dirname, 'fixtures', 'sample_invalid_postal.csv');

function tmpDbPath() {
  return path.join(os.tmpdir(), `corp-lead-kit-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

function countCompanies(dbPath) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT COUNT(*) AS n FROM companies').get();
  db.close();
  return row.n;
}

test('正常な行が discovered として登録される', async () => {
  const dbPath = tmpDbPath();
  const results = await collectFromCsv({ file: FIXTURE, dbPath, encoding: 'utf-8' });
  assert.equal(results.length, 2); // 東京(A) + 大阪(E) の2件が正常
  const tokyo = results.find((c) => c.corporate_no === '1234567890123');
  assert.ok(tokyo);
  assert.equal(tokyo.status, 'discovered');
  assert.equal(tokyo.name, 'サンプル株式会社,東京支店');
  fs.rmSync(dbPath, { force: true });
});

test('法人種別が対象外(101)の行は登録されない', async () => {
  const dbPath = tmpDbPath();
  const results = await collectFromCsv({ file: FIXTURE, dbPath, encoding: 'utf-8' });
  assert.ok(!results.some((c) => c.corporate_no === '2234567890123'));
  fs.rmSync(dbPath, { force: true });
});

test('処理区分=99(削除)の行は登録されない', async () => {
  const dbPath = tmpDbPath();
  const results = await collectFromCsv({ file: FIXTURE, dbPath, encoding: 'utf-8' });
  assert.ok(!results.some((c) => c.corporate_no === '3234567890123'));
  fs.rmSync(dbPath, { force: true });
});

test('最新履歴!=1の行は登録されない', async () => {
  const dbPath = tmpDbPath();
  const results = await collectFromCsv({ file: FIXTURE, dbPath, encoding: 'utf-8' });
  assert.ok(!results.some((c) => c.corporate_no === '4234567890123'));
  fs.rmSync(dbPath, { force: true });
});

test('郵便番号の桁数が不正な行はエラーをthrowする', async () => {
  const dbPath = tmpDbPath();
  await assert.rejects(
    () => collectFromCsv({ file: INVALID_FIXTURE, dbPath, encoding: 'utf-8' }),
    /郵便番号/
  );
  fs.rmSync(dbPath, { force: true });
});

test('pref指定で都道府県フィルタが効く', async () => {
  const dbPath = tmpDbPath();
  const results = await collectFromCsv({ file: FIXTURE, dbPath, pref: '大阪府', encoding: 'utf-8' });
  assert.equal(results.length, 1);
  assert.equal(results[0].prefecture, '大阪府');
  fs.rmSync(dbPath, { force: true });
});

test('limit指定で件数が制限される', async () => {
  const dbPath = tmpDbPath();
  const results = await collectFromCsv({ file: FIXTURE, dbPath, limit: 1, encoding: 'utf-8' });
  assert.equal(results.length, 1);
  fs.rmSync(dbPath, { force: true });
});

test('同じCSVを2回流しても重複登録されない(UPSERT冪等性)', async () => {
  const dbPath = tmpDbPath();
  await collectFromCsv({ file: FIXTURE, dbPath, encoding: 'utf-8' });
  await collectFromCsv({ file: FIXTURE, dbPath, encoding: 'utf-8' });
  assert.equal(countCompanies(dbPath), 2);
  fs.rmSync(dbPath, { force: true });
});
