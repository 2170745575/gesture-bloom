/**
 * _test/brightness-check.mjs —— 量化画面亮度
 *
 * 不看截图凭感觉调，而是直接算：
 *   · 平均亮度 / 中位亮度
 *   · 高光像素占比（过曝程度）
 *   · 暗部像素占比（太暗程度）
 *   · 花朵区域的覆盖像素数（形态是否清晰）
 *
 * 用法: node _test/brightness-check.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9400 + Math.floor(Math.random() * 100);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-bright-${Date.now()}`);
const URL_TO_TEST = process.argv[2] || 'http://localhost:5173/?nodegrade=1';

const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--window-size=1000,700',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDataDir,
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

/**
 * 在页面里用 canvas 读回 WebGL 画面并统计亮度。
 * 注意：WebGL 画布若 preserveDrawingBuffer=false，直接 drawImage 可能拿到空白，
 * 所以这里用 CDP 截图后在 Node 侧解码统计（见下）。
 */

// 极简 PNG 解码（只处理我们截图产生的 8-bit RGBA/RGB 非隔行 PNG）
import zlib from 'node:zlib';

function decodePng(buf) {
  let pos = 8; // 跳过签名
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('仅支持 8-bit PNG, got ' + bitDepth);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('不支持的 colorType ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pr) & 0xff;
          break;
        }
        default: throw new Error('未知 filter ' + filter);
      }
      cur[x] = v;
    }
  }
  return { width, height, channels, data: out };
}

function analyze(png) {
  const { width, height, channels, data } = png;
  // 只统计画面中心区域（避开 HUD），取中间 60%
  const x0 = Math.floor(width * 0.2), x1 = Math.floor(width * 0.8);
  const y0 = Math.floor(height * 0.18), y1 = Math.floor(height * 0.88);

  let sum = 0, n = 0;
  let bright = 0, hot = 0, dim = 0, lit = 0;
  const hist = new Array(16).fill(0);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // 感知亮度
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum; n++;
      hist[Math.min(15, Math.floor(lum / 16))]++;
      if (lum > 200) bright++;      // 高光
      if (lum > 245) hot++;         // 接近过曝
      if (lum < 20) dim++;          // 暗部
      if (lum > 45) lit++;          // 有效发光像素
    }
  }

  return {
    平均亮度: +(sum / n).toFixed(2),
    高光占比: +((bright / n) * 100).toFixed(2),
    过曝占比: +((hot / n) * 100).toFixed(2),
    暗部占比: +((dim / n) * 100).toFixed(2),
    发光像素占比: +((lit / n) * 100).toFixed(2),
    直方图: hist.map((v) => +((v / n) * 100).toFixed(1)),
    尺寸: `${width}x${height}`,
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
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true },
      sessionId
    );
    return r.result?.value;
  };

  // 关掉 HUD 与遮罩，只留粒子
  await evalJs(`
    document.getElementById('overlay').classList.add('hidden');
    document.body.classList.remove('show-skeleton','cam-on');
    for (const id of ['hud-tl','hud-tr','hud-bl','vignette']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    'ok'
  `);

  const results = {};
  for (const [name, tension] of [['bud', 0], ['mid', 0.5], ['bloom', 1]]) {
    await evalJs(`window.__bloomSetTension(${tension}); 'x'`);
    await sleep(2000);
    await evalJs(`window.__bloomSetTension(${tension}); window.__bloomSnap(); 'x'`);
    await sleep(800);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const png = decodePng(Buffer.from(shot.data, 'base64'));
    results[name] = analyze(png);

    fs.writeFileSync(`_test/bright-${name}.png`, Buffer.from(shot.data, 'base64'));
  }

  console.log(JSON.stringify(results, null, 2));

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