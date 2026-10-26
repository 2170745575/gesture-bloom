/**
 * effects.js —— 特效系统
 *
 * 包含四类效果，全部在 GPU 上完成，不增加 CPU 负担：
 *
 *  1. 花瓣散开 / 合拢（已有，强化）
 *     由 tension → spread 驱动，粒子在花苞位置与绽放位置之间插值。
 *
 *  2. 旋转（新增）
 *     · 整朵花自转：绽放时更快
 *     · 花瓣涡旋：每片花瓣绕自身轴轻微扭转，形成「旋开花瓣」的观感
 *     · 螺旋绽放：花瓣不是同时打开，而是按角度依次打开，形成旋转展开的动画
 *
 *  3. 抽花瓣（新增）
 *     从花心不断「抽出」新的花瓣粒子飞向目标位置。
 *     实现方式：额外的「花瓣流光」粒子系统，每个粒子沿一条从花心到花瓣尖的
 *     曲线运动，到达后淡出，循环再生。手势张开时抽出的频率与数量增加。
 *
 *  4. 飘落花粉 / 光点（新增）
 *     从花朵逸散出的细小光点，缓慢上浮并消散，营造梦幻感。
 *     绽放程度越高，逸散越多。
 */

import * as THREE from 'three';

/* ================================================================== *
 * 1. 花瓣流光（抽花瓣）
 * ================================================================== */

/**
 * 每个「抽花瓣」粒子的生命周期：
 *   0 → 0.25  从花心加速飞出
 *   0.25 → 0.7 沿花瓣弧线滑向目标位置
 *   0.7 → 1    抵达后淡出
 * 用 aStart（出发相位）让粒子错峰出发，形成连续不断地「抽」出花瓣。
 */
export const petalStreamVertexShader = /* glsl */ `
precision highp float;

attribute float aPhase;      // 生命周期相位 [0,1)
attribute float aSpeed;      // 运动速度倍率
attribute float aAngle;      // 该粒子所属花瓣的角度
attribute float aRadius;     // 目标半径
attribute float aSize;
attribute vec3  aColor;

uniform float uTime;
uniform float uSpread;       // 绽放程度：越高抽得越快越多
uniform float uPixelRatio;
uniform float uGlobalFade;
/** 抽花瓣脉冲 [0,1]：手势「张开」的瞬间由 JS 置 1，随后衰减到 0 */
uniform float uBurst;
/** 单指追踪：食指尖位置（归一化掌心坐标） */
uniform vec2  uFinger;
/** 单指追踪强度 [0,1] */
uniform float uFingerActive;
/** 整体旋转（与主体花朵保持一致） */
uniform float uSpin;
/** 捏合缩放 */
uniform float uScale;

varying vec3  vColor;
varying float vAlpha;
varying float vLife;

void main() {
  /* ---------- 生命周期 ---------- */
  // 用 uSpread 控制流速：花苞时几乎停止，绽放时快速抽出。
  // uBurst 会让整批粒子瞬间加速，形成「唰」地抽出一把花瓣的效果。
  float speed = aSpeed * (0.10 + uSpread * 1.45 + uBurst * 2.2);
  float life = fract(aPhase + uTime * speed);
  vLife = life;

  /* ---------- 路径：从花心沿螺旋线飞向花瓣目标位 ---------- */
  float ease = life * life * (3.0 - 2.0 * life);          // 平滑起步与收尾
  float easeOut = 1.0 - pow(1.0 - life, 2.4);              // 先快后慢

  // 从花心附近出发，半径随生命周期增长到 aRadius
  float r = aRadius * easeOut;

  // 螺旋：飞行过程中角度持续偏转，形成「旋着抽出来」的轨迹
  float twist = (1.0 - life) * 2.4;                        // 起点扭转大，终点归零
  float ang = aAngle + twist;

  vec3 pos;
  pos.x = cos(ang) * r;
  pos.z = sin(ang) * r;
  // 飞行弧线：中途略微抬起，像花瓣被抛出来
  pos.y = sin(life * 3.14159) * aRadius * 0.28 + (life * 0.1);

  // 出发前在花心聚拢成一个小点，避免突然出现
  float emerge = smoothstep(0.0, 0.12, life);
  pos *= emerge;

  /* ---------- 轻微扰动 ---------- */
  // 扰动幅度要小，否则流光会散成一片雾、把花瓣边界弄脏
  pos.x += sin(uTime * 3.0 + aPhase * 20.0) * 0.008;
  pos.y += cos(uTime * 2.4 + aPhase * 17.0) * 0.008;

  /* ---------- 单指追踪：流光汇聚到指尖 ---------- */
  // 食指单独伸出时，正在飞行的花瓣改而飞向指尖，
  // 视觉上就是「用手指把花瓣一片片抽出来」。
  if (uFingerActive > 0.001) {
    pos.xy = mix(pos.xy, uFinger * 2.3, uFingerActive * 0.72 * (1.0 - life * 0.35));
  }

  /* ---------- 整体旋转 + 缩放（与主体保持一致） ---------- */
  if (abs(uSpin) > 0.0001) {
    float c = cos(uSpin);
    float s = sin(uSpin);
    pos.xz = mat2(c, -s, s, c) * pos.xz;
  }
  pos *= uScale;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  /* ---------- 尺寸：中段最大，首尾收细 ---------- */
  float sizeCurve = sin(life * 3.14159);
  gl_PointSize = aSize * uPixelRatio * (150.0 / -mv.z) * (0.35 + sizeCurve * 1.5);
  gl_PointSize = clamp(gl_PointSize, 0.5, 12.0);

  /* ---------- 透明度：首尾淡入淡出 ---------- */
  float fadeIn  = smoothstep(0.0, 0.10, life);
  float fadeOut = 1.0 - smoothstep(0.70, 1.0, life);
  // 花苞时完全不抽花瓣；张开到一半以后才逐渐出现，全开时最盛。
  float gate = smoothstep(0.20, 0.80, uSpread);
  vAlpha = fadeIn * fadeOut * uGlobalFade * gate * (0.30 + uSpread * 0.40);

  // 脉冲期间额外提亮，强调「抽出」这一下
  vAlpha *= 1.0 + uBurst * 1.4;

  // 出生点是所有流光汇聚之处，必须额外压暗，否则花心会烧成白斑
  vAlpha *= smoothstep(0.0, 0.28, life);

  // 刚抽出时更亮（白热），随后回归本色
  float hot = 1.0 - smoothstep(0.0, 0.35, life);
  vColor = mix(aColor, vec3(1.0, 0.96, 0.88), hot * 0.7);
  vColor *= 1.0 + hot * 0.7;
}
`;

