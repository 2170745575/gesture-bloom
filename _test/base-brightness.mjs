/**
 * _test/base-brightness.mjs —— 关掉泛光，单独测「粒子本体」的亮度
 *
 * 泛光只是放大器。如果关掉泛光画面依然过曝，说明粒子本体就已经太亮，
 * 这时候再怎么调泛光参数都是白费力气。
 *
 * 用法: node _test/base-brightness.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 9100 + Math.floor(Math.random() * 90);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-base-${Date.now()}`);
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
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const L = lum(x, y); sum += L; n++;
    if (L > 245) hot++;
    if (L > 45) lit++;
  }
  let gradSum = 0, gradN = 0;
  for (let y = y0 + 1; y < y1 - 1; y += 2) for (let x = x0 + 1; x < x1 - 1; x += 2) {
    const gx = lum(x + 1, y) - lum(x - 1, y);
    const gy = lum(x, y + 1) - lum(x, y - 1);
    gradSum += Math.hypot(gx, gy); gradN++;
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

  const shoot = async () => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    return decodePng(Buffer.from(s.data, 'base64'));
  };

  console.log('=== 关掉泛光后，粒子本体的亮度 ===');
  await evalJs(`(window.__bloomExposeScene && window.__bloomExposeScene()).setBloomEnabled(false); 'x'`);
  await evalJs(`window.__bloomSetTension(1); window.__bloomSnap(); 'x'`);
  await sleep(2500);

  const noBloom = analyze(await shoot());
  console.log('  ' + JSON.stringify(noBloom));
  fs.writeFileSync('_test/base-nobloom.png',
    Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)).data, 'base64'));

  console.log('\n=== 打开泛光（当前参数）===');
  await evalJs(`(window.__bloomExposeScene && window.__bloomExposeScene()).setBloomEnabled(true); 'x'`);
  await sleep(1800);
  const withBloom = analyze(await shoot());
  console.log('  ' + JSON.stringify(withBloom));

  console.log('\n=== 结论 ===');
  if (noBloom.过曝占比 > 15) {
    console.log('  粒子本体已经过曝 —— 需要降低粒子能量，调泛光没用');
  } else {
    console.log('  粒子本体正常，问题在泛光强度');
  }
  console.log(`  泛光带来的亮度增益: +${(withBloom.平均亮度 - noBloom.平均亮度).toFixed(1)}`);

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