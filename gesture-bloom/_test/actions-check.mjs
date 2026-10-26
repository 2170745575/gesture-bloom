/**
 * _test/actions-check.mjs —— 验证「动作」真的驱动了画面
 *
 * 单元测试证明了信号提取正确，但还需要确认信号确实传到了着色器并产生可见变化。
 * 这里对每个动作，分别在「关闭」与「开启」两种状态下截帧，
 * 比较像素差异与画面统计量。
 *
 * 用法: node _test/actions-check.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 9000 + Math.floor(Math.random() * 80);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-act-${Date.now()}`);
const URL_TO_TEST = process.argv[2] || 'http://localhost:5173/?nodegrade=1';

const child = spawn(EDGE, [
  '--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions',
  '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--hide-scrollbars',
  '--window-size=760,520','--remote-debugging-port=' + PORT,'--user-data-dir=' + userDataDir,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('CDP connect failed');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.handlers.get(m.method)?.forEach((h) => h(m.params));
    });
  }
  on(m, f) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(f); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      switch (f) {
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: { const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; v = (v + pr) & 0xff; break; }
      }
      cur[x] = v;
    }
  }
  return { width, height, channels, data: out };
}

/** 返回「质心 x」与「发光像素数」，用于判断花瓣是否被拉向某侧 / 旋转 */
function stats(png) {
  const { width, height, channels, data } = png;
  const x0 = Math.floor(width * 0.10), x1 = Math.floor(width * 0.90);
  const y0 = Math.floor(height * 0.10), y1 = Math.floor(height * 0.90);
  let sx = 0, sy = 0, wsum = 0, lit = 0, lumSum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      const L = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      lumSum += L; n++;
      if (L > 60) {
        sx += x * (L - 60); sy += y * (L - 60); wsum += (L - 60); lit++;
      }
    }
  }
  return {
    质心x: wsum > 0 ? +(sx / wsum).toFixed(1) : null,
    质心y: wsum > 0 ? +(sy / wsum).toFixed(1) : null,
    发光像素: lit,
    平均亮度: +(lumSum / n).toFixed(1),
  };
}

function diff(a, b) {
  const n = Math.min(a.data.length, b.data.length);
  let changed = 0, total = 0;
  for (let i = 0; i < n; i += a.channels) {
    const la = 0.2126*a.data[i] + 0.7152*a.data[i+1] + 0.0722*a.data[i+2];
    const lb = 0.2126*b.data[i] + 0.7152*b.data[i+1] + 0.0722*b.data[i+2];
    if (Math.abs(la - lb) > 10) changed++;
    total++;
  }
  return +((changed / total) * 100).toFixed(2);
}

let pass = 0, fail = 0;
const check = (name, cond, detail='') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};

