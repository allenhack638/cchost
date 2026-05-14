'use strict';

function renderTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const cols = rows[0].length;
  const widths = new Array(cols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      const s = String(row[i] == null ? '' : row[i]);
      if (s.length > widths[i]) widths[i] = s.length;
    }
  }
  return rows
    .map((row) =>
      row
        .map((v, i) => {
          const s = String(v == null ? '' : v);
          return i === cols - 1 ? s : s.padEnd(widths[i] + 2);
        })
        .join('')
        .replace(/\s+$/, ''),
    )
    .join('\n');
}

module.exports = { renderTable };
