#!/usr/bin/env node
// promo-sync.mjs — 아리(상담봇) 프로모 이미지 자동 동기화 (설계 v2.1, 2026-07-04)
// Notion "57TB Promotions HP"(봇과 동일 쿼리) → 홈페이지 원본 다운로드 → LINE 규격 변환(p-/c-)
// → 57tb-assets push → jsDelivr purge + CDN 바이트 해시 검증. 실패/경고 시에만 LINE 알림.
// 실행: node --env-file=$HOME/.secrets/promo-sync.env scripts/promo-sync.mjs
// 매일 04:00(방콕) launchd: com.57tb.promo-sync

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ── 상수 (경로 전부 절대 — launchd PATH 빈약 대비) ──
const REPO = "/Users/dylanmacm5pro/Projects/57TB/57tb-assets";
const PROMOS = path.join(REPO, "promos");
const MANIFEST = path.join(PROMOS, "manifest.json");
const STATE_DIR = path.join(os.homedir(), ".local/state/promo-sync");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LOCK_DIR = "/tmp/promo-sync.lock";
const SIPS = "/usr/bin/sips";
const GIT = "/usr/bin/git";
// 봇 consult-chat index.ts PROMO_DB_ID와 동일 (database container ID)
const DB_ID = "31aa2fb1c15d81ac9209c4899b64de88";
const ORIGIN = "https://57tb.art/images/promotions/"; // 홈페이지 안정 원본 (p-{id8}.jpg, 실제 PNG)
const CDN = "https://cdn.jsdelivr.net/gh/DylanKwak57/57tb-assets@master/promos/";
const PURGE = "https://purge.jsdelivr.net/gh/DylanKwak57/57tb-assets@master/promos/";
const DYLAN_UID = "U1b8fafdea1124f98c7261d07f62c8b6a"; // 57TB Log봇 기준 Dylan (push only, broadcast 금지)
const BOT_VISIBLE = 4; // 봇 fetchActivePromos slice(0,4) — 손님 노출 범위
const ALERT_REPEAT_DAYS = 3; // 같은 사유 재알림 주기 (첫날 + 3일마다)

const NOTION_KEY = process.env.NOTION_API_KEY;
const LINE_TOKEN = process.env.LINE_57TB_TOKEN;

const logLines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logLines.push(line);
  console.log(line);
}

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function bangkokToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date()); // YYYY-MM-DD
}
function git(...args) { return execFileSync(GIT, args, { cwd: REPO, encoding: "utf8" }); }
function sips(...args) { return execFileSync(SIPS, args, { encoding: "utf8" }); }

// ── 상태 (repo 밖 — 알림 throttle + CDN pending. manifest는 repo 안 SHA만) ──
function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
const state = loadJson(STATE_FILE, { alerts: {}, cdnPending: {} });
function saveState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── 알림 (57TB Log봇 push → Dylan only). throttle: 첫날 + 3일마다 ──
const pendingAlerts = [];
function alert(key, message) {
  const last = state.alerts[key];
  const now = Date.now();
  if (last && now - new Date(last).getTime() < ALERT_REPEAT_DAYS * 86400_000) {
    log(`알림 억제(throttle ${key}): ${message}`);
    return;
  }
  state.alerts[key] = new Date(now).toISOString();
  pendingAlerts.push(message);
}
async function flushAlerts() {
  if (!pendingAlerts.length) return;
  const text = `[프로모 동기화]\n${pendingAlerts.join("\n")}`;
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${LINE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: DYLAN_UID, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
    });
    log(`LINE 알림 발송 status=${r.status}`);
    if (!r.ok) log(`LINE 알림 실패 body=${await r.text()}`);
  } catch (e) {
    log(`LINE 알림 예외: ${String(e)} — 로그로만 남김`);
  }
}

// ── 락 (mkdir = 원자적) ──
function acquireLock() {
  try {
    fs.mkdirSync(LOCK_DIR);
  } catch {
    // stale 판정: pid 생존 확인
    let pid = 0;
    try { pid = Number(fs.readFileSync(path.join(LOCK_DIR, "pid"), "utf8")); } catch {}
    let alive = false;
    if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch {} }
    if (alive) { log(`다른 실행 진행 중(pid ${pid}) — 종료`); process.exit(0); }
    log(`stale lock 해제(pid ${pid || "?"})`);
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    fs.mkdirSync(LOCK_DIR);
  }
  fs.writeFileSync(path.join(LOCK_DIR, "pid"), String(process.pid));
}
function releaseLock() { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); }

