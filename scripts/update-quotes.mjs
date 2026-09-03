// scripts/update-quotes.mjs
//
// index.html 안의 <script id="live-data" type="application/json"> 블록을
// 네이버증권 공개(비공식) API로 갱신한다. 이 파일은 실시간 시세(지수/환율/
// 원자재/금리) "숫자"만 건드리고, 시황 코멘트·뉴스·포트폴리오 같은 "글" 부분은
// 전혀 건드리지 않는다 — 그건 이 워크플로우의 책임 범위가 아니다.
//
// 설계 원칙: 어떤 항목의 파싱이 실패해도 절대 화면을 깨뜨리지 않는다.
// 파싱에 성공한 필드만 새 값으로 덮어쓰고, 실패한 필드는 기존 값을 그대로
// 유지한다. 모든 원본 응답은 콘솔에 로그로 남겨서, 나중에 매핑이 틀렸을 때
// Actions 로그만 보고 바로 고칠 수 있게 한다.
//
// 데이터 출처: stock.naver.com의 비공식 공개 API. 로그인/인증 없이 접근
// 가능한 공개 시세 화면과 동일한 데이터이며, 네이버의 공식 지원 대상은 아니다.
// 경로나 필드가 예고 없이 바뀔 수 있다.

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'index.html';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Referer: 'https://stock.naver.com/',
  Accept: 'application/json, text/plain, */*',
};

function log(label, data) {
  console.log(`\n--- ${label} ---`);
  try {
    console.log(JSON.stringify(data));
  } catch {
    console.log(String(data));
  }
}

async function getJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

