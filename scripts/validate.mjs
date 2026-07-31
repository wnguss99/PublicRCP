#!/usr/bin/env node
/**
 * claudito 서버 안전 검증 게이트
 * --------------------------------------------------------------------------
 * 목적: "서버가 정상 작동 안 할 여지가 있는 변경"을 배포/푸시 전에 자동 차단한다.
 *
 * 이 게이트는 2026-06-02 사고(프론트 ReferenceError 3건 + 백엔드 CLI hang)를
 * 재발시키지 않기 위해 만들어졌다. 검증 단계:
 *
 *   1. backend-build   : 백엔드 TypeScript strict 빌드 (dist 생성)
 *   2. frontend-syntax : public/js 전체 JS 문법 파싱 (node --check)
 *   3. frontend-refs   : checkJs 로 ReferenceError 후보(TS2304/TS2552) 검출.
 *                        단, 다른 파일에서 root/window 로 등록된 "진짜 전역"은
 *                        자동 수집해 화이트리스트 처리 → false positive 제거.
 *                        isTouchDevice / openModal 처럼 "주입받아야 하는데
 *                        함수 스코프에 없는" 변수는 화이트리스트에 안 잡혀서
 *                        앞으로도 계속 걸러진다.
 *   4. server-smoke    : 빌드된 dist 를 임시 포트로 실제 부팅해 GET /login 200 확인.
 *                        서버가 안 뜨면(=시스템 사용 불가) 무조건 FAIL.
 *   5. unit-tests      : --with-tests 일 때만. 전체 Jest 스위트(약 40초).
 *                        pre-push 전용이고 재시작 경로에는 일부러 안 넣는다 —
 *                        테스트 한 건이 흔들렸다고 장애 복구가 막히면 안 된다.
 *
 * 사용:
 *   node scripts/validate.mjs              # 전체 (재시작 게이트)
 *   node scripts/validate.mjs --with-tests # 전체 + 유닛 테스트 (pre-push)
 *   node scripts/validate.mjs --static     # 스모크 제외 (빠른 로컬 점검)
 *   node scripts/validate.mjs --smoke      # 스모크만
 */

import { execSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import http from 'node:http';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_JS = join(ROOT, 'public', 'js');

const args = process.argv.slice(2);
const ONLY_STATIC = args.includes('--static');
const ONLY_SMOKE = args.includes('--smoke');
const ONLY_REFS = args.includes('--refs-only'); // self-test 용 (빌드/스모크 생략)
const ONLY_INSTANCES = args.includes('--instances'); // pre-commit 용 (빌드 없이 구성만)
const WITH_TESTS = args.includes('--with-tests');    // pre-push 용 (유닛 테스트 포함)

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};
const log = (m) => process.stdout.write(m + '\n');
const ok = (m) => log(`${C.green}✓${C.reset} ${m}`);
const fail = (m) => log(`${C.red}✗ ${m}${C.reset}`);
const warn = (m) => log(`${C.yellow}⚠ ${m}${C.reset}`);
const head = (m) => log(`\n${C.bold}${C.cyan}── ${m}${C.reset}`);