// ── Notion 쿼리 (봇 fetchActivePromos와 동일: Active=true + Sort Order asc + Period 유효) ──
async function fetchActivePromos() {
  const r = await fetch(`https://api.notion.com/v1/databases/${DB_ID}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${NOTION_KEY}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
    body: JSON.stringify({ filter: { property: "Active", checkbox: { equals: true } }, sorts: [{ property: "Sort Order", direction: "ascending" }] }),
  });
  if (!r.ok) throw new Error(`Notion query 실패 ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const today = bangkokToday();
  const out = [];
  for (const pg of data.results ?? []) {
    const props = pg.properties ?? {};
    const period = props["Period"]?.date;
    let upcoming = false;
    if (period) {
      // date-only 정규화(slice(0,10)) — datetime이어도 당일 포함 (봇 raw 비교보다 상위집합 = 무해 방향)
      if (period.end && today > String(period.end).slice(0, 10)) continue; // 종료분만 제외
      // 🎯 시작 전(upcoming) 프로모도 "동기화 대상"에 포함 — 이미지 선행 준비 (2026-07-04 대표님 지적:
      // 관행상 전달 27일 등록 → 봇 야간근무가 자정을 걸치므로(예 7/31 19:30~8/1 10:00) 매월 1일 00:00~04:00에
      // "봇은 노출 시작했는데 이미지 미생성" 4시간 공백 발생. 미리 생성해두면 파일만 대기 — 노출은 봇 Period가 제어(무해).
      if (period.start && today < String(period.start).slice(0, 10)) upcoming = true;
    }
    const name = (props["Name"]?.title ?? []).map((t) => t.plain_text).join("");
    const description = (props["Description"]?.rich_text ?? []).map((t) => t.plain_text).join("");
    const id8 = String(pg.id).replace(/-/g, "").slice(-8); // 봇과 동일 연산
    // Notion 첨부 원본 (signed URL, 1h 만료 — 즉시 다운로드 전제). upcoming이 홈페이지에 아직 없을 때 폴백.
    const f = (props["Image"]?.files ?? [])[0];
    const notionImageUrl = f?.file?.url ?? f?.external?.url ?? null;
    out.push({ name, id8, description, upcoming, notionImageUrl });
  }
  return out; // live+upcoming 전부 동기화 대상 (봇 노출 판단은 upcoming 플래그로 구분)
}

// ── 이미지 유효성 ──
function magicOf(buf) {
  const h = buf.subarray(0, 4).toString("hex");
  if (h.startsWith("ffd8ff")) return "jpeg";
  if (h.startsWith("89504e47")) return "png";
  return null;
}
function validateOutput(file) {
  const buf = fs.readFileSync(file);
  if (magicOf(buf) !== "jpeg") return `JPEG 아님(${magicOf(buf)})`;
  if (buf.length > 1024 * 1024) return `1MB 초과(${buf.length})`;
  const g = sips("-g", "pixelWidth", "-g", "pixelHeight", file);
  const w = Number(/pixelWidth: (\d+)/.exec(g)?.[1]), h = Number(/pixelHeight: (\d+)/.exec(g)?.[1]);
  if (!(w > 0 && h > 0 && w <= 1024 && h <= 1024)) return `해상도 규격 위반(${w}x${h})`;
  return null; // OK
}

// ── 변환: p- = 비율유지 ≤1024 JPEG / c- = ≤1024 후 1024x1024 흰패딩(왜곡·잘림 0) ──
function convert(srcFile, id8) {
  const pFile = path.join(PROMOS, `p-${id8}.jpg`);
  const cFile = path.join(PROMOS, `c-${id8}.jpg`);
  const pTmp = `${pFile}.tmp.jpg`, cTmp = `${cFile}.tmp.jpg`;
  try {
    sips("-s", "format", "jpeg", "-Z", "1024", srcFile, "--out", pTmp);
    sips("-s", "format", "jpeg", "-Z", "1024", srcFile, "--out", cTmp);
    sips("-p", "1024", "1024", "--padColor", "FFFFFF", cTmp);
    for (const [f, label] of [[pTmp, "p"], [cTmp, "c"]]) {
      const err = validateOutput(f);
      if (err) throw new Error(`${label}-${id8} 산출물 검증 실패: ${err}`);
    }
    fs.renameSync(pTmp, pFile);
    fs.renameSync(cTmp, cFile);
    return { pFile, cFile };
  } finally {
    for (const f of [pTmp, cTmp]) fs.rmSync(f, { force: true });
  }
}

// ── CDN 검증: purge 후 CDN 바이트 SHA = 로컬 SHA (200만으론 stale 못 잡음) ──
async function verifyCdn(fileName) {
  const local = fs.readFileSync(path.join(PROMOS, fileName));
  const localSha = sha256(local);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await fetch(PURGE + fileName); } catch {}
    await new Promise((res) => setTimeout(res, attempt === 1 ? 6000 : 15000));
    try {
      const r = await fetch(CDN + fileName, { cache: "no-store" });
      if (r.ok) {
        const remote = Buffer.from(await r.arrayBuffer());
        if (sha256(remote) === localSha) return true;
        log(`CDN 불일치(${fileName}) attempt ${attempt}`);
      } else {
        log(`CDN ${r.status}(${fileName}) attempt ${attempt}`);
      }
    } catch (e) { log(`CDN 조회 예외(${fileName}): ${String(e)}`); }
  }
  return false;
}