// obj 안에서 candidates 목록의 키를 순서대로 찾아 첫 번째로 존재하는 값을 반환
function pick(obj, candidates) {
  if (!obj) return undefined;
  for (const k of candidates) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

// 배열에서 이름/코드에 특정 문자열이 들어간 항목을 찾는다 (대소문자 무시)
function findByName(list, needles) {
  if (!Array.isArray(list)) return undefined;
  const lowered = needles.map((n) => n.toLowerCase());
  return list.find((item) => {
    const name = String(
      pick(item, ['name', 'itemName', 'reutersCode', 'localTradedName', 'symbolName']) || ''
    ).toLowerCase();
    const code = String(pick(item, ['reutersCode', 'code', 'symbolCode']) || '').toLowerCase();
    return lowered.some((n) => name.includes(n) || code.includes(n));
  });
}

// ---------- 1) 코스피/코스닥 지수 ----------
async function fetchIndices(current) {
  const out = { ...current };
  try {
    const json = await getJSON(
      'https://stock.naver.com/api/polling/domestic/index?itemCodes=KOSPI,KOSDAQ'
    );
    log('indices raw', json);
    const rows = json?.datas || json?.data || json;
    for (const code of ['KOSPI', 'KOSDAQ']) {
      const row = Array.isArray(rows)
        ? rows.find((r) => String(pick(r, ['itemCode', 'code']) || '').toUpperCase() === code)
        : undefined;
      if (!row) continue;
      const v = toNum(pick(row, ['closePrice', 'nowValue', 'now', 'tradePrice']));
      const chg = toNum(pick(row, ['compareToPreviousClosePrice', 'compareValue', 'changeValue']));
      const pct = toNum(pick(row, ['fluctuationsRatio', 'changeRate', 'rate']));
      const open = toNum(pick(row, ['openPrice', 'open']));
      const high = toNum(pick(row, ['highPrice', 'high']));
      const low = toNum(pick(row, ['lowPrice', 'low']));
      const prev = toNum(pick(row, ['previousClose', 'prevClosePrice', 'basePrice']));
      out.indices = out.indices || {};
      out.indices[code] = {
        ...(out.indices[code] || {}),
        ...(v != null ? { v } : {}),
        ...(chg != null ? { chg } : {}),
        ...(pct != null ? { pct } : {}),
        ...(open != null ? { open } : {}),
        ...(high != null ? { high } : {}),
        ...(low != null ? { low } : {}),
        ...(prev != null ? { prev } : {}),
      };
    }
  } catch (e) {
    console.error('[indices] 실패, 기존 값 유지:', e.message);
  }
  return out;
}

// ---------- 2) 원/달러 환율 ----------
async function fetchUsdKrw(current) {
  const out = current.map((q) => ({ ...q }));
  try {
    const json = await getJSON(
      'https://stock.naver.com/api/stockDomestic/exchangeRates/list?currencies=USD'
    );
    log('usdkrw raw', json);
    const list = json?.rates || json?.data || json;
    const row = Array.isArray(list)
      ? list.find((r) =>
          String(pick(r, ['currency', 'currencyCode', 'code']) || '')
            .toUpperCase()
            .includes('USD')
        )
      : undefined;
    const v = toNum(pick(row, ['value', 'dealBasR', 'basePrice', 'rate', 'price']));
    const pct = toNum(pick(row, ['fluctuationsRatio', 'changeRate', 'rate']));
    if (v != null) {
      const idx = out.findIndex((q) => q.k === 'usdkrw');
      if (idx >= 0) {
        out[idx] = { ...out[idx], v, ...(pct != null ? { pct } : {}) };
      }
    }
  } catch (e) {
    console.error('[usdkrw] 실패, 기존 값 유지:', e.message);
  }
  return out;
}

// ---------- 3) 원자재: WTI / 브렌트 / 금 ----------
async function fetchCommodities(current) {
  const out = current.map((q) => ({ ...q }));
  function apply(key, item) {
    if (!item) return;
    const v = toNum(pick(item, ['closePrice', 'value', 'price', 'nowValue']));
    const pct = toNum(pick(item, ['fluctuationsRatio', 'changeRate', 'rate']));
    if (v == null) return;
    const idx = out.findIndex((q) => q.k === key);
    if (idx >= 0) out[idx] = { ...out[idx], v, ...(pct != null ? { pct } : {}) };
  }
  try {
    const energy = await getJSON('https://stock.naver.com/api/securityService/marketindex/energy');
    log('energy raw', energy);
    const list = energy?.datas || energy?.data || energy;
    apply('wti', findByName(list, ['wti', 'cl']));
    apply('brent', findByName(list, ['brent', '브렌트', 'lco']));
  } catch (e) {
    console.error('[energy] 실패, 기존 값 유지:', e.message);
  }
  try {
    const metals = await getJSON('https://stock.naver.com/api/securityService/marketindex/metals');
    log('metals raw', metals);
    const list = metals?.datas || metals?.data || metals;
    apply('gold', findByName(list, ['금', 'gold', 'gc']));
  } catch (e) {
    console.error('[metals] 실패, 기존 값 유지:', e.message);
  }
  return out;
}

// ---------- 4) 미 국채 10년/30년물 (best-effort) ----------
async function fetchBonds(current) {
  const out = current.map((q) => ({ ...q }));
  function apply(key, item) {
    if (!item) return;
    const v = toNum(pick(item, ['closePrice', 'value', 'price', 'yield', 'nowValue']));
    const pct = toNum(pick(item, ['fluctuationsRatio', 'changeRate', 'rate']));
    if (v == null) return;
    const idx = out.findIndex((q) => q.k === key);
    if (idx >= 0) out[idx] = { ...out[idx], v, ...(pct != null ? { pct } : {}) };
  }
  try {
    const bond = await getJSON(
      'https://stock.naver.com/api/securityService/marketindex/bond/nation/USA'
    );
    log('bond raw', bond);
    const list = bond?.datas || bond?.data || bond;
    apply('ust10', findByName(list, ['10년', '10-year', '10y']));
    apply('ust30', findByName(list, ['30년', '30-year', '30y']));
  } catch (e) {
    console.error('[bond] 실패(미 국채 필드는 소스가 불안정할 수 있음), 기존 값 유지:', e.message);
  }
  return out;
}

// ---------- 장중 여부 판단 ----------
function marketStatusKST() {
  const now = new Date(Date.now() + 9 * 3600 * 1000); // KST
  const dow = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const stamp = `${y}.${m}.${d} ${hh}:${mm}`;
  let session = '장마감';
  if (dow >= 1 && dow <= 5) {
    if (mins < 9 * 60) session = '장전';
    else if (mins <= 15 * 60 + 30) session = '장중';
    else session = '장마감';
  } else {
    session = '휴장';
  }
  return { stamp, session };
}

async function main() {
  const html = readFileSync(FILE, 'utf8');
  const match = html.match(
    /(<script id="live-data" type="application\/json">\n?)([\s\S]*?)(\n?<\/script>)/
  );
  if (!match) {
    console.error('live-data 블록을 찾지 못했습니다. index.html 구조가 바뀌었는지 확인하세요.');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(match[2]);
  } catch (e) {
    console.error('live-data 블록 JSON 파싱 실패:', e.message);
    process.exit(1);
  }

  data = await fetchIndices(data);
  data.quotes = await fetchUsdKrw(data.quotes || []);
  data.quotes = await fetchCommodities(data.quotes || []);
  data.quotes = await fetchBonds(data.quotes || []);

  const { stamp, session } = marketStatusKST();
  data.updated = stamp;
  data.session = session;

  const newBlock = match[1] + JSON.stringify(data, null, 2) + match[3];
  const newHtml = html.slice(0, match.index) + newBlock + html.slice(match.index + match[0].length);

  writeFileSync(FILE, newHtml, 'utf8');
  console.log(`\n갱신 완료: ${stamp} (${session})`);
}

main().catch((e) => {
  console.error('update-quotes 실행 중 예외:', e);
  process.exit(1);
});
