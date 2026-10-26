/**
 * _test/perceptual-brightness.mjs —— 按「人眼感受」而非「全画面平均」来评估
 *
 * 之前的 brightness-check 统计整幅画面的平均亮度，但这个指标会骗人：
 * 花朵只占画面约 1/3，剩下 2/3 是近黑的背景，
 * 于是「平均亮度 110」里其实混进了大量背景像素。
 *
 * 这里改成分别统计：
 *   · 花朵像素的平均亮度（只统计发光区域）—— 这才是「看起来亮不亮」
 *   · 背景平均亮度                    —— 决定了画面是否「通透」
 *   · 花朵覆盖率                      —— 画面是否够「满」
 *   · 高光/中间调/暗部的分布
 *
 * 用法: node _test/perceptual-brightness.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 8800 + Math.floor(Math.random() * 90);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-perc-${Date.now()}`);
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
  const channels = colorType === 6 ? 4 : 3;
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
  const x0 = Math.floor(width * 0.18), x1 = Math.floor(width * 0.82);
  const y0 = Math.floor(height * 0.14), y1 = Math.floor(height * 0.90);

  let flowerSum = 0, flowerN = 0;   // 发光像素（花朵本体）
  let bgSum = 0, bgN = 0;           // 非发光像素（背景）
  let hot = 0, mid = 0, dark = 0, n = 0;
  // 发光阈值：明显高于背景的像素
  const LIT = 55;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * channels;
      const L = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      n++;
      if (L >= LIT) { flowerSum += L; flowerN++; }
      else { bgSum += L; bgN++; }
      if (L > 235) hot++;
      else if (L > 90) mid++;
      else if (L < 25) dark++;
    }
  }

  return {
    花朵平均亮度: flowerN ? +(flowerSum / flowerN).toFixed(1) : 0,
    背景平均亮度: bgN ? +(bgSum / bgN).toFixed(1) : 0,
    花朵覆盖率: +((flowerN / n) * 100).toFixed(1),
    高光占比: +((hot / n) * 100).toFixed(1),
    中间调占比: +((mid / n) * 100).toFixed(1),
    近黑占比: +((dark / n) * 100).toFixed(1),
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

  const results = {};
  for (const [name, tension] of [['bud', 0], ['mid', 0.5], ['bloom', 1]]) {
    await evalJs(`window.__bloomSetTension(${tension}); window.__bloomSnap(); 'x'`);
    await sleep(2400);
    results[name] = analyze(await shoot());
    fs.writeFileSync(`_test/perc-${name}.png`,
      Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)).data, 'base64'));
  }

  console.log('=== 按「花朵像素」而非「全画面平均」评估 ===\n');
  console.log('状态   花朵平均亮度  背景平均亮度  花朵覆盖率  高光%  中间调%  近黑%');
  console.log('-'.repeat(72));
  for (const [k, v] of Object.entries(results)) {
    console.log(
      `${k.padEnd(6)} ${String(v.花朵平均亮度).padStart(11)} ${String(v.背景平均亮度).padStart(12)} ` +
      `${String(v.花朵覆盖率 + '%').padStart(10)} ${String(v.高光占比).padStart(6)} ` +
      `${String(v.中间调占比).padStart(7)} ${String(v.近黑占比).padStart(6)}`
    );
  }

  console.log('\n=== 判读 ===');
  const b = results.bloom;
  if (b.花朵平均亮度 < 120) console.log('  ⚠ 花朵自身偏暗 → 需要提高粒子能量');
  else if (b.花朵平均亮度 > 215) console.log('  ⚠ 花朵接近过曝 → 会失去层次');
  else console.log('  ✓ 花朵亮度在合理区间');

  if (b.花朵覆盖率 < 20) console.log('  ⚠ 花朵占画面比例小 → 视觉存在感弱，可考虑放大或增多粒子');
  else console.log('  ✓ 花朵覆盖率合理');

  if (b.背景平均亮度 < 8) console.log('  ⚠ 背景几乎全黑 → 画面显得"闷"，可提高星尘密度/亮度');
  else console.log('  ✓ 背景有层次');

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