const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');

const db = require('./db');

const app = express();
app.use(express.json({ limit: '512kb' }));

/**
 * Health check
 */
app.get('/health', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT 1 AS ok');
    res.json({ ok: true, db: rows[0].ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/**
 * Get user submissions list
 * GET /submissions?userName=...&phone=...&problemId=1
 */
app.get('/submissions', async (req, res) => {
  const userName = String(req.query.userName || '').trim();
  const phone = String(req.query.phone || '').trim();
  const problemId = req.query.problemId ? Number(req.query.problemId) : null;

  if (!userName || !phone) return res.status(400).json({ error: 'userName and phone required' });

  const [[user]] = await db.query('SELECT id FROM users WHERE username=? AND phone=?', [userName, phone]);
  if (!user) return res.json([]);

  const params = [user.id];
  let sql = `
    SELECT id, problem_id, language, status, exec_time_ms, memory_kb, created_at
    FROM submissions
    WHERE user_id=?
  `;
  if (problemId) {
    sql += ' AND problem_id=?';
    params.push(problemId);
  }
  sql += ' ORDER BY created_at DESC LIMIT 50';

  const [rows] = await db.query(sql, params);
  res.json(rows);
});

/**
 * Submit code
 * POST /submit
 * body: { userName, phone, problemId, code }
 */
app.post('/submit', async (req, res) => {
  const userName = String(req.body.userName || '').trim();
  const phone = String(req.body.phone || '').trim();
  const problemId = Number(req.body.problemId);
  const code = String(req.body.code || '');

  if (!userName || !phone || !problemId || !code.trim()) {
    return res.status(400).json({ error: 'userName, phone, problemId, code required' });
  }

  const userId = await getOrCreateUser(userName, phone);

  // problem + cases load
  const [[problem]] = await db.query('SELECT * FROM problems WHERE id=?', [problemId]);
  if (!problem) return res.status(404).json({ error: 'problem not found' });

  const [cases] = await db.query('SELECT * FROM test_cases WHERE problem_id=? ORDER BY id', [problemId]);
  if (cases.length === 0) return res.status(500).json({ error: 'no test cases for this problem' });

  // create submission record
  const [subIns] = await db.query(
    'INSERT INTO submissions(user_id, problem_id, code, language, status) VALUES (?,?,?,?,?)',
    [userId, problemId, code, 'cpp', 'PENDING']
  );
  const submissionId = subIns.insertId;

  // run all cases (케이스마다 래핑/컴파일/실행)
  let overall = 'AC';
  let maxTimeMs = null;
  let maxMemKb = null;

  const caseResults = [];

  for (const tc of cases) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-'));
    const sourcePath = path.join(workDir, 'main.cpp');
    const binaryPath = path.join(workDir, 'main');

    try {
      const wrapped = buildWrappedCode(code, tc.input_text, tc.expected_output);
      fs.writeFileSync(sourcePath, wrapped, 'utf8');

      const compileRes = await runCompile(sourcePath, binaryPath, workDir);
      if (!compileRes.ok) {
        overall = 'CE';

        await db.query(
          `INSERT INTO submission_results
           (submission_id, test_case_id, status, exec_time_ms, memory_kb, stdout, stderr)
           VALUES (?,?,?,?,?,?,?)`,
          [submissionId, tc.id, 'CE', null, null, '', clip(compileRes.stderr, 20000)]
        );

        // 컴파일 에러는 즉시 종료
        break;
      }

      // wrapper가 INPUT/EXPECTED를 코드에 박기 때문에 stdin은 필요 없음
      const execRes = await runWithTime(binaryPath, workDir, '', Number(problem.time_limit_ms || 2000));

      if (execRes.execTimeMs != null) maxTimeMs = (maxTimeMs == null) ? execRes.execTimeMs : Math.max(maxTimeMs, execRes.execTimeMs);
      if (execRes.memoryKb != null) maxMemKb = (maxMemKb == null) ? execRes.memoryKb : Math.max(maxMemKb, execRes.memoryKb);

      let status = 'AC';
      if (execRes.timeout) status = 'TLE';
      else if (execRes.exitCode !== 0) status = 'WA'; // wrapper 검증 실패시 non-zero 종료

      if (overall === 'AC' && status !== 'AC') overall = status;

      await db.query(
        `INSERT INTO submission_results
         (submission_id, test_case_id, status, exec_time_ms, memory_kb, stdout, stderr)
         VALUES (?,?,?,?,?,?,?)`,
        [
          submissionId,
          tc.id,
          status,
          execRes.execTimeMs,
          execRes.memoryKb,
          '', // stdout 채점에 사용 안 함
          clip(execRes.stderr, 20000)
        ]
      );

      caseResults.push({
        testCaseId: tc.id,
        status,
        execTimeMs: execRes.execTimeMs,
        memoryKb: execRes.memoryKb
      });

      // 하나라도 틀리면 끝내고 싶으면 주석 해제
      // if (status !== 'AC') break;
    } catch (e) {
      overall = 'RE';
      await db.query(
        `INSERT INTO submission_results
         (submission_id, test_case_id, status, exec_time_ms, memory_kb, stdout, stderr)
         VALUES (?,?,?,?,?,?,?)`,
        [submissionId, tc.id, 'RE', null, null, '', clip(String(e), 20000)]
      );
      break;
    } finally {
      cleanup(workDir);
    }
  }

  await db.query(
    'UPDATE submissions SET status=?, exec_time_ms=?, memory_kb=? WHERE id=?',
    [overall, maxTimeMs, maxMemKb, submissionId]
  );

  res.json({
    submissionId,
    status: overall,
    execTimeMs: maxTimeMs,
    memoryKb: maxMemKb
  });
});

// ---------- helpers ----------

async function getOrCreateUser(username, phone) {
  // (username, phone) UNIQUE 전제
  const [[u]] = await db.query('SELECT id FROM users WHERE username=? AND phone=?', [username, phone]);
  if (u) return u.id;

  const [ins] = await db.query('INSERT INTO users(username, phone) VALUES (?, ?)', [username, phone]);
  return ins.insertId;
}

function runCompile(sourcePath, binaryPath, cwd) {
  return new Promise((resolve) => {
    const p = spawn('g++', ['-std=c++17', '-O2', sourcePath, '-o', binaryPath], { cwd });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, stderr });
    });
  });
}

