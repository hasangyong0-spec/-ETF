/**
 * 시세 자동 갱신 스크립트
 * ------------------------------------------------------------------
 * index.html 안의 <script id="live-data"> JSON 블록만 새 값으로 바꿔 쓴다.
 * 코멘트·뉴스·ETF 포트폴리오 등 서술형 내용은 절대 건드리지 않는다.
 *
 * 실행: node scripts/update-quotes.mjs
 * 의존성 없음 (Node 18+ 내장 fetch 사용)
 *
 * 설계 원칙
 *  1) 실패에 관대하다 — 한 항목을 못 가져오면 기존 값을 그대로 남긴다.
 *  2) 지수 두 개를 모두 못 가져오면 파일을 쓰지 않는다 (빈 대시보드 방지).
 *  3) 모든 단계의 성공/실패를 로그로 남긴다 → Actions 로그에서 원인 확인.
 *
 * 엔드포인트가 막히면 아래 SOURCES 상수만 고치면 된다.
 */

import { readFile, writeFile } from 'node:fs/promises';

const FILE = 'index.html';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const log = (...a) => console.log(...a);
const warn = (...a) => console.log('  [건너뜀]', ...a);

/* ── 공통 fetch ─────────────────────────────────────────────── */
async function get(url, { json = true, referer = 'https://m.stock.naver.com/' } = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': json ? 'application/json, text/plain, */*' : 'text/html,*/*',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': referer,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return json ? res.json() : res.text();
}

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[,%\s+]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* ── 1. 코스피 / 코스닥 지수 ────────────────────────────────── */
async function fetchIndex(code) {
  const d = await get(`https://m.stock.naver.com/api/index/${code}/basic`);
  const v = num(d.closePrice);
  if (v === null) throw new Error('closePrice 없음');
  const chg = num(d.compareToPreviousClosePrice);
  const pct = num(d.fluctuationsRatio);
  return {
    v,
    chg,
    pct,
    open: num(d.openPrice),
    high: num(d.highPrice),
    low: num(d.lowPrice),
    prev: chg !== null ? Number((v - chg).toFixed(2)) : null,
  };
}

/* ── 2. 환율·원자재·금리·변동성 ─────────────────────────────── */
/** 네이버 시장지표 → 실패 시 stooq CSV 대체 */
const SOURCES = {
  usdkrw: { naver: 'FX_USDKRW',    stooq: 'usdkrw' },
  wti:    { naver: 'OIL_CL',       stooq: 'cl.f'   },
  brent:  { naver: 'OIL_LO',       stooq: 'cb.f'   },
  ust10:  { naver: null,           stooq: '10usy.b' },
  ust30:  { naver: null,           stooq: '30usy.b' },
  gold:   { naver: 'CMDT_GC',      stooq: 'gc.f'   },
  vix:    { naver: null,           stooq: '^vix'   },
};

async function fromNaver(key) {
  const id = SOURCES[key].naver;
  if (!id) throw new Error('네이버 코드 없음');
  const d = await get(`https://m.stock.naver.com/api/marketindex/${id}/basic`);
  const v = num(d.closePrice ?? d.value);
  if (v === null) throw new Error('값 없음');
  return { v, pct: num(d.fluctuationsRatio), chg: num(d.compareToPreviousClosePrice) };
}

async function fromStooq(key) {
  const sym = SOURCES[key].stooq;
  if (!sym) throw new Error('stooq 코드 없음');
  const csv = await get(
    `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`,
    { json: false, referer: 'https://stooq.com/' }
  );
  const rows = csv.trim().split('\n');
  if (rows.length < 2) throw new Error('CSV 비어 있음');
  const head = rows[0].split(',').map((s) => s.trim().toLowerCase());
  const cells = rows[1].split(',').map((s) => s.trim());
  const pick = (name) => cells[head.indexOf(name)];
  const close = num(pick('close'));
  const open = num(pick('open'));
  if (close === null) throw new Error('close 없음');
  // stooq 무료 CSV 에는 전일 대비가 없다 → 시가 대비로 근사하고 표기에서 구분한다.
  const pct = open ? Number((((close - open) / open) * 100).toFixed(2)) : null;
  return { v: close, pct, chg: open ? Number((close - open).toFixed(2)) : null, approx: true };
}

async function fetchQuote(key) {
  for (const [label, fn] of [['naver', fromNaver], ['stooq', fromStooq]]) {
    try {
      const q = await fn(key);
      log(`  ${key}: ${q.v} (${label}${q.approx ? ', 시가대비' : ''})`);
      return q;
    } catch (e) {
      // 다음 소스로
    }
  }
  warn(`${key} — 모든 소스 실패`);
  return null;
}

/* ── 3. 업종별 등락률 ───────────────────────────────────────── */
async function fetchSectors() {
  const html = await get('https://finance.naver.com/sise/sise_group.naver?type=upjong', {
    json: false,
    referer: 'https://finance.naver.com/',
  });
  const rows = [...html.matchAll(
    /sise_group_detail\.naver\?type=upjong[^>]*>([^<]+)<\/a>[\s\S]{0,400}?<span[^>]*>\s*([+-]?[\d.]+)\s*%/g
  )];
  const list = rows
    .map((m) => ({ name: m[1].trim(), pct: num(m[2]) }))
    .filter((s) => s.name && s.pct !== null);
  if (list.length < 5) throw new Error(`업종 파싱 실패 (${list.length}건)`);
  list.sort((a, b) => b.pct - a.pct);
  // 상승 상위 2 + 하락 하위 4
  const top = list.slice(0, 2);
  const bottom = list.slice(-4);
  return [...top, ...bottom];
}

