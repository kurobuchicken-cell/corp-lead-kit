'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'leads.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  corporate_no     TEXT UNIQUE,
  name             TEXT,
  address          TEXT,
  prefecture       TEXT,
  source           TEXT,
  website_url      TEXT,
  email            TEXT,
  contact_type     TEXT,
  business_summary TEXT,
  optout_notice    INTEGER,
  status           TEXT,
  exclude_reason   TEXT,
  created_at       TEXT,
  updated_at       TEXT
);

CREATE TABLE IF NOT EXISTS suppression (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  corporate_no TEXT,
  email        TEXT,
  reason       TEXT,
  created_at   TEXT
);
`;

function openDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

// corporate_no でUPSERTし、冪等に登録する（同じCSV/差分データを何度流しても重複しない）。
function upsertCompany(db, company) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO companies (corporate_no, name, address, prefecture, source, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(corporate_no) DO UPDATE SET
      name = excluded.name,
      address = excluded.address,
      prefecture = excluded.prefecture,
      source = excluded.source,
      updated_at = excluded.updated_at
    RETURNING *
  `);
  return stmt.get(
    company.corporate_no,
    company.name,
    company.address,
    company.prefecture,
    company.source,
    company.status,
    now,
    now
  );
}

// M2の抽出結果をcompaniesに反映する。渡されなかったフィールドは既存値を維持する。
function updateEnrichment(db, id, fields) {
  const now = new Date().toISOString();
  const current = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  if (!current) throw new Error(`updateEnrichment: company id=${id} が見つかりません`);

  const merged = {
    website_url: fields.website_url !== undefined ? fields.website_url : current.website_url,
    email: fields.email !== undefined ? fields.email : current.email,
    contact_type: fields.contact_type !== undefined ? fields.contact_type : current.contact_type,
    business_summary: fields.business_summary !== undefined ? fields.business_summary : current.business_summary,
    optout_notice: fields.optout_notice !== undefined ? (fields.optout_notice ? 1 : 0) : current.optout_notice,
    status: fields.status !== undefined ? fields.status : current.status,
    exclude_reason: fields.exclude_reason !== undefined ? fields.exclude_reason : current.exclude_reason,
  };

  const stmt = db.prepare(`
    UPDATE companies SET
      website_url = ?, email = ?, contact_type = ?, business_summary = ?,
      optout_notice = ?, status = ?, exclude_reason = ?, updated_at = ?
    WHERE id = ?
    RETURNING *
  `);
  return stmt.get(
    merged.website_url,
    merged.email,
    merged.contact_type,
    merged.business_summary,
    merged.optout_notice,
    merged.status,
    merged.exclude_reason,
    now,
    id
  );
}

module.exports = { openDb, upsertCompany, updateEnrichment, DEFAULT_DB_PATH };
