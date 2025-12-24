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
 * Get leaderboard
 * GET /leaderboard?limit=100
 */
app.get('/leaderboard', async (req, res) => {
  try {
    const limit = Number(req.query.limit || 100);
    
    const [rows] = await db.query(
      `SELECT 
        u.id,
        u.username,
        u.\`rank\`,
        u.total_time_ms,
        u.total_memory_kb,
        (SELECT COUNT(DISTINCT s.problem_id) FROM submissions s WHERE s.user_id = u.id AND s.status = 'AC') as solved_count
       FROM users u
       WHERE u.\`rank\` IS NOT NULL
       ORDER BY u.\`rank\` ASC
       LIMIT ?`,
      [limit]
    );

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Recalculate all rankings manually
 * POST /recalculate-rankings
 * GET /recalculate-rankings (for easy browser access)
 */
app.post('/recalculate-rankings', async (req, res) => {
  try {
    console.log('[API] Manual ranking recalculation requested (POST)');
    await recalculateAllRankings();
    res.json({ ok: true, message: 'Rankings recalculated successfully' });
  } catch (e) {
    console.error('[API] Failed to recalculate rankings:', e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/recalculate-rankings', async (req, res) => {
  try {
    console.log('[API] Manual ranking recalculation requested (GET)');
    await recalculateAllRankings();
    res.json({ ok: true, message: 'Rankings recalculated successfully' });
  } catch (e) {
    console.error('[API] Failed to recalculate rankings:', e);
    res.status(500).json({ error: String(e) });
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

  const perCaseLimitMs = Number(problem.time_limit_ms || 5000);
  const totalLimitMs = Number(process.env.TOTAL_TIME_LIMIT_MS || 90000); // 기본 총합 90s (실행 시간 기준)
  const startedAt = Date.now(); // 전체 처리 시간 (로그/통계용)
  let totalElapsedMs = 0; // 전체 처리 시간
  let totalExecTimeMs = 0; // 실제 실행 시간 합계 (각 테스트 케이스의 실행 시간 합)
  let processedCases = 0;
  let execRes = null; // 실행 결과를 저장하여 나중에 사용

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
      // CE일 때는 stderr를 표시하지 않음
      lastStderr = '';

      const firstCaseId = cases[0].id;
      await db.query(
        `INSERT INTO submission_results
         (submission_id, test_case_id, status, exec_time_ms, memory_kb, stdout, stderr)
         VALUES (?,?,?,?,?,?,?)`,
        [submissionId, firstCaseId, 'CE', null, null, '', '']
      );
    } else {
      // 한 번 실행하여 모든 케이스를 처리 (타임아웃은 실행 시간 기준)
      const execStartedAt = Date.now();
      execRes = await runWithTime(binaryPath, workDir, '', totalLimitMs);
      const execElapsedMs = execRes.execTimeMs != null ? execRes.execTimeMs : (Date.now() - execStartedAt);
      const parsed = parseBatchResult(execRes.stdout, cases.length);

      // 파싱된 시간 값들 확인
      const validTimes = parsed.times.filter(v => v != null && v > 0);
      maxCaseTimeMs = validTimes.length > 0 ? Math.max(...validTimes) : 0;
      
      // 메모리는 execRes에서 가져오기
      if (execRes.memoryKb != null && execRes.memoryKb > 0) {
        maxMemKb = execRes.memoryKb;
      }
      
      console.log(`[Submit] Parsed results: times=${JSON.stringify(parsed.times)}, statuses=${JSON.stringify(parsed.statuses)}, execRes.execTimeMs=${execRes.execTimeMs}, execRes.memoryKb=${execRes.memoryKb}`);

      // 모든 케이스 결과를 수집한 후 배치 INSERT (성능 최적화)
      const insertValues = [];
      let firstFailureIdx = -1;
      
      for (let i = 0; i < cases.length; i++) {
        const tc = cases[i];
        const statusCode = parsed.statuses[i];
        let status = 'AC';
        if (execRes.timeout) status = 'TLE';
        else if (statusCode === 0) status = 'AC';
        else status = 'WA';

        if (overall === 'AC' && status !== 'AC') {
          overall = status;
          if (firstFailureIdx === -1) firstFailureIdx = i;
        }
        lastStderr = clip(execRes.stderr, 20000);

        // 실행 시간 합계 계산 (AC인 경우만, null이 아니고 0보다 큰 경우만)
        if (status === 'AC' && parsed.times[i] != null && parsed.times[i] > 0) {
          totalExecTimeMs += parsed.times[i];
        }

        insertValues.push([
          submissionId,
          tc.id,
          status,
          parsed.times[i],
          null,
          '',
          lastStderr
        ]);

        caseResults.push({
          testCaseId: tc.id,
          status,
          execTimeMs: parsed.times[i],
          memoryKb: null
        });

        processedCases += 1;

        // 실패(AC 아님) 발견 시 이후 케이스는 저장하지 않음 (이미 C++에서 중단됨)
        if (status !== 'AC') {
          break;
        }
      }

      // 배치 INSERT로 한 번에 저장 (개별 INSERT 대비 10-100배 빠름)
      if (insertValues.length > 0) {
        const placeholders = insertValues.map(() => '(?,?,?,?,?,?,?)').join(',');
        const flatValues = insertValues.flat();
        await db.query(
          `INSERT INTO submission_results
           (submission_id, test_case_id, status, exec_time_ms, memory_kb, stdout, stderr)
           VALUES ${placeholders}`,
          flatValues
        );
      }

      // 전체 처리 시간 (로깅용)
      totalElapsedMs = Date.now() - startedAt;
      // 실제 실행 시간은 totalExecTimeMs 사용

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

  // 실행 시간 결정 우선순위:
  // 1. totalExecTimeMs (파싱된 각 케이스의 실행 시간 합계) - 가장 정확
  // 2. execRes.execTimeMs (time 명령어에서 파싱한 실제 실행 시간) - 두 번째로 정확
  // 3. maxCaseTimeMs (가장 긴 케이스의 실행 시간) - 대략적인 값
  // 4. totalElapsedMs (전체 처리 시간) - 마지막 대안
  let execTimeForDb = totalElapsedMs;
  if (overall === 'AC') {
    if (totalExecTimeMs > 0) {
      execTimeForDb = totalExecTimeMs;
    } else if (execRes && execRes.execTimeMs != null && execRes.execTimeMs > 0) {
      // totalExecTimeMs가 0이면 execRes.execTimeMs 사용 (time 명령어에서 파싱한 값)
      // 이 값은 실제 프로그램 실행 시간을 나타냄
      execTimeForDb = execRes.execTimeMs;
    } else if (maxCaseTimeMs != null && maxCaseTimeMs > 0) {
      execTimeForDb = maxCaseTimeMs;
    }
  }
  
  // 메모리 값이 없으면 execRes에서 다시 가져오기
  if ((maxMemKb == null || maxMemKb === 0) && overall === 'AC' && execRes && execRes.memoryKb != null && execRes.memoryKb > 0) {
    maxMemKb = execRes.memoryKb;
  }
  
  console.log(`[Submit] Submission ${submissionId}: status=${overall}, execTime=${execTimeForDb}ms, memory=${maxMemKb}KB, totalExecTimeMs=${totalExecTimeMs}, maxCaseTimeMs=${maxCaseTimeMs}, execRes.execTimeMs=${execRes?.execTimeMs}, execRes.memoryKb=${execRes?.memoryKb}, totalElapsedMs=${totalElapsedMs}`);
  console.log(`[Submit] Checking if overall === 'AC': overall="${overall}", type=${typeof overall}, comparison=${overall === 'AC'}`);
  
  await db.query(
    'UPDATE submissions SET status=?, exec_time_ms=?, memory_kb=? WHERE id=?',
    [overall, execTimeForDb, maxMemKb, submissionId]
  );

  // AC인 경우 랭킹 업데이트
  if (overall === 'AC') {
    try {
      console.log(`[Submit] Calling updateRanking for user ${userId}, submission ${submissionId}`);
      await updateRanking(userId);
      console.log(`[Submit] updateRanking completed for user ${userId}`);
    } catch (e) {
      console.error('Failed to update ranking after submission:', e);
      console.error('Error stack:', e.stack);
      // 랭킹 업데이트 실패해도 제출은 성공으로 처리
    }
  } else {
    console.log(`[Submit] Skipping ranking update - status is ${overall}, not AC`);
  }

  res.json({
    submissionId,
    status: overall,
    execTimeMs: totalExecTimeMs > 0 ? totalExecTimeMs : totalElapsedMs, // 실제 실행 시간 우선, 없으면 전체 경과 시간
    totalExecTimeMs, // 테스트 케이스 실행 시간 합계
    maxCaseTimeMs,
    memoryKb: maxMemKb,
    totalElapsedMs, // 전체 경과 시간 (디버깅용)
    processedCases,
    totalCases: cases.length,
    // 디버깅 편의를 위해 마지막 stderr와 케이스별 상태를 임시로 노출
    lastStderr,
    caseResults
  });
});

// ---------- helpers ----------

/**
 * 랭킹 업데이트: 최소 1개 문제라도 AC로 통과한 유저들의 랭킹 계산
 * 랭킹 기준: 1) 해결한 문제 수 (많을수록 좋음), 2) 총 실행시간 합계 (적을수록 좋음), 3) 메모리 사용량 합계 (적을수록 좋음)
 */
async function updateRanking(userId) {
  try {
    console.log(`[Ranking] updateRanking called for user ${userId}`);
    
    // 1. 모든 문제 목록 가져오기
    const [allProblems] = await db.query('SELECT id FROM problems ORDER BY id');
    console.log(`[Ranking] Found ${allProblems.length} problems`);
    
    if (allProblems.length === 0) {
      // 문제가 없으면 랭킹 제거
      await db.query(
        'UPDATE users SET total_time_ms=NULL, total_memory_kb=NULL, `rank`=NULL WHERE id=?',
        [userId]
      );
      console.log(`[Ranking] No problems found, cleared ranking for user ${userId}`);
      return;
    }

    // 2. 해당 유저가 AC로 통과한 문제 수 확인
    const [userAcCount] = await db.query(
      `SELECT COUNT(DISTINCT problem_id) as count 
       FROM submissions 
       WHERE user_id=? AND status='AC'`,
      [userId]
    );

    const acProblemCount = userAcCount[0]?.count || 0;
    console.log(`[Ranking] User ${userId} has ${acProblemCount} AC problems`);

    // AC로 통과한 문제가 없으면 랭킹에서 제외
    if (acProblemCount === 0) {
      await db.query(
        'UPDATE users SET total_time_ms=NULL, total_memory_kb=NULL, `rank`=NULL WHERE id=?',
        [userId]
      );
      console.log(`[Ranking] User ${userId} has no AC problems, clearing ranking`);
      // 다른 유저들의 랭킹도 재계산 필요
      await recalculateAllRankings();
      return;
    }

    // 3. AC로 통과한 문제들에 대해서만 최고 성능 제출 찾기
    let totalTimeMs = 0;
    let totalMemoryKb = 0;

    const [acProblems] = await db.query(
      `SELECT DISTINCT problem_id 
       FROM submissions 
       WHERE user_id=? AND status='AC'`,
      [userId]
    );

    for (const acProblem of acProblems) {
      let problemTime = 0;
      let problemMemory = 0;
      
      // submission_results에서 직접 합산 (각 테스트 케이스의 실행 시간 합계)
      try {
        // 가장 빠른 제출의 submission_results에서 합산
        const [submissionRows] = await db.query(
          `SELECT s.id
           FROM submissions s
           WHERE s.user_id=? AND s.problem_id=? AND s.status='AC' 
           ORDER BY s.id ASC
           LIMIT 1`,
          [userId, acProblem.problem_id]
        );
        
        console.log(`[Ranking] updateRanking: Query returned ${submissionRows.length} rows for user ${userId}, problem ${acProblem.problem_id}`);
        
        if (submissionRows.length > 0) {
          const submissionId = submissionRows[0].id;
          console.log(`[Ranking] updateRanking: Found submission id=${submissionId} for user ${userId}, problem ${acProblem.problem_id}`);
          
          // submission_results에서 실행 시간 합산
          const [timeRows] = await db.query(
            `SELECT SUM(sr.exec_time_ms) as total_time
             FROM submission_results sr
             WHERE sr.submission_id = ? AND sr.status = 'AC' AND sr.exec_time_ms IS NOT NULL AND sr.exec_time_ms > 0`,
            [submissionId]
          );
          
          if (timeRows[0] && timeRows[0].total_time != null) {
            problemTime = Number(timeRows[0].total_time);
          }
          
          // submissions 테이블에서 메모리 가져오기
          const [submissionData] = await db.query(
            `SELECT memory_kb FROM submissions WHERE id = ?`,
            [submissionId]
          );
          if (submissionData[0] && submissionData[0].memory_kb != null && submissionData[0].memory_kb > 0) {
            problemMemory = submissionData[0].memory_kb;
          }
        }
      } catch (e) {
        console.error(`[Ranking] Error in updateRanking for user ${userId}, problem ${acProblem.problem_id}:`, e);
      }
      
      totalTimeMs += problemTime;
      totalMemoryKb += problemMemory;
    }
    
    // 최소값 보장 (0이면 랭킹에 포함되지 않을 수 있음)
    if (totalTimeMs === 0) {
      totalTimeMs = 1; // 최소 1ms로 설정하여 랭킹에 포함되도록
    }

    // 4. 유저의 총 시간/메모리 업데이트
    console.log(`[Ranking] Updating user ${userId}: totalTimeMs=${totalTimeMs}, totalMemoryKb=${totalMemoryKb}`);
    await db.query(
      'UPDATE users SET total_time_ms=?, total_memory_kb=? WHERE id=?',
      [totalTimeMs, totalMemoryKb, userId]
    );
    console.log(`[Ranking] Updated user ${userId} total_time_ms and total_memory_kb`);

    // 5. 모든 유저들의 랭킹 재계산
    console.log(`[Ranking] Calling recalculateAllRankings after updating user ${userId}`);
    await recalculateAllRankings();
    console.log(`[Ranking] updateRanking completed successfully for user ${userId}`);
  } catch (e) {
    console.error('Failed to update ranking:', e);
    console.error('Error stack:', e.stack);
    throw e; // 에러를 다시 throw하여 상위에서 처리할 수 있도록
  }
}

/**
 * 최소 1개 문제라도 AC로 통과한 유저들의 랭킹 재계산
 * 랭킹 기준: 1) 해결한 문제 수 (많을수록 좋음), 2) 총 실행시간 합계 (적을수록 좋음), 3) 메모리 사용량 합계 (적을수록 좋음)
 */
async function recalculateAllRankings() {
  try {
    console.log('[Ranking] Starting recalculation...');
    
    // 모든 문제 목록
    const [allProblems] = await db.query('SELECT id FROM problems ORDER BY id');
    console.log(`[Ranking] Found ${allProblems.length} problems`);
    
    if (allProblems.length === 0) {
      // 문제가 없으면 모든 유저의 랭킹 제거
      await db.query('UPDATE users SET `rank`=NULL, total_time_ms=NULL, total_memory_kb=NULL');
      console.log('[Ranking] No problems found, cleared all rankings');
      return;
    }

    // 먼저 모든 유저의 랭킹을 초기화 (중복 방지)
    await db.query('UPDATE users SET `rank`=NULL');
    console.log('[Ranking] Reset all user ranks');

    // 최소 1개 문제라도 AC로 통과한 유저들 찾기
    const [qualifiedUsers] = await db.query(
      `SELECT u.id
       FROM users u
       WHERE (
         SELECT COUNT(DISTINCT s.problem_id)
         FROM submissions s
         WHERE s.user_id = u.id AND s.status = 'AC'
       ) > 0`
    );
    console.log(`[Ranking] Found ${qualifiedUsers.length} qualified users with AC submissions`);
    try {
      if (qualifiedUsers.length > 0) {
        console.log(`[Ranking] Qualified user IDs: ${qualifiedUsers.map(u => u.id).join(', ')}`);
      }
    } catch (e) {
      console.error(`[Ranking] Error logging qualified user IDs:`, e);
    }

    // 각 유저의 총 시간/메모리 재계산
    console.log(`[Ranking] Starting to process ${qualifiedUsers.length} users`);
    for (let userIdx = 0; userIdx < qualifiedUsers.length; userIdx++) {
      const user = qualifiedUsers[userIdx];
      try {
        console.log(`[Ranking] [${userIdx + 1}/${qualifiedUsers.length}] Processing user ${user.id}`);
        let totalTimeMs = 0;
        let totalMemoryKb = 0;

        // AC로 통과한 문제들만 계산
        console.log(`[Ranking] [${userIdx + 1}/${qualifiedUsers.length}] Querying AC problems for user ${user.id}`);
        const [acProblems] = await db.query(
          `SELECT DISTINCT problem_id 
           FROM submissions 
           WHERE user_id=? AND status='AC'`,
          [user.id]
        );
        console.log(`[Ranking] [${userIdx + 1}/${qualifiedUsers.length}] User ${user.id} has ${acProblems.length} AC problems`);
        if (acProblems.length > 0) {
          console.log(`[Ranking] [${userIdx + 1}/${qualifiedUsers.length}] Problem IDs: ${acProblems.map(p => p.problem_id).join(', ')}`);
        }

        for (let probIdx = 0; probIdx < acProblems.length; probIdx++) {
          const acProblem = acProblems[probIdx];
          try {
            const problemId = acProblem.problem_id;
            let problemTime = 0;
            let problemMemory = 0;
            
            console.log(`[Ranking] [${userIdx + 1}/${qualifiedUsers.length}] [${probIdx + 1}/${acProblems.length}] Processing user ${user.id}, problem ${problemId}`);
            
            // submission_results에서 직접 합산 (각 테스트 케이스의 실행 시간 합계)
            console.log(`[Ranking] Querying submission_results for user ${user.id}, problem ${problemId}`);
            try {
              // 가장 빠른 제출의 submission_results에서 합산
              const [submissionRows] = await db.query(
                `SELECT s.id
                 FROM submissions s
                 WHERE s.user_id=? AND s.problem_id=? AND s.status='AC' 
                 ORDER BY s.id ASC
                 LIMIT 1`,
                [user.id, problemId]
              );
              
              console.log(`[Ranking] Query returned ${submissionRows.length} rows for user ${user.id}, problem ${problemId}`);
              
              if (submissionRows.length > 0) {
                const submissionId = submissionRows[0].id;
                console.log(`[Ranking] Found submission id=${submissionId} for user ${user.id}, problem ${problemId}`);
                
                // submission_results에서 실행 시간 합산
                const [timeRows] = await db.query(
                  `SELECT SUM(sr.exec_time_ms) as total_time
                   FROM submission_results sr
                   WHERE sr.submission_id = ? AND sr.status = 'AC' AND sr.exec_time_ms IS NOT NULL AND sr.exec_time_ms > 0`,
                  [submissionId]
                );
                console.log(`[Ranking] Time query result:`, JSON.stringify(timeRows));
                
                if (timeRows[0] && timeRows[0].total_time != null) {
                  problemTime = Number(timeRows[0].total_time);
                  console.log(`[Ranking] Using submission_results SUM for time: ${problemTime}ms`);
                }
                
                // submissions 테이블에서 메모리 가져오기
                const [submissionData] = await db.query(
                  `SELECT memory_kb FROM submissions WHERE id = ?`,
                  [submissionId]
                );
                if (submissionData[0] && submissionData[0].memory_kb != null && submissionData[0].memory_kb > 0) {
                  problemMemory = submissionData[0].memory_kb;
                  console.log(`[Ranking] Using submissions.memory_kb: ${problemMemory}KB`);
                }
              } else {
                console.log(`[Ranking] No AC submission found for user ${user.id}, problem ${problemId}`);
              }
            } catch (e) {
              console.error(`[Ranking] Error querying submission_results for user ${user.id}, problem ${problemId}:`, e);
              console.error(`[Ranking] Error stack:`, e.stack);
            }
            
            console.log(`[Ranking] Adding to totals: time=${problemTime}ms, memory=${problemMemory}KB (before: totalTime=${totalTimeMs}ms, totalMem=${totalMemoryKb}KB)`);
            totalTimeMs += problemTime;
            totalMemoryKb += problemMemory;
            console.log(`[Ranking] After adding: totalTime=${totalTimeMs}ms, totalMem=${totalMemoryKb}KB`);
          } catch (e) {
            console.error(`[Ranking] Error processing problem ${acProblem.problem_id} for user ${user.id}:`, e);
          }
        }
        
        console.log(`[Ranking] Final totals for user ${user.id}: time=${totalTimeMs}ms, memory=${totalMemoryKb}KB`);
        
        // totalTimeMs가 0이면 랭킹에서 제외 (최소값 보장 로직 제거)
        if (totalTimeMs === 0) {
          console.log(`[Ranking] User ${user.id} has totalTimeMs=0, skipping update (will be excluded from ranking)`);
          continue; // 이 유저는 랭킹에서 제외
        }

        await db.query(
          'UPDATE users SET total_time_ms=?, total_memory_kb=? WHERE id=?',
          [totalTimeMs, totalMemoryKb, user.id]
        );
        console.log(`[Ranking] Updated user ${user.id}: time=${totalTimeMs}ms, memory=${totalMemoryKb}KB`);
      } catch (e) {
        console.error(`[Ranking] Error processing user ${user.id}:`, e);
        console.error('Error stack:', e.stack);
      }
    }

    // 랭킹 계산: 
    // 1순위: 해결한 문제 수 (많을수록 좋음)
    // 2순위: 총 실행시간 (적을수록 좋음)
    // 3순위: 메모리 사용량 (적을수록 좋음)
    // total_time_ms가 NULL이 아닌 경우만 포함 (0도 포함)
    const [rankedUsers] = await db.query(
      `SELECT u.id,
              (SELECT COUNT(DISTINCT s.problem_id) FROM submissions s WHERE s.user_id = u.id AND s.status = 'AC') as solved_count
       FROM users u
       WHERE u.total_time_ms IS NOT NULL
       ORDER BY solved_count DESC, u.total_time_ms ASC, u.total_memory_kb ASC`
    );
    console.log(`[Ranking] Found ${rankedUsers.length} users to rank`);

    // 랭킹 업데이트
    for (let i = 0; i < rankedUsers.length; i++) {
      await db.query(
        'UPDATE users SET `rank`=? WHERE id=?',
        [i + 1, rankedUsers[i].id]
      );
    }
    console.log(`[Ranking] Assigned ranks to ${rankedUsers.length} users`);

    // 랭킹에서 제외된 유저들 (AC로 통과한 문제가 없는 경우) - 명시적으로 NULL 설정
    const [excludedResult] = await db.query(
      `UPDATE users 
       SET \`rank\`=NULL, total_time_ms=NULL, total_memory_kb=NULL
       WHERE (
         SELECT COUNT(DISTINCT s.problem_id)
         FROM submissions s
         WHERE s.user_id = users.id AND s.status = 'AC'
       ) = 0`
    );
    console.log(`[Ranking] Excluded users with no AC submissions`);
    console.log('[Ranking] Recalculation completed successfully');
  } catch (e) {
    console.error('Failed to recalculate rankings:', e);
    console.error('Error message:', e.message);
    console.error('Error stack:', e.stack);
    if (e.sql) {
      console.error('SQL query:', e.sql);
    }
    throw e; // 에러를 다시 throw하여 상위에서 처리할 수 있도록
  }
}

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
    // 컴파일 최적화: -O2 (안정성과 성능 균형), -march=native (CPU 최적화), -pipe (메모리 사용)
    const p = spawn('g++', ['-std=c++17', '-O2', '-march=native', '-pipe', sourcePath, '-o', binaryPath], { cwd });
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
      
      // time 명령어의 출력을 제거하고 실제 프로그램의 stderr만 반환
      const filteredStderr = filterTimeOutput(stderr);

      resolve({
        timeout,
        exitCode,
        stdout,
        stderr: filteredStderr,
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

/**
 * stderr에서 /usr/bin/time -v의 출력을 제거하고 실제 프로그램의 stderr만 반환
 */
function filterTimeOutput(stderr) {
  if (!stderr) return '';
  
  const lines = stderr.split('\n');
  const filtered = [];
  let inTimeOutput = false;
  
  for (const line of lines) {
    // time 명령어 출력 시작 패턴
    if (line.includes('Command being timed:')) {
      inTimeOutput = true;
      continue;
    }
    
    // time 명령어 출력 종료 패턴 (Exit status 이후)
    if (inTimeOutput && (line.includes('Exit status:') || line.trim() === '')) {
      inTimeOutput = false;
      continue;
    }
    
    // time 명령어 출력 중이 아니면 유지
    if (!inTimeOutput) {
      filtered.push(line);
    }
  }
  
  return filtered.join('\n').trim();
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
