/**
 * flowerGeometry.js —— 用极坐标花瓣函数生成花朵粒子几何体
 *
 * 核心公式（玫瑰线 / 花瓣函数）：
 *
 *   骨架上，第 k 个花瓣的轮廓半径：
 *     r(θ) = R · [ base + amp · |cos(p/2 · θ + φ)|^sharp ]
 *
 *   其中 p = 花瓣数。
 *     · 当 p 为偶数时，|cos(p/2·θ)| 在 [0,2π) 上有 p 个凸起；
 *     · sharp 控制花瓣的胖瘦（越大越尖）；
 *     · base 是花心的最小半径，避免花瓣之间塌缩到 0。
 *
 *   为了得到“有厚度的花瓣”而不是一条曲线，对每片花瓣建立局部二维花瓣面：
 *     u ∈ [-1,1]  沿花瓣宽度方向
 *     v ∈ [ 0,1]  沿花瓣长度方向（0 = 花心，1 = 花瓣尖端）
 *
 *     halfWidth(v) = W · sin(π · v^0.72) · (1 - 0.28·v)     ← 花瓣横向半宽轮廓
 *     petalLen     = L · (0.85 + 0.3·|cos(p/2·θ_k)|)        ← 每片花瓣长度微变化
 *
 *     x = petalLen · v · cos(θ_k) - halfWidth · u · sin(θ_k)
 *     z = petalLen · v · sin(θ_k) + halfWidth · u · cos(θ_k)
 *
 *   最后叠加上卷曲（花瓣向外翻）与噪声，得到自然的形态。
 *
 * 每个粒子会拿到两组位置：
 *   aPosBloom —— 绽放时的位置（大而舒展）
 *   aPosBud   —— 花苞时的位置（紧收成纺锤形）
 * 顶点着色器用 spread 在两者之间插值，因此切换状态不需要 CPU 重算。
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * 伪随机 / 噪声（确定性，保证每次刷新形态一致）
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * 花瓣轮廓
 * ------------------------------------------------------------------ */

/**
 * 花瓣径向轮廓：给定角度返回归一化半径 [0,1]
 *
 * sharp 越小，花瓣越圆润（宽而钝）；越大越尖锐。
 * 取 0.75 左右能得到「圆花瓣」而不是「星形尖刺」。
 */
function petalProfile(theta, petals, sharp) {
  const c = Math.abs(Math.cos((petals / 2) * theta));
  return Math.pow(c, sharp);
}

/* ------------------------------------------------------------------ *
 * 主生成函数
 * ------------------------------------------------------------------ */

/**
 * @param {object} cfg CONFIG.particles
 * @returns {{geometry: THREE.BufferGeometry, count:number}}
 */
