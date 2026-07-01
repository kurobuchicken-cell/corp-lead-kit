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

module.exports = { openDb, upsertCompany, DEFAULT_DB_PATH };