const failures = [];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function walkJs(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'vendor' || name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkJs(p, acc);
    else if (name.endsWith('.js') && !name.endsWith('.test.js') && !name.endsWith('.spec.js')) acc.push(p);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// 0. 멀티 인스턴스 구성 (ecosystem.config.js)
// ---------------------------------------------------------------------------
// 2026-07-30 사고 재발 방지. 당시 실제로 터진 것들:
//   - 4000번(기존 사용자) CLAUDITO_HOME 이 새 경로로 바뀌어 프로젝트 5개가 사라짐
//   - 평문 비밀번호가 든 ecosystem.config.js 가 git 에 추적된 상태였음
// 포트/홈 중복, name 규칙 위반도 조용히 인스턴스를 하나 죽이므로 같이 막는다.
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function instanceConfig() {
  head('0. 멀티 인스턴스 구성 검증');

  const legacyHome = join(homedir(), '.claudito');
  const legacyIndex = join(legacyHome, 'projects', 'index.json');
  const legacyInstallExists = existsSync(legacyIndex);

  const targets = [
    { file: 'ecosystem.config.example.js', required: true, secretsAllowed: false },
    { file: 'ecosystem.config.js', required: false, secretsAllowed: true },
  ];

  let checked = 0;

  for (const target of targets) {
    const configPath = join(ROOT, target.file);

    if (!existsSync(configPath)) {
      if (target.required) {
        fail(`${target.file} 이 없다 (멀티 인스턴스 구성의 기준 파일)`);
        failures.push('instance-config');
      }
      continue;
    }

    let apps;

    try {
      // require 로 읽어야 path.join / os.homedir 같은 실제 계산 결과를 검증할 수 있다.
      const loaded = createRequire(import.meta.url)(configPath);
      apps = loaded?.apps;
    } catch (e) {
      fail(`${target.file} 로드 실패: ${e.message}`);
      failures.push('instance-config');
      continue;
    }

    if (!Array.isArray(apps) || apps.length === 0) {
      fail(`${target.file}: apps 배열이 비어 있다`);
      failures.push('instance-config');
      continue;
    }

    const ports = new Set();
    const homes = new Set();
    let legacyClaims = 0;

    for (const app of apps) {
      const env = app?.env || {};
      const label = `${target.file} → ${app?.name ?? '(name 없음)'}`;

      if (!env.PORT) {
        fail(`${label}: env.PORT 가 없다`);
        failures.push('instance-config');
        continue;
      }

      // PM2 는 env 값을 문자열로 넘긴다. 숫자를 넣으면 비교 로직에서 어긋난다.
      if (typeof env.PORT !== 'string') {
        fail(`${label}: env.PORT 는 문자열이어야 한다 (현재 ${typeof env.PORT})`);
        failures.push('instance-config');
      }

      if (app.name !== `claudito-${env.PORT}`) {
        fail(`${label}: name 은 claudito-${env.PORT} 여야 한다 (pm2 로그/조작 시 포트 식별 불가)`);
        failures.push('instance-config');
      }

      if (ports.has(String(env.PORT))) {
        fail(`${label}: PORT ${env.PORT} 중복 — 뒤에 뜬 인스턴스가 EADDRINUSE 로 죽는다`);
        failures.push('instance-config');
      }
      ports.add(String(env.PORT));

      if (!env.CLAUDITO_HOME) {
        fail(`${label}: env.CLAUDITO_HOME 가 없다 — 인스턴스끼리 데이터를 공유해 버린다`);
        failures.push('instance-config');
        continue;
      }

      if (!isAbsolute(env.CLAUDITO_HOME)) {
        fail(`${label}: CLAUDITO_HOME 가 절대경로가 아니다 (${env.CLAUDITO_HOME})`);
        failures.push('instance-config');
      }

      // 저장소 안에 두면 gitignore 되어 있어도 `git clean -xdf` 한 번에 사용자 데이터가 날아간다.
      if (isInside(ROOT, env.CLAUDITO_HOME)) {
        fail(`${label}: CLAUDITO_HOME 가 저장소 안이다 (${env.CLAUDITO_HOME}) — git clean 으로 사용자 데이터가 지워진다`);
        failures.push('instance-config');
      }

      const homeKey = env.CLAUDITO_HOME.toLowerCase();

      if (homes.has(homeKey)) {
        fail(`${label}: CLAUDITO_HOME 중복 (${env.CLAUDITO_HOME}) — 두 사용자가 같은 데이터를 덮어쓴다`);
        failures.push('instance-config');
      }
      homes.add(homeKey);

      if (homeKey === legacyHome.toLowerCase()) {
        legacyClaims++;
      }

      const weak = /change[_ ]?me/i;

      if (target.secretsAllowed && typeof env.CLAUDITO_PASSWORD === 'string' && weak.test(env.CLAUDITO_PASSWORD)) {
        fail(`${label}: 비밀번호가 아직 placeholder(${env.CLAUDITO_PASSWORD}) 다 — 실제 값으로 바꿔라`);
        failures.push('instance-config');
      }
    }

    // 기존 단일 인스턴스 설치가 있으면, 정확히 하나의 인스턴스가 그 홈을 이어받아야 한다.
    // 아무도 안 잡으면 그 사용자의 프로젝트 목록이 통째로 빈 화면이 된다.
    if (legacyInstallExists && legacyClaims !== 1) {
      fail(
        `${target.file}: ~/.claudito (기존 설치) 를 잡는 인스턴스가 ${legacyClaims}개 — ` +
        '정확히 1개여야 한다. 0개면 기존 사용자의 프로젝트가 사라진다.'
      );
      failures.push('instance-config');
    }

    checked++;
  }

  // 평문 비밀번호 파일이 git 에 추적되면 안 된다.
  try {
    const tracked = execSync('git ls-files ecosystem.config.js .env', { cwd: ROOT, stdio: 'pipe' })
      .toString()
      .trim();

    if (tracked) {
      fail(`비밀정보 파일이 git 에 추적 중이다: ${tracked.split('\n').join(', ')} → git rm --cached 하라`);
      failures.push('instance-config');
    }
  } catch {
    // git 이 없는 환경(배포 서버 등)에서는 건너뛴다.
  }

  if (checked > 0 && !failures.includes('instance-config')) {
    ok(`인스턴스 구성 통과 (검사 파일 ${checked}개)`);
  }
}

// ---------------------------------------------------------------------------
// 0b. Claude 인증 환경 (2026-07-30 "Invalid API key" 사고 재발방지)
// ---------------------------------------------------------------------------
// 사고 요약: 사용자 환경변수에 ANTHROPIC_API_KEY=sk-ant-... (문서 placeholder)
// 가 들어 있었다. Claude CLI 는 이 변수를 claude.ai 구독보다 우선하므로 모든
// 대화가 "Invalid API key · Fix external API key" 로 실패했다. 게다가 코드의
// 방어 로직(env 에서 삭제)이 defaultSpawner 의 `{...process.env, ...options.env}`
// 재병합에 의해 무력화되어 있었다 — 삭제한 변수가 되살아났다.
function claudeAuthEnv() {
  head('0b. Claude 인증 환경 검증');

  // (1) 지금 이 환경에 못 쓰는 키가 있는지
  const key = process.env.ANTHROPIC_API_KEY;

  if (key !== undefined) {
    const trimmed = key.trim();
    const unusable = trimmed === '' || !trimmed.startsWith('sk-') || trimmed.length < 40;

    if (unusable) {
      // 경고로만 둔다(배포 차단 X): 아래 두 정적 가드가 살아 있으면 코드가 이 값을
      // 스폰 env 에서 제거하므로 대화는 정상 동작한다. 다만 환경 자체는 고쳐야
      // 하므로 눈에 띄게 남긴다. 이 값을 쓰는 다른 도구는 여전히 깨진다.
      warn(
        `ANTHROPIC_API_KEY 가 사용 불가한 값이다 (길이 ${trimmed.length}). ` +
        'claudito 는 이 값을 무시하지만 환경을 정리하라.'
      );
      log(`${C.dim}  정리: Remove-ItemProperty HKCU:\\Environment -Name ANTHROPIC_API_KEY  (그 후 PM2 데몬 재시작)${C.reset}`);
    } else {
      ok('ANTHROPIC_API_KEY 가 설정돼 있고 형식은 유효하다');
    }
  } else {
    ok('ANTHROPIC_API_KEY 미설정 (구독 인증 사용 — 권장 상태)');
  }

  // (2) 스포너가 sanitize 된 env 를 되살리지 않는지 (정적 가드)
  const spawnerPath = join(ROOT, 'src', 'agents', 'process-manager.ts');
  const spawnerSrc = readFileSync(spawnerPath, 'utf-8');

  if (/\.\.\.process\.env\s*,\s*\.\.\.options\.env/.test(spawnerSrc)) {
    fail(
      'defaultSpawner 가 `{...process.env, ...options.env}` 로 병합한다 — ' +
      'env 에서 삭제한 ANTHROPIC_API_KEY/CLAUDECODE 가 되살아나 방어 로직이 무효화된다.'
    );
    failures.push('claude-auth-env');
  } else {
    ok('스포너가 sanitize 된 env 를 보존한다');
  }

  // (3) 방어 로직이 실제로 호출되는지 (정적 가드)
  const builderSrc = readFileSync(join(ROOT, 'src', 'agents', 'message-builder.ts'), 'utf-8');

  if (!/dropUnusableApiKey\s*\(/.test(builderSrc) || !/describeUnusableApiKey/.test(builderSrc)) {
    fail('MessageBuilder.buildEnvironment 의 ANTHROPIC_API_KEY 방어 로직이 사라졌다.');
    failures.push('claude-auth-env');
  } else {
    ok('buildEnvironment 에 ANTHROPIC_API_KEY 방어 로직이 있다');
  }
}

// ---------------------------------------------------------------------------
// 1. backend build
// ---------------------------------------------------------------------------
function backendBuild() {
  head('1. 백엔드 TypeScript 빌드 (strict)');
  try {
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
    ok('백엔드 빌드 통과');
  } catch (e) {
    fail('백엔드 빌드 실패');
    log(C.dim + (e.stdout?.toString() || e.message).split('\n').slice(-25).join('\n') + C.reset);
    failures.push('backend-build');
  }
}

// ---------------------------------------------------------------------------
// 2. frontend syntax
// ---------------------------------------------------------------------------
function frontendSyntax() {
  head('2. 프론트엔드 JS 문법 검사 (node --check)');
  const files = walkJs(PUBLIC_JS);
  let bad = 0;
  for (const f of files) {
    try {
      execSync(`node --check "${f}"`, { stdio: 'pipe' });
    } catch (e) {
      bad++;
      fail(`문법 오류: ${relative(ROOT, f)}`);
      log(C.dim + (e.stderr?.toString() || e.message).split('\n').slice(0, 4).join('\n') + C.reset);
    }
  }
  if (bad === 0) ok(`${files.length}개 JS 파일 문법 정상`);
  else failures.push('frontend-syntax');
}

// ---------------------------------------------------------------------------
// 3. frontend reference check (ReferenceError 후보)
// ---------------------------------------------------------------------------
// 표준 브라우저/JS 전역 + 알려진 외부 라이브러리 전역
const BUILTIN_GLOBALS = new Set([
  'window', 'document', 'console', 'navigator', 'location', 'history', 'screen',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'FormData', 'Blob', 'File', 'FileReader',
  'URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'AbortController',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'localStorage', 'sessionStorage', 'alert', 'confirm', 'prompt',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'CustomEvent', 'Event',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'getComputedStyle',
  'matchMedia', 'btoa', 'atob', 'structuredClone', 'queueMicrotask', 'crypto',
  'performance', 'self', 'globalThis', 'global', 'module', 'exports', 'require', 'process',
  'TextEncoder', 'TextDecoder', 'Image', 'Audio', 'Notification', 'onerror',
  'onunhandledrejection', 'onload', 'onbeforeunload',
  // 외부 라이브러리 (CDN/vendor 전역)
  '$', 'jQuery', 'mermaid', 'hljs', 'Prism', 'marked', 'DOMPurify', 'io', 'bootstrap',
  'Terminal', 'FitAddon', 'WebLinksAddon', 'QRCode',
]);

function collectRegisteredGlobals() {
  // 다른 파일에서 root.X = / window.X = / self.X = / globalThis.X = 로 등록되는 전역
  const files = walkJs(PUBLIC_JS);
  const re = /(?:root|window|self|globalThis)\.([A-Za-z_$][\w$]*)\s*=/g;
  const set = new Set();
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(text)) !== null) set.add(m[1]);
  }
  return set;
}

