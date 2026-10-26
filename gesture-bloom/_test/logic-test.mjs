/**
 * _test/logic-test.mjs —— 纯逻辑单元测试（无需浏览器）
 *
 * 关键点：这里 **直接 import 生产代码**，而不是复制一份公式。
 * 之前复制公式的写法会和 handTracking.js 逐渐漂移，
 * 导致「测试通过但线上行为不对」。
 *
 * config.js 引用了 navigator/screen，handTracking.js 引用了 window/document，
 * 所以在 import 之前先把这些浏览器全局补上（最小 stub）。
 *
 * 用法: node _test/logic-test.mjs
 */

/* ---------------- 浏览器全局 stub（必须在 import 之前） ----------------
   Node 24 已经内置了 getter-only 的 navigator，直接赋值会抛
   "Cannot set property navigator"，必须用 defineProperty 覆盖。 */
function stubGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

stubGlobal('navigator', {
  userAgent: 'node-test',
  maxTouchPoints: 0,
  mediaDevices: undefined,
});
stubGlobal('screen', { width: 1920, height: 1080 });
stubGlobal('window', {
  isSecureContext: true,
  devicePixelRatio: 1,
  addEventListener() {},
  innerWidth: 1920,
  innerHeight: 1080,
});
stubGlobal('document', {
  getElementById: () => null,
  createElement: () => ({ style: {}, dataset: {}, addEventListener() {} }),
  querySelector: () => null,
  head: { appendChild() {} },
  addEventListener() {},
  body: { classList: { add() {}, remove() {}, toggle: () => false } },
});

const { computeTension, tensionToSpread, spreadStateName, HAND_CONNECTIONS } =
  await import('../js/handTracking.js');
const { CONFIG } = await import('../js/config.js');

/** computeTension 返回 { tension, features }，这里取标量方便断言 */
const tensionOf = (lm) => computeTension(lm).tension;

const BUD = CONFIG.gesture.budThreshold;
const BLOOM = CONFIG.gesture.bloomThreshold;
const EASING = CONFIG.gesture.easing;

/* ---------------- 测试骨架 ---------------- */

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ---------------- 合成手部关键点 ---------------- */

const TIPS = [4, 8, 12, 16, 20];
const MCPS = [1, 5, 9, 13, 17];
const PIPS = [2, 6, 10, 14, 18];

/**
 * 生成一只合成的手。
 *   openness: 0 = 完全握拳（指尖卷回掌心）
 *             1 = 五指完全伸直
 * 21 个点必须全部赋值（之前漏了拇指的 IP(3) 会导致 NaN）。
 */
function makeHand(openness, scale = 1) {
  const lm = new Array(21);
  lm[0] = { x: 0.5, y: 0.9, z: 0 }; // WRIST

  const dirs = [
    { x: -0.34, y: -0.26 }, // 拇指
    { x: -0.14, y: -0.45 }, // 食指
    { x: -0.02, y: -0.47 }, // 中指
    { x: 0.1, y: -0.45 },   // 无名指
    { x: 0.21, y: -0.42 },  // 小指
  ];
  const mcpLen = [0.155, 0.2, 0.205, 0.195, 0.18];
  const fingerLen = [0.15, 0.235, 0.25, 0.23, 0.19];

  for (let f = 0; f < 5; f++) {
    const d = dirs[f];
    const mcp = { x: 0.5 + d.x * mcpLen[f], y: 0.9 + d.y * mcpLen[f], z: 0 };
    lm[MCPS[f]] = mcp;

    // 握拳 = 手指「卷曲」而不是「变短」：用两段关节折角模拟
    const curl = 1 - openness;
    const L = fingerLen[f];
    const bend = curl * 2.15;
    const seg1 = L * 0.5;
    const seg2 = L * 0.5;

    const a1 = Math.atan2(d.y, d.x) + bend * 0.42;
    const p1 = {
      x: mcp.x + Math.cos(a1) * seg1 * (1 - curl * 0.45),
      y: mcp.y + Math.sin(a1) * seg1 * (1 - curl * 0.45),
      z: 0,
    };

    const a2 = a1 + bend * 0.75;
    const p2 = {
      x: p1.x + Math.cos(a2) * seg2 * (1 - curl * 0.55),
      y: p1.y + Math.sin(a2) * seg2 * (1 - curl * 0.55),
      z: 0,
    };

    if (f === 0) {
      // 拇指链只有 4 点：1=CMC, 2=MCP, 3=IP, 4=TIP
      lm[2] = p1;
      lm[3] = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, z: 0 };
      lm[4] = p2;
    } else {
      lm[PIPS[f]] = p1;
      lm[PIPS[f] + 1] = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, z: 0 };
      lm[TIPS[f]] = p2;
    }
  }

  for (let i = 0; i < 21; i++) {
    if (!lm[i]) lm[i] = { x: lm[0].x, y: lm[0].y, z: 0 };
  }

  if (scale !== 1) {
    for (let i = 0; i < 21; i++) {
      lm[i] = {
        x: 0.5 + (lm[i].x - 0.5) * scale,
        y: 0.5 + (lm[i].y - 0.5) * scale,
        z: 0,
      };
    }
  }
  return lm;
}

