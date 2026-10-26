/**
 * _test/gestures-test.mjs —— 手势动作单元测试
 *
 * 直接 import 生产代码，用合成手部数据验证：
 *   · 单指（食指）识别是否正确
 *   · 旋转角是否随手掌转动
 *   · 捏合值是否随拇指食指距离变化
 *   · 挥手检测是否触发
 *   · 平滑是否收敛、无 NaN
 *
 * 用法: node _test/gestures-test.mjs
 */

function stubGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
}
stubGlobal('navigator', { userAgent: 'node-test', maxTouchPoints: 0 });
stubGlobal('screen', { width: 1920, height: 1080 });
stubGlobal('window', { isSecureContext: true, devicePixelRatio: 1, addEventListener() {} });
stubGlobal('performance', { now: () => Date.now() });

const { extractHandFeatures, GestureTracker, ActionDetector, TIPS, MCPS, PIPS } =
  await import('../js/gestures.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name}  ${detail}`); }
}

/* ------------------------------------------------------------------ *
 * 合成手部生成器
 * ------------------------------------------------------------------ */

/**
 * @param {object} opts
 *   extend: [拇指,食指,中指,无名指,小指] 是否伸出
 *   rotation: 手掌整体旋转（弧度）
 *   pinchClose: 0~1，1 表示拇指食指完全捏合
 */
function makeHand(opts = {}) {
  const extend = opts.extend || [true, true, true, true, true];
  const rot = opts.rotation || 0;
  const pinchClose = opts.pinchClose || 0;

  const lm = new Array(21);
  // 手掌基准姿态（手掌朝上，手指向上）
  lm[0] = { x: 0.5, y: 0.78, z: 0 };  // 手腕

  // 指根位置（相对手腕）
  const mcpOffset = [
    { x: -0.062, y: -0.105 },  // 拇指 CMC
    { x: -0.048, y: -0.155 },  // 食指
    { x: -0.008, y: -0.170 },  // 中指
    { x: 0.032, y: -0.158 },   // 无名指
    { x: 0.068, y: -0.135 },   // 小指
  ];
  const segLen = [0.052, 0.078, 0.084, 0.076, 0.062]; // 每指总长

  // 先算未旋转的坐标，最后统一绕手腕旋转
  const raw = new Array(21);

  for (let f = 0; f < 5; f++) {
    const mcp = { x: 0.5 + mcpOffset[f].x, y: 0.78 + mcpOffset[f].y, z: 0 };
    raw[MCPS[f]] = mcp;

    const L = segLen[f];
    const isExtended = extend[f];

    // 手指方向：伸直的指向上方，弯曲的折回掌心方向
    // 用两段关节模拟
    const baseAngle = -Math.PI / 2; // 向上
    const curl = isExtended ? 0 : 1;
    const bend1 = curl * 1.9;
    const bend2 = curl * 1.7;

    // 拇指特殊：朝侧面
    const thumbAngle = f === 0 ? (-Math.PI / 2 - 0.85 * (isExtended ? 1 : 0.35)) : baseAngle;

    const a1 = (f === 0 ? thumbAngle : baseAngle) + bend1 * 0.45;
    const s1 = L * 0.5;
    const p1 = {
      x: mcp.x + Math.cos(a1) * s1 * (1 - curl * 0.4),
      y: mcp.y + Math.sin(a1) * s1 * (1 - curl * 0.4),
      z: 0,
    };

    const a2 = a1 + bend2 * 0.7;
    const s2 = L * 0.5;
    const p2 = {
      x: p1.x + Math.cos(a2) * s2 * (1 - curl * 0.5),
      y: p1.y + Math.sin(a2) * s2 * (1 - curl * 0.5),
      z: 0,
    };

    if (f === 0) {
      raw[2] = p1;
      raw[3] = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, z: 0 };
      raw[4] = p2;
    } else {
      raw[PIPS[f]] = p1;
      raw[PIPS[f] + 1] = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, z: 0 };
      raw[TIPS[f]] = p2;
    }
  }

  /* ---- 捏合：把拇指尖拉向食指尖 ---- */
  if (pinchClose > 0) {
    const it = raw[8];
    const tt = raw[4];
    raw[4] = {
      x: tt.x + (it.x - tt.x) * pinchClose * 0.92,
      y: tt.y + (it.y - tt.y) * pinchClose * 0.92,
      z: 0,
    };
    // IP 也跟着走一半，保持关节链合理
    raw[3] = {
      x: raw[3].x + (it.x - raw[3].x) * pinchClose * 0.45,
      y: raw[3].y + (it.y - raw[3].y) * pinchClose * 0.45,
      z: 0,
    };
  }

  /* ---- 兜底：补齐任何未赋值的点 ----
     拇指分支只写了 2/3/4，而 MCPS[0]=1 已在循环里赋过；
     其余指头的 DIP 索引（PIPS[f]+1）在 f=0 时是 3，已被拇指占用。
     这里统一把空洞填到手腕，保证 21 个点都存在。 */
  for (let i = 0; i < 21; i++) {
    if (!raw[i]) raw[i] = { x: lm[0].x, y: lm[0].y, z: 0 };
  }

  /* ---- 整体旋转（绕手腕） ---- */
  const c = Math.cos(rot), s = Math.sin(rot);
  for (let i = 0; i < 21; i++) {
    const p = raw[i];
    const dx = p.x - lm[0].x;
    const dy = p.y - lm[0].y;
    lm[i] = {
      x: lm[0].x + dx * c - dy * s,
      y: lm[0].y + dx * s + dy * c,
      z: 0,
    };
  }
  return lm;
}