// ── 메인 ──
async function main() {
  if (!NOTION_KEY || !LINE_TOKEN) throw new Error("env 누락: NOTION_API_KEY / LINE_57TB_TOKEN (--env-file 확인)");
  log("=== promo-sync 시작 ===");

  // 0) git 선행 점검: promos/ 에 남의 미커밋 변경이 있으면 중단 (클로버링 방지)
  const dirty = git("status", "--porcelain", "--", "promos/").trim();
  if (dirty) {
    alert("dirty:global", `⚠️ 57tb-assets promos/에 미커밋 변경이 있어 동기화 중단:\n${dirty.slice(0, 300)}`);
    throw new Error(`promos/ dirty — 중단:\n${dirty}`);
  }
  git("-c", "rebase.autoStash=true", "pull", "--rebase"); // autostash: promos/ 밖(scripts/ 등) 작업중 변경에도 동기화 생존 (promos/ dirty는 별도 중단 가드)

  // 1) Notion Active 프로모 — live(기간중, 봇 노출) + upcoming(시작 전, 이미지 선행 준비)
  let promos = await fetchActivePromos();
  if (process.env.PROMO_SYNC_TEST_FAKE === "1") promos = [...promos, { name: "__TEST404__", id8: "deadbee1", description: "x", upcoming: false, notionImageUrl: null }];
  const live = promos.filter((p) => !p.upcoming);
  log(`동기화 대상 ${promos.length}건 (live ${live.length} + upcoming ${promos.length - live.length}): ${promos.map((p) => `${p.name}(${p.id8}${p.upcoming ? ",예정" : ""})`).join(", ") || "(없음)"}`);

  // 2) 운영 경고 — 봇 노출 판단은 live 기준 (upcoming은 노출 전이라 경고 대상 아님)
  if (live.length > BOT_VISIBLE) {
    alert("over4:global", `⚠️ 기간 중 Active 프로모 ${live.length}개 — 봇은 Sort Order 상위 ${BOT_VISIBLE}개만 손님에게 노출합니다. Notion 정리 필요 여부 확인해 주세요.`);
  }
  for (const p of live.slice(0, BOT_VISIBLE)) {
    if (!p.description.trim()) {
      alert(`desc:${p.id8}`, `⚠️ 프로모 "${p.name}" Description 빈칸 — 아리가 이 프로모의 가격·조건을 몰라 상세 답변을 못 합니다(환각 위험↑). Notion Description 기입 필요.`);
    }
  }

  // 3) 각 프로모: p-/c- 존재 + 원본 SHA 일치 검사 → 필요 시 재생성
  const manifest = loadJson(MANIFEST, {});
  const generated = []; // {id8, name, files:[...]}
  for (const p of promos) {
    const pFile = path.join(PROMOS, `p-${p.id8}.jpg`);
    const cFile = path.join(PROMOS, `c-${p.id8}.jpg`);
    let src;
    try {
      let r = await fetch(`${ORIGIN}p-${p.id8}.jpg`, { cache: "no-store" });
      // 홈페이지 미반영(404) → Notion 첨부 원본 폴백 (특히 upcoming: 홈페이지가 기간 전이라 아직 없을 수 있음)
      if (r.status === 404 && p.notionImageUrl) {
        log(`홈페이지 404 → Notion 첨부 폴백: ${p.name}(${p.id8})`);
        r = await fetch(p.notionImageUrl, { cache: "no-store" });
      }
      if (r.status === 404) {
        if (p.upcoming) {
          log(`skip(예정·원본 미준비): ${p.name}(${p.id8}) — 시작 전까지 자동 재시도`); // 노출 전이라 무알림
        } else {
          alert(`404:${p.id8}`, `⚠️ 프로모 "${p.name}"(${p.id8}) 원본 미반영(홈페이지 404·Notion 첨부 없음) — 자동 재시도합니다. 그동안 봇에서 이 프로모 이미지가 안 보입니다.`);
        }
        continue;
      }
      if (!r.ok) throw new Error(`원본 다운로드 ${r.status}`);
      src = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      alert(`dl:${p.id8}`, `❌ 프로모 "${p.name}" 원본 다운로드 실패: ${String(e).slice(0, 120)}`);
      continue;
    }
    if (!magicOf(src) || src.length === 0) {
      alert(`badsrc:${p.id8}`, `❌ 프로모 "${p.name}" 원본이 유효한 이미지가 아님(magic=${magicOf(src)})`);
      continue;
    }
    const srcSha = sha256(src);
    const upToDate = manifest[p.id8]?.sha256 === srcSha && fs.existsSync(pFile) && fs.existsSync(cFile);
    if (upToDate) { log(`skip(최신): ${p.name}(${p.id8})`); continue; }

    // 재생성 (신규 / c- 누락 / 원본 교체)
    const tmpSrc = path.join(os.tmpdir(), `promo-src-${p.id8}`);
    fs.writeFileSync(tmpSrc, src);
    try {
      convert(tmpSrc, p.id8);
      manifest[p.id8] = { sha256: srcSha, name: p.name, updatedAt: new Date().toISOString() };
      generated.push({ id8: p.id8, name: p.name, files: [`p-${p.id8}.jpg`, `c-${p.id8}.jpg`] });
      log(`생성: ${p.name}(${p.id8}) p+c`);
    } catch (e) {
      alert(`conv:${p.id8}`, `❌ 프로모 "${p.name}" 변환/검증 실패: ${String(e).slice(0, 150)}`);
    } finally {
      fs.rmSync(tmpSrc, { force: true });
    }
  }

  // 4) git commit·push (생성분 + manifest 같은 커밋 = 원자적. 파일 명시 stage만)
  if (generated.length) {
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    const files = generated.flatMap((g) => g.files.map((f) => `promos/${f}`));
    git("add", "--", ...files, "promos/manifest.json");
    git("commit", "-m", `[자동] 프로모 이미지 동기화: ${generated.map((g) => g.name).join(", ")}\n\nCo-Authored-By: promo-sync (launchd daily)`);
  }
  // push 필요 = 오늘 커밋 or 이전 실행의 미푸시 커밋
  const ahead = git("rev-list", "--count", "@{u}..HEAD").trim();
  if (Number(ahead) > 0) {
    try { git("push", "origin", "master"); }
    catch {
      log("push 실패 — pull --rebase 후 1회 재시도");
      git("-c", "rebase.autoStash=true", "pull", "--rebase"); // autostash: promos/ 밖(scripts/ 등) 작업중 변경에도 동기화 생존 (promos/ dirty는 별도 중단 가드)
      git("push", "origin", "master"); // 재실패 시 throw → 알림
    }
    log(`push 완료 (${ahead} commit)`);
  }

  // 5) CDN 검증: 오늘 생성분 + 이전 pending 재검증
  const toVerify = new Set([
    ...generated.flatMap((g) => g.files),
    ...Object.keys(state.cdnPending),
  ]);
  for (const f of toVerify) {
    if (!fs.existsSync(path.join(PROMOS, f))) { delete state.cdnPending[f]; continue; }
    if (await verifyCdn(f)) {
      delete state.cdnPending[f];
      log(`CDN 검증 OK: ${f}`);
    } else {
      state.cdnPending[f] = new Date().toISOString();
      alert(`cdn:${f}`, `⚠️ ${f} CDN 반영 미확인(purge 후에도 불일치) — 다음 실행에서 재검증합니다.`);
    }
  }

  // 6) 성공 1줄 알림 (신규 생성 시에만 — 무소식=정상)
  if (generated.length) {
    pendingAlerts.push(`✅ 프로모 이미지 ${generated.length}건 자동 동기화 완료: ${generated.map((g) => g.name).join(", ")}`);
  }
  log(`=== 완료: 생성 ${generated.length}건, 알림 ${pendingAlerts.length}건 ===`);
}

acquireLock();
try {
  await main();
} catch (e) {
  log(`FATAL: ${String(e)}`);
  alert("fatal:global", `❌ 프로모 동기화 실행 실패: ${String(e).slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  await flushAlerts();
  saveState();
  releaseLock();
}
