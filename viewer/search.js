'use strict';

const query = document.getElementById('query');
const count = document.getElementById('matches');
const rows = Array.from(document.querySelectorAll('article'));
const searchable = rows.map(row => row.textContent.toLowerCase());

query.addEventListener('input', () => {
  const needle = query.value.trim().toLowerCase();
  let matches = 0;
  for (const [index, row] of rows.entries()) {
    row.hidden = !searchable[index].includes(needle);
    if (!row.hidden) matches++;
  }
  count.textContent = '显示 ' + matches + ' / ' + rows.length + ' 条';
});
