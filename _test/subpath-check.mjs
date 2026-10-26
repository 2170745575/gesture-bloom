/**
 * _test/subpath-check.mjs —— 模拟 GitHub Pages 的「子目录部署」
 *
 * GitHub Pages 会把站点挂在 https://用户名.github.io/仓库名/ 这种子目录下。
 * 绝对路径（/js/main.js）在这种环境下会 404，是部署后最常见的翻车点。
 *
 * 这个脚本在**父目录**起一个静态服务器，于是项目被挂在 /gesture-bloom/ 下，
 * 与 GitHub Pages 的路径结构一致，然后完整走一遍：
 *   页面加载 → 所有资源 200 → MediaPipe 加载 → 无控制台错误
 *
 * 用法: node _test/subpath-check.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');           // .../gesture-bloom
const PARENT = path.resolve(PROJECT, '..');              // 父目录（作为站点根）
const MOUNT = '/' + path.basename(PROJECT);              // /gesture-bloom

const HTTP_PORT = 5180;
const CDP_PORT = 6100 + Math.floor(Math.random() * 100);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userDataDir = path.join(os.tmpdir(), `edge-sub-${Date.now()}`);

/* ---------------- 父目录静态服务器 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.binarypb': 'application/octet-stream',
  '.ico': 'image/x-icon',
};

const requests = [];
const server = http.createServer((req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad');
    return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(PARENT, p);
  // 防穿越
  if (!path.resolve(file).startsWith(path.resolve(PARENT))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      requests.push({ url: p, status: 404 });
      res.writeHead(404).end('404');
      return;
    }
    requests.push({ url: p, status: 200 });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
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

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}  ${d}`); }
};

(async () => {
  await new Promise((r) => server.listen(HTTP_PORT, '127.0.0.1', r));
  const url = `http://localhost:${HTTP_PORT}${MOUNT}/`;
  console.log(`模拟 GitHub Pages 子目录部署`);
  console.log(`  站点根: ${PARENT}`);
  console.log(`  项目挂载于: ${MOUNT}/`);
  console.log(`  访问地址: ${url}\n`);

  const child = spawn(EDGE, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--hide-scrollbars', '--window-size=1280,800',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDataDir,
    'about:blank',
  ], { stdio: 'ignore' });

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
    errors.push('EXC: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') errors.push('LOG: ' + p.entry.text);
  });

  await cdp.send('Page.navigate', { url }, sessionId);
  await sleep(8000);

  const ev = async (e) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression: e, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
    return r.result?.value;
  };

  /* ---------- 1. 页面是否加载 ---------- */
  console.log('=== 1. 页面加载 ===');
  const dbg = await ev('window.__bloomDebug ? JSON.stringify(window.__bloomDebug()) : null');
  check('页面脚本已执行（__bloomDebug 存在）', dbg && !dbg.__err, String(dbg).slice(0, 120));
  if (dbg && !dbg.__err) {
    const d = JSON.parse(dbg);
    check('粒子系统已创建', d.particles > 0, `particles=${d.particles}`);
    check('着色器无编译错误', !d.shaderError, String(d.shaderError).slice(0, 160));
    console.log(`    粒子=${d.particles} 泛光=${d.bloom} 形态=${d.shape}`);
  }

  /* ---------- 2. 资源是否都从子目录正确加载 ---------- */
  console.log('\n=== 2. 资源请求（关键：路径都带子目录前缀）===');
  const notFound = requests.filter((r) => r.status === 404);
  const bad = requests.filter((r) => r.status === 200 && !r.url.startsWith(MOUNT));
  console.log(`    共 ${requests.length} 个请求，404 ${notFound.length} 个`);
  if (notFound.length) {
    notFound.slice(0, 10).forEach((r) => console.log(`      404: ${r.url}`));
  }
  check('没有 404 资源', notFound.length === 0, `${notFound.length} 个 404`);
  check('所有资源都在子目录下（无绝对路径泄漏）', bad.length === 0,
    bad.slice(0, 5).map((r) => r.url).join(', '));

  const vendorOk = requests.filter((r) => r.url.includes('/vendor/') && r.status === 200).length;
  check('本地依赖已从子目录加载（three + mediapipe）', vendorOk >= 5, `只加载了 ${vendorOk} 个 vendor 资源`);

  /* ---------- 3. MediaPipe 在子目录下能否加载 ---------- */
  console.log('\n=== 3. MediaPipe（子目录 + WASM）===');
  await ev(`document.getElementById('start-btn').click(); 'x'`);
  let mpOk = false;
  for (let i = 0; i < 24; i++) {
    await sleep(1500);
    const st = await ev(`JSON.stringify({
      status: document.getElementById('status')?.textContent || '',
      cls: document.getElementById('status')?.className || '',
      overlay: document.getElementById('overlay')?.classList.contains('hidden'),
      gesture: window.__bloomDebug ? window.__bloomDebug().gestureActive : false
    })`);
    if (st && !st.__err) {
      const s = JSON.parse(st);
      if (i % 3 === 0) console.log(`    [${((i + 1) * 1.5).toFixed(0)}s] ${s.status.slice(0, 60)}`);
      if (s.gesture) { mpOk = true; break; }
      if (s.cls === 'error') { console.log(`    错误: ${s.status}`); break; }
    }
  }
  check('MediaPipe 在子目录下成功初始化', mpOk);

  const mpReqs = requests.filter((r) => r.url.includes('mediapipe'));
  mpReqs.forEach((r) => console.log(`    ${r.status}  ${r.url}`));
  const mp404 = mpReqs.filter((r) => r.status === 404);
  check('MediaPipe 资源无 404', mp404.length === 0, `${mp404.length} 个 404`);

  /* ---------- 4. 控制台 ---------- */
  console.log('\n=== 4. 控制台 ===');
  // 忽略与路径无关的噪音
  const realErrors = errors.filter((e) => !/QUIC|ERR_|favicon/i.test(e));
  check('无控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  realErrors.slice(0, 5).forEach((e) => console.log(`    ${e.slice(0, 160)}`));

  console.log(`\n  通过 ${pass} / ${pass + fail}`);

  ws.close();
  child.kill();
  server.close();
  await sleep(300);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('HARNESS ERROR', e);
  try { server.close(); } catch {}
  process.exit(2);
});