/* ================= 1. 手指伸展识别 ================= */
console.log('\n[1] 手指伸展识别');
{
  const allOpen = extractHandFeatures(makeHand({ extend: [true, true, true, true, true] }));
  const allFist = extractHandFeatures(makeHand({ extend: [false, false, false, false, false] }));
  const indexOnly = extractHandFeatures(makeHand({ extend: [false, true, false, false, false] }));

  console.log(`    全开: ${allOpen.extendedCount} 指  indexOnly=${allOpen.indexOnly}`);
  console.log(`    握拳: ${allFist.extendedCount} 指  indexOnly=${allFist.indexOnly}`);
  console.log(`    单指: ${indexOnly.extendedCount} 指  indexOnly=${indexOnly.indexOnly}`);

  check('五指全开 → extendedCount = 5', allOpen.extendedCount === 5, `got ${allOpen.extendedCount}`);
  check('握拳 → extendedCount = 0', allFist.extendedCount === 0, `got ${allFist.extendedCount}`);
  check('只伸食指 → indexOnly = true', indexOnly.indexOnly === true);
  check('只伸食指 → extendedCount = 1', indexOnly.extendedCount === 1, `got ${indexOnly.extendedCount}`);
  check('五指全开时 indexOnly = false（多指时不该触发单指逻辑）', allOpen.indexOnly === false);
}

/* ================= 2. 旋转角 ================= */
console.log('\n[2] 旋转角');
{
  const angles = [0, 0.4, 0.9, 1.6];
  const got = angles.map((a) => extractHandFeatures(makeHand({ rotation: a })).rotation);
  // rotation = atan2(中指根 - 手腕)
  // 基准姿态下手指朝上，所以基准角约为 -π/2
  console.log(`    输入旋转: ${angles.map((a) => a.toFixed(2)).join(', ')}`);
  console.log(`    测得角度: ${got.map((a) => a.toFixed(3)).join(', ')}`);

  // 相邻差值应约等于输入差值
  let ok = true;
  for (let i = 1; i < angles.length; i++) {
    let d = got[i] - got[i - 1];
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const expected = angles[i] - angles[i - 1];
    if (Math.abs(d - expected) > 0.06) ok = false;
  }
  check('旋转角随手掌转动线性变化', ok);

  check('旋转角有限（无 NaN）', got.every(Number.isFinite));
}

