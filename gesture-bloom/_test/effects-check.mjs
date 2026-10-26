/**
 * _test/effects-check.mjs —— 验证特效真的在动
 *
 * 单张截图只能证明「画出来了」，不能证明「在动」。
 * 这里在固定时间点连续抓帧，比较相邻帧的像素差异，
 * 并对每个特效层单独做「是否产生变化」的判定。
 *
 * 用法: node _test/effects-check.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 9300 + Math.floor(Math.random() * 100);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-fx-${Date.now()}`);
const URL_TO_TEST = process.argv[2] || 'http://localhost:5173/?nodegrade=1';

const child = spawn(
  EDGE,
  [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--hide-scrollbars',
    '--window-size=800,560',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + userDataDir,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

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
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      switch (filter) {
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pr) & 0xff; break;
        }
      }
      cur[x] = v;
    }
  }
  return { width, height, channels, data: out };
}

/** 两帧之间的变化像素比例（阈值 8） */
function frameDiff(a, b) {
  const n = Math.min(a.data.length, b.data.length);
  let changed = 0, total = 0, sumDelta = 0;
  for (let i = 0; i < n; i += a.channels) {
    const la = 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2];
    const lb = 0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2];
    const d = Math.abs(la - lb);
    sumDelta += d;
    if (d > 8) changed++;
    total++;
  }
  return {
    变化像素占比: +((changed / total) * 100).toFixed(2),
    平均差值: +(sumDelta / total).toFixed(3),
  };
}

/**
 * 只比较画面中心区域的变化（按归一化坐标给出的矩形）。
 * 用途：把「主体是否稳定」与「背景星尘是否活跃」分开评估。
 */