/* ── 4. 투자자별 수급 (코스피) ──────────────────────────────── */
async function fetchFlows() {
  const html = await get('https://finance.naver.com/sise/investorDealTrendDay.naver?bizdate=', {
    json: false,
    referer: 'https://finance.naver.com/',
  });
  // 첫 데이터 행: 날짜 | 개인 | 외국인 | 기관계 ... (단위: 백만원)
  const row = html.match(/<tr[^>]*>\s*<td[^>]*>\s*[\d.]{8,10}\s*<\/td>([\s\S]*?)<\/tr>/);
  if (!row) throw new Error('수급 행 없음');
  const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
    .map((m) => num(m[1].replace(/<[^>]+>/g, '')));
  const [indi, foreign, inst] = cells;
  if ([indi, foreign, inst].some((x) => x === null)) throw new Error('수급 값 파싱 실패');
  // 백만원 → 억원
  const toEok = (x) => Math.round(x / 100);
  return { indi: toEok(indi), foreign: toEok(foreign), inst: toEok(inst), unit: '억원' };
}

/* ── 5. 특징 종목 등락률 (종목명 → 코드 해석 후 조회) ────────── */
const codeCache = new Map();

async function resolveCode(name) {
  if (codeCache.has(name)) return codeCache.get(name);
  const d = await get(
    `https://m.stock.naver.com/api/search/all?query=${encodeURIComponent(name)}&target=stock`
  );
  const hit = (d?.stocks?.result ?? d?.result?.stocks ?? d?.stocks ?? [])[0];
  const code = hit?.reutersCode?.replace(/^A/, '') ?? hit?.itemCode ?? hit?.code;
  if (!code) throw new Error('코드 해석 실패');
  codeCache.set(name, code);
  return code;
}

async function fetchStockPct(name) {
  const code = await resolveCode(name);
  const d = await get(`https://m.stock.naver.com/api/stock/${code}/basic`);
  const pct = num(d.fluctuationsRatio);
  if (pct === null) throw new Error('등락률 없음');
  return pct;
}

/* ── KST 시간 유틸 ──────────────────────────────────────────── */
function kstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return {
    date: d,
    hhmm: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: d.getUTCDay(), // 0 일 … 6 토
    stamp: `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`,
  };
}

function sessionLabel(m) {
  if (m < 9 * 60) return '장 시작 전';
  if (m <= 15 * 60 + 30) return '장중';
  return '장 마감';
}

/* ── 메인 ───────────────────────────────────────────────────── */
const t = kstNow();
log(`▶ 실행 시각 ${t.stamp} ${t.hhmm} KST (${sessionLabel(t.minutes)})`);

if (t.dow === 0 || t.dow === 6) {
  log('주말이므로 갱신하지 않습니다.');
  process.exit(0);
}
if (t.minutes < 8 * 60 + 40 || t.minutes > 15 * 60 + 50) {
  log('장 시간대(08:40~15:50 KST)가 아니므로 갱신하지 않습니다.');
  process.exit(0);
}

const html = await readFile(FILE, 'utf8');
const block = html.match(
  /(<script id="live-data" type="application\/json">)([\s\S]*?)(<\/script>)/
);
if (!block) {
  console.error('오류: index.html 에서 <script id="live-data"> 블록을 찾지 못했습니다.');
  process.exit(1);
}

const data = JSON.parse(block[2]);
let indexOk = 0;

log('· 지수');
for (const code of ['KOSPI', 'KOSDAQ']) {
  try {
    data.indices[code] = await fetchIndex(code);
    log(`  ${code}: ${data.indices[code].v} (${data.indices[code].pct}%)`);
    indexOk++;
  } catch (e) {
    warn(`${code} — ${e.message}`);
  }
}

log('· 환율·원자재·금리');
for (const q of data.quotes) {
  const got = await fetchQuote(q.k);
  if (got) {
    q.v = got.v;
    if (got.pct !== null) q.pct = got.pct;
    q.approx = !!got.approx;
  }
}

log('· 업종');
try {
  data.sectors = await fetchSectors();
  log(`  ${data.sectors.length}건: ` + data.sectors.map((s) => `${s.name} ${s.pct}%`).join(', '));
} catch (e) {
  warn(`업종 — ${e.message}`);
}

log('· 수급');
try {
  data.flows = await fetchFlows();
  log(`  개인 ${data.flows.indi} / 외국인 ${data.flows.foreign} / 기관 ${data.flows.inst} (억원)`);
} catch (e) {
  warn(`수급 — ${e.message}`);
}

log('· 특징 종목');
for (const name of Object.keys(data.movers)) {
  try {
    data.movers[name] = await fetchStockPct(name);
    log(`  ${name}: ${data.movers[name]}%`);
  } catch (e) {
    warn(`${name} — ${e.message}`);
  }
}

if (indexOk === 0) {
  console.error('오류: 코스피·코스닥을 모두 가져오지 못했습니다. 파일을 수정하지 않고 종료합니다.');
  process.exit(1);
}

data.updated = `${t.stamp} ${t.hhmm}`;
data.session = sessionLabel(t.minutes);

const next = html.replace(
  block[0],
  `${block[1]}\n${JSON.stringify(data, null, 2)}\n${block[3]}`
);

if (next === html) {
  log('변경 사항이 없습니다.');
  process.exit(0);
}

await writeFile(FILE, next);
log(`✔ ${FILE} 갱신 완료 — 기준 ${data.updated} KST`);