/* ================= 1. trait: tension → spread ================= */
console.log('\n[1] tension → spread 阈值映射（需求 4）');
check(`tension 0.00 → spread 0`, approx(tensionToSpread(0), 0));
check(`tension 0.20 → spread 0（花苞区）`, approx(tensionToSpread(0.2), 0));
check(`tension ${BUD - 0.01} → spread 0（阈值下沿）`, approx(tensionToSpread(BUD - 0.01), 0));
check(`tension ${BUD} → spread 0（阈值点）`, approx(tensionToSpread(BUD), 0));
check(`tension ${BLOOM} → spread 1（阈值点）`, approx(tensionToSpread(BLOOM), 1));
check(`tension 0.80 → spread 1（绽放区）`, approx(tensionToSpread(0.8), 1));
check(`tension 1.00 → spread 1`, approx(tensionToSpread(1.0), 1));

const midT = (BUD + BLOOM) / 2;
const midS = tensionToSpread(midT);
check(`tension ${midT.toFixed(2)}（中点）→ spread ≈ 0.5`, approx(midS, 0.5, 0.02),
  `got ${midS.toFixed(4)}`);

/* ================= 2. 单调性与平滑 ================= */
console.log('\n[2] 单调性与平滑过渡');
let prev = -1;
let monotonic = true;
for (let t = 0; t <= 1.0001; t += 0.005) {
  const s = tensionToSpread(t);
  if (s < prev - 1e-9) monotonic = false;
  prev = s;
}
check('spread 随 tension 单调不减', monotonic);

let maxJump = 0;
prev = tensionToSpread(0);
for (let t = 0.005; t <= 1.0001; t += 0.005) {
  const s = tensionToSpread(t);
  maxJump = Math.max(maxJump, Math.abs(s - prev));
  prev = s;
}
check('无阶跃（单步跳变 < 0.05）', maxJump < 0.05, `maxJump=${maxJump.toFixed(4)}`);

/* ================= 3. 缓动公式（需求 5） ================= */
console.log(`\n[3] 缓动公式 current += (target - current) * ${EASING}`);
{
  let cur = 0;
  for (let i = 0; i < 300; i++) cur += (1 - cur) * EASING;
  check('300 帧后收敛到 target', Math.abs(cur - 1) < 1e-6, `cur=${cur}`);

  cur = 0;
  for (let i = 0; i < 10; i++) cur += (1 - cur) * EASING;
  const expect = 1 - Math.pow(1 - EASING, 10);
  check(`10 帧后 = ${expect.toFixed(6)}`, approx(cur, expect, 1e-9), `cur=${cur.toFixed(6)}`);

  // 帧率无关：60Hz 与 30Hz 在同一段真实时间内应收敛到同一水平
  let a = 0;
  for (let i = 0; i < 60; i++) a += (1 - a) * EASING;
  let b = 0;
  for (let i = 0; i < 30; i++) {
    const k = 1 - Math.pow(1 - EASING, (1 / 30) * 60);
    b += (1 - b) * k;
  }
  check('60Hz 与 30Hz 在 1 秒后一致（误差 < 0.01）', Math.abs(a - b) < 0.01,
    `60Hz=${a.toFixed(5)} 30Hz=${b.toFixed(5)}`);
}