export function createFlowerGeometry(cfg) {
  const {
    count,
    petals,
    layers,
    radius,
    layerRadii,
    layerWeights,
    layerPetals,
  } = cfg;

  const positions0 = new Float32Array(count * 3); // 绽放位置
  const positions1 = new Float32Array(count * 3); // 花苞位置
  const aRandom = new Float32Array(count);        // 每粒子随机数（闪烁用）
  const aSeed = new Float32Array(count * 4);      // 随机种子 vec4
  const aLayer = new Float32Array(count);         // 层索引 [0,1]
  const aColor = new Float32Array(count * 3);     // 颜色
  const aSize = new Float32Array(count);          // 尺寸倍率
  const aPhase = new Float32Array(count);         // 相位（呼吸/旋转）
  const aPetal = new Float32Array(count);         // 所属花瓣角度，供跟随手指用

  const rand = mulberry32(20261026);

  const cCore = cfg._core || [1.0, 0.86, 0.55];
  const cInner = cfg._inner || [1.0, 0.45, 0.72];
  const cOuter = cfg._outer || [0.42, 0.62, 1.0];
  const cAccent = cfg._accent || [0.72, 0.42, 1.0];

  let idx = 0;

  for (let layer = 0; layer < layers; layer++) {
    const layerT = layers > 1 ? layer / (layers - 1) : 0; // 0 = 外层, 1 = 最内层
    const layerRadius = radius * (layerRadii[layer] ?? 1);
    const layerWeight = layerWeights[layer] ?? 1;
    const layerPetalCount = Math.max(3, Math.round(petals * (layerPetals[layer] ?? 1)));

    // 本层粒子数：外层多、内层少，且带一点随机抖动
    const layerShareBase =
      layer === 0 ? 0.5 : layer === 1 ? 0.32 : 1 - 0.5 - 0.32;
    const layerCount =
      layer === layers - 1
        ? count - idx
        : Math.round(count * layerShareBase);

    for (let i = 0; i < layerCount && idx < count; i++, idx++) {
      // ---- 选择花瓣 & 花瓣内局部参数 ----
      const petalIndex = Math.floor(rand() * layerPetalCount);
      // 在花瓣内均匀撒点，但让粒子更集中在轮廓边缘（视觉更像花瓣）。
      // 注意起点 0.06 → 0.16：花心处留出一点空隙，
      // 否则所有花瓣的根部都堆在原点，加法混合会烧成一个白斑。
      // v 用接近均匀的分布（0.85 的幂只做轻微偏向），
      // 避免粒子在花瓣尖端堆成一个亮斑。
      const vBias = Math.pow(rand(), 0.85);       // 沿长度 v ∈ [0,1]
      const v = 0.16 + vBias * 0.84;
      // u ∈ [-1,1] 沿花瓣宽度方向。
      // 必须用「均匀分布」而不是 sqrt 分布：sqrt 会把粒子推到 |u|≈1 的
      // 边缘，花瓣就变成一个空心的轮廓（V 字形描边），中间没有肉。
      const u = rand() * 2 - 1;

      const baseAngle = (petalIndex / layerPetalCount) * Math.PI * 2;
      // 每片花瓣的相位扰动（要小，否则相邻花瓣会互相糊在一起）
      const angleJitter = (rand() - 0.5) * 0.05;
      const theta = baseAngle + angleJitter;

      // ---- 花瓣长度（用极坐标轮廓调制，让花瓣长短不一）----
      // profile 在花瓣中心处 ≈1、在花瓣间隙处 ≈0。
      // 注意：petalLen 同时控制「花瓣有多长」和「有多少粒子能伸到那么远」，
      // 因为 v 的上限由它缩放——这样花瓣才是有弧度的圆瓣，而不是等长的尖刺。
      //
      // 系数从 0.48 收到 0.40、基准从 0.58 提到 0.66：
      // 让花瓣「更短更饱满」。之前全长差太大（0.58~1.06 倍半径），
      // 绽放后花瓣拉得很长很散，看起来像一团发散的尘埃；现在收拢一些，
      // 花瓣之间仍然分明，但整体轮廓更接近一朵完整的花。
      const profile = petalProfile(theta, layerPetalCount, 0.75);
      const petalLen = layerRadius * (0.66 + 0.40 * profile);

      // ---- 花瓣横向半宽 ----
      // 系数从 0.34 收到 0.26：花瓣之间要留出可见的缝隙，
      // 否则 8 片花瓣会连成一整块圆形色斑，看不出花瓣数。
      const halfWidth = petalLen * 0.26 * Math.sin(Math.PI * Math.pow(v, 0.72)) * (1 - 0.26 * v);

      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      // ---- 绽放位置 ----
      let x = petalLen * v * cosT - halfWidth * u * sinT;
      let z = petalLen * v * sinT + halfWidth * u * cosT;

      // 花瓣向外翻卷：越靠尖端越往上抬，形成碗状花冠
      const curl = Math.pow(v, 1.7) * 0.62 * (0.6 + 0.4 * layerT);
      let y = curl * layerRadius * 0.5;
      // 横向的浅碗形：中间低、两边翘，但幅度要小，避免又变成只有边缘有粒子
      y += u * u * layerRadius * 0.07 * v;
      // 内层抬高，形成立体的花蕊
      y += layerT * layerRadius * 0.18;

      // 自然噪声（幅度要小，否则花瓣边界会糊掉）
      const nAmp = layerRadius * 0.012;
      x += (rand() - 0.5) * nAmp;
      y += (rand() - 0.5) * nAmp * 1.6;
      z += (rand() - 0.5) * nAmp;

      // ---- 花苞位置 ----
      // 收拢成一个水滴形花蕾：底部饱满、向上收尖。
      // budRadius 太小会让花苞变成一根细管，失去「花蕾」的体积感。
      const budRadius = layerRadius * 0.34;
      const budV = v;
      // 横向半径沿高度先饱满后收尖（水滴轮廓）
      const budTaper = Math.sin(Math.PI * Math.pow(0.18 + budV * 0.82, 0.85)) * 0.75 + 0.35;
      const bx = Math.cos(theta) * budRadius * budTaper - halfWidth * u * sinT * 0.42;
      const bz = Math.sin(theta) * budRadius * budTaper + halfWidth * u * cosT * 0.42;
      // 竖向稍微拉长，让花苞比绽放态更高挑
      const by = (budV - 0.46) * layerRadius * 0.82 + Math.abs(u) * 0.05;
      // 花苞中轴微微内凹，形成花蕾的弧线
      const bulge = 1 - Math.pow(Math.abs(by) / (layerRadius * 0.92), 2);

      positions0[idx * 3 + 0] = x;
      positions0[idx * 3 + 1] = y;
      positions0[idx * 3 + 2] = z;

      positions1[idx * 3 + 0] = bx * Math.max(bulge, 0.18);
      positions1[idx * 3 + 1] = by;
      positions1[idx * 3 + 2] = bz * Math.max(bulge, 0.18);

      // ---- 颜色 ----
      // 从花心暖黄 → 花瓣中部粉 → 外缘青蓝 的渐变
      const radialT = Math.min(1, (petalLen * v) / (radius * 1.02)); // 距花心远近
      let r, g, b;
      if (radialT < 0.34) {
        const t = radialT / 0.34;
        r = cCore[0] + (cInner[0] - cCore[0]) * t;
        g = cCore[1] + (cInner[1] - cCore[1]) * t;
        b = cCore[2] + (cInner[2] - cCore[2]) * t;
      } else {
        const t = (radialT - 0.34) / 0.66;
        r = cInner[0] + (cOuter[0] - cInner[0]) * t;
        g = cInner[1] + (cOuter[1] - cInner[1]) * t;
        b = cInner[2] + (cOuter[2] - cInner[2]) * t;
      }
      // 外层掺入紫色点缀
      const accentMix = layerT * 0.0 + (layer === 2 ? 0.35 : 0) + Math.pow(radialT, 3) * 0.2;
      r += (cAccent[0] - r) * accentMix * 0.4;
      g += (cAccent[1] - g) * accentMix * 0.4;
      b += (cAccent[2] - b) * accentMix * 0.4;
      // 边缘提亮，制造光晕感。
      // 注意：颜色是加法混合下的叠加权重，必须夹在 1.0 以内，
      // 否则几万个粒子互相叠加会直接饱和成白色，丢掉花瓣形态。
      const edgeGlow = Math.pow(Math.abs(u), 2) * 0.22 + Math.pow(v, 4) * 0.18;
      r = Math.min(1.0, r + edgeGlow * 0.28);
      g = Math.min(1.0, g + edgeGlow * 0.24);
      b = Math.min(1.0, b + edgeGlow * 0.30);

      aColor[idx * 3 + 0] = r;
      aColor[idx * 3 + 1] = g;
      aColor[idx * 3 + 2] = b;

      // ---- 其他属性 ----
      aRandom[idx] = rand();
      aSeed[idx * 4 + 0] = rand();
      aSeed[idx * 4 + 1] = rand();
      aSeed[idx * 4 + 2] = rand();
      aSeed[idx * 4 + 3] = rand();
      aLayer[idx] = layerT;
      aSize[idx] = layerWeight * (0.55 + rand() * 0.95);
      aPhase[idx] = rand() * Math.PI * 2;
      aPetal[idx] = theta;
    }
  }

  // 兜底：若因取整导致 idx < count，把剩余粒子塞到最内层
  for (; idx < count; idx++) {
    const a = rand() * Math.PI * 2;
    const rr = rand() * radius * 0.2;
    positions0[idx * 3] = Math.cos(a) * rr;
    positions0[idx * 3 + 1] = (rand() - 0.5) * 0.1;
    positions0[idx * 3 + 2] = Math.sin(a) * rr;
    positions1[idx * 3] = Math.cos(a) * rr * 0.3;
    positions1[idx * 3 + 1] = (rand() - 0.5) * 0.3;
    positions1[idx * 3 + 2] = Math.sin(a) * rr * 0.3;
    aColor[idx * 3] = cCore[0];
    aColor[idx * 3 + 1] = cCore[1];
    aColor[idx * 3 + 2] = cCore[2];
    aRandom[idx] = rand();
    aSeed[idx * 4 + 0] = rand();
    aSeed[idx * 4 + 1] = rand();
    aSeed[idx * 4 + 2] = rand();
    aSeed[idx * 4 + 3] = rand();
    aLayer[idx] = 1;
    aSize[idx] = 0.7;
    aPhase[idx] = rand() * Math.PI * 2;
    aPetal[idx] = a;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions0, 3));
  geometry.setAttribute('aPosBud', new THREE.BufferAttribute(positions1, 3));
  // 目标形态位置：默认与绽放位置相同（即「花朵」形态），
  // 切换形态时由 scene 直接写入这个属性，无需重建几何体。
  geometry.setAttribute(
    'aPosMorph',
    new THREE.BufferAttribute(positions0.slice(), 3)
  );
  geometry.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
  geometry.setAttribute('aRandom', new THREE.BufferAttribute(aRandom, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 4));
  geometry.setAttribute('aLayer', new THREE.BufferAttribute(aLayer, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  geometry.setAttribute('aPetal', new THREE.BufferAttribute(aPetal, 1));

  // 用 spawn 时间做逐粒子入场动画
  const spawn = new Float32Array(count);
  for (let i = 0; i < count; i++) spawn[i] = i / count;
  geometry.setAttribute('aSpawn', new THREE.BufferAttribute(spawn, 1));

  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, 0, 0),
    radius * 1.6
  );

  return { geometry, count };
}