function frameDiffCenter(a, b, x0n, y0n, x1n, y1n) {
  const x0 = Math.floor(a.width * x0n), x1 = Math.floor(a.width * x1n);
  const y0 = Math.floor(a.height * y0n), y1 = Math.floor(a.height * y1n);
  let changed = 0, total = 0, sumDelta = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * a.channels;
      const la = 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2];
      const lb = 0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2];
      const d = Math.abs(la - lb);
      sumDelta += d;
      if (d > 8) changed++;
      total++;
    }
  }
  return {
    变化像素占比: +((changed / total) * 100).toFixed(2),
    平均差值: +(sumDelta / total).toFixed(3),
  };
}

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
    if (tag) fs.writeFileSync(`_test/fx-${tag}.png`, buf);
    return decodePng(buf);
  };

  console.log('=== 1. 静止时是否仍在动（旋转/流光/花粉）===');
  await evalJs(`window.__bloomSetTension(1); window.__bloomSnap(); 'x'`);
  await sleep(1500);
  const f1 = await shoot('t0');
  await sleep(1400);
  const f2 = await shoot('t1');
  await sleep(1400);
  const f3 = await shoot('t2');

  const d12 = frameDiff(f1, f2);
  const d23 = frameDiff(f2, f3);
  console.log('  帧1→帧2:', JSON.stringify(d12));
  console.log('  帧2→帧3:', JSON.stringify(d23));

  // 全开状态下应该有明显动画
  const animated = d12.变化像素占比 > 2 && d23.变化像素占比 > 2;
  console.log(`  ${animated ? 'PASS' : 'FAIL'}  绽放态持续动画（变化像素 > 2%）`);

  console.log('\n=== 2. 花苞态是否安静 ===');
  await evalJs(`window.__bloomSetTension(0); window.__bloomSnap(); 'x'`);
  await sleep(2500);
  const b1 = await shoot('b0');
  await sleep(1400);
  const b2 = await shoot('b1');
  const db = frameDiff(b1, b2);
  console.log('  花苞 帧1→帧2:', JSON.stringify(db));

  // 阈值说明：星尘从 900 颗提到 3200 颗之后，同样的缓慢漂浮会覆盖更多像素，
  // 花苞态的画面变化从 4.7% 升到约 11%。
  // 这属于"背景在呼吸"，不是主体在乱动——实测把场景 update 停掉后变化为 0%，
  // 说明全部来自正常的逐帧动画（花朵自转 + 星空漂浮 + 星云流动），没有抖动。
  // 所以阈值放宽到 16%，并且在下面额外检查「花苞主体本身」是否稳定。
  const calm = db.变化像素占比 < 16;
  console.log(`  ${calm ? 'PASS' : 'FAIL'}  花苞态背景未过度活跃（变化像素 < 16%）`);

  // 关键补充检查：花苞**主体**本身应当是稳定的。
  // 这里排除星尘层后再测中心区域——星尘铺满全屏（含中心），
  // 3200 个点精灵即使只做亚像素漂移，也会让"中心区域变化"高达 15%
  // （实测隐藏星尘后降到 3.3%），不能用来判断主体是否稳定。
  const dustWasVisible = await evalJs(`(()=>{const s=window.__bloomExposeScene();const v=s.dust.points.visible;s.dust.points.visible=false;return v;})()`);
  await sleep(700);
  const c1 = await shoot('b-center0');
  await sleep(1200);
  const c2 = await shoot('b-center1');
  const centerDiff = frameDiffCenter(c1, c2, 0.3, 0.2, 0.7, 0.8);
  console.log(`  花苞主体（隐藏星尘后中心区域）变化: ${centerDiff.变化像素占比}%`);
  const centerCalm = centerDiff.变化像素占比 < 8;
  console.log(`  ${centerCalm ? 'PASS' : 'FAIL'}  花苞主体本身稳定（中心区域变化 < 8%）`);
  await evalJs(`window.__bloomExposeScene().dust.points.visible=${dustWasVisible};'x'`);

  console.log('\n=== 3. 各特效层是否真的在渲染 ===');
  const layers = await evalJs(`
    (() => {
      const s = window.__bloomExposeScene ? window.__bloomExposeScene() : null;
      if (!s) return JSON.stringify({ err: 'scene 未暴露' });
      return JSON.stringify({
        主体粒子: s.particleCount,
        花瓣流光: s.petalStream ? s.petalStream.count : null,
        逸散花粉: s.pollen ? s.pollen.count : null,
        冲击波光环: s.ripple ? s.ripple.points.geometry.attributes.aDir.count : null,
        场景子节点数: s.scene.children.length,
        绘制调用: s.renderer.info.render.calls,
        着色器程序数: s.renderer.info.programs.length
      });
    })()
  `);
  console.log('  ' + layers);

  console.log('\n=== 4. 抽花瓣脉冲是否触发 ===');
  await evalJs(`window.__bloomSetTension(0); window.__bloomSnap(); 'x'`);
  await sleep(1200);
  // 模拟「张开」的手势变化
  const burstInfo = await evalJs(`
    (async () => {
      const s = window.__bloomExposeScene ? window.__bloomExposeScene() : null;
      if (!s) return JSON.stringify({ err: 'scene 未暴露' });
      const before = s._burst;
      // 逐步张开，制造 delta
      for (let i = 0; i <= 20; i++) {
        window.__bloomSetTension(i / 20);
        await new Promise(r => setTimeout(r, 50));
      }
      await new Promise(r => setTimeout(r, 200));
      return JSON.stringify({
        触发前burst: Number(before.toFixed(3)),
        触发后burst: Number(s._burst.toFixed(3)),
        光环激活过: s._ringActive || s._ringT > 0
      });
    })()
  `);
  console.log('  ' + burstInfo);

  const parsed = JSON.parse(burstInfo);
  const burstOk = !parsed.err && parsed.触发后burst > 0;
  console.log(`  ${burstOk ? 'PASS' : 'FAIL'}  张开手势触发了抽花瓣脉冲`);

  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(animated && calm && centerCalm && burstOk ? 0 : 1);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  try { child.kill(); } catch {}
  process.exit(2);
});