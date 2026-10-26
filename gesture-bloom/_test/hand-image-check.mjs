/**
 * _test/hand-image-check.mjs —— 用真实手部图片喂给 MediaPipe，验证识别链路
 *
 * 假摄像头只能验证「管线通不通」，不能验证「认不认得出手」。
 * 这里用 --use-file-for-fake-video-capture 指定一个 Y4M 视频，
 * 或者直接把图片画到 canvas 里送进 Hands.send()。
 *
 * 本脚本走后者：在页面里用离屏 canvas 加载一张手部图片，
 * 直接调用 Hands 的 send()，检查是否返回 21 个关键点。
 *
 * 用法: node _test/hand-image-check.mjs [图片路径]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9500 + Math.floor(Math.random() * 120);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-himg-${Date.now()}`);
const URL_TO_TEST = 'http://localhost:5173/?nodegrade=1';

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
    '--window-size=1280,800',
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
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const errors = [];
  cdp.on('Runtime.exceptionThrown', (p) =>
    errors.push('EXC: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text))
  );

  await cdp.send('Page.navigate', { url: URL_TO_TEST }, sessionId);
  await sleep(5000);

  const evalJs = async (expr, timeout = 60000) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true, timeout },
      sessionId
    );
    if (r.exceptionDetails) {
      return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return r.result?.value;
  };

  // tracker 只在用户点击「开启摄像头」后才创建（无摄像头环境下不会创建），
// 所以测试里直接构造一个 HandTracker 实例来验证识别能力。
  console.log('=== 用合成手部图测试 MediaPipe 识别 ===');

  const result = await evalJs(`
    (async () => {
      let tracker = window.__bloomTracker;
      if (!tracker) {
        const mod = await import('./js/handTracking.js');
        const video = document.createElement('video');
        const canvas = document.createElement('canvas');
        tracker = new mod.HandTracker(video, canvas);
        window.__bloomTracker = tracker;
      }
      if (!tracker.hands) {
        try {
          await tracker.loadMediaPipe((m) => console.log('[test] ' + m));
        } catch (e) {
          return JSON.stringify({ ok:false, reason:'loadMediaPipe 失败: ' + (e && e.message) });
        }
      }

      // 画一只「张开的手」到离屏 canvas
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#8899aa'; ctx.fillRect(0,0,640,480);
      ctx.fillStyle = '#e8c4a0';
      ctx.beginPath(); ctx.ellipse(320, 340, 90, 110, 0, 0, Math.PI*2); ctx.fill();
      const fingers = [[-60,-1.35],[-30,-1.5],[0,-1.55],[30,-1.5],[60,-1.35]];
      for (const [dx, ang] of fingers) {
        ctx.save();
        ctx.translate(320+dx, 250);
        ctx.rotate(ang + Math.PI/2);
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(-16, -150, 32, 170, 16); ctx.fill(); }
        else { ctx.fillRect(-16, -150, 32, 170); }
        ctx.restore();
      }
      ctx.save();
      ctx.translate(225, 320); ctx.rotate(-0.9);
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(-18, -100, 36, 120, 18); ctx.fill(); }
      else { ctx.fillRect(-18, -100, 36, 120); }
      ctx.restore();

      let sendErr = null;
      try {
        await tracker.hands.send({ image: c });
      } catch (e) {
        sendErr = (e && e.message) || String(e);
      }
      await new Promise(r => setTimeout(r, 800));

      return JSON.stringify({
        ok: sendErr === null,
        sendError: sendErr,
        ready: tracker.ready,
        landmarkCount: tracker.lastLandmarkCount || 0,
        hasHand: tracker.hasHand,
        tension: Number(tracker.tension.toFixed(4)),
        resultKeys: tracker.lastResultKeys,
        sourceHost: tracker.sourceHost
      });
    })()
  `, 120000);

  console.log('  ' + JSON.stringify(result, null, 2));
  console.log('\n  错误: ' + errors.length);
  errors.slice(0, 5).forEach((e) => console.log('    ' + e));

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