/* ================= 3. 捏合 ================= */
console.log('\n[3] 捏合（约定：1 = 张开，0 = 捏紧）');
{
  const open = extractHandFeatures(makeHand({ pinchClose: 0 })).pinch;
  const mid = extractHandFeatures(makeHand({ pinchClose: 0.5 })).pinch;
  const closed = extractHandFeatures(makeHand({ pinchClose: 1 })).pinch;
  console.log(`    张开=${open.toFixed(3)}  半合=${mid.toFixed(3)}  捏紧=${closed.toFixed(3)}`);

  check('捏合值随手指靠近而下降（1=张开, 0=捏紧）', open > mid && mid > closed,
    `${open.toFixed(3)} > ${mid.toFixed(3)} > ${closed.toFixed(3)}`);
  check('张开时 pinch > 0.85', open > 0.85, `got ${open.toFixed(3)}`);
  check('捏紧时 pinch < 0.1', closed < 0.1, `got ${closed.toFixed(3)}`);
  check('pinch 在 [0,1]', open <= 1 && closed >= 0);
}

/* ================= 4. 指尖位置 ================= */
console.log('\n[4] 指尖位置（单指追踪用）');
{
  // 食指伸出且指向上方时，指尖 y 应显著小于掌心（屏幕坐标 y 向下）
  const f = extractHandFeatures(makeHand({ extend: [false, true, false, false, false] }));
  console.log(`    fingerPos = (${f.fingerPos.x.toFixed(3)}, ${f.fingerPos.y.toFixed(3)})`);
  check('食指伸出时指尖 y 为负（在掌心上方）', f.fingerPos.y < -0.3, `got ${f.fingerPos.y.toFixed(3)}`);
  check('指尖位置有限', Number.isFinite(f.fingerPos.x) && Number.isFinite(f.fingerPos.y));

  // 手掌旋转后指尖位置应随之变化
  const f2 = extractHandFeatures(makeHand({ extend: [false, true, false, false, false], rotation: 1.0 }));
  console.log(`    旋转 1.0 后 = (${f2.fingerPos.x.toFixed(3)}, ${f2.fingerPos.y.toFixed(3)})`);
  const moved = Math.hypot(f2.fingerPos.x - f.fingerPos.x, f2.fingerPos.y - f.fingerPos.y);
  check('手掌旋转时指尖位置跟着变', moved > 0.4, `moved=${moved.toFixed(3)}`);
}

/* ================= 5. GestureTracker 平滑与累积 ================= */
console.log('\n[5] GestureTracker 平滑与累积');
{
  const gt = new GestureTracker();
  const dt = 1 / 30;

  // 连续转 2 秒，每秒约 1 弧度
  let acc = 0;
  for (let i = 0; i < 60; i++) {
    const lm = makeHand({ rotation: acc, extend: [false, true, false, false, false] });
    gt.update(lm, dt);
    acc += 1.0 * dt;
  }
  console.log(`    累积旋转 = ${gt.state.rotationAccum.toFixed(3)} rad（期望 ≈ ${acc.toFixed(3)}）`);
  check('累积旋转接近真实转动量', Math.abs(gt.state.rotationAccum - acc) < 0.15,
    `got ${gt.state.rotationAccum.toFixed(3)} vs ${acc.toFixed(3)}`);

  // 转多圈不跳变
  const gt2 = new GestureTracker();
  let a2 = 0;
  for (let i = 0; i < 200; i++) {
    gt2.update(makeHand({ rotation: a2 }), dt);
    a2 += 2.5 * dt; // 约 1.4 圈
  }
  console.log(`    多圈累积 = ${gt2.state.rotationAccum.toFixed(3)} rad（期望 ≈ ${a2.toFixed(3)}）`);
  check('可连续累积多圈不跳变', Math.abs(gt2.state.rotationAccum - a2) < 0.4,
    `got ${gt2.state.rotationAccum.toFixed(3)} vs ${a2.toFixed(3)}`);

  check('所有状态有限（无 NaN）',
    Number.isFinite(gt2.state.rotationAccum) &&
    Number.isFinite(gt2.state.pinch) &&
    Number.isFinite(gt2.state.fingerPos.x));

  // 手离开后归零
  const gt3 = new GestureTracker();
  for (let i = 0; i < 30; i++) gt3.update(makeHand({ pinchClose: 1 }), dt);
  const beforePinch = gt3.state.pinch;
  for (let i = 0; i < 120; i++) gt3.update(null, dt);
  console.log(`    手离开前 pinch=${beforePinch.toFixed(3)} → 离开后 ${gt3.state.pinch.toFixed(3)}`);
  check('手离开后 pinch 衰减到接近 0', gt3.state.pinch < 0.1, `got ${gt3.state.pinch.toFixed(3)}`);
  check('手离开后 hasHand = false', gt3.hasHand === false);
}

