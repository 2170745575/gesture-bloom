/**
 * 预加载 MediaPipe 资源
 *
 * 背景（都是实测出来的）：
 *
 *  1) GitHub Pages 对 .wasm/.data/.tflite **不做压缩**，
 *     而模型总量约 16 MB，国内访问实测只有 38 KB/s —— 要 7 分钟。
 *
 *  2) 原来的流程是「用户点了开启摄像头 → 才开始下载 → 90 秒超时放弃」，
 *     所以永远进不去。而且等待期间界面上只有一个"已等待 N 秒"，
 *     看起来就像卡死了。
 *
 *  3) 并行下载会互相抢带宽：7 个文件同时下时，
 *     一个 276 KB 的文件用了 86.6 秒（≈3 KB/s）。
 *
 * 所以这里改成：
 *  - 页面一加载就在**后台**开始预加载（不等用户点击）
 *  - **串行**下载，避免抢带宽
 *  - 实时把进度报给界面，让用户看到"下到第几个、多少 MB"
 *  - 资源经 Service Worker 落进 Cache Storage，第二次打开是瞬间的
 *
 * 即使这个模块整个失败，也不影响功能 —— 只是回到原来的按需下载。
 */

/** 需要预加载的文件，按「小的在前」排序，让进度条一开始就动起来 */
const ASSETS = [
  'hands.binarypb',
  'hands_solution_packed_assets_loader.js',
  'hands.js',
  'hands_solution_simd_wasm_bin.js',
  'hand_landmark_full.tflite',
  'hands_solution_packed_assets.data',
  'hands_solution_simd_wasm_bin.wasm',
];

/** 预估值（字节），用于在没有 Content-Length 时也能显示进度 */
const EST_SIZES = {
  'hands.binarypb': 550,
  'hands_solution_packed_assets_loader.js': 8327,
  'hands.js': 45581,
  'hands_solution_simd_wasm_bin.js': 276479,
  'hand_landmark_full.tflite': 5478688,
  'hands_solution_packed_assets.data': 4326731,
  'hands_solution_simd_wasm_bin.wasm': 6026259,
};

const BASE = './vendor/mediapipe/';
const CACHE_NAME = 'gesture-bloom-vendor-v1';

/**
 * 查 Cache Storage 里现在已经缓存了几个目标文件。
 *
 * 为什么不用「这次 fetch 花了多少毫秒」来判断命中：
 *   在本地 localhost 上一切都在 60ms 内完成，
 *   会把「真的下载了」误判成「命中缓存」（实测在全新缓存上也报 6/7）。
 *   直接查缓存内容是准确的，而且这正是要告诉用户的信息
 *   ——「已缓存，下次打开更快」。
 */
async function countCached() {
  if (!('caches' in window)) return 0;
  try {
    const cache = await caches.open(CACHE_NAME);
    let n = 0;
    for (const name of ASSETS) {
      // ignoreSearch：SW 存的时候可能带上查询串
      const hit = await cache.match(BASE + name, { ignoreSearch: true });
      if (hit) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** 注册 Service Worker（失败不影响功能） */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  // file:// 下不支持 SW
  if (location.protocol === 'file:') return null;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    // 等它真正激活，否则第一次访问时预加载不会被接管
    await navigator.serviceWorker.ready;
    return reg;
  } catch (err) {
    console.info('[preload] Service Worker 注册失败（不影响使用）：', err?.message || err);
    return null;
  }
}

/**
 * 串行预加载。
 *
 * @param {(p: {index:number,total:number,name:string,loadedBytes:number,totalBytes:number,done:boolean,cached:boolean}) => void} onProgress
 * @returns {Promise<{ok:boolean, bytes:number, cachedHits:number}>}
 */
export async function preloadMediaPipe(onProgress) {
  const totalBytes = ASSETS.reduce((s, n) => s + (EST_SIZES[n] || 0), 0);
  let loadedBytes = 0;
  let ok = true;

  // 开始前先看已经缓存了几个（第二次打开时应该全是命中）
  const cachedBefore = await countCached();

  // 直接听 Service Worker 报告的命中事件。
  // 这是「真的走了缓存」的直接证据 —— 比测耗时可靠得多
  // （在 localhost 上一切都在 60ms 内，按耗时判断会把下载误判成命中）。
  const hits = new Set();
  const onSwMessage = (ev) => {
    const m = ev.data;
    if (m && m.type === 'sw-hit' && m.url) hits.add(String(m.url).split('/').pop());
  };
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', onSwMessage);
  }

  for (let i = 0; i < ASSETS.length; i++) {
    const name = ASSETS[i];
    try {
      // 注意：必须 await 到响应返回。
      // Service Worker 是「读完整个流再返回 Response」，
      // 所以 await 完成时文件已经下完并落进缓存了。
      const res = await fetch(BASE + name);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      // 释放页面侧的内存（SW 那边已经存好了）
      try { await res.body?.cancel(); } catch {}
    } catch (err) {
      ok = false;
      console.info(`[preload] ${name} 预加载失败（后续交给 MediaPipe 自己按需加载）：`, err?.message || err);
    }

    loadedBytes += EST_SIZES[name] || 0;
    onProgress?.({
      index: i + 1, total: ASSETS.length, name,
      loadedBytes, totalBytes,
      done: i === ASSETS.length - 1,
    });
  }

  // 给 SW 的消息一点到达时间
  await new Promise((r) => setTimeout(r, 120));
  if (navigator.serviceWorker) {
    navigator.serviceWorker.removeEventListener('message', onSwMessage);
  }

  // 结束后再查一次缓存内容，这个数字是准确的
  const cachedAfter = await countCached();

  return {
    ok,
    bytes: loadedBytes,
    cachedBefore,
    cachedAfter,
    /** 本次有几个文件是 Service Worker 从缓存直接给的 */
    servedFromCache: hits.size,
  };
}

/** 供界面显示用：把字节数变成 "3.2 MB" */
export function formatMB(bytes) {
  return (bytes / 1048576).toFixed(1) + ' MB';
}

export const ASSET_TOTAL_BYTES = ASSETS.reduce((s, n) => s + (EST_SIZES[n] || 0), 0);
export const ASSET_COUNT = ASSETS.length;