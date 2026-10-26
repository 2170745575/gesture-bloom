/**
 * config.js —— 全局可调参数
 * 所有魔法数字集中在这里，方便调参。
 */

export const CONFIG = {
  /* ---------- 粒子 ---------- */
  particles: {
    /** 粒子总数，需求 5000~20000，可配置 */
    count: 18000,
    /**
     * 采样分布：花瓣轮廓是按极坐标采样的，
     * petals 越多，每个花瓣分配到的粒子越少。
     */
    petals: 8,
    /** 花瓣层数（多层嵌套，制造层次感） */
    layers: 3,
    /**
     * 花朵整体半径（世界单位）。
     * 调大不只是"变大"——它同时提高花朵在画面中的覆盖率，
     * 而覆盖率是"看起来亮不亮"的关键：实测覆盖率 11% 时
     * 虽然花朵像素已达 223/255，整体观感依然偏暗（背景占 85%）。
     */
    radius: 2.72,
    /** 花苞状态的整体缩放（聚合程度） */
    budScale: 0.3,
    /** 花苞状态的 z 轴压扁（收紧成一个球） */
    budFlatten: 0.72,
    /** 粒子基础尺寸（像素，受 DPR 与透视影响）。
    尺寸影响「每颗粒子贡献多少光」，但过大会让粒子互相糊在一起。 */
    size: 2.35,
    /** 每层粒子的半径比例（内层收得更小，避免中心堆叠过曝） */
    layerRadii: [1.0, 0.66, 0.36],
    /** 每层粒子的亮度权重 */
    layerWeights: [1.0, 0.78, 0.55],
    /** 每层花瓣数量的倍率（内层更少花瓣，像花蕊） */
    layerPetals: [1, 0.62, 0.38],
  },

  /* ---------- 手势 ---------- */
  gesture: {
    /** 低于此值判定为握拳（花苞） */
    budThreshold: 0.32,
    /** 高于此值判定为完全绽放 */
    bloomThreshold: 0.66,
    /**
     * 缓动系数：currentSpread += (target - current) * easing
     * 需求指定 0.1，这里按帧率做了 deltaTime 归一化（见 main.js），
     * 保证 30Hz 与 120Hz 屏幕手感一致。
     */
    easing: 0.1,
    /** tension 的额外低通平滑（作用于原始信号，更抗抖） */
    smoothing: 0.28,
    /** 手部离开画面后，tension 回落速度 */
    lostDecay: 0.035,
    /** 手掌位置跟随的平滑系数 */
    positionSmoothing: 0.09,
  },

  /* ---------- 渲染 ---------- */
  render: {
    /** 设备像素比上限，移动端防止过载 */
    maxPixelRatio: 2,
    /** 相机视野 */
    fov: 46,
    /** 相机初始距离 */
    cameraDistance: 6.4,
    /** 泛光。这是「看起来亮不亮」的最大杠杆，但也是最容易毁掉细节的地方：
    实测强度 1.15 时边缘清晰度从 21 掉到 2.9，整朵花糊成一个白盘。
    所以宁可让粒子本体亮一些，泛光只做「光晕」这一层，不做主要亮度来源。 */
    bloomStrength: 0.48,
    bloomRadius: 0.32,
    bloomThreshold: 0.62,
    /** 移动端自动降级：粒子数缩放 & 关闭泛光 */
    mobileParticleScale: 0.55,
  },

  /* ---------- 摄像头 ---------- */
  camera: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    facingMode: 'user',
  },

  /* ---------- MediaPipe ---------- */
  mediapipe: {
    /** 同时检测的手部数量 */
    maxNumHands: 1,
    /** 检测置信度 */
    minDetectionConfidence: 0.62,
    minTrackingConfidence: 0.55,
    /** Hands 构造函数与资源，按顺序尝试（第一个成功即用） */
    scriptUrls: [
      // 首选本地：MediaPipe 全套约 15MB，其中 6MB 的 WASM 在慢网络下
      // 实测可卡 40+ 秒（停在 "wasm-instantiate" 依赖上），
      // 本地化后完全没有这个等待。
      './vendor/mediapipe/hands.js',
      'https://unpkg.com/@mediapipe/hands@0.4.1675469240/hands.js',
      'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js',
    ],
    /**
     * locateFile 基址列表，与 scriptUrls 一一对应。
     * MediaPipe 会从这里拉 wasm / 打包数据 / .tflite 模型等资源。
     */
    assetBases: [
      './vendor/mediapipe/',
      'https://unpkg.com/@mediapipe/hands@0.4.1675469240/',
      'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/',
    ],
    /**
     * 只有这些文件才需要我们从外部提供地址；
     * 其余（尤其 .tflite 模型）由 hands_solution_packed_assets.data 内部提供。
     *
     * 实测：MediaPipe 会先请求 hand_landmark_full.tflite，
     * 再用 overrideFile() 把打包资源里解出来的同名文件覆盖上去。
     * 这个请求必须成功返回，否则会报 'Not ' should be 'TFL3' 并 abort。
     */
    externalFilePattern:
      /\.(wasm|data|binarypb|tflite)$|_packed_assets_loader\.js$|_wasm_bin\.js$/i,
    /** 当前选中的资源基址（加载成功后写入） */
    activeBase: './vendor/mediapipe/',
    locateFile: (file) =>
      `${CONFIG.mediapipe.activeBase}${file}`,
  },

  /* ---------- 花朵配色 ---------- */
  colors: {
    /** 花心颜色（偏暖但不过曝；加法混合下纯白很容易糊成一片） */
    core: [0.92, 0.62, 0.32],
    /** 花瓣根部颜色 */
    petalInner: [0.95, 0.40, 0.62],
    /** 花瓣外缘颜色 */
    petalOuter: [0.42, 0.62, 1.0],
    /** 外层点缀色 */
    accent: [0.72, 0.42, 1.0],
  },
};

/** 按设备能力生成实际生效的配置（移动端降级） */
export function resolveRuntimeConfig() {
  const isMobile =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    ) ||
    (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);

  // 深拷贝数据部分，但要跳过函数字段：
  // structuredClone / JSON 都无法处理函数（前者直接抛 DataCloneError），
  // 所以这里对 mediapipe 单独浅拷贝，函数字段在下面显式重新挂上。
  const { mediapipe: mpSrc, ...rest } = CONFIG;
  const cfg = {
    ...JSON.parse(JSON.stringify(rest)),
    mediapipe: {
      // 只拷贝可序列化的字段，函数与数组单独处理
      maxNumHands: mpSrc.maxNumHands,
      minDetectionConfidence: mpSrc.minDetectionConfidence,
      minTrackingConfidence: mpSrc.minTrackingConfidence,
      scriptUrls: [...mpSrc.scriptUrls],
      assetBases: [...mpSrc.assetBases],
      activeBase: mpSrc.activeBase,
      locateFile: mpSrc.locateFile,
    },
  };

  if (isMobile) {
    cfg.particles.count = Math.round(
      CONFIG.particles.count * CONFIG.render.mobileParticleScale
    );
    // 移动端屏幕小、像素密度高，粒子要更小才不至于糊成一片
    cfg.particles.size = CONFIG.particles.size * 0.85;
    cfg.render.bloomStrength = 0.3;
    cfg.render.maxPixelRatio = Math.min(CONFIG.render.maxPixelRatio, 1.75);
  }

  cfg.isMobile = isMobile;
  return cfg;
}