'use strict';

const fs = require('fs');

const LF = 0x0a;
const CR = 0x0d;

// RFC4180風の1行CSVパーサ。ダブルクオート囲み・""エスケープに対応。
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// 生バイトをLF単位で分割してからデコードする。区切り文字（LF/CR/カンマ/引用符）は
// Shift-JISの2バイト文字の後続バイト範囲（0x40-0xFC）にも UTF-8 の継続バイト範囲
// （0x80-0xBF）にも含まれないため、文字の途中で切れる心配がない。
// これにより219MB級のファイルでも全読み込みせずに shouldStop() で早期終了できる。
function readCsvRows(filePath, { encoding = 'shift-jis', onRow, shouldStop } = {}) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder(encoding);
    const stream = fs.createReadStream(filePath);
    let leftover = Buffer.alloc(0);
    let rowIndex = 0;
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result);
    };

    stream.on('data', (chunk) => {
      if (settled) return;
      const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      let start = 0;
      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] !== LF) continue;
        let end = i;
        if (end > start && buf[end - 1] === CR) end -= 1;
        const lineBuf = buf.subarray(start, end);
        start = i + 1;
        if (lineBuf.length > 0) {
          const line = decoder.decode(lineBuf);
          const fields = parseCsvLine(line);
          rowIndex += 1;
          try {
            onRow(fields, rowIndex);
          } catch (err) {
            stream.destroy(err);
            return;
          }
          if (shouldStop && shouldStop()) {
            stream.destroy();
            finish(null, { rowCount: rowIndex, stopped: true });
            return;
          }
        }
      }
      leftover = Buffer.from(buf.subarray(start));
    });

    stream.on('error', (err) => finish(err));

    stream.on('close', () => {
      if (settled) return;
      if (leftover.length > 0) {
        const line = decoder.decode(leftover);
        if (line.length > 0) {
          rowIndex += 1;
          try {
            onRow(parseCsvLine(line), rowIndex);
          } catch (err) {
            finish(err);
            return;
          }
        }
      }
      finish(null, { rowCount: rowIndex, stopped: false });
    });
  });
}

module.exports = { parseCsvLine, readCsvRows };
