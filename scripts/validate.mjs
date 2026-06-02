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
 *
 * 사용:
 *   node scripts/validate.mjs           # 전체 (CI / pre-push)
 *   node scripts/validate.mjs --static  # 스모크 제외 (빠른 로컬 점검)
 *   node scripts/validate.mjs --smoke   # 스모크만
 */

import { execSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import http from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_JS = join(ROOT, 'public', 'js');

const args = process.argv.slice(2);
const ONLY_STATIC = args.includes('--static');
const ONLY_SMOKE = args.includes('--smoke');
const ONLY_REFS = args.includes('--refs-only'); // self-test 용 (빌드/스모크 생략)

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};
const log = (m) => process.stdout.write(m + '\n');
const ok = (m) => log(`${C.green}✓${C.reset} ${m}`);
const fail = (m) => log(`${C.red}✗ ${m}${C.reset}`);
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

async function serverSmoke() {
  head('4. 서버 부팅 스모크 (임시 포트 GET /login 200)');
  const PORT = 4099;
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
// main
// ---------------------------------------------------------------------------
(async () => {
  log(`${C.bold}claudito 서버 안전 검증 게이트${C.reset}`);

  if (ONLY_REFS) {
    frontendRefs();
  } else if (ONLY_SMOKE) {
    await serverSmoke();
  } else if (ONLY_STATIC) {
    backendBuild();
    frontendSyntax();
    frontendRefs();
  } else {
    backendBuild();
    frontendSyntax();
    frontendRefs();
    if (!failures.includes('backend-build')) await serverSmoke();
    else log(`\n${C.yellow}⚠ 백엔드 빌드 실패로 스모크 테스트 생략${C.reset}`);
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