function frontendRefs() {
  head('3. 프론트엔드 ReferenceError 검출 (checkJs TS2304/TS2552)');
  let tscOut = '';
  try {
    execSync('npx tsc -p public/js/tsconfig.json', { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    tscOut = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
  }

  const registered = collectRegisteredGlobals();
  const whitelist = new Set([...BUILTIN_GLOBALS, ...registered]);

  const re = /^(.+?)\((\d+),(\d+)\): error TS(?:2304|2552): Cannot find name '([^']+)'/gm;
  const violations = [];
  let m;
  while ((m = re.exec(tscOut)) !== null) {
    const [, file, line, , name] = m;
    if (!whitelist.has(name)) violations.push({ file, line, name });
  }

  if (violations.length === 0) {
    ok(`ReferenceError 후보 0건 (전역 ${registered.size}개 자동 화이트리스트)`);
  } else {
    fail(`ReferenceError 후보 ${violations.length}건 — 런타임 크래시 위험`);
    for (const v of violations) {
      log(`  ${C.yellow}${v.file}:${v.line}${C.reset}  '${C.red}${v.name}${C.reset}' 미정의 (전역 등록 안 됨 = 주입 누락/오타 의심)`);
    }
    failures.push('frontend-refs');
  }
}

// ---------------------------------------------------------------------------
// 4. server boot smoke test
// ---------------------------------------------------------------------------
function get(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 예전에는 4099 로 고정이었다. 그 포트를 다른 것이 쓰고 있으면 스모크가 EADDRINUSE
// 로 실패하고, 게이트는 그것을 "새 코드가 안 뜬다" 로 보고해 재시작을 막는다.
// 장애도 아닌데 배포가 멈추는 셈이라 OS 에게 빈 포트를 받아 쓴다.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function serverSmoke() {
  head('4. 서버 부팅 스모크 (임시 포트 GET /login 200)');
  const PORT = await findFreePort();
  const child = spawn(process.execPath, ['-r', 'dotenv/config', 'dist/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: 'pipe',
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += d.toString()));
  child.stdout?.on('data', () => {});

  const url = `http://127.0.0.1:${PORT}/login`;
  let status = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break; // 프로세스가 죽었으면 중단
    status = await get(url, 2000);
    if (status !== null) break;
    await sleep(700);
  }

  // 자식 + 손자 프로세스까지 정리 (Windows tree kill)
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }

  if (status && status >= 200 && status < 500) {
    ok(`서버 정상 부팅 + /login 응답 ${status}`);
  } else {
    fail(`서버 부팅 실패 (응답: ${status ?? '없음/타임아웃'})`);
    if (stderr.trim()) log(C.dim + stderr.split('\n').slice(-15).join('\n') + C.reset);
    failures.push('server-smoke');
  }
}


