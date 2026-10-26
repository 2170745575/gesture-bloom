/**
 * _test/bloom-sweep.mjs —— 泛光参数扫描
 *
 * 手动改一个值、跑一次、看一眼，效率太低而且容易过冲。
 * 这个脚本在一次浏览器会话里，用页面内暴露的接口动态改泛光参数，
 * 逐个测出「平均亮度 / 过曝占比 / 花瓣细节保留度」，最后给出推荐值。
 *
 * 判定标准（自己定的目标）：
 *   · 平均亮度 45~85        —— 够亮但不刺眼
 *   · 过曝占比 < 8%         —— 保留花瓣层次，不烧成白盘
 *   · 边缘清晰度 > 阈值     —— 花瓣轮廓还在（用画面梯度衡量）
 *
 * 用法: node _test/bloom-sweep.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 9200 + Math.floor(Math.random() * 100);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-sweep-${Date.now()}`);
const URL_TO_TEST = process.argv[2] || 'http://localhost:5173/?nodegrade=1';

const child = spawn(
  EDGE,
  [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--hide-scrollbars',
    '--window-size=760,520',
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

function analyze(png) {
  const { width, height, channels, data } = png;
  const x0 = Math.floor(width * 0.22), x1 = Math.floor(width * 0.78);
  const y0 = Math.floor(height * 0.20), y1 = Math.floor(height * 0.85);

  const lum = (x, y) => {
    const i = (y * width + x) * channels;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };

  let sum = 0, n = 0, hot = 0, lit = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const L = lum(x, y);
      sum += L; n++;
      if (L > 245) hot++;
      if (L > 45) lit++;
    }
  }

  // 边缘清晰度：Sobel 梯度的平均值。
  // 过曝时大片区域被削平成纯白，梯度会显著下降——用它衡量「花瓣细节是否还在」。
  let gradSum = 0, gradN = 0;
  for (let y = y0 + 1; y < y1 - 1; y += 2) {
    for (let x = x0 + 1; x < x1 - 1; x += 2) {
      const gx = lum(x + 1, y) - lum(x - 1, y);
      const gy = lum(x, y + 1) - lum(x, y - 1);
      gradSum += Math.hypot(gx, gy);
      gradN++;
    }
  }

  return {
    平均亮度: +(sum / n).toFixed(1),
    过曝占比: +((hot / n) * 100).toFixed(2),
    发光像素占比: +((lit / n) * 100).toFixed(1),
    边缘清晰度: +(gradSum / gradN).toFixed(2),
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

  // 暴露泛光修改能力
  const hasApi = await evalJs(`
    (() => {
      const s = window.__bloomExposeScene ? window.__bloomExposeScene() : null;
      if (!s || !s.bloomPass) return 'no';
      window.__setBloom = (strength, radius, threshold) => {
        s.bloomPass.strength = strength;
        s.bloomPass.radius = radius;
        s.bloomPass.threshold = threshold;
        return true;
      };
      return 'ok';
    })()
  `);
  console.log('泛光接口:', hasApi);
  if (hasApi !== 'ok') {
    console.log('无法动态调泛光，退出');
    child.kill();
    process.exit(2);
  }

  const shoot = async () => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    return decodePng(Buffer.from(s.data, 'base64'));
  };

  // 固定在「半开」状态测量：这个状态最能同时反映核心与花瓣
  await evalJs(`window.__bloomSetTension(1); window.__bloomSnap(); 'x'`);
  await sleep(2200);

  const combos = [
    [0.35, 0.40, 0.55],
    [0.45, 0.42, 0.52],
    [0.55, 0.45, 0.48],
    [0.70, 0.45, 0.45],
    [0.85, 0.42, 0.50],
    [1.00, 0.40, 0.55],
  ];

  console.log('\n强度  半径  阈值 | 平均亮度  过曝%  发光%  边缘清晰度');
  console.log('-'.repeat(62));
  const rows = [];
  for (const [st, ra, th] of combos) {
    await evalJs(`window.__setBloom(${st}, ${ra}, ${th}); 'x'`);
    await sleep(1300);
    const m = analyze(await shoot());
    rows.push({ st, ra, th, ...m });
    console.log(
      `${st.toFixed(2)}  ${ra.toFixed(2)}  ${th.toFixed(2)} | ${String(m.平均亮度).padStart(8)}  ${String(m.过曝占比).padStart(5)}  ${String(m.发光像素占比).padStart(5)}  ${String(m.边缘清晰度).padStart(9)}`
    );
  }

  // 打分：亮度达标 + 不过曝 + 边缘清晰
  const score = (r) => {
    let s = 0;
    // 平均亮度目标 60~95
    if (r.平均亮度 >= 55 && r.平均亮度 <= 100) s += 3;
    else s += Math.max(0, 3 - Math.abs(r.平均亮度 - 77) / 30);
    // 过曝越少越好
    s += Math.max(0, 3 - r.过曝占比 / 2.5);
    // 边缘清晰度越高越好（归一化到 0~3）
    s += Math.min(3, r.边缘清晰度 / 4);
    return s;
  };

  rows.forEach((r, i) => (r.score = +score(r).toFixed(2)));
  const best = rows.reduce((a, b) => (b.score > a.score ? b : a));
  console.log('\n评分:');
  rows.forEach((r) =>
    console.log(`  ${r.st.toFixed(2)}/${r.ra.toFixed(2)}/${r.th.toFixed(2)} -> ${r.score}`)
  );
  console.log(`\n推荐: bloomStrength=${best.st}  bloomRadius=${best.ra}  bloomThreshold=${best.th}`);
  console.log(`  平均亮度 ${best.平均亮度} · 过曝 ${best.过曝占比}% · 边缘清晰度 ${best.边缘清晰度}`);

  ws.close();
  child.kill();
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  try { child.kill(); } catch {}
  process.exit(2);
});