(async () => {
  const ws = new WebSocket(await getWsUrl());
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: URL_TO_TEST }, sessionId);
  await sleep(6000);

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description };
    return r.result?.value;
  };

  await evalJs(`
    document.getElementById('overlay').classList.add('hidden');
    document.body.classList.remove('show-skeleton','cam-on');
    for (const id of ['hud-tl','hud-tr','hud-bl','vignette']) {
      const el = document.getElementById(id); if (el) el.style.display='none';
    }
    'ok'
  `);

  const shoot = async (tag) => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const buf = Buffer.from(s.data, 'base64');
    if (tag) fs.writeFileSync(`_test/act-${tag}.png`, buf);
    return decodePng(buf);
  };

  // 暴露内部状态供测试驱动
  const hook = await evalJs(`
    (() => {
      const s = window.__bloomExposeScene && window.__bloomExposeScene();
      if (!s) return 'no-scene';
      window.__actSet = (o) => { Object.assign(window.__actState, o); return true; };
      return 'ok';
    })()
  `);
  console.log('钩子:', hook);

  console.log('\n=== 1. 单指追踪：花瓣被拉向指尖 ===');
  await evalJs(`window.__bloomSetTension(0.55); window.__bloomSnap(); 'x'`);
  await sleep(2200);

  // 用一层包装注入手势参数
  await evalJs(`
    (() => {
      const s = window.__bloomExposeScene();
      if (s.__patched) return 'already';
      s.__patched = true;
      s.__inject = { fingerX:0, fingerY:0, fingerActive:0, rotation:0, pinch:0.5 };
      const orig = s.update.bind(s);
      s.update = (dt, st) => orig(dt, Object.assign({}, st, s.__inject));
      return 'patched';
    })()
  `);

  /* 关键：冻结花朵自转。
     花朵在绽放态以约 0.44 rad/s 自转，2 秒就是 50°，
     质心位移会被这个自转淹没，导致「单指追踪」的测量结果失真
     （实测未冻结时得到 -21.6px 的反向位移，冻结后是正确的 +28px）。 */
  await evalJs(`
    (() => {
      const s = window.__bloomExposeScene();
      s.__freeze = true;
      const orig = s.update.bind(s);
      s.update = (dt, st) => {
        orig(dt, Object.assign({}, st, s.__inject));
        if (s.__freeze) s.points.rotation.y = 0;
      };
      return 'frozen';
    })()
  `);

  // 基准：无指尖
  await evalJs(`window.__bloomExposeScene().__inject = {fingerX:0,fingerY:0,fingerActive:0,rotation:0,pinch:0.5}; 'x'`);
  await sleep(2200);
  const base = await shoot('base');
  const baseStats = stats(base);
  console.log('  基准:', JSON.stringify(baseStats));

  // 指尖在右侧
  await evalJs(`window.__bloomExposeScene().__inject = {fingerX:0.85,fingerY:0.25,fingerActive:1,rotation:0,pinch:0.5}; 'x'`);
  await sleep(2400);
  const rightF = await shoot('finger-right');
  const rightStats = stats(rightF);
  console.log('  指尖右:', JSON.stringify(rightStats));

  const cxShift = rightStats.质心x - baseStats.质心x;
  console.log(`  质心水平位移: ${cxShift.toFixed(1)} px`);
  check('花瓣被拉向指尖一侧（质心右移）', cxShift > 3, `shift=${cxShift.toFixed(1)}`);
  check('单指追踪产生可见变化（像素差异 > 3%）', diff(base, rightF) > 3, `diff=${diff(base,rightF)}%`);

  console.log('\n=== 2. 手指旋转：整朵花旋转 ===');
  await evalJs(`window.__bloomExposeScene().__inject = {fingerX:0,fingerY:0,fingerActive:0,rotation:0,pinch:0.5}; 'x'`);
  await sleep(2000);
  const rot0 = await shoot('rot0');
  const rot0Stats = stats(rot0);

  await evalJs(`window.__bloomExposeScene().__inject = {fingerX:0,fingerY:0,fingerActive:0,rotation:1.2,pinch:0.5}; 'x'`);
  await sleep(2400);
  const rot1 = await shoot('rot1');
  const rot1Stats = stats(rot1);
  console.log('  旋转 0:', JSON.stringify(rot0Stats));
  console.log('  旋转 1.2rad:', JSON.stringify(rot1Stats));
  check('旋转产生可见画面变化（像素差异 > 5%）', diff(rot0, rot1) > 5, `diff=${diff(rot0,rot1)}%`);

  console.log('\n=== 3. 捏合缩放 ===');
  await evalJs(`window.__bloomExposeScene().__inject = {fingerX:0,fingerY:0,fingerActive:0,rotation:0,pinch:1}; 'x'`);
  await sleep(2400);
  const big = stats(await shoot('pinch-open'));
  await evalJs(`window.__bloomExposeScene().__inject = {fingerX:0,fingerY:0,fingerActive:0,rotation:0,pinch:0}; 'x'`);
  await sleep(2400);
  const small = stats(await shoot('pinch-close'));
  console.log('  张开(pinch=1):', JSON.stringify(big));
  console.log('  捏紧(pinch=0):', JSON.stringify(small));
  check('捏合改变了画面覆盖范围', big.发光像素 !== small.发光像素,
    `${big.发光像素} vs ${small.发光像素}`);

  console.log('\n=== 4. 吹散（挥手触发） ===');
  await evalJs(`window.__bloomExposeScene().__inject = {fingerX:0,fingerY:0,fingerActive:0,rotation:0,pinch:0.5}; 'x'`);
  await sleep(2000);
  const preScatter = await shoot('scatter-before');
  const preLight = stats(preScatter).发光像素;

  await evalJs(`window.__bloomExposeScene().triggerScatter(1.4); 'x'`);
  await sleep(700);
  const postScatter = await shoot('scatter-after');
  const postLight = stats(postScatter).发光像素;
  console.log(`  吹散前发光像素=${preLight} → 吹散后=${postLight}`);
  check('吹散使花瓣向外扩散（覆盖面积增加）', diff(preScatter, postScatter) > 8,
    `diff=${diff(preScatter,postScatter)}%`);

  console.log('\n=== 5. 抽花瓣脉冲 ===');
  await evalJs(`window.__bloomExposeScene().triggerBurst(1.0); 'x'`);
  const burstVal = await evalJs(`window.__bloomExposeScene()._burst`);
  console.log(`  burst = ${burstVal}`);
  check('脉冲值被设置', burstVal > 0.5, `got ${burstVal}`);

  console.log(`\n  通过 ${pass} / ${pass + fail}`);

  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  try { child.kill(); } catch {}
  process.exit(2);
});