// ---------------------------------------------------------------------------
// 4b. 모델 목록 단일 출처 검증
// ---------------------------------------------------------------------------
// 2026-07-31 발견: index.html 의 <option> 과 app.js 의 displayNames 맵에 모델
// ID 가 하드코딩돼 있어서, 백엔드 SUPPORTED_MODELS 에 Opus 5 를 추가해도
//   - 드롭다운에 안 나타나 선택 자체가 불가능했고
//   - override 없는 프로젝트는 실제로 Opus 5 로 도는데 화면은 "Sonnet 4.6" 표시
// 하는 상태였다. 프론트는 이제 /api/settings/models 로 목록을 받는다.
// 리터럴이 다시 들어오면 같은 드리프트가 재발하므로 여기서 막는다.
const MODEL_ID_RE = /claude-(?:opus|sonnet|haiku)-[0-9][\w-]*/g;

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--');
}

function modelSingleSource() {
  head('4b. 모델 목록 단일 출처 (프론트 하드코딩 금지)');

  const files = [
    ...walkJs(PUBLIC_JS),
    join(ROOT, 'public', 'index.html'),
  ].filter((f) => existsSync(f));

  const offenders = [];

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);

    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;

      const hits = line.match(MODEL_ID_RE);
      if (hits) offenders.push(`${relative(ROOT, file)}:${i + 1}  ${hits.join(', ')}`);
    });
  }

  if (offenders.length > 0) {
    fail(`프론트에 모델 ID 가 하드코딩돼 있다 (${offenders.length}곳)`);
    log(C.dim + offenders.slice(0, 15).map((o) => '    ' + o).join('\n') + C.reset);
    log(C.dim + '    → src/config/models.ts 를 유일한 출처로 두고 /api/settings/models 로 받아라.' + C.reset);
    failures.push('model-single-source');
    return;
  }

  ok('프론트에 하드코딩된 모델 ID 없음 (백엔드 config 가 유일한 출처)');
}

