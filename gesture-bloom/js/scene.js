/**
 * scene.js —— Three.js 场景 / 粒子系统 / 后期泛光
 *
 * 对外只暴露一个 FlowerScene 类：
 *   - 构造时建好场景、相机、粒子、泛光
 *   - update(dt, state) 每帧调用，state 里带 spread / hand / velocity
 *   - 内置「旋转、视角摆动、相机跟随手掌」等镜头语言
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createFlowerGeometry } from './flowerGeometry.js';
import {
  flowerVertexShader,
  flowerFragmentShader,
  dustVertexShader,
  dustFragmentShader,
  nebulaVertexShader,
  nebulaFragmentShader,
} from './shaders.js';
import {
  petalStreamVertexShader,
  petalStreamFragmentShader,
  pollenVertexShader,
  pollenFragmentShader,
  rippleVertexShader,
  rippleFragmentShader,
} from './effects.js';
import { buildAllShapes, SHAPE_DEFS } from './shapes.js';

export class FlowerScene {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} cfg resolveRuntimeConfig() 的返回值
   */
  constructor(canvas, cfg) {
    this.canvas = canvas;
    this.cfg = cfg;
    this.time = 0;

    /* ---------------- 渲染器 ---------------- */
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // 粒子不需要 MSAA，省性能
      alpha: true,               // 让摄像头画面透出来
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, cfg.render.maxPixelRatio)
    );
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    /* ---------------- 场景 & 相机 ---------------- */
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x05060f, 0.045);

    this.camera = new THREE.PerspectiveCamera(
      cfg.render.fov,
      window.innerWidth / Math.max(window.innerHeight, 1),
      0.1,
      100
    );
    this.camera.position.set(0, 0.9, cfg.render.cameraDistance);
    this.camera.lookAt(0, 0, 0);

    /* 花是长在 XZ 平面上的，如果相机只在略高处平视，会看到一个压扁的圆盘。
       这里把整朵花向前倾倒 ~58°，让花瓣正对相机，同时保留立体感。 */
    this.flowerTilt = -Math.PI * 0.32;

    this.cameraBase = this.camera.position.clone();
    this.cameraTarget = new THREE.Vector3(0, 0, 0);

    /* ---------------- 花朵粒子 ---------------- */
    const flowerCfg = {
      ...cfg.particles,
      _core: cfg.colors.core,
      _inner: cfg.colors.petalInner,
      _outer: cfg.colors.petalOuter,
      _accent: cfg.colors.accent,
    };
    const { geometry, count } = createFlowerGeometry(flowerCfg);
    this.particleCount = count;

    this.uniforms = {
      uTime: { value: 0 },
      uSpread: { value: 0 },
      uSize: { value: cfg.particles.size },
      uHand: { value: new THREE.Vector2(0, 0) },
      uHandVel: { value: new THREE.Vector2(0, 0) },
      uPixelRatio: { value: this.renderer.getPixelRatio() },
      uGlobalFade: { value: 0 },
      uBreath: { value: 1.0 },
      // 新增：旋转 / 单指追踪 / 缩放
      uSpin: { value: 0 },
      uFinger: { value: new THREE.Vector2(0, 0) },
      uFingerActive: { value: 0 },
      uScale: { value: 1 },
      uScatter: { value: 0 },
      uMorph: { value: 0 },
      uShapeTime: { value: 0 },
    };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: flowerVertexShader,
      fragmentShader: flowerFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;

    /* 着色器编译错误默认只在控制台 warning，这里显式记录下来，
       便于自动化测试与线上排查。 */
    this.shaderError = null;
    this.renderer.debug.checkShaderErrors = true;
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const info = gl.getProgramInfoLog(program) || '';
      const vLog = gl.getShaderInfoLog(vs) || '';
      const fLog = gl.getShaderInfoLog(fs) || '';
      this.shaderError = `program: ${info}\nvertex: ${vLog}\nfragment: ${fLog}`;
      console.error('[shader] 编译失败:\n' + this.shaderError);
    };

    this.scene.add(this.points);

    /* ---------------- 星云背景 ---------------- */
    this.nebula = this._createNebula();
    this.scene.add(this.nebula.mesh);

    /* ---------------- 背景星尘 ---------------- */
    this.dust = this._createDust();
    this.scene.add(this.dust.points);

    /* ---------------- 形态库 ---------------- */
    // 为每种形态预生成位置数据；切换时只写入 aPosMorph 属性。
    const shapes = buildAllShapes(count, cfg.particles.radius);
    this.shapeData = shapes.data;
    this.shapeDefs = shapes.defs;
    this.currentShape = 'flower';
    /** 形态混合进度 [0,1]：0 = 花朵，1 = 目标形态 */
    this._morph = 0;
    this._morphTarget = 0;

    /* ---------------- 特效层 ---------------- */
    this.petalStream = this._createPetalStream();
    this.scene.add(this.petalStream.points);

    this.pollen = this._createPollen();
    this.scene.add(this.pollen.points);

    this.ripple = this._createRipple();
    this.scene.add(this.ripple.points);
    // 光环跟随花朵一起旋转/倾斜
    this.ripple.points.rotation.x = this.flowerTilt;

    /* ---------------- 后期泛光 ---------------- */
    this.useBloom = true;
    try {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        cfg.render.bloomStrength,
        cfg.render.bloomRadius,
        cfg.render.bloomThreshold
      );
      this.composer.addPass(this.bloomPass);
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(window.innerWidth, window.innerHeight);
    } catch (e) {
      // 某些低端设备 / WebGL1 下泛光可能失败，自动降级为直接渲染
      console.warn('[scene] 泛光初始化失败，降级为直接渲染：', e);
      this.composer = null;
      this.useBloom = false;
    }

    /* ---------------- 状态 ---------------- */
    this._prevHand = new THREE.Vector2(0, 0);
    this._handVel = new THREE.Vector2(0, 0);
    this._handSmooth = new THREE.Vector2(0, 0);
    this._rotSpeed = 0.06;
    this._parallax = new THREE.Vector2(0, 0);
    /** 冲击波光环状态 */
    this._ringT = 0;
    this._ringActive = false;
    this._prevSpread = 0;
    /** 抽花瓣脉冲强度 [0,1] */
    this._burst = 0;
    /** 单指追踪：指尖位置与激活强度 */
    this._fingerSmooth = new THREE.Vector2(0, 0);
    this._fingerActive = 0;
    /** 手指旋转带来的整体自转（跟随视觉的累积角） */
    this._spin = 0;
    /** 捏合缩放 */
    this._scale = 1;
    /** 吹散强度（挥手触发，随时间衰减） */
    this._scatter = 0;
    /** 变形时相机额外的后退量 */
    this._camDollyExtra = 0;
    /** 当前倾角（花朵态与形态态不同，需要平滑过渡） */
    this._tilt = this.flowerTilt;
    /** 泛光缩放系数（性能降级用，1 = 原始） */
    this._bloomScale = 1;

    this.resize();
  }

  /* ---------------- 星云背景 ---------------- */

  /**
   * 全屏柔光雾。
   * 作用：单靠星点无法消除「大片纯黑」的观感（实测花苞态近黑像素占 85%）。
   * 星云是一层极低亮度、缓慢流动的彩色雾，把背景从「死黑」变成「有层次的暗」，
   * 显著提升画面通透感，而且亮度极低，几乎不与前景花朵争夺注意力。
   */
  _createNebula() {
    const geo = new THREE.PlaneGeometry(2, 2);
    const uniforms = {
      uTime: { value: 0 },
      uHand: { value: new THREE.Vector2(0, 0) },
      uSpread: { value: 0 },
      uAspect: { value: window.innerWidth / Math.max(window.innerHeight, 1) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: nebulaVertexShader,
      fragmentShader: nebulaFragmentShader,
      transparent: true,
      depthWrite: false,
      // 关掉深度测试 + 负 z + 最小 renderOrder，保证它永远在最底层
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = -30;
    mesh.frustumCulled = false;
    mesh.renderOrder = -100;
    return { mesh, uniforms, material: mat, geometry: geo };
  }

  /* ---------------- 星尘 ---------------- */
  _createDust() {
    // 星尘数量大幅提高：它负责填充背景，是「画面通透感」的主要来源
    const N = this.cfg.isMobile ? 1400 : 3200;
    const pos = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const phase = new Float32Array(N);
    const randAttr = new Float32Array(N);
    const color = new Float32Array(N * 3);

    for (let i = 0; i < N; i++) {
      // 球壳分布，但更靠近相机一侧，保证屏幕上有足够密度
      const r = 7 + Math.random() * 18;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.cos(phi) * 0.62;
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta) - 5;

      size[i] = 0.6 + Math.random() * 1.8;
      phase[i] = Math.random() * Math.PI * 2;
      randAttr[i] = Math.random();

      // 配色：冷蓝为主，掺入粉 / 金 / 紫，让背景不是单调的灰蓝
      const t = Math.random();
      let r0, g0, b0;
      if (t < 0.45) {
        // 冷蓝
        r0 = 0.40; g0 = 0.60; b0 = 1.00;
      } else if (t < 0.68) {
        // 淡紫
        r0 = 0.72; g0 = 0.52; b0 = 1.00;
      } else if (t < 0.86) {
        // 粉
        r0 = 1.00; g0 = 0.62; b0 = 0.82;
      } else {
        // 暖金
        r0 = 1.00; g0 = 0.84; b0 = 0.52;
      }
      const dim = 0.55 + Math.random() * 0.45;
      color[i * 3] = r0 * dim;
      color[i * 3 + 1] = g0 * dim;
      color[i * 3 + 2] = b0 * dim;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aRandom', new THREE.BufferAttribute(randAttr, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));

    const uniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: this.renderer.getPixelRatio() },
      uHand: { value: new THREE.Vector2(0, 0) },
      uSpread: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: dustVertexShader,
      fragmentShader: dustFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;

    return { points, uniforms, material: mat, geometry: geo };
  }

  /* ---------------- 花瓣流光：抽花瓣 ---------------- */

  _createPetalStream() {
    const N = this.cfg.isMobile ? 900 : 2200;
    const phase = new Float32Array(N);
    const speed = new Float32Array(N);
    const angle = new Float32Array(N);
    const radius = new Float32Array(N);
    const size = new Float32Array(N);
    const color = new Float32Array(N * 3);
    const pos = new Float32Array(N * 3); // 占位，真实位置在着色器里算

    const cInner = this.cfg.colors.petalInner;
    const cOuter = this.cfg.colors.petalOuter;
    const cCore = this.cfg.colors.core;

    for (let i = 0; i < N; i++) {
      // 相位均匀铺开，保证任意时刻都有一批粒子在飞行中途
      phase[i] = i / N + (Math.random() - 0.5) * 0.02;
      speed[i] = 0.55 + Math.random() * 0.9;

      // 落在某片花瓣的方向上（与主体花瓣数一致，视觉上才对得上）
      const petalIdx = Math.floor(Math.random() * this.cfg.particles.petals);
      const base = (petalIdx / this.cfg.particles.petals) * Math.PI * 2;
      // 花瓣内再加一点角度散布，形成一束而不是一条线
      angle[i] = base + (Math.random() - 0.5) * 0.42;

      // 目标半径：从花心到花瓣尖（收敛到花朵范围内，避免流光撒得太远显脏）
      radius[i] = this.cfg.particles.radius * (0.42 + Math.random() * 0.42);
      size[i] = 0.7 + Math.random() * 1.4;

      // 颜色：靠近花心的偏暖，外圈偏冷
      const t = Math.random();
      const from = t < 0.5 ? cCore : cInner;
      const to = t < 0.5 ? cInner : cOuter;
      const k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      color[i * 3] = from[0] + (to[0] - from[0]) * k;
      color[i * 3 + 1] = from[1] + (to[1] - from[1]) * k;
      color[i * 3 + 2] = from[2] + (to[2] - from[2]) * k;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
    geo.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);

    const uniforms = {
      uTime: { value: 0 },
      uSpread: { value: 0 },
      uPixelRatio: { value: this.renderer.getPixelRatio() },
      uGlobalFade: { value: 0 },
      uBurst: { value: 0 },
      uFinger: { value: new THREE.Vector2(0, 0) },
      uFingerActive: { value: 0 },
      uSpin: { value: 0 },
      uScale: { value: 1 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: petalStreamVertexShader,
      fragmentShader: petalStreamFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    return { points, uniforms, material: mat, geometry: geo, count: N };
  }

  /* ---------------- 逸散花粉 ---------------- */

  _createPollen() {
    const N = this.cfg.isMobile ? 500 : 1300;
    const phase = new Float32Array(N);
    const speed = new Float32Array(N);
    const size = new Float32Array(N);
    const origin = new Float32Array(N * 3);
    const drift = new Float32Array(N * 3);
    const color = new Float32Array(N * 3);
    const pos = new Float32Array(N * 3);

    const R = this.cfg.particles.radius;
    const cCore = this.cfg.colors.core;
    const cInner = this.cfg.colors.petalInner;
    const cOuter = this.cfg.colors.petalOuter;

    for (let i = 0; i < N; i++) {
      phase[i] = Math.random();
      speed[i] = 0.4 + Math.random() * 0.85;
      size[i] = 0.5 + Math.random() * 1.1;

      // 出生点：花朵上的随机位置（花瓣区域）
      const a = Math.random() * Math.PI * 2;
      const r = R * (0.25 + Math.random() * 0.85);
      origin[i * 3] = Math.cos(a) * r;
      origin[i * 3 + 1] = (Math.random() - 0.5) * R * 0.25;
      origin[i * 3 + 2] = Math.sin(a) * r;

      // 漂移方向：向外 + 偏上
      const da = a + (Math.random() - 0.5) * 0.8;
      drift[i * 3] = Math.cos(da) * (0.2 + Math.random() * 0.5);
      drift[i * 3 + 1] = 0.15 + Math.random() * 0.5;
      drift[i * 3 + 2] = Math.sin(da) * (0.2 + Math.random() * 0.5);

      const t = Math.random();
      const from = t < 0.4 ? cCore : t < 0.8 ? cInner : cOuter;
      color[i * 3] = from[0];
      color[i * 3 + 1] = from[1];
      color[i * 3 + 2] = from[2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aOrigin', new THREE.BufferAttribute(origin, 3));
    geo.setAttribute('aDrift', new THREE.BufferAttribute(drift, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 16);

    const uniforms = {
      uTime: { value: 0 },
      uSpread: { value: 0 },
      uPixelRatio: { value: this.renderer.getPixelRatio() },
      uHand: { value: new THREE.Vector2(0, 0) },
      uGlobalFade: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: pollenVertexShader,
      fragmentShader: pollenFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    return { points, uniforms, material: mat, geometry: geo, count: N };
  }

  /* ---------------- 冲击波光环 ---------------- */

  _createRipple() {
    const N = this.cfg.isMobile ? 300 : 700;
    const dir = new Float32Array(N * 2);
    const seed = new Float32Array(N);
    const pos = new Float32Array(N * 3);

    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + (Math.random() - 0.5) * 0.03;
      dir[i * 2] = Math.cos(a);
      dir[i * 2 + 1] = Math.sin(a);
      seed[i] = Math.random();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 2));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);

    const uniforms = {
      uTime: { value: 0 },
      uRingT: { value: 0 },
      uRingActive: { value: 0 },
      uPixelRatio: { value: this.renderer.getPixelRatio() },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: rippleVertexShader,
      fragmentShader: rippleFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    return { points, uniforms, material: mat, geometry: geo };
  }

  /* ---------------- 每帧更新 ---------------- */

  /**
   * @param {number} dt   秒
   * @param {object} state { spread, tension, handX, handY, hasHand,
   *                         fingerX, fingerY, fingerActive,
   *                         rotation, pinch }
   */
  update(dt, state) {
    this.time += dt;
    const { spread, handX, handY } = state;

    // 平滑手掌位置，避免抖动传递到画面上
    this._handSmooth.x += (handX - this._handSmooth.x) * 0.12;
    this._handSmooth.y += (handY - this._handSmooth.y) * 0.12;

    /* ---- 单指追踪 ---- */
    const fingerActive = state.fingerActive ?? 0;
    const fx = state.fingerX ?? 0;
    const fy = state.fingerY ?? 0;
    // 指尖位置平滑（比手掌更灵敏，要跟手）
    this._fingerSmooth.x += (fx - this._fingerSmooth.x) * 0.28;
    this._fingerSmooth.y += (fy - this._fingerSmooth.y) * 0.28;
    this._fingerActive += (fingerActive - this._fingerActive) * 0.14;

    /* ---- 旋转 ---- */
    // uSpin 是跟随视觉的「累积角」，直接取手势累积量
    const targetSpin = state.rotation ?? 0;
    this._spin += (targetSpin - this._spin) * 0.22;
    // 花苞时自转更快（合拢的花苞转起来更明显），绽放时略慢
    const spinSpeed = state.rotationSpeed ?? 0;
    void spinSpeed;

    /* ---- 捏合缩放 ---- */
    // pinch: 0 = 捏合（缩小）, 1 = 张开（放大）
    const targetScale = 0.72 + (state.pinch ?? 0.5) * 0.62;
    this._scale += (targetScale - this._scale) * 0.10;

    // 手掌速度（归一化到每秒）
    if (dt > 1e-4) {
      this._handVel.set(
        (this._handSmooth.x - this._prevHand.x) / dt,
        (this._handSmooth.y - this._prevHand.y) / dt
      );
      this._handVel.multiplyScalar(0.35);
    }
    this._prevHand.copy(this._handSmooth);

    /* ---- uniform ---- */
    this.uniforms.uTime.value = this.time;
    this.uniforms.uSpread.value = spread;
    this.uniforms.uHand.value.set(this._handSmooth.x, this._handSmooth.y);
    this.uniforms.uHandVel.value.set(
      THREE.MathUtils.clamp(this._handVel.x, -3, 3),
      THREE.MathUtils.clamp(this._handVel.y, -3, 3)
    );
    // 入场淡入
    this.uniforms.uGlobalFade.value = Math.min(
      1,
      this.uniforms.uGlobalFade.value + dt * 0.55
    );

    // 旋转 / 单指追踪 / 缩放
    this.uniforms.uSpin.value = this._spin;
    this.uniforms.uFinger.value.set(this._fingerSmooth.x, this._fingerSmooth.y);
    this.uniforms.uFingerActive.value = this._fingerActive;
    this.uniforms.uScale.value = this._scale;

    // 吹散强度衰减：推出去之后自己飘回来
    this._scatter = Math.max(0, this._scatter - dt * 1.1);
    this.uniforms.uScatter.value = this._scatter;

    this.dust.uniforms.uTime.value = this.time;
    this.dust.uniforms.uSpread.value = spread;
    this.dust.uniforms.uHand.value.set(this._handSmooth.x, this._handSmooth.y);

    /** 形态混合缓动 ---- */
    // 用比绽放稍慢的缓动，让变形过程看得清
    const kMorph = 1 - Math.pow(0.955, dt * 60);
    this._morph += (this._morphTarget - this._morph) * kMorph;
    if (Math.abs(this._morph - this._morphTarget) < 0.0005) {
      this._morph = this._morphTarget;
    }
    this.uniforms.uMorph.value = this._morph;
    this.uniforms.uShapeTime.value = this.time;

    /* ---- 变形时相机后退 ---- */
    // 形状已按「最大半径」归一化，最外点必定入镜，
    // 所以只需要很小的后退量（原来 1.6 会让形状显得太小）。
    this._camDollyExtra += ((this._morph * 0.55) - this._camDollyExtra) * 0.06;

    /* ---- 星云背景 ---- */
    this.nebula.uniforms.uTime.value = this.time;
    this.nebula.uniforms.uSpread.value = spread;
    this.nebula.uniforms.uHand.value.set(this._handSmooth.x, this._handSmooth.y);

    /* ---- 特效层 uniform ---- */
    const fade = this.uniforms.uGlobalFade.value;

    // 抽花瓣：绽放时才大量抽出
    this.petalStream.uniforms.uTime.value = this.time;
    this.petalStream.uniforms.uSpread.value = spread;
    this.petalStream.uniforms.uGlobalFade.value = fade;
    // 脉冲衰减
    this._burst = Math.max(0, this._burst - dt * 1.6);
    this.petalStream.uniforms.uBurst.value = this._burst;
    // 流光也跟随指尖 / 旋转 / 缩放
    this.petalStream.uniforms.uFinger.value.set(this._fingerSmooth.x, this._fingerSmooth.y);
    this.petalStream.uniforms.uFingerActive.value = this._fingerActive;
    this.petalStream.uniforms.uSpin.value = this._spin;
    this.petalStream.uniforms.uScale.value = this._scale;

    // 逸散花粉
    this.pollen.uniforms.uTime.value = this.time;
    this.pollen.uniforms.uSpread.value = spread;
    this.pollen.uniforms.uGlobalFade.value = fade;
    this.pollen.uniforms.uHand.value.set(this._handSmooth.x, this._handSmooth.y);

    // 冲击波光环
    this.ripple.uniforms.uTime.value = this.time;
    if (this._ringActive) {
      this._ringT += dt * 1.5;
      if (this._ringT >= 1) {
        this._ringT = 0;
        this._ringActive = false;
      }
      this.ripple.uniforms.uRingT.value = this._ringT;
      this.ripple.uniforms.uRingActive.value = this._ringActive ? 1 : 0;
    } else {
      this.ripple.uniforms.uRingActive.value = 0;
    }

    /* ---- 状态突变时触发特效 ---- */
    // 手势「张开」的瞬间：放一圈冲击波 + 抽出一把花瓣
    const spreadDelta = spread - this._prevSpread;
    const rising = spreadDelta > 0.012;
    if (rising && spread > 0.35) {
      // 光环（节流：一圈没走完不再触发新的）
      if (!this._ringActive && spreadDelta > 0.030) {
        this._ringActive = true;
        this._ringT = 0;
      }
      // 抽花瓣脉冲
      this._burst = Math.min(1, this._burst + spreadDelta * 12);
    }
    // 合拢时给一个较小的脉冲，表现「收回去」也有动作
    if (spreadDelta < -0.030 && spread < 0.9) {
      this._burst = Math.min(0.6, this._burst + Math.abs(spreadDelta) * 5);
    }
    this._prevSpread = spread;

    /* ---- 花朵自转 ---- */
    // 自转速度随绽放程度提升：花苞基本静止，盛开时明显旋转。
    // 花苞若也在转，中心区域的画面变化会达到 19.5%（实测），
    // 视觉上"闭合的花苞一直在晃"，与"闭合"的语义相悖。
    // 现在用 spread^1.5 让低速段压得更低：spread=0 时转速为 0。
    const spinScale = 1 - this._morph;
    if (spinScale > 0.02) {
      const spinRate = Math.pow(spread, 1.5) * 0.40;
      this.points.rotation.y += dt * spinRate * spinScale;
    } else {
      // 平滑归零（取最短路径，避免绕远路转一大圈）
      let ry = this.points.rotation.y % (Math.PI * 2);
      if (ry > Math.PI) ry -= Math.PI * 2;
      if (ry < -Math.PI) ry += Math.PI * 2;
      this.points.rotation.y = ry * 0.92;
      if (Math.abs(this.points.rotation.y) < 0.002) this.points.rotation.y = 0;
    }
    // 基础倾角 + 轻微摆动，像被风吹
    const sway = Math.sin(this.time * 0.6) * 0.05 * (0.15 + spread);
    // 倾角随形态变化：
    //   花朵是「长在 XZ 平面」的，需要 -58° 倾角才正对相机；
    //   而蝴蝶/心形/凤凰等形态是「立在 XY 平面」的，再倾斜就会被看扁、
    //   糊成一片模糊的云（实测心形完全不可辨）。所以形态化时把倾角归零。
    const tiltTarget = this.flowerTilt * (1 - this._morph);
    this._tilt += (tiltTarget - this._tilt) * 0.06;
    this.points.rotation.x = this._tilt + sway * 0.28;
    // 摆动幅度也随形态衰减：平面图形（心形/蝴蝶）轻微倾斜就会明显变形，
    // 0.5 rad 的摆动足以让心形看起来是歪的。
    this.points.rotation.z = sway * 0.5 * (1 - this._morph);

    // 特效层跟随花朵的旋转与位置，保证彼此对齐
    this.petalStream.points.rotation.y = this.points.rotation.y * 0.85;
    this.petalStream.points.rotation.x = this.flowerTilt;
    this.pollen.points.rotation.y = this.points.rotation.y * 0.6;
    this.ripple.points.rotation.y = this.points.rotation.y * 0.5;
    this.ripple.points.position.copy(this.points.position);
    this.petalStream.points.position.copy(this.points.position);
    this.pollen.points.position.copy(this.points.position);

    /* ---- 相机：跟随手掌的透视位移 + 呼吸推拉 ---- */
    // 形态化时相机回正。
    // 花朵态相机略高并俯视（花朵"躺"在 XZ 平面，需要俯视才看得全）；
    // 但平面形态（心形/蝴蝶）是"立"在 XY 平面的，俯视会让它看起来歪斜
    // （实测心形被俯视视角压成约 45° 的斜向椭圆）。所以形态化时把相机拉回水平。
    const upright = 1 - this._morph;
    const targetX = this._handSmooth.x * 0.62;
    const targetY = (0.9 - this._handSmooth.y * 0.42) * upright;
    const dolly = this.cfg.render.cameraDistance - spread * 0.85 + this._camDollyExtra;
    const breath = Math.sin(this.time * 0.4) * 0.14 * upright;

    this.camera.position.x += (targetX - this.camera.position.x) * 0.05;
    this.camera.position.y += (targetY + breath - this.camera.position.y) * 0.05;
    this.camera.position.z += (dolly - this.camera.position.z) * 0.05;

    this.cameraTarget.x += (this._handSmooth.x * 0.5 - this.cameraTarget.x) * 0.05;
    this.cameraTarget.y += ((-this._handSmooth.y * 0.3) * upright - this.cameraTarget.y) * 0.05;
    this.camera.lookAt(this.cameraTarget);

    // 花朵整体也跟随手掌做小幅平移（保证视觉上“跟着手走”）
    this.points.position.x += (this._handSmooth.x * 0.55 - this.points.position.x) * 0.06;
    this.points.position.y += (-this._handSmooth.y * 0.42 - this.points.position.y) * 0.06;

    /* ---- 渲染 ---- */
    if (this.composer && this.useBloom) {
      // 泛光强度随绽放增强，并乘上性能降级的缩放系数
      this.bloomPass.strength =
        this.cfg.render.bloomStrength * (0.45 + spread * 0.85) * this._bloomScale;
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /* ---------------- 尺寸 ---------------- */
  resize() {
    const w = window.innerWidth;
    const h = Math.max(window.innerHeight, 1);
    const dpr = Math.min(window.devicePixelRatio || 1, this.cfg.render.maxPixelRatio);

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.uniforms.uPixelRatio.value = dpr;
    this.dust.uniforms.uPixelRatio.value = dpr;
    this.petalStream.uniforms.uPixelRatio.value = dpr;
    this.pollen.uniforms.uPixelRatio.value = dpr;
    this.ripple.uniforms.uPixelRatio.value = dpr;
    this.nebula.uniforms.uAspect.value = w / h;

    this.camera.aspect = w / h;
    // 竖屏时视野放宽，确保花朵完整入镜
    this.camera.fov = h > w ? this.cfg.render.fov * 1.35 : this.cfg.render.fov;
    this.camera.updateProjectionMatrix();

    if (this.composer) {
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(w, h);
      this.bloomPass?.setSize(w, h);
    }
  }

  /**
   * 切换到指定形态。
   * 只写入 aPosMorph 属性，真正的过渡由 uMorph 缓动完成。
   * @param {string} id 形态 id（'flower' 表示还原成花朵）
   * @returns {boolean} 是否切换成功
   */
  setShape(id) {
    if (id === this.currentShape) return false;

    const attr = this.points.geometry.getAttribute('aPosMorph');

    if (id === 'flower') {
      // 还原：把目标位置设回绽放位置，再让 uMorph 缓动回 0
      const bloom = this.points.geometry.getAttribute('position');
      attr.array.set(bloom.array);
    } else {
      const data = this.shapeData[id];
      if (!data) {
        console.warn(`[shape] 未知形态 "${id}"`);
        return false;
      }
      if (data.length !== attr.array.length) {
        // 这种情况说明 shapeData 与 current geometry 的粒子数不同步。
        // 不要静默失败——之前就是这里 return false 导致"点了没反应"很难排查。
        console.error(
          `[shape] 粒子数不同步：形态数据 ${data.length / 3} 个粒子，` +
            `几何体 ${attr.array.length / 3} 个。请检查 setParticleCount 是否重建了形态数据。`
        );
        return false;
      }
      attr.array.set(data);
    }

    attr.needsUpdate = true;
    this.currentShape = id;
    this._morphTarget = id === 'flower' ? 0 : 1;
    return true;
  }

  /** 循环切到下一个形态 */
  cycleShape(dir = 1) {
    const ids = this.shapeDefs.map((d) => d.id);
    const i = ids.indexOf(this.currentShape);
    const next = ids[(i + dir + ids.length) % ids.length];
    this.setShape(next);
    return next;
  }

  /** 当前形态信息 */
  getShapeInfo() {
    const def = this.shapeDefs.find((d) => d.id === this.currentShape);
    return {
      id: this.currentShape,
      name: def?.name ?? this.currentShape,
      icon: def?.icon ?? '',
      morph: this._morph,
    };
  }

  /** 触发一次「抽花瓣」脉冲（外部调用，例如五指全开时） */
  triggerBurst(strength = 1) {
    this._burst = Math.min(1, this._burst + strength);
  }

  /**
   * 触发「吹散」效果：所有花瓣粒子被向外推一把，然后自然回位。
   * 用独立的速度场实现，不改变粒子本身的位置属性。
   */
  triggerScatter(strength = 1) {
    this._scatter = Math.min(1.6, this._scatter + strength);
    this._ringActive = true;
    this._ringT = 0;
  }

  /** 重置视角与旋转 */
  reset() {
    this.points.rotation.set(this.flowerTilt, 0, 0);
    this.points.position.set(0, 0, 0);
    this.petalStream.points.rotation.set(this.flowerTilt, 0, 0);
    this.pollen.points.rotation.set(0, 0, 0);
    this.ripple.points.rotation.set(this.flowerTilt, 0, 0);
    this.petalStream.points.position.set(0, 0, 0);
    this.pollen.points.position.set(0, 0, 0);
    this.ripple.points.position.set(0, 0, 0);
    this.camera.position.copy(this.cameraBase);
    this.cameraTarget.set(0, 0, 0);
    this._handSmooth.set(0, 0);
    this._prevHand.set(0, 0);
    this._ringActive = false;
    this._ringT = 0;
    this._scatter = 0;
    this._spin = 0;
    this._scale = 1;
    this._fingerActive = 0;
    this._fingerSmooth.set(0, 0);
    this._burst = 0;
  }

  /** 开关泛光（低端设备自动降级时用） */
  setBloomEnabled(on) {
    this.useBloom = on && !!this.composer;
  }

  /**
   * 按比例缩放泛光强度（1 = 原始）。
   * 用缩放而不是开关：泛光对"画质观感"影响很大，
   * 一刀切关掉会让画面立刻变得很平。
   */
  setBloomScale(scale) {
    this._bloomScale = Math.max(0, scale);
  }

  /** 重建粒子（切换数量时用）
   *
   * 注意：形态数据（this.shapeData）必须跟着一起重建。
   * 之前的实现只换了 geometry，导致 shapeData 仍是旧粒子数的数组，
   * 而 setShape 里有一句 `data.length !== attr.array.length → return false`，
   * 于是**性能降级之后所有形态切换都会静默失败**
   * ——按钮点了没反应、键也不管用，表现就是"变不了"。
   */
  setParticleCount(newCount) {
    const flowerCfg = {
      ...this.cfg.particles,
      count: newCount,
      _core: this.cfg.colors.core,
      _inner: this.cfg.colors.petalInner,
      _outer: this.cfg.colors.petalOuter,
      _accent: this.cfg.colors.accent,
    };
    const { geometry, count } = createFlowerGeometry(flowerCfg);

    // 形态数据按新的粒子数重建
    const shapes = buildAllShapes(count, this.cfg.particles.radius);
    this.shapeData = shapes.data;

    this.points.geometry.dispose();
    this.points.geometry = geometry;
    this.particleCount = count;

    // 重建后 aPosMorph 会被重置为"绽放位置"（= 花朵形态），
    // 所以如果当前正处于某个形态，需要把目标位置重新写回去，
    // 否则画面会突然变回花朵。
    if (this.currentShape !== 'flower') {
      const want = this.currentShape;
      this.currentShape = 'flower';       // 先归位，才能让 setShape 生效
      this._morph = 0;
      this.setShape(want);
      this._morph = 1;
      this._morphTarget = 1;
    }
    return count;
  }

  dispose() {
    for (const layer of [this.points, this.dust.points, this.petalStream.points, this.pollen.points, this.ripple.points, this.nebula.mesh]) {
      layer.geometry.dispose();
      layer.material.dispose();
    }
    this.composer?.dispose?.();
    this.renderer.dispose();
  }
}