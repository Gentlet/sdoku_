const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

  // run all cases (한 번 컴파일 후 모든 케이스 실행)
  let overall = 'AC';
  let maxCaseTimeMs = null;
  let maxMemKb = null;

  const caseResults = [];
  let lastStderr = '';

  const perCaseLimitMs = Number(problem.time_limit_ms || 2000);
  const totalLimitMs = Number(process.env.TOTAL_TIME_LIMIT_MS || 30000); // 기본 총합 30s (실행 시간 기준)
  const startedAt = Date.now(); // 전체 처리 시간 (로그/통계용)
  let totalElapsedMs = 0; // 전체 처리 시간
  let processedCases = 0;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-'));
  const sourcePath = path.join(workDir, 'main.cpp');
  const binaryPath = path.join(workDir, 'main');

  try {
    // 한 번만 컴파일 (모든 케이스를 소스에 포함)
    const wrapped = buildWrappedCode(code, cases);
    fs.writeFileSync(sourcePath, wrapped, 'utf8');

    const compileRes = await runCompile(sourcePath, binaryPath, workDir);
    if (!compileRes.ok) {
      overall = 'CE';
      lastStderr = clip(compileRes.stderr, 20000);

      const firstCaseId = cases[0].id;
      await db.query(
        `INSERT INTO submission_results
         (submission_id, test_case_id, status, exec_time_ms, memory_kb, stdout, stderr)
         VALUES (?,?,?,?,?,?,?)`,
        [submissionId, firstCaseId, 'CE', null, null, '', lastStderr]
      );
    } else {
      // 한 번 실행하여 모든 케이스를 처리 (타임아웃은 실행 시간 기준)
      const execStartedAt = Date.now();
      const execRes = await runWithTime(binaryPath, workDir, '', totalLimitMs);
      const execElapsedMs = execRes.execTimeMs != null ? execRes.execTimeMs : (Date.now() - execStartedAt);
      const parsed = parseBatchResult(execRes.stdout, cases.length);

      maxCaseTimeMs = parsed.times.filter(v => v != null).reduce((a, b) => Math.max(a, b), 0);
      if (execRes.memoryKb != null) maxMemKb = execRes.memoryKb;

      let stopEarly = false; // 실패 시 이후 케이스 처리 중단
      for (let i = 0; i < cases.length; i++) {
        const tc = cases[i];
        const statusCode = parsed.statuses[i];
        let status = 'AC';
        if (execRes.timeout) status = 'TLE';
        else if (statusCode === 0) status = 'AC';
        else status = 'WA';

        if (overall === 'AC' && status !== 'AC') overall = status;
        lastStderr = clip(execRes.stderr, 20000);

        await db.query(
          `INSERT INTO submission_results
           (submission_id, test_case_id, status, exec_time_ms, memory_kb, stdout, stderr)
           VALUES (?,?,?,?,?,?,?)`,
          [
            submissionId,
            tc.id,
            status,
            parsed.times[i],
            null,
            '',
            lastStderr
          ]
        );

        caseResults.push({
          testCaseId: tc.id,
          status,
          execTimeMs: parsed.times[i],
          memoryKb: null
        });

        processedCases += 1;

        // 실패(AC 아님) 발견 시 즉시 중단
        if (status !== 'AC') {
          stopEarly = true;
          break;
        }
      }

      totalElapsedMs = Date.now() - startedAt;

      // 실행 시간 기준 시간 초과 체크 (DB insert 등은 포함하지 않음)
      if (overall === 'AC' && (execRes.timeout || execElapsedMs > totalLimitMs)) {
        overall = 'TLE';
        lastStderr = `total time limit exceeded (${totalLimitMs} ms)`;
      }
    }
  } catch (e) {
    overall = 'RE';
    await db.query(
      `INSERT INTO submission_results
       (submission_id, test_case_id, status, exec_time_ms, memory_kb, stdout, stderr)
       VALUES (?,?,?,?,?,?,?)`,
      [submissionId, cases[0]?.id || null, 'RE', null, null, '', clip(String(e), 20000)]
    );
  } finally {
    cleanup(workDir);
  }

  await db.query(
    'UPDATE submissions SET status=?, exec_time_ms=?, memory_kb=? WHERE id=?',
    [overall, totalElapsedMs, maxMemKb, submissionId]
  );

  res.json({
    submissionId,
    status: overall,
    execTimeMs: totalElapsedMs,
    maxCaseTimeMs,
    memoryKb: maxMemKb,
    totalElapsedMs,
    processedCases,
    totalCases: cases.length,
    // 디버깅 편의를 위해 마지막 stderr와 케이스별 상태를 임시로 노출
    lastStderr,
    caseResults
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
    const compileTimeoutMs = Number(process.env.COMPILE_TIMEOUT_MS || 20000); // g++ 최대 대기
    const p = spawn('g++', ['-std=c++17', '-O2', sourcePath, '-o', binaryPath], { cwd });
    let stderr = '';
    let killed = false;

    const killProc = () => {
      if (killed) return;
      killed = true;
      try { p.kill('SIGKILL'); } catch {/* ignore */}
    };

    const timer = setTimeout(() => {
      stderr += `\n[compile timeout after ${compileTimeoutMs} ms]`;
      killProc();
    }, compileTimeoutMs);

    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => {
      clearTimeout(timer);
      if (!killed && code === 0) resolve({ ok: true });
      else resolve({ ok: false, stderr });
    });
    p.on('error', (err) => {
      stderr += `\n[spawn error] ${String(err)}`;
      killProc();
    });
  });
}

