import * as THREE from 'three';
import {
  DECKS,
  SHAFTS,
  DECK_HALF_WIDTH,
  DECK_HALF_DEPTH,
  PLATFORM_HALF_WIDTH,
  PLATFORM_IDS,
} from '../core/station.js';

const COLORS = {
  bg: 0x070c16,
  deck: 0x28374f,
  deckTop: 0x31435f,
  platform: 0x1d2c45,
  rail: 0x4b638a,
  corridor: 0x364b6c,
};

export class StationScene {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.bg);
    this.scene.fog = new THREE.Fog(COLORS.bg, 55, 105);

    this.camera = new THREE.PerspectiveCamera(
      42,
      container.clientWidth / container.clientHeight,
      0.1,
      240
    );
    this.orbit = { yaw: -0.72, pitch: 0.46, dist: 40 };

    this.scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x121a28, 0.95));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(14, 30, 18);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6f8fff, 0.55);
    rim.position.set(-18, 14, -16);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(0, -10, -20);
    this.scene.add(fill);

    this.deckGroups = new Map();
    this.platformGroups = new Map();
    this.doorSets = new Map();
    this.gates = new Map();

    this.buildDecks();
    this.buildPlatforms();
    this.buildCharacter();
    this.buildRoute();
    this.buildLabels();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._bindCameraControls();
    this.updateCamera();
  }

  buildDecks() {
    for (const deck of DECKS) {
      const g = new THREE.Group();
      g.position.y = deck.y;
      this.deckGroups.set(deck.id, g);
      this.scene.add(g);

      const a = SHAFTS.A;
      const b = SHAFTS.B;
      const segments = [
        { x0: -DECK_HALF_WIDTH, x1: a.shaftX - a.halfWidth },
        { x0: a.shaftX + a.halfWidth, x1: b.shaftX - b.halfWidth },
        { x0: b.shaftX + b.halfWidth, x1: DECK_HALF_WIDTH },
      ];

      for (const seg of segments) {
        const w = seg.x1 - seg.x0;
        if (w <= 0.05) continue;
        const slab = new THREE.Mesh(
          new THREE.BoxGeometry(w, 0.3, DECK_HALF_DEPTH * 2),
          new THREE.MeshStandardMaterial({ color: COLORS.deck, roughness: 0.9, metalness: 0.1 })
        );
        slab.position.set((seg.x0 + seg.x1) / 2, 0, 0);
        g.add(slab);

        const top = new THREE.Mesh(
          new THREE.BoxGeometry(w - 0.12, 0.02, DECK_HALF_DEPTH * 2 - 0.12),
          new THREE.MeshStandardMaterial({ color: COLORS.deckTop, roughness: 0.95 })
        );
        top.position.set((seg.x0 + seg.x1) / 2, 0.16, 0);
        g.add(top);

        // walking strip marks the safe corridor lane
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(w - 0.2, 0.025, 0.7),
          new THREE.MeshStandardMaterial({ color: COLORS.corridor, roughness: 1 })
        );
        strip.position.set((seg.x0 + seg.x1) / 2, 0.175, 0);
        g.add(strip);
      }

      // perimeter trim
      const trimMat = new THREE.MeshBasicMaterial({ color: 0x3a4f70 });
      for (const side of [-1, 1]) {
        const trim = new THREE.Mesh(
          new THREE.BoxGeometry(DECK_HALF_WIDTH * 2, 0.04, 0.08),
          trimMat
        );
        trim.position.set(0, 0.16, side * DECK_HALF_DEPTH);
        g.add(trim);
      }

      for (const pid of PLATFORM_IDS) {
        const s = SHAFTS[pid];
        // shaft guide rails
        for (const side of [-1, 1]) {
          const rail = new THREE.Mesh(
            new THREE.BoxGeometry(0.07, 4.0, 0.07),
            new THREE.MeshStandardMaterial({ color: COLORS.rail, metalness: 0.7, roughness: 0.35 })
          );
          rail.position.set(s.shaftX + side * (s.halfWidth + 0.12), 2.0, side * (DECK_HALF_DEPTH + 0.12));
          g.add(rail);
        }

        // hazard-zone marker around the shaft cut
        const hazard = new THREE.Mesh(
          new THREE.PlaneGeometry(s.halfWidth * 2 + 0.6, DECK_HALF_DEPTH * 2),
          new THREE.MeshBasicMaterial({
            color: pid === 'A' ? 0x123a4a : 0x4a3a12,
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide,
          })
        );
        hazard.rotation.x = -Math.PI / 2;
        hazard.position.set(s.shaftX, 0.02, 0);
        g.add(hazard);

        // sliding gate at the corridor-side deck edge
        if (s.stops === undefined) {
          // built below regardless of service; gate opens only with the car
        }
        const gate = new THREE.Group();
        const gateMat = new THREE.MeshStandardMaterial({
          color: pid === 'A' ? 0x5ad1ff : 0xffd166,
          metalness: 0.4,
          roughness: 0.35,
          emissive: new THREE.Color(pid === 'A' ? 0x0d3a4a : 0x4a3608),
        });
        const shutter = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.45, DECK_HALF_DEPTH * 2 - 0.2), gateMat);
        shutter.position.set(0, 0.75, 0);
        gate.add(shutter);
        // chevron stripes
        for (let i = -3; i <= 3; i += 1) {
          const stripe = new THREE.Mesh(
            new THREE.BoxGeometry(0.06, 0.09, 0.5),
            new THREE.MeshBasicMaterial({ color: 0x0a1420 })
          );
          stripe.position.set(0.02, 0.75 + i * 0.2, 0);
          gate.add(stripe);
        }
        gate.position.set(s.edgeX, 0, 0);
        g.add(gate);
        this.gates.set(`${pid}:${deck.id}`, { group: gate, shutter });
      }

      const plate = makeTextSprite(`${deck.name} · ${deck.label}`, {
        color: '#dbe7ff',
        background: 'rgba(14,24,40,0.9)',
        size: 0.62,
      });
      plate.position.set(-DECK_HALF_WIDTH - 1.1, 1.4, 0);
      g.add(plate);
    }
  }

  buildPlatforms() {
    for (const pid of PLATFORM_IDS) {
      const s = SHAFTS[pid];
      const root = new THREE.Group();
      root.position.x = s.shaftX;
      this.platformGroups.set(pid, root);
      this.scene.add(root);

      const car = new THREE.Group();
      root.add(car);

      const floor = new THREE.Mesh(
        new THREE.BoxGeometry(PLATFORM_HALF_WIDTH * 2, 0.22, DECK_HALF_DEPTH * 2 - 0.5),
        new THREE.MeshStandardMaterial({
          color: COLORS.platform,
          roughness: 0.55,
          metalness: 0.4,
          emissive: new THREE.Color(s.color).multiplyScalar(0.1),
        })
      );
      car.add(floor);

      const deckStripe = new THREE.Mesh(
        new THREE.BoxGeometry(PLATFORM_HALF_WIDTH * 2 - 0.1, 0.025, 0.14),
        new THREE.MeshBasicMaterial({ color: s.color })
      );
      deckStripe.position.y = 0.14;
      car.add(deckStripe);

      // cabin: back wall + roof + corner posts make vertical motion readable
      const glass = new THREE.MeshStandardMaterial({
        color: s.color,
        transparent: true,
        opacity: 0.16,
        roughness: 0.2,
        metalness: 0.6,
        side: THREE.DoubleSide,
      });
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(PLATFORM_HALF_WIDTH * 1.9, 2.5, DECK_HALF_DEPTH * 2 - 0.7),
        glass
      );
      wall.position.y = 1.4;
      car.add(wall);

      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(PLATFORM_HALF_WIDTH * 2 + 0.08, 0.12, DECK_HALF_DEPTH * 2 - 0.4),
        new THREE.MeshStandardMaterial({ color: 0x39506f, metalness: 0.6, roughness: 0.35 })
      );
      roof.position.y = 2.68;
      car.add(roof);

      const beacon = new THREE.Mesh(
        new THREE.BoxGeometry(PLATFORM_HALF_WIDTH * 2 - 0.3, 0.06, 0.12),
        new THREE.MeshBasicMaterial({ color: s.color })
      );
      beacon.position.set(0, 2.76, 0);
      car.add(beacon);

      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const post = new THREE.Mesh(
            new THREE.BoxGeometry(0.06, 2.6, 0.06),
            new THREE.MeshStandardMaterial({ color: 0x8fb4e0, metalness: 0.75, roughness: 0.3 })
          );
          post.position.set(sx * PLATFORM_HALF_WIDTH, 1.35, sz * (DECK_HALF_DEPTH - 0.42));
          car.add(post);
        }
      }

      // doors on the corridor side
      const doorMat = new THREE.MeshStandardMaterial({
        color: 0xa9ccef,
        metalness: 0.5,
        roughness: 0.3,
        transparent: true,
        opacity: 0.9,
      });
      const doorGroup = new THREE.Group();
      doorGroup.position.set(PLATFORM_HALF_WIDTH - 0.02, 1.15, 0);
      car.add(doorGroup);
      const panels = [];
      for (const dir of [-1, 1]) {
        const panel = new THREE.Mesh(
          new THREE.BoxGeometry(0.05, 2.0, 1.22),
          doorMat.clone()
        );
        panel.userData.dir = dir;
        doorGroup.add(panel);
        panels.push(panel);
      }
      this.doorSets.set(pid, { group: doorGroup, panels });

      // floor halo ring while docked
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(PLATFORM_HALF_WIDTH * 0.9, PLATFORM_HALF_WIDTH * 1.25, 32),
        new THREE.MeshBasicMaterial({
          color: s.color,
          transparent: true,
          opacity: 0.25,
          side: THREE.DoubleSide,
        })
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.13;
      car.add(halo);

      root.userData = { car, halo, wall };
    }
  }

  buildCharacter() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, 0.8, 8, 16),
      new THREE.MeshStandardMaterial({ color: 0xff7b72, roughness: 0.45, emissive: 0x5a1a14, emissiveIntensity: 0.7 })
    );
    body.position.y = 1.0;
    g.add(body);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.25, 24, 18),
      new THREE.MeshStandardMaterial({ color: 0xffd9c9, roughness: 0.55 })
    );
    head.position.y = 1.78;
    g.add(head);
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.09, 0.09),
      new THREE.MeshBasicMaterial({ color: 0x0a1420 })
    );
    visor.position.set(0, 1.82, 0.21);
    g.add(visor);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.46, 0.62, 44),
      new THREE.MeshBasicMaterial({
        color: 0x6ef3b5,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.2;
    g.add(ring);
    this.charRing = ring;

    const glow = new THREE.PointLight(0xff7b72, 2.2, 5, 2);
    glow.position.y = 1.1;
    g.add(glow);

    this.character = g;
    this.scene.add(g);
  }

  buildRoute() {
    this.routeMesh = null;
    this.ghostMesh = null;
  }

  buildLabels() {
    this.waitLabel = makeTextSprite('', {
      color: '#0b1322',
      background: 'rgba(110,243,181,0.94)',
      size: 0.44,
    });
    this.waitLabel.visible = false;
    this.scene.add(this.waitLabel);

    this.timeLabel = makeTextSprite('T 0.0s', {
      color: '#dbe7ff',
      background: 'rgba(10,17,32,0.85)',
      size: 0.56,
    });
    this.timeLabel.position.set(-11.5, 13.6, 3.4);
    this.scene.add(this.timeLabel);
  }

  _bindCameraControls() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag = { x: e.clientX, y: e.clientY };
      this.orbit.yaw -= dx * 0.005;
      this.orbit.pitch = Math.max(0.06, Math.min(1.25, this.orbit.pitch + dy * 0.004));
      this.updateCamera();
    });
    el.addEventListener('pointerup', () => {
      this.drag = null;
    });
    el.addEventListener('pointercancel', () => {
      this.drag = null;
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.orbit.dist = Math.max(16, Math.min(58, this.orbit.dist + e.deltaY * 0.02));
        this.updateCamera();
      },
      { passive: false }
    );
  }

  updateCamera() {
    const { yaw, pitch, dist } = this.orbit;
    const target = new THREE.Vector3(0, 6.5, 0);
    this.camera.position.set(
      target.x + dist * Math.cos(pitch) * Math.sin(yaw),
      target.y + dist * Math.sin(pitch),
      target.z + dist * Math.cos(pitch) * Math.cos(yaw)
    );
    this.camera.lookAt(target);
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  applyFrame(frame) {
    updateTextSprite(
      this.timeLabel,
      `T ${frame.t.toFixed(1)}s   ${frame.phaseLabel}`,
      { color: '#dbe7ff', background: 'rgba(10,17,32,0.9)', size: 0.56 }
    );

    for (const pose of frame.platforms) {
      const g = this.platformGroups.get(pose.liftId);
      if (!g) continue;
      g.position.y = pose.y;
      const set = this.doorSets.get(pose.liftId);
      const doorInfo = frame.doors[pose.liftId] || {};
      const amount = doorInfo.open ? doorInfo.amount ?? 0 : 0;
      for (const p of set.panels) {
        p.position.z = 0.62 + amount * 0.85 * p.userData.dir;
        p.material.opacity = 0.35 + (1 - amount) * 0.55;
      }
      g.userData.halo.material.opacity = pose.atDeck ? 0.3 + amount * 0.35 : 0.1;
      g.userData.halo.scale.setScalar(pose.atDeck ? 1 : 0.6);
    }

    for (const [pid, byDeck] of Object.entries(frame.doors)) {
      for (const [deck, state] of Object.entries(byDeck.byDeck || {})) {
        const gate = this.gates.get(`${pid}:${deck}`);
        if (!gate) continue;
        const open = state.open ? 1 : 0;
        gate.shutter.position.y = 0.75 - open * 1.35;
        gate.shutter.material.emissiveIntensity = state.open ? 1.1 : 0.15;
        gate.shutter.material.opacity = 0.9;
        gate.shutter.material.transparent = true;
        gate.shutter.visible = open < 0.98;
      }
    }

    const a = frame.agent;
    const ax = a.x ?? 0;
    const ay = a.y ?? 0;
    const az = a.z ?? 0;
    this.character.position.set(ax, ay, az);
    this.character.visible = a.visible !== false;
    this.charRing.visible = a.safe !== false;
    this.charRing.material.color.set(a.waiting ? 0x6ef3b5 : a.riding ? 0x5ad1ff : 0x9aa9c2);
    this.charRing.material.opacity = a.waiting ? 0.8 : 0.35;

    if (a.waitLabel) {
      this.waitLabel.visible = true;
      this.waitLabel.position.set(ax + 1.1, ay + 2.55, az + 0.4);
      updateTextSprite(this.waitLabel, a.waitLabel, {
        color: '#0b1322',
        background: 'rgba(110,243,181,0.94)',
        size: 0.44,
      });
    } else {
      this.waitLabel.visible = false;
    }

    this.setRoute(frame.route, frame.ghostRoute);
  }

  setRoute(points, ghostPoints) {
    this.routeMesh = replaceTube(this.routeMesh, this.scene, points, 0x8fe6ff, 0.055, 0.13);
    this.ghostMesh = replaceTube(this.ghostMesh, this.scene, ghostPoints, 0xffa66b, 0.04, -0.02);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
  }
}

