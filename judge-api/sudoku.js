function parseSudokuGrid(text) {
  const digits = [];
  for (const ch of (text || '')) {
    if (ch >= '0' && ch <= '9') digits.push(ch);
  }
  if (digits.length < 81) return null;

  const grid = [];
  for (let r = 0; r < 9; r++) {
    grid.push(digits.slice(r * 9, (r + 1) * 9));
  }
  return grid;
}

function compareSudokuOutput(userStdout, expectedText) {
  const userGrid = parseSudokuGrid(userStdout);
  const expGrid = parseSudokuGrid(expectedText);

  if (!userGrid || !expGrid) return { ok: false, reason: 'invalid_format' };

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      if (userGrid[r][c] !== expGrid[r][c]) {
        return { ok: false, reason: 'mismatch', row: r, col: c, got: userGrid[r][c], expected: expGrid[r][c] };
      }
    }
  }
  return { ok: true };
}

module.exports = { compareSudokuOutput };
