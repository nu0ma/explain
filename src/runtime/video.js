(() => {
  const D = JSON.parse(document.getElementById('amv-data').textContent);
  const W = 1920;
  const H = 1080;
  const T = 0.9;     // 場面の切り替え時間。TIMING.transition と同じ値
  const R = 0.6;     // 1 手順が現れるまでの時間
  const CAM = 0.8;   // カメラの移動時間
  const root = document.documentElement;
  const stage = document.querySelector('.amv-stage');
  const camera = document.querySelector('.amv-camera');
  const overlay = document.querySelector('.amv-overlay');
  const caption = document.querySelector('.amv-caption span');
  const scenes = [...document.querySelectorAll('.amv-scene')];
  const segs = D.segments;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const ease = (x) => { const v = clamp(x); return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2; };
  const lerp = (a, b, p) => a + (b - a) * p;
  const STEP_SEL = '.am-tl-item, .am-lim, .am-seg, tbody tr, .am-kv-cell, .am-md > ul > li, .am-md > ol > li, .am-md > p, .am-md > blockquote, .am-callout';

  // ── 1. 各場面の内容を画面に収める ──
  for (const sc of scenes) {
    const fit = sc.querySelector('.amv-fit');
    if (!fit || !fit.children.length) continue;
    const s = Math.min(1600 / fit.offsetWidth, 740 / fit.offsetHeight, 3.4);
    fit.style.transform = `scale(${s})`;
  }

  // 場面の題名はカメラの外に置く。カメラが寄っても題名は動かない。
  const heads = scenes.map((sc) => {
    const h = sc.querySelector('.amv-scene-head');
    if (h) stage.insertBefore(h, camera.nextSibling);
    return h;
  });

  // 舞台を座標系として要素を測る（このときカメラは恒等変換）。
  const sr = stage.getBoundingClientRect();
  const k = sr.width / W;
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: (r.left - sr.left) / k, y: (r.top - sr.top) / k, w: r.width / k, h: r.height / k };
  };

  // ── 2. 手順に分ける：部品に data-step があればそれでまとめ、なければ行や項目ごとに自動で分ける ──
  const items = [];   // { el, at, paths: [{ el, len }] }
  scenes.forEach((sc, i) => {
    if (i === 0) return;
    const groups = [];
    for (const block of sc.querySelectorAll('.amv-fit > *')) {
      const marked = [...block.querySelectorAll('[data-step]')];
      if (marked.length) {
        const by = new Map();
        for (const el of marked) {
          const n = Number(el.dataset.step);
          if (!by.has(n)) by.set(n, []);
          by.get(n).push(el);
        }
        [...by.keys()].sort((a, b) => a - b).forEach((n) => groups.push(by.get(n)));
      } else {
        const found = [...block.querySelectorAll(STEP_SEL)].filter((el) => !el.parentElement.closest(STEP_SEL));
        if (found.length) found.forEach((el) => groups.push([el]));
        else groups.push([block]);
      }
    }
    const beats = segs[i].beats;
    const S = groups.length;
    const B = beats.length;
    const perBeat = new Map();
    groups.forEach((g, gi) => {
      // ナレーションが手順より多いときは、余った文を前置きにし、手順を最後の数文にそろえる。
      const b = S <= B ? gi + (B - S) : Math.floor((gi * B) / S);
      const rank = perBeat.get(b) ?? 0;
      perBeat.set(b, rank + 1);
      const beat = beats[b];
      const count = S <= B ? 1 : Math.ceil(S / B) || 1;
      const slot = Math.min(0.45, (beat.end - beat.start) / count);
      for (const el of g) {
        const paths = (el.matches('path.am-edge') ? [el] : [...el.querySelectorAll('path.am-edge')])
          .filter((p) => !p.classList.contains('am-edge--dashed'))
          .map((p) => ({ el: p, len: p.getTotalLength() }));
        items.push({ el, scene: i, at: beat.start + rank * slot, paths });
      }
    });
  });

  // ── 3. 場面をまたぐ変形：前後の場面にある同じ名前（data-key）の要素 ──
  const morphs = [];  // { scene, from, to, ghost, a, b }
  const keyed = (sc) => {
    const m = new Map();
    for (const el of sc.querySelectorAll('[data-key]')) if (!m.has(el.dataset.key)) m.set(el.dataset.key, el);
    return m;
  };
  for (let i = 2; i < scenes.length; i++) {
    const prev = keyed(scenes[i - 1]);
    for (const [key, to] of keyed(scenes[i])) {
      const from = prev.get(key);
      // 同じ種類の要素どうし（SVG と SVG、HTML と HTML）でだけ変形する。そうしないと形が合わない。
      if (!from || (from instanceof SVGElement) !== (to instanceof SVGElement)) continue;
      try {
        const ghost = makeGhost(from);
        overlay.append(ghost.node);
        morphs.push({ scene: i, from, to, ghost: ghost.node, a: ghost.place(rectOf(from)), b: ghost.place(rectOf(to)) });
      } catch {
        // 変形はおまけ。測れない要素があっても飛ばすだけで、再生には影響させない。
      }
    }
  }
  const carried = new Set(morphs.map((m) => m.to));

  function makeGhost(el) {
    const wrap = document.createElement('div');
    const host = el.closest('.am-diagram, .am-tree, .am-timeline, .am-kv, .am-limits');
    wrap.className = `amv-ghost ${host ? host.className : ''}`;
    if (el instanceof SVGGraphicsElement) {
      const bb = el.getBBox();
      const pad = 4;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `${bb.x - pad} ${bb.y - pad} ${bb.width + pad * 2} ${bb.height + pad * 2}`);
      svg.setAttribute('width', bb.width + pad * 2);
      svg.setAttribute('height', bb.height + pad * 2);
      const clone = el.cloneNode(true);
      clone.removeAttribute('style');
      svg.append(clone);
      wrap.append(svg);
      return {
        node: wrap,
        place: (r) => {
          const s = r.w / (bb.width || 1);
          return { x: r.x - pad * s, y: r.y - pad * s, s };
        },
      };
    }
    const clone = el.cloneNode(true);
    clone.removeAttribute('style');
    clone.querySelectorAll('[data-key], ul').forEach((n) => n.remove());
    const box = document.createElement(el.tagName === 'LI' ? 'ul' : 'div');
    box.className = el.tagName === 'LI' ? 'am-tree-list' : '';
    box.style.margin = '0';
    box.append(clone);
    wrap.append(box);
    wrap.style.width = `${el.offsetWidth}px`;
    const w0 = el.offsetWidth || 1;
    return { node: wrap, place: (r) => ({ x: r.x, y: r.y, s: r.w / w0 }) };
  }

  // ── 4. カメラ：ナレーションの [名前] に対応する要素 ──
  const findKey = (sc, key) => {
    const all = [...sc.querySelectorAll('[data-key]')];
    const norm = (s) => s.replace(/[`*]/g, '').trim().toLowerCase();
    return all.find((el) => norm(el.dataset.key) === norm(key))
      ?? all.find((el) => norm(el.dataset.key).includes(norm(key)))
      ?? [...sc.querySelectorAll(`${STEP_SEL}, text`)].find((el) => norm(el.textContent).includes(norm(key)));
  };
  const IDENT = { s: 1, x: 0, y: 0 };
  // 寄っても切らない。拡大した後も図全体を、題名と字幕の間の安全な範囲に収める。
  const SAFE = { left: 60, right: W - 60, top: 140, bottom: H - 150 };
  function focusCam(r, sc) {
    const fit = sc.querySelector('.amv-fit');
    const c = fit ? rectOf(fit) : { x: 0, y: 0, w: W, h: H };
    const room = Math.min((SAFE.right - SAFE.left) / c.w, (SAFE.bottom - SAFE.top) / c.h);
    const s = clamp(Math.min(0.5 * W / r.w, 0.42 * H / r.h, room, 1.4), 1, 1.4);
    const fitAxis = (want, lo, hi, a, b) => (s * (b - a) <= hi - lo ? clamp(want, lo - s * a, hi - s * b) : want);
    return {
      s,
      x: fitAxis(W / 2 - s * (r.x + r.w / 2), SAFE.left, SAFE.right, c.x, c.x + c.w),
      y: fitAxis(H * 0.5 - s * (r.y + r.h / 2), SAFE.top, SAFE.bottom, c.y, c.y + c.h),
    };
  }
  const camEvents = [];   // { t, cam, hl }
  segs.forEach((seg, i) => {
    camEvents.push({ t: seg.start, cam: IDENT, hl: null });
    seg.beats.forEach((b) => {
      const el = b.focus ? findKey(scenes[i], b.focus) : null;
      let cam = IDENT;
      if (el) cam = focusCam(rectOf(el), scenes[i]);
      camEvents.push({ t: b.start, cam, hl: el });
    });
  });
  const hlTargets = new Set(camEvents.map((e) => e.hl).filter(Boolean));

  // ── 5. 決定的な描画：同じ時刻には必ず同じフレームを描く ──
  function render(t) {
    t = clamp(t, 0, D.duration);
    const cur = segs.findLastIndex((s) => t >= s.start);

    scenes.forEach((sc, i) => {
      const seg = segs[i];
      const next = segs[i + 1];
      const fadeIn = i === 0 ? ease(t / 0.8) : ease((t - seg.start) / T);
      const fadeOut = next ? 1 - ease((t - next.start) / T) : 1;
      const op = t < seg.start ? 0 : Math.min(fadeIn, fadeOut);
      sc.style.opacity = op;
      sc.style.visibility = op > 0 ? 'visible' : 'hidden';
      if (heads[i]) {
        // 題名を重ねない。古い題名は切り替えの前半で消え、新しい題名は後半で現れる。
        const hin = ease((t - seg.start - T / 2) / (T / 2));
        const hout = next ? 1 - ease((t - next.start) / (T / 2)) : 1;
        const hop = t < seg.start ? 0 : Math.min(hin, hout);
        heads[i].style.opacity = hop;
        heads[i].style.visibility = hop > 0 ? 'visible' : 'hidden';
      }
    });

    for (const it of items) {
      const p = ease((t - it.at) / R);
      const fade = clamp((t - it.at) / 0.25);
      if (carried.has(it.el)) continue;
      it.el.style.opacity = fade;
      if (it.paths.length) {
        for (const { el, len } of it.paths) {
          el.style.strokeDasharray = `${len}`;
          el.style.strokeDashoffset = `${len * (1 - p)}`;
          el.style.markerEnd = p < 0.97 ? 'none' : '';
        }
      } else {
        it.el.style.transform = p < 1 ? `translateY(${(1 - p) * 14}px)` : '';
      }
    }

    for (const m of morphs) {
      const s0 = segs[m.scene].start;
      const during = t >= s0 && t < s0 + T;
      const p = ease((t - s0) / T);
      m.ghost.style.display = during ? '' : 'none';
      if (during) {
        m.ghost.style.transform = `translate(${lerp(m.a.x, m.b.x, p)}px, ${lerp(m.a.y, m.b.y, p)}px) scale(${lerp(m.a.s, m.b.s, p)})`;
      }
      m.from.style.visibility = during ? 'hidden' : '';
      m.to.style.visibility = t < s0 + T ? 'hidden' : '';
      m.to.style.opacity = 1;
    }

    // カメラと強調
    const ev = camEvents.findLastIndex((e) => t >= e.t);
    let cam = IDENT;
    let hl = null;
    if (ev >= 0) {
      const e = camEvents[ev];
      const prev = ev > 0 ? camEvents[ev - 1].cam : IDENT;
      const p = ease((t - e.t) / CAM);
      cam = { s: lerp(prev.s, e.cam.s, p), x: lerp(prev.x, e.cam.x, p), y: lerp(prev.y, e.cam.y, p) };
      hl = e.hl;
    }
    camera.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`;
    for (const el of hlTargets) el.classList.toggle('amv-hl', el === hl);

    // 字幕
    const beats = cur >= 0 ? segs[cur].beats : [];
    const b = beats.find((x) => t >= x.start && t < x.end + 0.3);
    const html = b ? b.html : '';
    if (caption.dataset.html !== html) {
      caption.innerHTML = html;
      caption.dataset.html = html;
    }
    caption.style.opacity = b ? clamp((t - b.start) / 0.2) : 0;
    updateUi(t);
  }

  // ── 6. プレーヤー ──
  const audio = document.getElementById('amv-audio');
  const seek = document.querySelector('.amv-seek');
  const timeEl = document.querySelector('.amv-time');
  const toggleBtn = document.querySelector('[data-amv="toggle"]');
  const bigPlay = document.querySelector('.amv-bigplay');
  const marks = document.querySelector('.amv-marks');
  const fmt = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  seek.max = D.duration;
  segs.slice(1).forEach((s) => {
    const m = document.createElement('i');
    m.style.left = `${(s.start / D.duration) * 100}%`;
    m.title = s.title;
    marks.append(m);
  });

  let playing = false;
  let base = 0;
  let t0 = 0;
  const now = () => (!playing ? base : audio ? audio.currentTime : base + (performance.now() - t0) / 1000);

  function updateUi(t) {
    if (document.activeElement !== seek) seek.value = t;
    timeEl.textContent = `${fmt(t)} / ${fmt(D.duration)}`;
  }

  function play() {
    if (base >= D.duration - 0.05) base = 0;
    playing = true;
    bigPlay.hidden = true;
    toggleBtn.textContent = '❚❚';
    toggleBtn.setAttribute('aria-label', toggleBtn.dataset.pause);
    if (audio) {
      audio.currentTime = base;
      audio.play().catch(() => {});
    } else {
      t0 = performance.now();
    }
    requestAnimationFrame(tick);
  }

  function pause() {
    base = now();
    playing = false;
    audio?.pause();
    toggleBtn.textContent = '▶';
    toggleBtn.setAttribute('aria-label', toggleBtn.dataset.play);
  }

  function seekTo(x) {
    base = clamp(x, 0, D.duration);
    if (audio) audio.currentTime = base;
    t0 = performance.now();
    render(base);
  }

  function tick() {
    if (!playing) return;
    const t = now();
    if (t >= D.duration) {
      pause();
      base = D.duration;
      render(D.duration);
      return;
    }
    render(t);
    requestAnimationFrame(tick);
  }

  const toggle = () => (playing ? pause() : play());
  toggleBtn.addEventListener('click', toggle);
  bigPlay.addEventListener('click', play);
  stage.addEventListener('click', (e) => { if (e.target !== bigPlay) toggle(); });
  seek.addEventListener('input', () => seekTo(Number(seek.value)));
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    if (e.key === 'ArrowRight') seekTo(now() + 5);
    if (e.key === 'ArrowLeft') seekTo(now() - 5);
  });
  audio?.addEventListener('ended', () => { pause(); base = D.duration; });

  function fitStage() {
    if (root.hasAttribute('data-export')) return;
    const vp = stage.parentElement;
    const s = Math.min(vp.clientWidth / W, vp.clientHeight / H);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }
  window.addEventListener('resize', fitStage);

  // 書き出し：舞台を等倍で左上に置き、フレームごとに render(t) を呼ぶ。
  window.render = render;
  window.__amv = {
    duration: D.duration,
    fps: D.fps,
    exportMode() {
      root.setAttribute('data-export', '');
      // 書き出す環境の配色で結果が変わらないよう、auto はライトに固定する。
      if (root.getAttribute('data-mode') === 'auto') root.setAttribute('data-mode', 'light');
      stage.style.transform = '';
    },
  };
  fitStage();
  // 表紙：完全に現れた後のタイトル画面を見せる。再生は 0 秒から始める。
  render(Math.min(1, segs[0].end));
  updateUi(0);
})();