export const petalStreamFragmentShader = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
varying float vLife;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;
  float r = sqrt(r2) * 2.0;

  float core = smoothstep(1.0, 0.1, r);
  float halo = pow(1.0 - r, 2.2);
  float a = (core * 0.55 + halo * 0.40) * vAlpha;

  vec3 col = vColor * (0.7 + core * 0.5);
  gl_FragColor = vec4(col * a, a);
}
`;

/* ================================================================== *
 * 2. 逸散花粉
 * ================================================================== */

export const pollenVertexShader = /* glsl */ `
precision highp float;

attribute float aPhase;
attribute float aSpeed;
attribute float aSize;
attribute vec3  aOrigin;     // 出生点（花朵上某处）
attribute vec3  aDrift;      // 漂移方向
attribute vec3  aColor;

uniform float uTime;
uniform float uSpread;
uniform float uPixelRatio;
uniform vec2  uHand;
uniform float uGlobalFade;

varying vec3  vColor;
varying float vAlpha;

void main() {
  // 生命周期：绽放时花粉才大量逸散
  float speed = aSpeed * (0.05 + uSpread * 0.55);
  float life = fract(aPhase + uTime * speed);

  vec3 pos = aOrigin;
  // 缓慢上浮 + 侧向漂移。漂移距离要克制：
  // 花粉本是点缀，飘太远会让整幅画面布满散点、显得"脏"。
  float t = life;
  pos += aDrift * (t * t * 1.9);
  pos.y += t * 1.15;

  // 被手掌轻微推开
  vec2 d = pos.xy - uHand * 3.0;
  pos.xy += normalize(d + 1e-5) * exp(-dot(d, d) * 0.5) * 0.5 * uSpread;

  // 飘动噪声
  pos.x += sin(uTime * 0.9 + aPhase * 30.0) * 0.16 * t;
  pos.z += cos(uTime * 1.1 + aPhase * 24.0) * 0.16 * t;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  gl_PointSize = aSize * uPixelRatio * (120.0 / -mv.z) * (1.0 - t * 0.5);
  gl_PointSize = clamp(gl_PointSize, 0.4, 8.0);

  // 淡入淡出
  float fadeIn = smoothstep(0.0, 0.12, life);
  float fadeOut = 1.0 - smoothstep(0.55, 1.0, life);
  // 花苞状态不应该有花粉逸散——那会破坏「闭合」的观感。
  // 用一个较陡的门槛：spread > 0.25 才开始明显飘散，>0.7 达到最盛。
  float gate = smoothstep(0.25, 0.75, uSpread);
  vAlpha = fadeIn * fadeOut * uGlobalFade * gate * 0.55;

  vColor = aColor;
}
`;

export const pollenFragmentShader = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float r = length(uv) * 2.0;
  if (r > 1.0) discard;
  float a = pow(1.0 - r, 2.6) * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}
`;

/* ================================================================== *
 * 3. 冲击波光环（手掌快速移动 / 状态突变时触发）
 * ================================================================== */

export const rippleVertexShader = /* glsl */ `
precision highp float;
attribute vec2 aDir;         // 该顶点在环上的单位方向
attribute float aSeed;

uniform float uTime;
uniform float uRingT;        // 环的进度 [0,1]，由 JS 驱动
uniform float uRingActive;
uniform float uPixelRatio;

varying float vAlpha;
varying float vSeed;

void main() {
  vSeed = aSeed;
  // 环半径随时间扩张
  float radius = 0.3 + uRingT * 4.2;
  vec3 pos = vec3(aDir.x * radius, aDir.y * radius * 0.75, 0.0);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  gl_PointSize = uPixelRatio * (34.0 / -mv.z) * (1.0 - uRingT * 0.6);
  gl_PointSize = clamp(gl_PointSize, 0.5, 10.0);

  // 环的亮度：先亮后灭
  vAlpha = uRingActive * (1.0 - uRingT) * 0.85 * (0.6 + aSeed * 0.4);
}
`;

export const rippleFragmentShader = /* glsl */ `
precision highp float;
varying float vAlpha;
varying float vSeed;
void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float r = length(uv) * 2.0;
  if (r > 1.0) discard;
  float a = pow(1.0 - r, 2.0) * vAlpha;
  vec3 col = mix(vec3(0.62, 0.82, 1.0), vec3(1.0, 0.85, 0.95), vSeed);
  gl_FragColor = vec4(col * a, a);
}
`;