// ---------------------------------------------------------------------------
// 5. 유닛 테스트 (pre-push 에서만)
// ---------------------------------------------------------------------------
// 재시작 경로에는 일부러 넣지 않는다. 테스트 한 건이 흔들렸다고 장애 복구가
// 막히면 안 된다. 재시작은 "서버가 뜨는가"(스모크)로 충분하고, "코드가 옳은가"는
// 저장소로 나가기 전에 본다.
function unitTests() {
  head('5. 유닛 테스트');

  try {
    execSync('npx jest --silent', { cwd: ROOT, stdio: 'pipe' });
    ok('전체 유닛 테스트 통과');
  } catch (e) {
    fail('유닛 테스트 실패');
    const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
    const lines = out.split(/\r?\n/).filter((l) => /✕|●|Tests:|Suites:/.test(l));
    log(C.dim + lines.slice(0, 25).join('\n') + C.reset);
    failures.push('unit-tests');
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  log(`${C.bold}claudito 서버 안전 검증 게이트${C.reset}`);

  if (ONLY_INSTANCES) {
    instanceConfig();
    claudeAuthEnv();
  } else if (ONLY_REFS) {
    frontendRefs();
  } else if (ONLY_SMOKE) {
    await serverSmoke();
  } else if (ONLY_STATIC) {
    instanceConfig();
    claudeAuthEnv();
    backendBuild();
    frontendSyntax();
    frontendRefs();
    modelSingleSource();
  } else {
    instanceConfig();
    claudeAuthEnv();
    backendBuild();
    frontendSyntax();
    frontendRefs();
    modelSingleSource();

    // 빌드가 깨졌으면 dist 가 낡았거나 없으므로 스모크/테스트 결과가 무의미하다.
    if (failures.includes('backend-build')) {
      log(`\n${C.yellow}⚠ 백엔드 빌드 실패 — 스모크/유닛 테스트 생략${C.reset}`);
    } else {
      await serverSmoke();
      if (WITH_TESTS) unitTests();
    }
  }

  log('');
  if (failures.length === 0) {
    log(`${C.green}${C.bold}✓ 전체 검증 통과 — 배포/푸시 안전${C.reset}`);
    process.exit(0);
  } else {
    log(`${C.red}${C.bold}✗ 검증 실패: ${failures.join(', ')}${C.reset}`);
    log(`${C.dim}이 변경은 서버를 망가뜨릴 수 있다. 위 항목을 고친 뒤 다시 실행하라.${C.reset}`);
    process.exit(1);
  }
})();
