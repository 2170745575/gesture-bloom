/**
 * server.js —— 零依赖本地静态服务器
 *
 * 用途：摄像头 API 需要安全上下文（HTTPS 或 localhost），
 *       直接双击打开 file:// 无法使用。用这个脚本启动 http://localhost。
 *
 * 运行：
 *   node server.js
 *   node server.js 8080
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  // 防目录穿越：
  //   1. 先 posix.normalize 消掉 ".." 段；
  //   2. 解析成绝对路径后用 path.relative 判断是否越出根目录。
  // 不能只用 startsWith 做前缀判断——"/root-evil" 会误判通过。
  const root = path.resolve(__dirname);
  const safePath = path.posix.normalize('/' + urlPath);
  const resolved = path.resolve(root, '.' + safePath);
  const rel = path.relative(root, resolved);
  const escapes = rel.startsWith('..') || path.isAbsolute(rel);

  if (escapes || !safePath.startsWith('/')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      if (process.env.LOG_REQUESTS) {
        console.log(`  404  ${req.method} ${urlPath}`);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    if (process.env.LOG_REQUESTS) {
      console.log(`  200  ${req.method} ${urlPath}  (${stat.size} bytes)`);
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // MediaPipe 用到的 SharedArrayBuffer / WASM 需要跨源隔离时可用；
      // 这里保持宽松，仅本地开发使用。
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(resolved).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🌸 指尖花开 · Gesture Bloom');
  console.log('  ─────────────────────────────────────');
  console.log(`  本地地址:  http://${HOST}:${PORT}`);
  console.log(`  局域网:    http://<你的IP>:${PORT}   (手机调试用，需 HTTPS 才能开摄像头)`);
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，试试： node server.js ${PORT + 1}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});