/**
 * Run with:
 *   /usr/bin/time -v ./main
 */
function runWithTime(binaryPath, cwd, inputText, timeLimitMs) {
  return new Promise((resolve) => {
    const cmd = `/usr/bin/time -v ./main`;
    const child = exec(
      cmd,
      {
        cwd,
        timeout: timeLimitMs + 200,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        const timeout = !!(error && error.killed);
        const exitCode = (error && typeof error.code === 'number') ? error.code : 0;

        const execTimeSec = parseUserTime(stderr);
        const memoryKb = parseMaxRss(stderr);

        resolve({
          timeout,
          exitCode,
          stdout: stdout || '',
          stderr: stderr || '',
          execTimeMs: execTimeSec != null ? Math.round(execTimeSec * 1000) : null,
          memoryKb: memoryKb != null ? memoryKb : null
        });
      }
    );

    try {
      child.stdin.write(inputText || '');
      child.stdin.end();
    } catch {
      // ignore
    }
  });
}

function parseUserTime(stderr) {
  const m = (stderr || '').match(/User time \(seconds\):\s+([0-9.]+)/);
  return m ? Number(m[1]) : null;
}

function parseMaxRss(stderr) {
  const m = (stderr || '').match(/Maximum resident set size \(kbytes\):\s+(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function clip(s, maxLen) {
  s = String(s || '');
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '\n...[clipped]';
}

// ---------- wrapper builders (FIXED) ----------

// ✅ 안전 파서: 9줄×9자리 우선, 아니면 숫자 81개 fallback
function parseSudoku9x9(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(s => s.replace(/[^0-9]/g, ''))
    .filter(s => s.length > 0);

  // 9줄이 있고 각 줄이 9개 이상이면, 앞 9줄/9자리만 사용
  if (lines.length >= 9 && lines.slice(0, 9).every(s => s.length >= 9)) {
    const grid = [];
    for (let r = 0; r < 9; r++) {
      const row = lines[r].slice(0, 9).split('').map(ch => Number(ch));
      grid.push(row);
    }
    return grid;
  }

  // fallback: 숫자만 81개
  const d = String(text || '').replace(/[^0-9]/g, '');
  if (d.length < 81) throw new Error('expected at least 81 digits for sudoku');
  const grid = [];
  for (let r = 0; r < 9; r++) {
    const row = [];
    for (let c = 0; c < 9; c++) row.push(Number(d[r * 9 + c]));
    grid.push(row);
  }
  return grid;
}

// ✅ 항상 9줄짜리 C++ 초기화 리스트 생성: "{1,2,...,9}" 형태 9개
function gridToCppArray(text) {
  const g = parseSudoku9x9(text); // [[...9], ...9]
  return g.map(row => `  {${row.join(',')}}`).join(',\n');
}

function buildWrappedCode(userCode, inputText, expectedText) {
  const inputArr = gridToCppArray(inputText);
  const expectedArr = gridToCppArray(expectedText);

  return `
#include <bits/stdc++.h>
using namespace std;

using Grid = array<array<int,9>,9>;

// ===== User Code =====
${userCode}
// =====================

static Grid INPUT = {
${inputArr}
};

static Grid EXPECTED = {
${expectedArr}
};

static bool validRange(const Grid& g) {
  for (int r=0;r<9;r++) for (int c=0;c<9;c++) {
    if (g[r][c] < 1 || g[r][c] > 9) return false;
  }
  return true;
}

static bool respectClues(const Grid& in, const Grid& out) {
  for (int r=0;r<9;r++) for (int c=0;c<9;c++) {
    if (in[r][c] != 0 && out[r][c] != in[r][c]) return false;
  }
  return true;
}

static bool validSudoku(const Grid& g) {
  for (int i=0;i<9;i++) {
    bool row[10]={0}, col[10]={0};
    for (int j=0;j<9;j++) {
      int a=g[i][j], b=g[j][i];
      if (a < 1 || a > 9 || b < 1 || b > 9) return false;
      if (row[a] || col[b]) return false;
      row[a]=true; col[b]=true;
    }
  }
  for (int br=0;br<9;br+=3) for (int bc=0;bc<9;bc+=3) {
    bool seen[10]={0};
    for (int r=0;r<3;r++) for (int c=0;c<3;c++) {
      int v=g[br+r][bc+c];
      if (v < 1 || v > 9) return false;
      if (seen[v]) return false;
      seen[v]=true;
    }
  }
  return true;
}

static bool equalsExpected(const Grid& g) {
  for (int r=0;r<9;r++) for (int c=0;c<9;c++) {
    if (g[r][c] != EXPECTED[r][c]) return false;
  }
  return true;
}

int main() {
  // 사용자가 반드시 제공해야 하는 함수:
  // Grid solveSudoku(const Grid& input);

  Grid out;
  try {
    out = solveSudoku(INPUT);
  } catch (...) {
    return 20; // 예외 -> WA
  }

  if (!validRange(out)) return 1;
  if (!respectClues(INPUT, out)) return 2;
  if (!validSudoku(out)) return 3;
  if (!equalsExpected(out)) return 4;

  return 0; // AC
}
`;
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Judge API listening on ${PORT}`));