function replaceTube(prev, scene, points, color, radius, lift) {
  if (prev) {
    scene.remove(prev);
    prev.geometry.dispose();
    prev.material.dispose();
  }
  if (!points || points.length < 2) return null;
  const curvePoints = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const np = new THREE.Vector3(p.x, p.y + lift + 0.1, p.z);
    if (i > 0) {
      const last = curvePoints[curvePoints.length - 1];
      if (last.distanceTo(np) < 1e-4) continue;
    }
    curvePoints.push(np);
  }
  if (curvePoints.length < 2) return null;
  const curve = new THREE.CatmullRomCurve3(curvePoints, false, 'catmullrom', 0.15);
  const geo = new THREE.TubeGeometry(curve, Math.max(12, curvePoints.length * 10), radius, 6, false);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);
  return mesh;
}

/* ------------------------------------------------------------------ labels */

function makeTextTexture(text, { color = '#fff', background = 'rgba(0,0,0,0.6)' } = {}) {
  const canvas = document.createElement('canvas');
  const fontPx = 48;
  const pad = 22;
  const ctx = canvas.getContext('2d');
  ctx.font = `600 ${fontPx}px "SF Mono","Noto Sans CJK SC","PingFang SC",Menlo,monospace`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = fontPx + pad * 2;
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d');
  c.fillStyle = background;
  roundRect(c, 0, 0, w, h, 16);
  c.fill();
  c.font = `600 ${fontPx}px "SF Mono","Noto Sans CJK SC","PingFang SC",Menlo,monospace`;
  c.fillStyle = color;
  c.textBaseline = 'middle';
  c.fillText(text, pad, h / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.userData = { aspect: w / h };
  return tex;
}

function makeTextSprite(text, opts) {
  const map = makeTextTexture(text, opts);
  const mat = new THREE.SpriteMaterial({ map, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const scale = opts.size ?? 0.4;
  sprite.scale.set(scale * (map.userData.aspect || 4), scale, 1);
  sprite.userData = { opts, last: text };
  return sprite;
}

function updateTextSprite(sprite, text, opts) {
  if (sprite.userData.last === text) return;
  sprite.userData.last = text;
  const map = makeTextTexture(text, opts);
  if (sprite.material.map) sprite.material.map.dispose();
  sprite.material.map = map;
  const scale = opts.size ?? 0.4;
  sprite.scale.set(scale * (map.userData.aspect || 4), scale, 1);
  sprite.material.needsUpdate = true;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