/* ================= 6. 挥手检测 ================= */
console.log('\n[6] 挥手检测');
{
  const gt = new GestureTracker();
  const dt = 1 / 30;
  // 快速水平移动手掌
  let x = 0.5;
  let maxWave = 0;
  for (let i = 0; i < 40; i++) {
    const lm = makeHand({});
    // 整体平移
    for (const p of lm) p.x += (x - 0.5);
    gt.update(lm, dt);
    x += 2.2 * dt;  // 快速移动
    maxWave = Math.max(maxWave, gt.state.wave);
  }
  console.log(`    挥手峰值 = ${maxWave.toFixed(3)}`);
  check('快速水平移动触发挥手信号', maxWave > 0.3, `got ${maxWave.toFixed(3)}`);

  // 静止时不应触发
  const gt2 = new GestureTracker();
  let maxWave2 = 0;
  for (let i = 0; i < 40; i++) {
    gt2.update(makeHand({}), dt);
    maxWave2 = Math.max(maxWave2, gt2.state.wave);
  }
  console.log(`    静止时峰值 = ${maxWave2.toFixed(3)}`);
  check('静止时不触发挥手', maxWave2 < 0.15, `got ${maxWave2.toFixed(3)}`);
}

/* ================= 7. ActionDetector 边沿与冷却 ================= */
console.log('\n[7] ActionDetector 边沿触发与冷却');
{
  const ad = new ActionDetector();
  const dt = 1 / 30;
  let fires = 0;

  // 满足条件持续 2 秒，冷却 0.5 秒 → 应触发多次但受冷却限制
  for (let i = 0; i < 60; i++) {
    if (ad.edge('test', true, dt, 0.5)) fires++;
  }
  console.log(`    持续 2s、冷却 0.5s → 触发 ${fires} 次`);
  check('持续满足时不会每帧都触发', fires < 60, `fires=${fires}`);
  check('持续满足时至少触发一次', fires >= 1, `fires=${fires}`);

  // 边沿：只在 false → true 时触发
  const ad2 = new ActionDetector();
  let fires2 = 0;
  const pattern = [false, false, true, true, true, false, false, true];
  for (const p of pattern) {
    if (ad2.edge('e', p, dt, 0)) fires2++;
  }
  console.log(`    边沿模式 [F,F,T,T,T,F,F,T] → 触发 ${fires2} 次（期望 2）`);
  check('边沿检测正确（上升沿才触发）', fires2 === 2, `fires=${fires2}`);
}

/* ================= 汇总 ================= */
console.log('\n' + '='.repeat(48));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log('  失败项:');
  failures.forEach((f) => console.log('    - ' + f));
}
console.log('='.repeat(48));
process.exit(fail ? 1 : 0);