/* ================= 4. computeTension 手势判别 ================= */
console.log('\n[4] computeTension 手势判别（需求 2）');
const tFist = tensionOf(makeHand(0));
const tHalf = tensionOf(makeHand(0.5));
const tOpen = tensionOf(makeHand(1));
console.log(`    握拳 tension = ${tFist.toFixed(4)}`);
console.log(`    半开 tension = ${tHalf.toFixed(4)}`);
console.log(`    张开 tension = ${tOpen.toFixed(4)}`);

check(`握拳 tension < ${BUD}（判为花苞）`, tFist < BUD, `got ${tFist.toFixed(4)}`);
check(`张开 tension > ${BLOOM}（判为绽放）`, tOpen > BLOOM, `got ${tOpen.toFixed(4)}`);
check('张开 > 握拳', tOpen > tFist);
check('半开位于两者之间', tHalf > tFist && tHalf < tOpen);
check('tension 恒在 [0,1]', tFist >= 0 && tOpen <= 1);
check(`动态范围充足（> 0.55）`, tOpen - tFist > 0.55, `range=${(tOpen - tFist).toFixed(4)}`);

const fistBig = tensionOf(makeHand(0, 1.6));
const openBig = tensionOf(makeHand(1, 1.6));
check('尺度不变：放大后的握拳接近', Math.abs(fistBig - tFist) < 0.12,
  `${tFist.toFixed(4)} vs ${fistBig.toFixed(4)}`);
check('尺度不变：放大后的张开接近', Math.abs(openBig - tOpen) < 0.12,
  `${tOpen.toFixed(4)} vs ${openBig.toFixed(4)}`);

/* ================= 5. 响应曲线 ================= */
console.log('\n[5] openness → tension → spread 响应曲线');
console.log('    openness   tension   spread   状态');
for (const o of [0, 0.15, 0.25, 0.35, 0.5, 0.65, 0.8, 0.9, 1.0]) {
  const t = tensionOf(makeHand(o));
  const s = tensionToSpread(t);
  console.log(`    ${o.toFixed(2)}       ${t.toFixed(4)}    ${s.toFixed(4)}   ${spreadStateName(s)}`);
}
let last = -1;
let mono2 = true;
for (let o = 0; o <= 1.0001; o += 0.05) {
  const t = tensionOf(makeHand(o));
  if (t < last - 1e-6) mono2 = false;
  last = t;
}
check('tension 随 openness 单调不减', mono2);
// 手势应当是连续渐变，而不是「一松手就到底」的开关
const tQuarter = tensionOf(makeHand(0.28));
check('小幅度松手不会立刻满绽放（openness 0.28 → spread < 0.98）',
  tensionToSpread(tQuarter) < 0.98, `spread=${tensionToSpread(tQuarter).toFixed(4)}`);

/* ================= 6. 边界与健壮性 ================= */
console.log('\n[6] 边界与健壮性');
const allZero = new Array(21).fill(null).map(() => ({ x: 0, y: 0, z: 0 }));
check('关键点全部重合不产生 NaN', Number.isFinite(tensionOf(allZero)),
  `got ${tensionOf(allZero)}`);

const atOrigin = tensionOf(makeHand(0).map((p) => ({ ...p, x: 0, y: 0 })));
check('退化输入不产生 NaN', Number.isFinite(atOrigin), `got ${atOrigin}`);

check('tension 越界夹紧（-1 → 0）', approx(tensionToSpread(-1), 0));
check('tension 越界夹紧（2 → 1）', approx(tensionToSpread(2), 1));
check('21 点连线表完整', HAND_CONNECTIONS.length > 0);

// 状态名覆盖整个 [0,1]
let namesOk = true;
for (let s = 0; s <= 1.0001; s += 0.05) {
  if (!spreadStateName(s) || typeof spreadStateName(s) !== 'string') namesOk = false;
}
check('状态名对 [0,1] 全域有效', namesOk);

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(48));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log('  失败项:');
  failures.forEach((f) => console.log('    - ' + f));
}
console.log('='.repeat(48));
process.exit(fail ? 1 : 0);