/**
 * Run with:
 *   /usr/bin/time -v ./main
 *
 * - 출력 1MB 이상이면 강제 종료 (기존 exec maxBuffer 무시 문제 보완)
 * - 타임아웃 시 프로세스 종료
 */
function runWithTime(binaryPath, cwd, inputText, timeLimitMs, extraArgs = []) {
  return new Promise((resolve) => {
    const maxOutputBytes = 1024 * 1024; // 1MB
    const child = spawn('/usr/bin/time', ['-v', binaryPath, ...extraArgs], {
      cwd,
      shell: false,
      detached: false
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let timeout = false;
    let outputOverflow = false;

    const killChild = (signal = 'SIGKILL') => {
      if (killed) return;
      killed = true;
      try {
        child.kill(signal);
      } catch {
        /* ignore */
      }
    };

    const timer = setTimeout(() => {
      timeout = true;
      killChild();
    }, timeLimitMs + 200);

    const handleChunk = (chunk, isStdout) => {
      const str = chunk.toString();
      if (isStdout) stdout += str;
      else stderr += str;

      if (stdout.length + stderr.length > maxOutputBytes) {
        outputOverflow = true;
        stderr += '\n[truncated: output exceeded 1MB]\n';
        killChild();
      }
    };

    child.stdout.on('data', (d) => handleChunk(d, true));
    child.stderr.on('data', (d) => handleChunk(d, false));

    child.on('error', (err) => {
      stderr += `\n[spawn error] ${String(err)}\n`;
      killChild();
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const exitCode = outputOverflow
        ? 137 // treat as failure
        : (typeof code === 'number' ? code : (signal ? 128 : 0));

      const execTimeSec = parseUserTime(stderr);
      const memoryKb = parseMaxRss(stderr);

      resolve({
        timeout,
        exitCode,
        stdout,
        stderr,
        execTimeMs: execTimeSec != null ? Math.round(execTimeSec * 1000) : null,
        memoryKb: memoryKb != null ? memoryKb : null
      });
    });

    try {
      child.stdin.write(inputText || '');
      child.stdin.end();
    } catch {
      /* ignore */
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

// CASE <idx> STATUS <status> TIME_MS <elapsed>
function parseBatchResult(stdout, caseCount) {
  const statuses = Array(caseCount).fill(null);
  const times = Array(caseCount).fill(null);
  const re = /CASE\s+(\d+)\s+STATUS\s+(-?\d+)\s+TIME_MS\s+(-?\d+)/g;
  let m;
  while ((m = re.exec(stdout || '')) !== null) {
    const idx = Number(m[1]);
    const st = Number(m[2]);
    const t = Number(m[3]);
    if (!Number.isNaN(idx) && idx >= 0 && idx < caseCount) {
      statuses[idx] = st;
      times[idx] = Number.isNaN(t) ? null : t;
    }
  }
  return { statuses, times };
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

function buildWrappedCode(userCode, cases) {
  const caseBlocks = cases.map((tc, idx) => {
    const inputArr = gridToCppArray(tc.input_text).split('\n').map(line => `      ${line}`).join('\n');
    const expectedArr = gridToCppArray(tc.expected_output).split('\n').map(line => `      ${line}`).join('\n');
    return `  { // case ${idx}
    { // input
      {
${inputArr}
      }
    },
    { // expected
      {
${expectedArr}
      }
    }
  }`;
  }).join(',\n');

  return `
#include <bits/stdc++.h>
using namespace std;

using Grid = array<array<int,9>,9>;

// ===== User Code =====
${userCode}
// =====================

struct CaseIO { Grid in; Grid exp; };
struct CaseResult { int status; long long time_ms; };

static const CaseIO CASES[] = {
${caseBlocks}
};
static const int CASE_COUNT = sizeof(CASES)/sizeof(CASES[0]);

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

static bool equalsExpected(const Grid& g, const Grid& exp) {
  for (int r=0;r<9;r++) for (int c=0;c<9;c++) {
    if (g[r][c] != exp[r][c]) return false;
  }
  return true;
}

int main() {
  vector<CaseResult> results;
  results.reserve(CASE_COUNT);

  for (int idx = 0; idx < CASE_COUNT; ++idx) {
    const Grid& INPUT = CASES[idx].in;
    const Grid& EXPECTED = CASES[idx].exp;

    Grid out;
    int status = 0;
    auto t0 = chrono::steady_clock::now();
    try {
      out = solveSudoku(INPUT);
    } catch (...) {
      status = 5; // exception
    }
    auto t1 = chrono::steady_clock::now();

    if (status == 0) {
      if (!validRange(out)) status = 1;
      else if (!respectClues(INPUT, out)) status = 2;
      else if (!validSudoku(out)) status = 3;
      else if (!equalsExpected(out, EXPECTED)) status = 4;
    }

    long long elapsed = chrono::duration_cast<chrono::milliseconds>(t1 - t0).count();
    results.push_back({status, elapsed});
  }

  // 출력: CASE <idx> STATUS <status> TIME_MS <elapsed>
  for (int i = 0; i < (int)results.size(); ++i) {
    cout << "CASE " << i << " STATUS " << results[i].status << " TIME_MS " << results[i].time_ms << "\\n";
        if (results[i].status != 0) {
          // 첫 실패에서 즉시 종료
          return 1;
        }
  }
  return 0;
}
`;
}

const PORT = Number(process.env.PORT || 3000);

// DB 연결 테스트 후 서버 시작
async function startServer() {
  try {
    // DB 연결 테스트
    console.log('Testing DB connection...');
    await db.query('SELECT 1');
    console.log('DB connection OK');
    
    // 서버 시작
    app.listen(PORT, () => {
      console.log(`Judge API listening on ${PORT}`);
    }).on('error', (err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
  } catch (err) {
    console.error('Failed to start server - DB connection error:', err);
    console.error('DB config:', {
      host: process.env.DB_HOST || 'db',
      user: process.env.DB_USER || 'judge',
      database: process.env.DB_NAME || 'judge'
    });
    process.exit(1);
  }
}

// 처리되지 않은 예외/프로미스 거부 시 로깅
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

startServer();
