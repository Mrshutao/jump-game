/* 跳一跳 MVP · 开发：小C
 * 结构：平台适配层(Env) / 纯逻辑(Logic) / 渲染(Render) / 输入与主循环
 * 迁移微信小游戏时只需替换 Env（canvas、尺寸、存储、触摸事件、rAF）。
 */
(function () {
  'use strict';

  // ---------------- 平台适配层 ----------------
  var isWx = typeof wx !== 'undefined' && wx.getSystemInfoSync;
  var Env = {
    canvas: isWx ? wx.createCanvas() : document.getElementById('game'),
    size: function () {
      if (isWx) { var i = wx.getSystemInfoSync(); return { w: i.windowWidth, h: i.windowHeight, dpr: i.pixelRatio }; }
      return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
    },
    getItem: function (k) {
      try { return isWx ? wx.getStorageSync(k) : window.localStorage.getItem(k); } catch (e) { return null; }
    },
    setItem: function (k, v) {
      try { isWx ? wx.setStorageSync(k, String(v)) : window.localStorage.setItem(k, String(v)); } catch (e) {}
    },
    raf: isWx ? requestAnimationFrame : window.requestAnimationFrame.bind(window),
    now: function () { return Date.now(); }
  };

  // ---------------- 配置 ----------------
  var CFG = {
    platH: 30,          // 平台高度
    pxPerMs: 0.22,      // 跳跃距离 = 按压时长(ms) * pxPerMs
    maxPress: 2000,     // 蓄力上限(ms)
    jumpDur: 520,       // 空中时间(ms)
    jumpHeight: 110,
    centerRatio: 0.2,   // 中心区半径 = 平台宽度 * 20%
    maxCompress: 10,
    bestKey: 'jump_best_score'
  };

  // 可复现随机数：URL 加 ?seed=123 即可固定平台序列（方便测试）
  var seed = null;
  try { var m = !isWx && location.search.match(/seed=(\d+)/); if (m) seed = +m[1]; } catch (e) {}
  function rand() {
    if (seed === null) return Math.random();
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  function rr(a, b) { return a + (b - a) * rand(); }

  var COLORS = ['#f2a65a', '#6cc3d5', '#a78bfa', '#f472b6', '#86efac', '#fde047', '#94a3b8', '#fb7185'];

  // ---------------- 纯逻辑 ----------------
  function jumpDistance(pressMs) {
    var t = Math.max(0, Math.min(pressMs, CFG.maxPress));
    return t * CFG.pxPerMs;
  }
  function makePlatform(x, z, s, type) {
    return { x: x, z: z, s: s, type: type, color: COLORS[Math.floor(rand() * COLORS.length)], press: 0 };
  }
  function nextPlatform(prev, score) {
    var maxS = Math.max(20, 42 - score * 0.6);
    var minS = Math.max(15, 30 - score * 0.5);
    var s = rr(minS, maxS);
    var gap = prev.s + s + rr(25, 45 + Math.min(score * 3, 110));
    var type = rand() < 0.5 ? 'box' : 'cyl';
    var dir = rand() < 0.5 ? 'x' : 'z'; // x=右前，z=左前
    var p = dir === 'x' ? makePlatform(prev.x + gap, prev.z, s, type) : makePlatform(prev.x, prev.z + gap, s, type);
    p.dir = dir;
    return p;
  }
  function onPlatform(p, x, z) {
    if (p.type === 'cyl') return Math.hypot(x - p.x, z - p.z) <= p.s;
    return Math.abs(x - p.x) <= p.s && Math.abs(z - p.z) <= p.s;
  }
  function isCenter(p, x, z) {
    return Math.hypot(x - p.x, z - p.z) <= p.s * 2 * CFG.centerRatio;
  }

  // ---------------- 状态 ----------------
  var G = {
    state: 'start', // start | ready | charging | jumping | falling | over
    score: 0, combo: 0, best: parseInt(Env.getItem(CFG.bestKey), 10) || 0,
    plats: [], cur: null, next: null,
    player: { x: 0, z: 0, y: CFG.platH, sq: 1, rot: 0 },
    pressStart: 0, jump: null, fall: null,
    cam: { x: 0, y: 0, tx: 0, ty: 0 },
    popups: [], overAt: 0, jumps: 0
  };

  function resetGame() {
    G.score = 0; G.combo = 0; G.newBest = false; G.jumps = 0; G.popups = [];
    var first = makePlatform(0, 0, 40, 'box');
    G.plats = [first]; G.cur = first;
    G.next = nextPlatform(first, 0); G.plats.push(G.next);
    G.player = { x: 0, z: 0, y: CFG.platH, sq: 1, rot: 0 };
    G.jump = null; G.fall = null;
    updateCamTarget(true);
    G.state = 'ready';
  }

  function startJump(pressMs) {
    if (G.state !== 'charging' && G.state !== 'ready') return;
    var p = G.player, n = G.next;
    var dx = n.x - p.x, dz = n.z - p.z, len = Math.hypot(dx, dz) || 1;
    var d = jumpDistance(pressMs);
    G.jump = { t0: Env.now(), sx: p.x, sz: p.z, ex: p.x + dx / len * d, ez: p.z + dz / len * d, sy: p.y, dirSign: n.dir === 'x' ? 1 : -1, press: pressMs };
    G.cur.press = 0; p.sq = 1;
    G.state = 'jumping';
    G.jumps++;
  }

  function land() {
    var p = G.player, n = G.next, c = G.cur;
    p.y = CFG.platH; p.rot = 0;
    if (onPlatform(n, p.x, p.z)) {
      var add;
      if (isCenter(n, p.x, p.z)) { G.combo++; add = 2 * G.combo; }
      else { G.combo = 0; add = 1; }
      G.score += add;
      if (G.score > G.best) { G.best = G.score; G.newBest = true; Env.setItem(CFG.bestKey, G.best); }
      G.popups.push({ text: '+' + add, x: p.x, z: p.z, t0: Env.now(), center: add > 1 });
      G.cur = n;
      G.next = nextPlatform(n, G.score);
      G.plats.push(G.next);
      if (G.plats.length > 8) G.plats.shift();
      updateCamTarget(false);
      G.state = 'ready';
      return 'hit';
    }
    if (onPlatform(c, p.x, p.z)) { G.state = 'ready'; return 'stay'; } // 落回当前平台：不得分、不结束、连击保持
    G.fall = { t0: Env.now() };
    G.state = 'falling';
    return 'miss';
  }

  function gameOver() {
    G.state = 'over'; G.overAt = Env.now();
    if (G.score > G.best) { G.best = G.score; Env.setItem(CFG.bestKey, G.best); G.newBest = true; }
  }

  // ---------------- 渲染 ----------------
  var canvas = Env.canvas, ctx = canvas.getContext('2d');
  var W = 0, H = 0;
  function resize() {
    var s = Env.size(); W = s.w; H = s.h;
    canvas.width = Math.round(W * s.dpr); canvas.height = Math.round(H * s.dpr);
    if (canvas.style) { canvas.style.width = W + 'px'; canvas.style.height = H + 'px'; }
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  }
  function iso(x, z) { return { x: (x - z) * 0.866, y: -(x + z) * 0.5 }; }
  function proj(x, y, z) {
    var i = iso(x, z);
    return { x: i.x - G.cam.x + W / 2, y: i.y - y - G.cam.y + H * 0.62 };
  }
  function updateCamTarget(snap) {
    var a = iso(G.cur.x, G.cur.z), b = iso(G.next.x, G.next.z);
    G.cam.tx = (a.x + b.x) / 2; G.cam.ty = (a.y + b.y) / 2;
    if (snap) { G.cam.x = G.cam.tx; G.cam.y = G.cam.ty; }
  }
  function shade(hex, f) {
    var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 'rgb(' + Math.round(r * f) + ',' + Math.round(g * f) + ',' + Math.round(b * f) + ')';
  }
  function poly(pts, fill) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  }
  function drawPlatform(p) {
    var top = CFG.platH - p.press, s = p.s;
    if (p.type === 'box') {
      var c1t = proj(p.x - s, top, p.z - s), c2t = proj(p.x + s, top, p.z - s), c3t = proj(p.x + s, top, p.z + s), c4t = proj(p.x - s, top, p.z + s);
      var c1b = proj(p.x - s, 0, p.z - s), c2b = proj(p.x + s, 0, p.z - s), c4b = proj(p.x - s, 0, p.z + s);
      poly([c1t, c2t, c2b, c1b], shade(p.color, 0.78));
      poly([c1t, c4t, c4b, c1b], shade(p.color, 0.62));
      poly([c1t, c2t, c3t, c4t], p.color);
    } else {
      var ct = proj(p.x, top, p.z), cb = proj(p.x, 0, p.z), rx = s * 1.2247, ry = s * 0.7071;
      ctx.fillStyle = shade(p.color, 0.7);
      ctx.beginPath(); ctx.ellipse(cb.x, cb.y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(ct.x - rx, ct.y, rx * 2, cb.y - ct.y);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.ellipse(ct.x, ct.y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    }
    // 中心标记（淡）
    var cc = proj(p.x, top, p.z), cr = s * 2 * CFG.centerRatio;
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.ellipse(cc.x, cc.y, cr * 1.2247, cr * 0.7071, 0, 0, Math.PI * 2); ctx.fill();
  }
  function drawPlayer() {
    var p = G.player, f = proj(p.x, p.y, p.z), h = 34 * p.sq;
    ctx.save(); ctx.translate(f.x, f.y - h / 2); ctx.rotate(p.rot); ctx.translate(0, h / 2);
    ctx.fillStyle = '#3b3355';
    ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(9, 0); ctx.lineTo(5, -h * 0.72); ctx.lineTo(-5, -h * 0.72); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -h * 0.72 - 8, 8, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function drawText(t, x, y, size, color, align) {
    ctx.fillStyle = color; ctx.font = 'bold ' + size + 'px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, x, y);
  }
  var BTN = { w: 180, h: 54 };
  function btnRect() { return { x: W / 2 - BTN.w / 2, y: H * 0.62, w: BTN.w, h: BTN.h }; }
  function drawButton(label) {
    var b = btnRect(); ctx.fillStyle = '#22c55e';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(b.x, b.y, b.w, b.h, 27) : ctx.rect(b.x, b.y, b.w, b.h); ctx.fill();
    drawText(label, W / 2, b.y + b.h / 2, 20, '#fff');
  }
  function render() {
    var g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#e9edf3'); g.addColorStop(1, '#c9cfdb');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (G.state === 'start') {
      drawText('跳一跳', W / 2, H * 0.36, 44, '#3b3355');
      drawText('按住屏幕蓄力，松手起跳', W / 2, H * 0.46, 16, '#555');
      drawButton('开始游戏'); return;
    }
    var list = G.plats.slice().sort(function (a, b) { return (b.x + b.z) - (a.x + a.z); });
    var falling = G.state === 'falling' || G.state === 'over';
    var pd = G.player.x + G.player.z, drawn = false;
    for (var i = 0; i < list.length; i++) {
      // 掉落时按深度插入：落到平台后方会被平台挡住
      if (falling && !drawn && (list[i].x + list[i].z) < pd) { drawPlayer(); drawn = true; }
      drawPlatform(list[i]);
      if (list[i] === G.cur && !falling && G.state !== 'jumping') drawPlayer();
    }
    if ((falling && !drawn) || G.state === 'jumping') drawPlayer();
    var now = Env.now();
    G.popups = G.popups.filter(function (pp) { return now - pp.t0 < 700; });
    G.popups.forEach(function (pp) {
      var k = (now - pp.t0) / 700, q = proj(pp.x, CFG.platH + 50 + k * 30, pp.z);
      ctx.globalAlpha = 1 - k; drawText(pp.text, q.x, q.y, pp.center ? 24 : 18, pp.center ? '#f97316' : '#3b3355'); ctx.globalAlpha = 1;
    });
    drawText(String(G.score), 20, 40, 36, '#3b3355', 'left');
    if (G.combo > 1) drawText('连击 x' + G.combo, 20, 76, 16, '#f97316', 'left');
    if (G.state === 'over') {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
      drawText('游戏结束', W / 2, H * 0.3, 32, '#fff');
      drawText('本局得分  ' + G.score, W / 2, H * 0.41, 22, '#fff');
      drawText((G.newBest ? '新纪录！' : '') + '最高分  ' + G.best, W / 2, H * 0.49, 18, G.newBest ? '#fde047' : '#ddd');
      drawButton('再来一局');
    }
  }

  // ---------------- 主循环 ----------------
  var lastT = 0;
  function update() {
    var now = Env.now(), p = G.player;
    var dt = lastT ? Math.min(now - lastT, 100) : 16.67; lastT = now;
    if (G.state === 'charging') {
      var k = Math.min(now - G.pressStart, CFG.maxPress) / CFG.maxPress;
      G.cur.press = k * CFG.maxCompress; p.sq = 1 - 0.4 * k; p.y = CFG.platH - G.cur.press;
    } else if (G.state === 'jumping') {
      var j = G.jump, t = Math.min((now - j.t0) / CFG.jumpDur, 1);
      p.x = j.sx + (j.ex - j.sx) * t; p.z = j.sz + (j.ez - j.sz) * t;
      p.y = j.sy + (CFG.platH - j.sy) * t + 4 * CFG.jumpHeight * t * (1 - t);
      p.rot = j.dirSign * t * Math.PI * 2;
      if (t >= 1) land();
    } else if (G.state === 'falling') {
      var ft = Math.min((now - G.fall.t0) / 350, 1);
      p.y = CFG.platH * (1 - ft); p.rot = 0.6 * ft;
      if (ft >= 1) gameOver();
    }
    var ck = 1 - Math.pow(0.88, dt / 16.67); // 与帧率无关
    G.cam.x += (G.cam.tx - G.cam.x) * ck; G.cam.y += (G.cam.ty - G.cam.y) * ck;
  }
  function loop() { try { update(); render(); } catch (e) { console.error(e); } Env.raf(loop); }

  // ---------------- 输入 ----------------
  function inBtn(x, y) { var b = btnRect(); return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; }
  function onDown(x, y, key) {
    if (G.state === 'start') { if (key || inBtn(x, y)) resetGame(); return; }
    if (G.state === 'over') { if (Env.now() - G.overAt > 400 && (key || inBtn(x, y))) resetGame(); return; }
    if (G.state === 'ready') { G.state = 'charging'; G.pressStart = Env.now(); }
  }
  function onUp() { if (G.state === 'charging') startJump(Env.now() - G.pressStart); }

  if (isWx) {
    wx.onTouchStart(function (e) { var t = e.touches[0]; onDown(t.clientX, t.clientY); });
    wx.onTouchEnd(onUp); wx.onTouchCancel(onUp);
  } else {
    canvas.addEventListener('pointerdown', function (e) { e.preventDefault(); try { canvas.setPointerCapture(e.pointerId); } catch (_) {} onDown(e.clientX, e.clientY); });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onUp);
    window.addEventListener('keydown', function (e) { if (e.code === 'Space' && !e.repeat) { e.preventDefault(); onDown(-1, -1, true); } });
    window.addEventListener('keyup', function (e) { if (e.code === 'Space') onUp(); });
    document.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    window.addEventListener('resize', resize);
  }

  // ---------------- 测试钩子（给小D） ----------------
  var api = {
    CFG: CFG,
    state: function () { return { state: G.state, score: G.score, combo: G.combo, best: G.best, jumps: G.jumps, player: { x: G.player.x, z: G.player.z }, cur: G.cur, next: G.next }; },
    start: function () { resetGame(); },
    jumpDistance: jumpDistance,
    pressFor: function (ms) { if (G.state === 'ready') { G.state = 'charging'; G.pressStart = Env.now() - ms; startJump(ms); } },
    // 算出正好跳到下一平台某点所需按压时长；offset=0 为中心，1 为边缘
    pressToNext: function (offset) {
      var p = G.player, n = G.next, dx = n.x - p.x, dz = n.z - p.z, len = Math.hypot(dx, dz);
      return (len + (offset || 0) * n.s) / CFG.pxPerMs;
    },
    tick: function () { update(); },  // 无 rAF 的环境（无头浏览器）手动推进
    land: land, onPlatform: onPlatform, isCenter: isCenter
  };
  if (!isWx) window.__jump = api; else GameGlobal.__jump = api;

  resize();
  loop();
})();
