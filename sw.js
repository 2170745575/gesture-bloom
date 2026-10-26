/* ==================================================================
 * Service Worker —— MediaPipe 资源缓存
 *
 * 为什么需要它（实测数据）：
 *
 *  1) GitHub Pages 的 Cache-Control 只有 max-age=600（10 分钟）。
 *     16 MB 的模型每 10 分钟就要重下一次，完全不可用。
 *     本 Service Worker 把资源存进 Cache Storage（持久化，不会过期），
 *     第二次打开是**瞬间**的。
 *
 *  2) GitHub Pages **不压缩** .wasm / .data / .tflite
 *     （实测 Content-Encoding: 无），6 MB 的 WASM 原样传输。
 *
 *  3) 并行请求会互相抢带宽。实测 7 个文件同时下时，
 *     一个 276 KB 的文件用了 86.6 秒（≈3 KB/s）；
 *     而单个文件顺序下载能到 38 KB/s。
 *     所以预加载走**串行**，并把实时进度报给页面。
 *
 * 设计要点：
 *  - 只接管 /vendor/ 下的请求。页面自身的 html/js 不缓存，
 *    这样更新代码后刷新就能看到，不会被旧缓存卡住。
 *  - 任何一步失败都退化成普通的网络请求，不影响功能。
 * ================================================================== */

const CACHE_NAME = 'gesture-bloom-vendor-v1';
const VENDOR_MARK = '/vendor/';

self.addEventListener('install', () => {
  // 新版本立即接管，不等旧页面关闭
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 清掉旧版本缓存（改了 CACHE_NAME 就会走到这里）
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('gesture-bloom-vendor-') && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // 只管同源的 vendor 资源
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.includes(VENDOR_MARK)) return;

  event.respondWith(handle(req));
});

/** 通知所有页面（用于显示进度） */
async function report(msg) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) c.postMessage(msg);
  } catch {
    /* 进度只是锦上添花，失败就算了 */
  }
}

async function handle(req) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) {
      await report({ type: 'sw-hit', url: req.url });
      return hit;
    }
  } catch {
    cache = null;
  }

  const res = await fetch(req);
  if (!res || !res.ok || !res.body || !cache) return res;

  const name = new URL(req.url).pathname.split('/').pop();
  const total = Number(res.headers.get('Content-Length')) || 0;

  // 边读边报进度，读完再写缓存。
  // 这样页面上能看到"下到第几个文件、多少 MB"，而不是一个转圈。
  try {
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      await report({ type: 'sw-progress', name, received, total });
    }

    const headers = new Headers(res.headers);
    const blob = new Blob(chunks, {
      type: headers.get('Content-Type') || 'application/octet-stream',
    });
    const out = new Response(blob, { status: 200, statusText: 'OK', headers });

    // 存一份（clone 一份用于返回）
    await cache.put(req, out.clone());
    await report({ type: 'sw-done', name, size: received, total });

    return out;
  } catch (err) {
    // 读流失败：退回普通请求，保证功能不受影响
    await report({ type: 'sw-error', name, message: String(err) });
    return fetch(req);
  }
}