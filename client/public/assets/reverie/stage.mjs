import * as T from './vendor/three.module.js';
import {
  sceneModel,
  describePicture,
  furnitureKind,
  hash,
  figureAppearance,
  figurePosition,
  figureActivity,
  activityPose,
  residentFace,
  walkPose,
} from './presentation.mjs?v=296';

const COLORS = {
  wood: 0xa37750,
  edge: 0x745240,
  cream: 0xf4dfba,
  leaf: 0x648e62,
  teal: 0x3b7e7b,
  water: 0x458e9b,
  stone: 0x899594,
  brass: 0xc89a57,
  ink: 0x253f48,
};
const shapes = {
  box: new T.BoxGeometry(1, 1, 1),
  sphere: new T.SphereGeometry(1, 12, 8),
  leaf: new T.IcosahedronGeometry(1, 1),
  cylinder: new T.CylinderGeometry(1, 1, 1, 12),
  cone: new T.ConeGeometry(1, 1, 10),
  ring: new T.TorusGeometry(1, 0.025, 4, 32),
};

/** Shared-state picture. Taps request the same validated actions as the labeled controls. */
export class Stage {
  constructor(host, onFailure) {
    this.host = host;
    this.onFailure = onFailure;
    this.materials = new Map();
    this.animated = [];
    this.figures = [];
    this.textures = [];
    this.disposables = [];
    this.bubbles = [];
    this.bubbleSprites = [];
    this.nameTags = true;
    this.running = false;
    this.motion = true;
    this.visible = true;
    this.angle = 0.68;
    this.zoom = 1;
    this.time = 0;
    this.lastTime = 0;
    this.renderer = new T.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.setAttribute('role', 'presentation');
    this.canvas.className = 'reverie-canvas';
    this.host.appendChild(this.canvas);
    this.tapStart = null;
    this.raycaster = new T.Raycaster();
    this.onPointerDown = (event) => { this.tapStart = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, room: this.model?.id } : null; };
    this.onPointerCancel = () => { this.tapStart = null; };
    this.onPointerUp = (event) => {
      const start = this.tapStart; this.tapStart = null;
      if (!event.isPrimary || !start || !this.model || start.room !== this.model.id || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 9) return;
      const bounds = this.canvas.getBoundingClientRect();
      this.raycaster.setFromCamera(new T.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1), this.camera);
      const hits = this.raycaster.intersectObjects(this.world.children, true);
      for (const hit of hits) {
        let object = hit.object;
        while (object && !object.userData.interaction) object = object.parent;
        if (!object) continue;
        this.host.dispatchEvent(new CustomEvent('reverie-scene-action', { bubbles: true, detail: { roomId: this.model.id, ...object.userData.interaction } }));
        break;
      }
    };
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.scene = new T.Scene();
    this.camera = new T.OrthographicCamera(-8, 8, 5, -5, 0.1, 80);
    this.world = new T.Group();
    this.scene.add(this.world);
    this.painting = new T.TextureLoader().load(
      (window.ReverieAssetBase || '/assets/reverie/') + 'mural.webp',
      () => this.render(),
    );
    this.painting.colorSpace = T.SRGBColorSpace;
    this.paintingMaterial = new T.MeshStandardMaterial({
      map: this.painting,
      roughness: 1,
    });
    this.waterfrontPainting = new T.TextureLoader().load((window.ReverieAssetBase || '/assets/reverie/') + 'waterfront.webp', () => this.render());
    this.waterfrontPainting.colorSpace = T.SRGBColorSpace;
    this.waterfrontMaterial = new T.MeshStandardMaterial({ map: this.waterfrontPainting, roughness: 1 });
    this.hemi = new T.HemisphereLight(0xfff1d8, 0x678d98, 2.7);
    this.sun = new T.DirectionalLight(0xffe2b1, 4);
    this.sun.position.set(-4, 10, 6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, {
      left: -9,
      right: 9,
      top: 9,
      bottom: -9,
      near: 1,
      far: 30,
    });
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.hemi, this.sun);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.intersection = new IntersectionObserver((entries) => {
      this.visible = entries[0].isIntersecting;
      this.syncAnimation();
    });
    this.intersection.observe(host);
    this.visibility = () => this.syncAnimation();
    document.addEventListener('visibilitychange', this.visibility);
    this.contextLost = (event) => {
      event.preventDefault();
      this.onFailure();
    };
    this.canvas.addEventListener('webglcontextlost', this.contextLost);
    this.resize();
  }

  material(color, glow = false) {
    const key = `${color}:${glow}`;
    if (!this.materials.has(key))
      this.materials.set(
        key,
        new T.MeshStandardMaterial({
          color,
          roughness: 0.82,
          metalness: 0,
          ...(glow ? { emissive: color, emissiveIntensity: 1.5 } : {}),
        }),
      );
    return this.materials.get(key);
  }

  mesh(shape, color, position, scale, parent = this.world, glow = false) {
    const mesh = new T.Mesh(shapes[shape], this.material(color, glow));
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.castShadow = !glow;
    mesh.receiveShadow = !glow;
    parent.add(mesh);
    return mesh;
  }

  box(color, x, y, z, w, h, d, parent = this.world) {
    return this.mesh('box', color, [x, y, z], [w, h, d], parent);
  }

  group(x, y, z, rotation = 0) {
    const group = new T.Group();
    group.position.set(x, y, z);
    group.rotation.y = rotation;
    this.world.add(group);
    return group;
  }

  tree(x, z, size, seed) {
    const group = this.group(x, 0, z);
    this.mesh('cylinder', COLORS.edge, [0, 1.15, 0], [0.13, 2.3, 0.13], group);
    const crown = new T.Group();
    crown.position.y = 2;
    group.add(crown);
    const colors = [0x527f68, 0x799759, 0x4c8c79, 0x91a664, 0x3c7166];
    this.mesh('leaf', colors[seed % 5], [0, 0.45, 0], [0.95, 1.15, 0.87], crown);
    this.mesh('leaf', colors[(seed + 1) % 5], [-0.5, 0.03, 0.06], [0.72, 0.8, 0.7], crown);
    this.mesh('leaf', colors[seed % 5], [0.5, 0.2, -0.15], [0.67, 0.9, 0.7], crown);
    group.scale.setScalar(size);
    this.animated.push((t) => {
      crown.rotation.z = Math.sin(t * 0.7 + seed) * 0.018;
    });
  }

  shrub(x, z, seed, pot = false) {
    const group = this.group(x, 0, z);
    if (pot) this.mesh('cylinder', 0xb9785f, [0, 0.22, 0], [0.26, 0.44, 0.26], group);
    for (let i = 0; i < 4; i++) {
      const a = i * 1.9 + seed;
      const leaf = this.mesh(
        'leaf',
        i % 2 ? 0x507f69 : 0x8baa78,
        [Math.cos(a) * 0.18, (pot ? 0.55 : 0.2) + i * 0.065, Math.sin(a) * 0.18],
        [0.14, 0.33, 0.12],
        group,
      );
      leaf.rotation.z = Math.cos(a) * 0.7;
    }
  }

  lamp(x, z, short = false) {
    const height = short ? 1.5 : 2.5;
    const group = this.group(x, 0, z);
    this.mesh('cylinder', COLORS.ink, [0, height / 2, 0], [0.045, height, 0.045], group);
    this.box(COLORS.ink, 0, height + 0.32, 0, 0.4, 0.08, 0.4, group);
    this.mesh('box', 0xffc278, [0, height + 0.12, 0], [0.25, 0.3, 0.25], group, this.model.dark);
    this.box(COLORS.ink, 0, height - 0.07, 0, 0.35, 0.08, 0.35, group);
    if (this.model.dark) {
      const light = new T.PointLight(0xffbd79, 6, 4.5, 2);
      light.position.set(0, height, 0.15);
      group.add(light);
    }
  }

  bench(x, z, rotation = 0) {
    const g = this.group(x, 0, z, rotation);
    this.box(COLORS.wood, 0, 0.53, 0, 1.5, 0.12, 0.48, g);
    for (const y of [0.83, 1.05]) this.box(COLORS.wood, 0, y, -0.21, 1.5, 0.14, 0.08, g);
    for (const dx of [-0.55, 0.55]) this.box(COLORS.ink, dx, 0.27, 0, 0.09, 0.54, 0.35, g);
    return g;
  }

  table(x, z, parent = this.world) {
    this.box(COLORS.wood, x, 0.78, z, 1.75, 0.14, 1.1, parent);
    for (const dx of [-0.65, 0.65])
      for (const dz of [-0.35, 0.35])
        this.box(COLORS.edge, x + dx, 0.37, z + dz, 0.1, 0.74, 0.1, parent);
    this.mesh('cylinder', COLORS.cream, [x + 0.35, 0.88, z], [0.16, 0.04, 0.16], parent);
    this.mesh('cylinder', COLORS.teal, [x - 0.3, 0.97, z + 0.15], [0.08, 0.2, 0.08], parent);
  }

  water(x = -2.8, z = 0, width = 3.4, depth = 9) {
    this.box(COLORS.water, x, 0.08, z, width, 0.11, depth);
    for (let i = 0; i < 18; i++) {
      const px = x + Math.sin(i * 17) * width * 0.35;
      const pz = z - depth / 2 + (i / 18) * depth;
      const ripple = this.mesh('ring', 0x9ccdc5, [px, 0.143, pz], [0.25, 0.09, 1]);
      ripple.rotation.x = -Math.PI / 2;
      ripple.castShadow = false;
      this.animated.push((t) => {
        ripple.position.z = pz + Math.sin(t * 0.55 + i) * 0.18;
        ripple.scale.set(0.3 + Math.sin(t + i) * 0.08, 0.12, 1);
      });
    }
  }

  terrain() {
    const type = this.model.type;
    const natural = ['woodland', 'creek', 'camp'].includes(type);
    this.box(natural ? 0x596d53 : 0x6e7b76, 0, -0.46, 0, 11, 0.78, 9);
    this.box(natural ? 0x8aa575 : 0xb6b8a3, 0, -0.03, 0, 11, 0.13, 9);
    if (natural) {
      for (let i = 0; i < 14; i++) {
        const x = Math.sin(i * 29) * 4.8,
          z = Math.cos(i * 11) * 3.9;
        if (type === 'creek' && x < -1) continue;
        this.shrub(x, z, i);
        for (let j = 0; j < 3; j++)
          this.mesh(
            'sphere',
            [0xe9cf96, 0xe9b5a5, 0xe9ead0][i % 3],
            [x + j * 0.09, 0.15, z + 0.25],
            [0.055, 0.075, 0.055],
          );
      }
      for (let i = 0; i < 10; i++) {
        const z = -4 + i * 0.84;
        const x = type === 'creek' ? 1.9 + Math.sin(i * 0.43) * 0.7 : Math.sin(i * 0.6) * 1.2;
        this.mesh('cylinder', 0xbca886, [x, 0.065, z], [1.0, 0.07, 0.66]);
      }
      [
        [-4.3, -3.5, 1.12],
        [-2.4, -3.4, 1.2],
        [0.1, -3.8, 1.0],
        [2.3, -3.7, 1.18],
        [4.4, -3.1, 1.0],
        [4.65, -0.5, 0.85],
        [-4.6, 1.3, 0.85],
      ].forEach((p, i) => this.tree(p[0], p[1], p[2], i));
      if (type === 'creek') {
        this.water(-2.6, 0, 3.3, 9);
        for (let i = 0; i < 11; i++)
          this.mesh(
            'leaf',
            i % 2 ? 0xa7b4a8 : 0x748d86,
            [-0.88 + Math.sin(i * 2) * 0.22, 0.1, -4 + i * 0.8],
            [0.28, 0.16, 0.36],
          );
        for (let i = 0; i < 12; i++)
          this.mesh(
            'cylinder',
            0x527860,
            [-1.17 + (i % 3) * 0.14, 0.28, 1 + i * 0.06],
            [0.018, 0.62, 0.018],
          );
        this.bench(3.4, 0.4, -Math.PI / 2);
      }
      if (type === 'camp') this.camp();
      if (this.model.id === 'alder_hide') {
        this.box(COLORS.wood, -3.1, 0.8, -0.6, 1.9, 1.6, 0.12);
        this.box(COLORS.edge, -3.1, 1.75, -0.8, 2.25, 0.15, 1.7);
      }
      return;
    }
    if (type === 'pavilion' || type === 'netloft') { this.waterfront(); return; }
    if (type === 'harbor') {
      this.water(-3.8, 0, 3.4, 9);
      for (let i = 0; i < 30; i++)
        this.box(i % 3 ? 0xb99873 : 0xa88968, 1.5, 0.12, -4.35 + i * 0.3, 7.6, 0.15, 0.27);
      for (let i = 0; i < 6; i++) {
        this.mesh('cylinder', COLORS.edge, [-2.2, 0.45, -4 + i * 1.5], [0.11, 1.0, 0.11]);
        this.mesh('ring', COLORS.cream, [-2.2, 0.78, -4 + i * 1.5], [0.12, 0.12, 0.12]).rotation.x =
          Math.PI / 2;
      }
      this.bench(3.6, -2.3);
      this.lamp(4.2, 2.8);
      this.lamp(-1.3, -3.3);
      return;
    }
    if (type === 'yard') { this.yard(); return; }
    if (['theater', 'arcade', 'bakery', 'pool', 'studio'].includes(type)) { this.venue(); return; }
    if (type === 'town') this.town();
    else this.interior();
  }

  waterfront() {
    const open = this.model.type === 'pavilion';
    this.water(-4.2, 0, 2.1, 9);
    for (let i = 0; i < 24; i++) this.box(i % 3 ? 0xb99873 : 0xa88968, 0.9, 0.12, -4 + i * 0.34, 8.2, 0.14, 0.3);
    for (const x of [-2.8, 4.5]) for (const z of [-3.5, 3.3]) this.box(COLORS.edge, x, 1.5, z, .18, 3, .18);
    // A cutaway roof keeps the room, people, and painting visible from above.
    this.box(COLORS.teal, .8, 3.15, -3.5, 8, .2, .9);
    this.box(COLORS.cream, .8, open ? 1 : 1.6, -3.6, 7.6, open ? 1.6 : 3, .18);
    this.bench(-1.2, -.2, Math.PI / 2); this.bench(3.2, -.2, -Math.PI / 2);
    this.box(COLORS.edge, .8, 2.15, -3.45, 2.9, 1.85, .13);
    const art = new T.Mesh(shapes.box, this.waterfrontMaterial);
    art.scale.set(2.65, 1.65, .01);
    art.position.set(.8, 2.15, -3.36); this.world.add(art);
    if (open) {
      for (let i = 0; i < 18; i++) {
        const reed = this.mesh('cylinder', 0x7a8c4e, [-3 + (i % 3) * .14, .55, -3 + i * .35], [.025, 1, .025]);
        this.animated.push((t) => { reed.rotation.z = Math.sin(t * .8 + i) * .07; });
      }
    } else {
      this.box(COLORS.wood, .8, .95, -.3, 2.5, .15, 1.5);
      for (let i = 0; i < 4; i++) {
        const coil = this.mesh('ring', 0xc4aa78, [.2 + i * .4, 1.07, -.3], [.18, .18, .18]); coil.rotation.x = Math.PI / 2;
      }
    }
    this.lamp(4, 2.6);
    const token = this.box(COLORS.wood, 1, .6, 1.5, 1.8, .16, .65);
    token.userData.interaction = { command: open ? 'listen to the reeds' : 'try a sailors knot' };
  }

  camp() {
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI) / 5;
      this.mesh(
        'leaf',
        COLORS.stone,
        [-1.5 + Math.cos(a) * 0.62, 0.14, 0.6 + Math.sin(a) * 0.62],
        [0.2, 0.19, 0.22],
      );
    }
    const log = this.mesh('cylinder', COLORS.edge, [-1.5, 0.19, 0.6], [0.1, 1, 0.1]);
    log.rotation.z = Math.PI / 2;
    for (let i = 0; i < 3; i++) {
      const flame = this.mesh(
        'cone',
        [0xffac5c, 0xffdb80, 0xf18b49][i],
        [-1.65 + i * 0.15, 0.43, 0.6],
        [0.18, 0.65, 0.18],
        this.world,
        true,
      );
      this.animated.push((t) => {
        flame.scale.y = 0.58 + Math.sin(t * 4 + i) * 0.12;
        flame.rotation.z = Math.sin(t * 3 + i) * 0.12;
      });
    }
    const glow = new T.PointLight(0xff923e, this.model.dark ? 9 : 2, 5);
    glow.position.set(-1.5, 0.8, 0.6);
    this.world.add(glow);
    this.bench(-1.5, 2.1);
    this.bench(-3, 0.5, Math.PI / 2);
    this.table(2.2, -0.8);
    for (const x of [1.1, 3.3])
      for (const z of [-1.6, 0]) this.box(COLORS.edge, x, 1.3, z, 0.09, 2.6, 0.09);
    this.box(0x56776d, 2.2, 2.65, -0.8, 2.7, 0.12, 2.2);
  }

  town() {
    for (let i = 0; i < 9; i++)
      for (let j = 0; j < 8; j++) {
        this.box(
          (i + j) % 3 ? 0xb2b4aa : 0xc4c5b7,
          -5 + i * 1.2,
          0.065,
          -3.9 + j * 1.1,
          1.12,
          0.08,
          1.02,
        );
      }
    const facades = [0x648d89, 0xc79578, 0xb5b187];
    for (let i = 0; i < 3; i++) {
      const x = -3.5 + i * 3.5;
      this.box(facades[i], x, 1.65, -3.4, 3.1, 3.3, 1.75);
      this.box(COLORS.cream, x, 3.35, -3.4, 3.3, 0.17, 1.9);
      this.box(COLORS.edge, x, 0.75, -2.5, 0.65, 1.5, 0.1);
      for (const dx of [-0.93, 0.93]) {
        this.box(COLORS.cream, x + dx, 1.8, -2.47, 0.85, 1.2, 0.08);
        this.mesh(
          'box',
          this.model.dark ? 0xffcc86 : 0x78aab0,
          [x + dx, 1.8, -2.4],
          [0.69, 1.05, 0.04],
          this.world,
          this.model.dark,
        );
        this.box(COLORS.cream, x + dx, 1.8, -2.35, 0.045, 1.05, 0.04);
        this.box(COLORS.cream, x + dx, 1.8, -2.35, 0.69, 0.045, 0.04);
      }
      for (let j = 0; j < 8; j++) {
        const awning = this.box(
          j % 2 ? COLORS.cream : facades[i],
          x - 1.4 + j * 0.4,
          2.5,
          -2.05,
          0.38,
          0.06,
          1.1,
        );
        awning.rotation.x = 0.14;
      }
    }
    this.bench(-3.6, 0.9, 0.35);
    this.bench(3.6, 1, -0.35);
    this.shrub(-4.5, 2.7, 3, true);
    this.shrub(4.5, 2.7, 1, true);
    this.lamp(-4.8, -0.5);
    this.lamp(4.8, -0.5);
    if (/gate|threshold/.test(this.model.id)) {
      for (const x of [-1.15, 1.15]) this.box(0xd5c8b0, x, 1.55, -1.8, 0.4, 3.1, 0.5);
      this.box(0xd5c8b0, 0, 3, -1.8, 2.7, 0.42, 0.5);
    }
  }

  interior() {
    const diner = this.model.type === 'diner';
    if (diner) {
      for (let i = 0; i < 11; i++)
        for (let j = 0; j < 9; j++)
          this.box((i + j) % 2 ? 0x758c86 : 0xeee0c5, -5 + i, 0.055, -4 + j, 0.98, 0.08, 0.98);
    } else if (this.model.type === 'laundry') {
      this.box(0xb7c8b7, 0, 0.07, 0, 11, 0.1, 9);
      for (let i = 0; i < 40; i++) this.box(0xa9bca9, -5 + (i * 2.71) % 10, 0.125, -4 + (i * 1.37) % 8, .045, .005, .065);
    } else if (this.model.type === 'home' && this.model.style?.floorKind && this.model.style.floorKind !== 'planks') {
      this.floor(this.model.style.floorKind, this.model.style.floor);
    } else {
      for (let i = 0; i < 27; i++)
        this.box(i % 3 ? 0xc4a27b : 0xb4916d, 0, 0.07, -4.35 + i * 0.335, 11, 0.1, 0.31);
    }
    const wall = this.model.type === 'home' && this.model.style?.wallHex ? this.hexColor(this.model.style.wallHex) : null;
    this.box(wall ? wall.back : 0x87a39a, 0, 1.5, -4.5, 11, 3, 0.16);
    this.box(wall ? wall.side : 0xb6c5ac, -5.5, 1.5, 0, 0.16, 3, 9);
    this.box(COLORS.cream, 0, 0.19, -4.38, 11, 0.23, 0.1);
    this.box(COLORS.cream, -5.38, 0.19, 0, 0.1, 0.23, 9);
    this.box(COLORS.cream, -1.2, 1.95, -4.36, 2.4, 1.65, 0.12);
    this.mesh('box', this.model.dark ? 0x2d5068 : 0xadd5ce, [-1.2, 1.95, -4.26], [2.15, 1.4, 0.06]);
    this.box(COLORS.cream, -1.2, 1.95, -4.2, 0.07, 1.4, 0.1);
    this.box(COLORS.cream, -1.2, 1.95, -4.2, 2.15, 0.07, 0.1);
    if (this.model.type !== 'home') {
      this.box(COLORS.edge, 2.55, 1.95, -4.32, 2.35, 1.6, 0.1);
      const painting = new T.Mesh(shapes.box, this.paintingMaterial);
      painting.position.set(2.55, 1.95, -4.24);
      painting.scale.set(2.2, 1.46, 0.035);
      this.world.add(painting);
    }
    if (this.model.type === 'home') {
      const positions = [
        [-3.6, -2.4],
        [2.8, -2.6],
        [-3.8, 0.4],
        [2.9, 0.3],
        [-1, -1.7],
        [0.7, 2.7],
        [-3.8, 2.7],
        [3.3, 2.7],
      ];
      const pieces = this.model.furniture.filter((name) => furnitureKind(name) !== 'painting');
      pieces.forEach((name, i) => {
        const pos = positions[i % 8];
        this.furniture(furnitureKind(name), pos[0] + Math.floor(i / 8) * 0.35, pos[1], i);
      });
      this.model.furniture.filter((name) => furnitureKind(name) === 'painting').slice(0, 5)
        .forEach((name, i) => this.hangPainting(String(name).replace(/^a painting:\s*/i, ''), 1.2 + i * 1.05, 2.1, -4.36, i));
    } else if (diner) {
      this.box(0x8c6556, -3.55, 0.6, -1.35, 1.2, 1.2, 5.4);
      this.box(COLORS.cream, -3.55, 1.24, -1.35, 1.42, 0.13, 5.65);
      for (let i = 0; i < 4; i++) {
        this.mesh('cylinder', COLORS.ink, [-2.2, 0.35, -3.2 + i * 1.3], [0.06, 0.7, 0.06]);
        this.mesh('cylinder', 0xb75f50, [-2.2, 0.75, -3.2 + i * 1.3], [0.3, 0.14, 0.3]);
      }
      for (const z of [-2, 1.5]) {
        this.table(2.2, z);
        this.furniture('sofa', 3.9, z, 0, Math.PI / 2);
      }
      this.mesh('cylinder', COLORS.ink, [-3.55, 1.62, -3], [0.24, 0.65, 0.24]);
    } else if (this.model.type === 'library') {
      this.furniture('shelf', -4, -3.4, 0);
      this.furniture('shelf', 1.3, -3.4, 1);
      this.furniture('shelf', 3.4, -3.4, 2);
      this.table(0.6, 0.2);
      this.furniture('chair', 0.6, 1.3, 0);
    }
    if (this.model.type === 'barber') {
      this.box(COLORS.wood,-2.8,.65,-2.8,2.8,1.3,.7);
      this.box(COLORS.brass,-2.8,2,-3.25,2.4,1.65,.12);
      this.box(0xa1c4ca,-2.8,2,-3.17,2.2,1.45,.04);
      this.furniture('chair',-2.8,-.7,0,Math.PI);
      this.mesh('cylinder',COLORS.ink,[-2.8,.18,-.7],[.45,.2,.45]);
      for(let i=0;i<3;i++) this.box(COLORS.cream,-2.1,1.35+i*.08,-2.8,.55,.08,.4);
      this.box(COLORS.ink,-3.4,1.34,-2.65,.32,.025,.09);
      this.bench(3,1.5);
    }
    if (this.model.type === 'workshop') {
      this.box(COLORS.edge,0,1,-2.8,5.5,1.8,.85);
      this.box(COLORS.wood,0,1.95,-2.8,5.7,.18,1.0);
      this.box(0x756a58,0,2.7,-4.1,5.2,1.4,.12);
      for(let i=0;i<7;i++) {
        this.box(COLORS.ink,-2.1+i*.65,2.7,-3.98,.09,.55,.07);
        this.box(0xb5c5c3,-2.1+i*.65,3,-3.96,.27,.1,.1);
      }
      for(let i=0;i<3;i++) this.mesh('cylinder',COLORS.ink,[3.6,.2+i*.32,.5],[.55,.3,.55]);
      this.mesh('cylinder',0xb78063,[-1,.6,0],[.4,.15,.4]);
      this.mesh('cylinder',COLORS.ink,[-1,.3,0],[.055,.6,.055]);
    }
    if (this.model.type === 'bar') {
      this.box(COLORS.edge, 0.8, .65, -1.5, 6.3, 1.3, .75);
      this.box(COLORS.wood, .8, 1.35, -1.5, 6.6, .15, 1.1);
      for (let i = 0; i < 5; i++) {
        this.mesh('cylinder', COLORS.ink, [-1.5 + i * 1.2, .4, -.3], [.06,.8,.06]);
        this.mesh('cylinder', 0xb9775b, [-1.5 + i * 1.2, .83, -.3], [.27,.14,.27]);
        this.mesh('cylinder', 0x507e6f, [-.2 + i * .6, 1.6, -3.7], [.08,.42,.08]);
      }
      this.box(COLORS.wood, 1.1, 1.35, -3.7, 3.7,.12,.55);
      const board = this.mesh('cylinder', COLORS.ink, [-4.3,1.8,-4.25], [.45,.07,.45]);
      board.rotation.x = Math.PI/2;
      this.mesh('sphere',0xc66c52,[-4.3,1.8,-4.2],[.08,.08,.025]);
    }
    if (this.model.type === 'bowling') {
      for (let lane = 0; lane < 3; lane++) {
        const x = -2.6 + lane * 2.1;
        this.box(0xd9b97c,x,.18,-1.3,1.7,.13,5.3);
        for (const edge of [-1,1]) this.box(COLORS.ink,x+edge*.87,.16,-1.3,.12,.12,5.3);
        for (let row = 0; row < 4; row++) for (let j = 0; j <= row; j++) {
          const px=x+(j-row/2)*.23,pz=-2.9-row*.2;
          this.mesh('sphere',COLORS.cream,[px,.39,pz],[.08,.2,.08]);
          this.mesh('sphere',COLORS.cream,[px,.62,pz],[.055,.07,.055]);
          this.mesh('cylinder',0xb45d4c,[px,.53,pz],[.038,.035,.038]);
        }
      }
      this.bench(3.9,2.8);
      this.box(COLORS.ink,3.8,.45,.7,.8,.8,1.8);
      for(let i=0;i<3;i++) this.mesh('sphere',[0x447e84,0xa26780,0x5f788e][i],[3.8,.96,.1+i*.5],[.2,.2,.2]);
    }
    if (this.model.type === 'laundry') {
      for(let i=0;i<4;i++) {
        const x=-3.8+i*2.0;
        this.box(0xd3ddd4,x,.8,-3.4,1.65,1.6,1.2);
        const door=this.mesh('cylinder',COLORS.ink,[x,.8,-2.77],[.5,.08,.5]);door.rotation.x=Math.PI/2;
        const cloth=this.mesh('leaf',0xc38c77,[0,0.04,0],[.3,.07,.25],door);
        this.animated.push(t=>{cloth.rotation.y=t*.5+i;});
      }
      this.table(.8,.4); this.mesh('cylinder',0xc9a372,[2,.4,2],[.5,.7,.5]);
      this.box(0x3f6c96,.55,1.0,.4,.4,.18,.28);
      for (let i=0;i<4;i++) this.mesh('sphere',[0xe0c69b,0x654d45,0xf3e5c4][i%3],[.43+i*.075,1.105,.4],[.025,.012,.025]);
      this.bench(-3.8,1.1,Math.PI/2);
      if (this.model.washhouse?.benchStage < 3) {
        this.box(COLORS.wood,-2.8,.2,1.3,.55,.13,.4);
        this.box(COLORS.ink,-2.8,.29,1.3,.3,.055,.045);
      }
      this.furniture('shelf',3.8,-.5,2);

    }
    if (this.model.type === 'office') {
      for(let i=0;i<3;i++) {
        const x=.5+i*1.3;
        this.box(0x7e9a94,x,1.1,-3.7,1.1,2.2,.65);
        for(let j=0;j<4;j++){this.box(0x98aea5,x,.3+j*.5,-3.32,.98,.43,.06);this.box(COLORS.ink,x,.36+j*.5,-3.27,.23,.035,.035);}
      }
      this.table(-2,-.9);this.furniture('chair',-2,.3);
      this.box(COLORS.cream,-2.2,.97,-.9,.7,.05,.55);this.lamp(-.9,-1.3,true);
    }
    this.lamp(4.6, -3.8, true);
  }

  furniture(kind, x, z, seed = 0, rotation = 0) {
    const g = this.group(x, 0, z, rotation);
    if (kind === 'table') {
      this.table(0, 0, g);
      return;
    }
    if (kind === 'plant') {
      this.world.remove(g);
      this.shrub(x, z, seed, true);
      return;
    }
    if (kind === 'lamp') {
      this.world.remove(g);
      this.lamp(x, z, true);
      return;
    }
    if (kind === 'rug') {
      this.box(0xa86350, 0, 0.14, 0, 2.7, 0.03, 1.65, g);
      this.box(0xd4ba86, 0, 0.16, 0, 2.4, 0.02, 1.36, g);
      return;
    }
    if (kind === 'bed' || kind === 'crib') {
      this.box(COLORS.edge, 0, 0.3, 0, 1.6, 0.5, 2.5, g);
      this.box(COLORS.cream, 0, 0.63, 0, 1.57, 0.2, 2.44, g);
      this.box(0x4f8884, 0, 0.77, 0.35, 1.6, 0.12, 1.75, g);
      this.box(COLORS.cream, 0, 0.8, -0.82, 1.13, 0.22, 0.48, g);
      this.box(COLORS.wood, 0, 0.7, -1.3, 1.72, 1.4, 0.13, g);
      return;
    }
    if (kind === 'sofa' || kind === 'chair') {
      const w = kind === 'sofa' ? 2.0 : 0.72;
      this.box(0x527d74, 0, 0.4, 0, w, 0.6, 0.85, g);
      this.box(0x719a88, 0, 0.82, -0.38, w, 0.85, 0.19, g);
      for (const dx of [-1, 1]) this.box(0x719a88, dx * (w / 2 - 0.06), 0.63, 0, 0.15, 0.7, 0.9, g);
      this.box(0x99b6a1, 0, 0.75, 0.05, w - 0.32, 0.13, 0.63, g);
      if (kind === 'sofa') this.box(0xe1b276, 0.55, 1, -0.2, 0.38, 0.4, 0.16, g);
      return;
    }
    if (kind === 'shelf') {
      this.box(COLORS.edge, 0, 1.1, 0, 1.5, 2.2, 0.5, g);
      for (let row = 0; row < 3; row++) {
        this.box(COLORS.cream, 0, 0.18 + row * 0.68, 0.3, 1.44, 0.08, 0.62, g);
        for (let j = 0; j < 6; j++)
          this.box(
            [0x8fa194, 0xc78966, 0xd5b57d, 0x597c85][(j + row + seed) % 4],
            -0.6 + j * 0.23,
            0.44 + row * 0.68,
            0.21,
            0.17,
            0.42 + (j % 3) * 0.05,
            0.36,
            g,
          );
      }
      return;
    }
    if (kind === 'easel') {
      for (const [dx, rz] of [[-0.28, 0.12], [0.28, -0.12]]) { const leg = this.box(COLORS.edge, dx, 0.8, 0, 0.06, 1.6, 0.06, g); leg.rotation.z = rz; }
      const back = this.box(COLORS.edge, 0, 0.75, -0.3, 0.06, 1.5, 0.06, g); back.rotation.x = -0.3;
      this.box(COLORS.cream, 0, 1.15, 0.05, 0.8, 0.62, 0.04, g);
      this.box([0xc46457, 0x537fc3, 0xe5c363, 0x719b84][seed % 4], 0, 1.15, 0.075, 0.5, 0.36, 0.01, g);
      return;
    }
    if (kind === 'telescope') {
      for (const a of [0, 2.1, 4.2]) { const leg = this.box(COLORS.ink, Math.sin(a) * 0.22, 0.45, Math.cos(a) * 0.22, 0.05, 0.95, 0.05, g); leg.rotation.x = Math.cos(a) * 0.25; leg.rotation.z = -Math.sin(a) * 0.25; }
      const tube = this.mesh('cylinder', COLORS.brass, [0, 1.05, 0], [0.11, 1.1, 0.11], g); tube.rotation.x = -0.9;
      return;
    }
    if (kind === 'jukebox') {
      this.box(0x7a3b3b, 0, 0.75, 0, 1.0, 1.5, 0.6, g);
      const arch = this.mesh('cylinder', 0xffc76b, [0, 1.5, 0.05], [0.5, 0.6, 0.12], g, true); arch.rotation.x = Math.PI / 2;
      this.box(0x9ad0d8, 0, 0.95, 0.31, 0.7, 0.35, 0.02, g);
      const lights = [0xff7a8a, 0x8ae0ff, 0xfff08a].map((c, i) => this.mesh('sphere', c, [-0.3 + i * 0.3, 0.45, 0.31], [0.06, 0.06, 0.03], g, true));
      this.animated.push((t) => lights.forEach((l, i) => { l.visible = Math.sin(t * 3 + i * 2) > -0.4; }));
      return;
    }
    if (kind === 'fishtank') {
      this.box(COLORS.wood, 0, 0.35, 0, 1.3, 0.7, 0.6, g);
      const glass = new T.Mesh(shapes.box, new T.MeshStandardMaterial({ color: 0x7fc4d4, transparent: true, opacity: 0.45, roughness: 0.1 }));
      glass.position.set(0, 1.05, 0); glass.scale.set(1.25, 0.7, 0.55); g.add(glass); this.disposables.push(glass.material);
      for (let i = 0; i < 4; i++) {
        const fish = this.mesh('leaf', [0xff9f45, 0xffd84a, 0x9fd0ff, 0xff7a8a][i], [0, 1.0 + i * 0.09, 0], [0.09, 0.05, 0.05], g);
        this.animated.push((t) => { fish.position.x = Math.sin(t * (0.6 + i * 0.17) + i) * 0.45; fish.position.z = Math.cos(t * 0.4 + i) * 0.12; fish.rotation.y = Math.cos(t * (0.6 + i * 0.17) + i) > 0 ? 0 : Math.PI; });
      }
      return;
    }
    if (kind === 'hammock') {
      for (const dx of [-1.1, 1.1]) this.box(COLORS.edge, dx, 0.8, 0, 0.1, 1.6, 0.1, g);
      const cloth = this.mesh('sphere', 0xd98f6b, [0, 0.72, 0], [1.05, 0.18, 0.42], g);
      this.animated.push((t) => { cloth.rotation.x = Math.sin(t * 0.9) * 0.08; });
      return;
    }
    if (kind === 'lavalamp') {
      this.mesh('cone', COLORS.ink, [0, 0.15, 0], [0.16, 0.3, 0.16], g);
      this.mesh('cylinder', 0xffa15a, [0, 0.55, 0], [0.11, 0.55, 0.11], g, true);
      const blob = this.mesh('sphere', 0xff4f4f, [0, 0.45, 0], [0.07, 0.09, 0.07], g, true);
      this.animated.push((t) => { blob.position.y = 0.42 + (Math.sin(t * 0.5) + 1) * 0.16; });
      const light = new T.PointLight(0xff7a4a, this.model.dark ? 3 : 0.8, 3); light.position.set(0, 0.7, 0); g.add(light);
      return;
    }
    if (kind === 'tv') {
      this.box(COLORS.wood, 0, 0.3, 0, 1.1, 0.6, 0.55, g);
      this.box(COLORS.ink, 0, 0.95, 0, 0.95, 0.7, 0.5, g);
      const screen = this.mesh('box', 0x8fd6c8, [0, 0.95, 0.26], [0.78, 0.55, 0.02], g, true);
      this.animated.push((t) => { screen.material.emissiveIntensity = 1.1 + Math.sin(t * 7) * 0.25; });
      return;
    }
    if (kind === 'shower') {
      this.box(0xe8eef0, 0, 0.05, 0, 1.2, 0.1, 1.2, g);
      const glass = new T.Mesh(shapes.box, new T.MeshStandardMaterial({ color: 0xcfe8ef, transparent: true, opacity: 0.35, roughness: 0.1 }));
      glass.position.set(0, 1.1, 0.58); glass.scale.set(1.2, 2.1, 0.04); g.add(glass); this.disposables.push(glass.material);
      this.mesh('cylinder', 0xb7c0c4, [0, 2.1, -0.4], [0.12, 0.05, 0.12], g);
      return;
    }
    if (kind === 'bunk') {
      for (const y of [0, 1.05]) {
        this.box(COLORS.edge, 0, 0.3 + y, 0, 1.3, 0.25, 2.2, g);
        this.box(COLORS.cream, 0, 0.48 + y, 0, 1.25, 0.14, 2.1, g);
        this.box(y ? 0xc46457 : 0x537fc3, 0, 0.57 + y, 0.3, 1.27, 0.1, 1.4, g);
      }
      for (const dx of [-0.62, 0.62]) for (const dz of [-1.05, 1.05]) this.box(COLORS.edge, dx, 0.9, dz, 0.08, 1.8, 0.08, g);
      return;
    }
    if (kind === 'post') {
      this.box(0xc9b28a, 0, 0.06, 0, 0.7, 0.12, 0.7, g);
      this.mesh('cylinder', 0xd8c7a0, [0, 0.6, 0], [0.12, 1.1, 0.12], g);
      this.box(0xc9b28a, 0, 1.18, 0, 0.55, 0.08, 0.55, g);
      return;
    }
    if (kind === 'radio') {
      this.box(COLORS.wood, 0, 0.37, 0, 0.95, 0.65, 0.48, g);
      this.box(COLORS.ink, -0.2, 0.38, 0.26, 0.37, 0.43, 0.03, g);
      this.mesh('sphere', COLORS.brass, [0.25, 0.3, 0.28], [0.09, 0.09, 0.035], g);
      return;
    }
    this.box(
      kind === 'fridge' ? 0xc5d6cb : COLORS.wood,
      0,
      kind === 'fridge' ? 1 : 0.48,
      0,
      1,
      kind === 'fridge' ? 2 : 0.96,
      0.8,
      g,
    );
    this.box(COLORS.brass, 0.33, 0.65, 0.43, 0.055, 0.22, 0.035, g);
    if (kind === 'stove')
      for (const dx of [-0.23, 0.23])
        for (const dz of [-0.2, 0.2])
          this.mesh('cylinder', COLORS.ink, [dx, 1, dz], [0.14, 0.03, 0.14], g);
  }

  avatar(person, index) {
    const seed = hash(person.id || person.name);
    const position = figurePosition(this.model, person, index);
    const { x, z } = position;
    const look = figureAppearance(person);
    const g = this.group(x, position.y || 0, z);
    g.userData.interaction = person.self ? { command: 'wardrobe' } : { personId: person.id };
    if (['stray', 'pet'].includes(person.kind)) {
      this.mesh('leaf', 0xb98968, [0, 0.22, 0], [0.28, 0.22, 0.5], g);
      this.mesh('sphere', 0xb98968, [0, 0.43, 0.37], [0.19, 0.19, 0.19], g);
      for (const dx of [-0.1, 0.1])
        this.mesh('cone', 0x7e614e, [dx, 0.63, 0.37], [0.09, 0.16, 0.08], g);
      this.nameTag(person, g, null);
      const tail=this.mesh('cylinder',0xb98968,[0,.37,-.5],[.045,.55,.045],g);tail.rotation.x=.8;
      this.animated.push(t=>{tail.rotation.z=Math.sin(t*2+seed)*.25;g.position.y=Math.sin(t*1.8+seed)*.007;});
      return;
    }
    const activity = figureActivity(this.model, person);
    const { skin, shirt } = look;
    const body = new T.Group();
    g.add(body);
    this.mesh('sphere', shirt, [0, 0.77, 0], [0.25, 0.36, 0.18], body);
    const head = new T.Group();
    body.add(head);
    this.mesh('sphere', skin, [0, 1.26, 0], [0.2, 0.23, 0.2], head);
    const hair = look.hairColor;
    if (look.hair !== 'bald') this.mesh('sphere', hair, [0, 1.41, -0.02], [0.206, 0.13, 0.2], head);
    if (look.hair === 'bun') this.mesh('sphere', hair, [0, 1.55, -0.12], [0.13, 0.13, 0.13], head);
    if (look.hair === 'long') this.mesh('sphere', hair, [0, 1.15, -0.13], [0.23, 0.38, 0.15], head);
    if (look.hair === 'locks')
      for (let i = 0; i < 9; i++) {
        const a = (i / 8) * Math.PI;
        this.mesh(
          'cylinder',
          hair,
          [Math.cos(a) * 0.2, 1.15, -Math.sin(a) * 0.17],
          [0.038, 0.48 + (i % 2) * 0.08, 0.038],
          head,
        );
      }
    if (look.hair === 'curls')
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        this.mesh(
          'sphere',
          hair,
          [Math.cos(a) * 0.17, 1.43 + Math.sin(a) * 0.065, -0.035],
          [0.095, 0.095, 0.12],
          head,
        );
      }
    if (look.hair === 'hat') {
      this.mesh('cylinder', COLORS.ink, [0, 1.53, 0], [0.24, 0.17, 0.24], head);
      this.mesh('cylinder', COLORS.ink, [0, 1.46, 0.045], [0.3, 0.035, 0.3], head);
    }
    if (look.outfit === 'dress') this.mesh('cone', shirt, [0, 0.52, 0], [0.39, 0.66, 0.3], body);
    if (look.outfit === 'coat') {
      this.box(shirt, 0, 0.61, 0, 0.53, 0.59, 0.37, body);
      this.box(COLORS.cream, 0, 0.88, 0.19, 0.07, 0.42, 0.022, body);
      for (const y of [0.55, 0.7])
        this.mesh('sphere', COLORS.brass, [0.055, y, 0.2], [0.022, 0.022, 0.02], body);
    }
    if (look.outfit === 'coveralls')
      this.box(COLORS.cream, 0.11, 0.88, 0.177, 0.11, 0.045, 0.015, body);
    if (look.headphones) {
      for (const dx of [-0.225, 0.225])
        this.mesh('sphere', COLORS.ink, [dx, 1.27, 0], [0.06, 0.095, 0.075], head);
      this.mesh('ring', COLORS.ink, [0, 1.32, 0], [0.25, 0.27, 0.22], head);
    }
    const mouth = this.mesh('sphere', 0x714b42, [0, 1.16, .195], [.055,.013,.018], head);
    const eyes = [], brows = [], corners = [];
    for (const dx of [-1, 1]) {
      eyes.push(this.mesh('sphere', 0x313b3b, [dx*.075,1.29,.185], [.019,.024,.019], head));
      brows.push(this.box(hair,dx*.076,1.345,.183,.073,.014,.02,head));
      corners.push(this.mesh('sphere',0x714b42,[dx*.046,1.165,.193],[.018,.009,.012],head));
      this.mesh('sphere',skin,[dx*.203,1.25,0],[.043,.065,.04],head);
      if(look.glasses) this.mesh('ring',COLORS.ink,[dx*.076,1.29,.205],[.063,.052,.045],head);
    }
    if(look.glasses) this.box(COLORS.ink,0,1.295,.209,.035,.012,.02,head);
    head.children.forEach(piece => { piece.position.y -= 1.26; });
    head.position.y = 1.26;
    if(look.apron) this.box(COLORS.cream,0,.69,.181,.35,.51,.035,body);
    const limbs = [];
    for (const dx of [-1, 1]) {
      const arm = new T.Group();
      arm.position.set(dx * 0.25, 0.97, 0);
      body.add(arm);
      this.mesh('cylinder', shirt, [0, -0.16, 0], [0.075, 0.32, 0.075], arm);
      this.mesh('sphere', skin, [0, -0.35, 0], [0.068, 0.086, 0.068], arm);
      const leg = new T.Group();
      leg.position.set(dx * 0.115, 0.49, 0);
      g.add(leg);
      this.mesh('cylinder', 0x3e515a, [0, -0.19, 0], [0.086, 0.38, 0.086], leg);
      this.mesh('sphere', COLORS.cream, [0, -0.4, 0.04], [0.105, 0.065, 0.16], leg);
      limbs.push(arm, leg);
    }
    if (activity === 'reading') {
      const book=this.box(0x9b735d,0,.76,.33,.46,.08,.32,body);book.rotation.x=-.25;
      this.box(COLORS.cream,0,.81,.33,.42,.025,.29,body);
    }
    if (activity === 'carrying') this.box(COLORS.wood,0,.65,.38,.62,.45,.5,body);
    if (activity === 'cooking') {
      this.mesh('cylinder',COLORS.ink,[0,-.58,0],[.02,.45,.02],limbs[2]);
      this.box(0xa7b7b0,0,-.84,0,.16,.18,.035,limbs[2]);
      this.box(COLORS.cream,0,.7,.19,.3,.44,.025,body);
    }
    if(look.watch) this.mesh('cylinder',COLORS.brass,[0,-.28,0],[.08,.035,.08],limbs[2]);
    if (activity === 'washing') this.mesh('cylinder',COLORS.cream,[0,-.36,.08],[.09,.15,.09],limbs[2]);
    if (activity === 'drinking') this.mesh('cylinder',COLORS.cream,[0,-.36,.07],[.09,.15,.09],limbs[2]);
    if (activity === 'sweeping' || activity === 'fishing') {
      const tool=this.mesh('cylinder',COLORS.edge,[.38,.85,.22],[.022,1.6,.022],g);tool.rotation.z=-.2;
      if(activity==='sweeping')this.box(0xb7a077,.53,.12,.22,.32,.18,.14,g);
    }
    const scale = person.kind === 'child' ? 0.72 : 1;
    g.scale.set(look.width * scale, look.height * scale, scale);
    g.rotation.y = position.rotation;
    const previous = this.previousFigures?.get(person.id);
    const from = previous || (this.entering ? { x: x - 0.65, z: z + 0.4 } : { x, z });
    this.nameTag(person, g, look);
    if (position.swimming) {
      /* a swimmer is waist-deep: a ring of ripples at the waterline says so */
      const wake = this.mesh('ring', 0xe6fbff, [0, 0.59 / look.height, 0], [0.5 / look.width, 0.5, 1], g, true);
      wake.rotation.x = -Math.PI / 2;
      wake.castShadow = false;
      this.animated.push((t) => { const k = 1 + ((t * 0.8 + seed % 7) % 1) * 0.6; wake.scale.set(0.5 * k / look.width, 0.5 * k, 1); });
    }
    if (person.self) {
      const ring = this.mesh('ring', 0xffd27a, [0, 0.05, 0], [0.42 / look.width, 0.42 / scale, 1], g, true);
      ring.rotation.x = -Math.PI / 2;
      ring.castShadow = false;
      this.animated.push((t) => { ring.material.emissiveIntensity = 1.1 + Math.sin(t * 2.2) * 0.35; });
    }
    const figure = {
      id: person.id,
      name: person.name,
      self: !!person.self,
      g,
      body,
      head,
      eyes,
      brows,
      mouth,
      limbs,
      seed,
      index,
      until: previous?.until || 0,
      action: previous?.action || '',
      activity,
      born: this.time,
    };
    this.figures.push(figure);
    this.animated.push((t) => {
      const elapsed = this.motion ? t - figure.born : Infinity;
      const walk = walkPose(from, position, elapsed, seed);
      g.position.x = walk.x;
      g.position.z = walk.z;
      g.rotation.y = walk.rotation;
      body.position.y = Math.sin(t * (1.4 + seed % 5 * .1) + seed % 7) * .012;
      const active = t < figure.until;
      const pose = activityPose(activity, t, seed);
      limbs.forEach((limb, i) => {
        limb.rotation.x = walk.walking ? walk.stride * ([1,-1,-1,1][i]) : Math.sin(t + seed + i) * .018;
      });
      if (!walk.walking) { limbs[0].rotation.x += pose.left; limbs[2].rotation.x += pose.right; }
      body.rotation.x = pose.nod;
      body.rotation.z = active && figure.action === 'dance' ? Math.sin(t * 5) * .1 : pose.lean;
      if (active && figure.action === 'wave') {
        limbs[2].rotation.z = -2.4;
        limbs[2].rotation.x = Math.sin(t * 8) * .25;
      } else limbs[2].rotation.z = 0;
      const face = residentFace(activity, t, seed);
      head.rotation.x = face.head;
      head.rotation.y = walk.walking ? 0 : face.gaze * .14;
      eyes.forEach((eye, i) => {
        eye.scale.y = .024 * Math.max(.08, 1 - face.blink);
        eye.position.x = (i === 0 ? -.075 : .075) + face.gaze * .009;
      });
      brows.forEach((brow, i) => { brow.rotation.z = face.brow * (i === 0 ? 1 : -1); });
      mouth.scale.y = .013 + face.mouth * .012;
      corners.forEach(corner => { corner.position.y = -.095 + face.smile * .018; });
    });
  }

  hexColor(css) {
    const c = new T.Color();
    try { c.setStyle(css); } catch (_) { c.setHex(0x87a39a); }
    const side = c.clone().offsetHSL(0, 0, 0.08);
    return { back: c.getHex(), side: side.getHex() };
  }

  floor(kind, words) {
    if (kind === 'checker') {
      const dark = /black/.test(words || '') ? 0x2f3336 : /blue/.test(words || '') ? 0x5f7fa8 : /red/.test(words || '') ? 0xa4553f : 0x758c86;
      for (let i = 0; i < 11; i++) for (let j = 0; j < 9; j++) this.box((i + j) % 2 ? dark : 0xeee0c5, -5 + i, 0.055, -4 + j, 0.98, 0.08, 0.98);
      return;
    }
    if (kind === 'carpet') { this.box(/blue/.test(words || '') ? 0x4f6f9a : /green/.test(words || '') ? 0x5f8a66 : /red|rose|pink/.test(words || '') ? 0xa25d61 : 0x8f7c6c, 0, 0.07, 0, 11, 0.1, 9); return; }
    if (kind === 'stone') { for (let i = 0; i < 9; i++) for (let j = 0; j < 7; j++) this.box((i * 3 + j) % 4 ? 0x9a9e98 : 0x878b86, -4.9 + i * 1.23, 0.06, -3.9 + j * 1.3, 1.17, 0.09, 1.24); return; }
    if (kind === 'tile') { for (let i = 0; i < 16; i++) for (let j = 0; j < 13; j++) this.box(/black|dark/.test(words || '') ? 0x3a3f42 : /blue/.test(words || '') ? 0xa9c6dc : 0xe9ecea, -5.15 + i * 0.69, 0.055, -4.15 + j * 0.69, 0.66, 0.08, 0.66); return; }
    if (kind === 'grass') { this.box(0x88a86f, 0, 0.06, 0, 11, 0.1, 9); return; }
    for (let i = 0; i < 27; i++) this.box(i % 3 ? 0xc4a27b : 0xb4916d, 0, 0.07, -4.35 + i * 0.335, 11, 0.1, 0.31);
  }

  /** A small abstract painting whose colors and shapes come from its own title. */
  paintingTexture(title, seed = 0) {
    const t = String(title || '').toLowerCase();
    const h = hash(t + seed);
    const surface = document.createElement('canvas');
    surface.width = 96; surface.height = 72;
    const ctx = surface.getContext('2d');
    const night = /night|moon|star|dark|midnight|evening/.test(t);
    const water = /sea|river|water|lake|ferry|boat|harbor|harbour|pier|creek|rain|pool|ocean/.test(t);
    const green = /garden|tree|orchard|apple|field|park|forest|woods|grass|leaf|flower/.test(t);
    const warm = /sun|fire|kitchen|pie|bread|autumn|fall|sunset|morning|bakery|gold/.test(t);
    const hues = [h % 360, (h >> 8) % 360, (h >> 16) % 360];
    ctx.fillStyle = night ? '#1f2d4a' : warm ? '#f2b36b' : `hsl(${hues[0]}, 45%, 72%)`;
    ctx.fillRect(0, 0, 96, 72);
    ctx.fillStyle = water ? '#3f7fa0' : green ? '#5f8f55' : `hsl(${hues[1]}, 40%, ${night ? 25 : 48}%)`;
    ctx.fillRect(0, 44 + (h % 8), 96, 30);
    ctx.fillStyle = night ? '#f5eec8' : warm ? '#fff2b0' : `hsl(${hues[2]}, 70%, 65%)`;
    ctx.beginPath(); ctx.arc(20 + (h % 56), 18 + ((h >> 5) % 12), 7 + (h % 5), 0, Math.PI * 2); ctx.fill();
    if (/cat|dog|bird|heron|duck|fish|horse|cow|raccoon|owl/.test(t)) {
      ctx.fillStyle = '#3b2f2a'; ctx.beginPath(); ctx.ellipse(48, 50, 13, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(60, 42, 6, 0, Math.PI * 2); ctx.fill();
    } else if (/house|home|church|tower|bell|diner|shop|street|city/.test(t)) {
      ctx.fillStyle = `hsl(${hues[2]}, 35%, 40%)`; ctx.fillRect(34, 30, 26, 22); ctx.beginPath(); ctx.moveTo(31, 31); ctx.lineTo(47, 18); ctx.lineTo(63, 31); ctx.fill();
      ctx.fillStyle = night ? '#ffd27a' : '#e9f3f5'; ctx.fillRect(40, 36, 5, 5); ctx.fillRect(50, 36, 5, 5);
    } else if (/face|portrait|mother|father|grand|friend|woman|man|girl|boy|people|me|self/.test(t)) {
      ctx.fillStyle = '#d7a47f'; ctx.beginPath(); ctx.ellipse(48, 38, 12, 15, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3b2f2a'; ctx.beginPath(); ctx.ellipse(48, 27, 13, 7, 0, 0, Math.PI * 2); ctx.fill();
    } else {
      for (let i = 0; i < 5; i++) { ctx.fillStyle = `hsla(${(hues[i % 3] + i * 40) % 360}, 60%, 55%, .8)`; ctx.fillRect((h >> i) % 80, 20 + ((h >> (i + 3)) % 40), 8 + i * 3, 4 + (i % 3) * 3); }
    }
    const tex = new T.CanvasTexture(surface);
    tex.colorSpace = T.SRGBColorSpace;
    this.textures.push(tex);
    return tex;
  }

  hangPainting(title, x, y, z, seed = 0, facing = 0, scale = 1) {
    const g = this.group(x, y, z, facing);
    this.box(COLORS.brass, 0, 0, 0, 0.9 * scale, 0.72 * scale, 0.06, g);
    const mat = new T.MeshStandardMaterial({ map: this.paintingTexture(title, seed), roughness: 0.9 });
    this.disposables.push(mat);
    const art = new T.Mesh(shapes.box, mat);
    art.position.set(0, 0, 0.035);
    art.scale.set(0.8 * scale, 0.62 * scale, 0.01);
    g.add(art);
    return g;
  }

  venueShell(floorColor, backWall, sideWall) {
    this.box(floorColor, 0, 0.07, 0, 11, 0.1, 9);
    this.box(backWall, 0, 1.5, -4.5, 11, 3, 0.16);
    this.box(sideWall, -5.5, 1.5, 0, 0.16, 3, 9);
    this.box(COLORS.cream, 0, 0.19, -4.38, 11, 0.23, 0.1);
    this.box(COLORS.cream, -5.38, 0.19, 0, 0.1, 0.23, 9);
  }

  venue() {
    const type = this.model.type;
    if (type === 'theater') {
      this.venueShell(0x5a2f3a, 0x3d2a35, 0x4a3240);
      for (let i = 0; i < 22; i++) this.mesh('sphere', 0xc9a35e, [-5 + (i * 2.37) % 10, 0.125, -3.8 + (i * 1.61) % 8], [0.05, 0.01, 0.05]);
      const screen = this.mesh('box', 0xe8e4d4, [0.6, 1.75, -4.33], [6.2, 2.1, 0.05], this.world, true);
      const tones = [0xe8e4d4, 0xbfd6e8, 0xf0d9b8, 0xd8e8c8];
      this.animated.push((t) => { screen.material.emissiveIntensity = 0.75 + Math.sin(t * 9) * 0.06 + Math.sin(t * 2.3) * 0.1; });
      let beat = 0;
      this.animated.push((t) => { const k = Math.floor(t / 4) % tones.length; if (k !== beat) { beat = k; screen.material.emissive.setHex(tones[k]); } });
      for (const side of [-1, 1]) for (let f = 0; f < 5; f++) this.mesh('cylinder', 0xb38a2e, [0.6 + side * (3.25 + f * 0.13), 1.55, -4.2], [0.09, 3, 0.09]);
      this.box(0x6b1f2a, 0.6, 3.05, -4.2, 7.2, 0.35, 0.2);
      for (let row = 0; row < 4; row++) for (let seat = 0; seat < 7; seat++) {
        const x = -2.3 + seat * 0.95 + (row % 2) * 0.2, z = -1.3 + row * 1.25, y = row * 0.1;
        this.box(0x9e2f3a, x, 0.4 + y, z, 0.75, 0.22, 0.6);
        this.box(0xb8404c, x, 0.8 + y, z + 0.28, 0.75, 0.62, 0.12);
      }
      this.box(0x8c6b3f, -4.3, 0.75, -3.1, 1.3, 1.5, 1.0);
      const glass = new T.Mesh(shapes.box, new T.MeshStandardMaterial({ color: 0xfff1b8, transparent: true, opacity: 0.55 }));
      glass.position.set(-4.3, 1.85, -3.1); glass.scale.set(1.1, 0.7, 0.8); this.world.add(glass); this.disposables.push(glass.material);
      for (let i = 0; i < 12; i++) this.mesh('sphere', 0xfff6d6, [-4.65 + (i % 4) * 0.22, 1.6 + Math.floor(i / 4) * 0.12, -3.3 + (i % 3) * 0.2], [0.07, 0.07, 0.07]);
      const glow = new T.PointLight(0xdfe8ff, 5, 9, 1.6);
      glow.position.set(0.6, 1.8, -2.8);
      this.world.add(glow);
      return;
    }
    if (type === 'arcade') {
      this.venueShell(0x1f2d55, 0x2b2350, 0x33295c);
      for (let i = 0; i < 40; i++) this.mesh('sphere', [0xffd27a, 0x8ae0ff, 0xff9ad0][i % 3], [-5 + (i * 2.71) % 10, 0.125, -4 + (i * 1.37) % 8], [0.06, 0.01, 0.06]);
      const glows = [0xff8a3d, 0x5fe08a, 0x8ab8ff];
      for (let m = 0; m < 3; m++) {
        const x = -3.8 + m * 1.5;
        this.box(0x3a3f55, x, 0.55, -3.3, 0.9, 0.9, 1.7);
        const top = this.box(0x5d6b8f, x, 1.05, -3.3, 0.85, 0.08, 1.6); top.rotation.x = -0.12;
        const back = this.mesh('box', glows[m], [x, 1.75, -4.05], [0.95, 1.1, 0.16], this.world, true);
        this.animated.push((t) => { back.material.emissiveIntensity = 1.1 + Math.sin(t * 5 + m * 2) * 0.45; });
        const ball = this.mesh('sphere', 0xdfe6ea, [x, 1.13, -3.3], [0.05, 0.05, 0.05]);
        this.animated.push((t) => { ball.position.x = x + Math.sin(t * 3.1 + m) * 0.3; ball.position.z = -3.3 + Math.sin(t * 2.3 + m * 2) * 0.6; });
      }
      const cx = 3.6, cz = -2.8;
      this.box(0xd84a5a, cx, 0.5, cz, 1.3, 1.0, 1.3);
      const glass = new T.Mesh(shapes.box, new T.MeshStandardMaterial({ color: 0xd8f0ff, transparent: true, opacity: 0.28, roughness: 0.05 }));
      glass.position.set(cx, 1.55, cz); glass.scale.set(1.25, 1.1, 1.25); this.world.add(glass); this.disposables.push(glass.material);
      for (let i = 0; i < 14; i++) this.mesh('sphere', [0xff9ad0, 0xffd27a, 0x8ae0ff, 0x9fe08a, 0xc9a0ff][i % 5], [cx - 0.4 + (i % 4) * 0.27, 1.12 + Math.floor(i / 5) * 0.12, cz - 0.4 + (i % 3) * 0.33], [0.14, 0.14, 0.14]);
      this.box(0xd84a5a, cx, 2.15, cz, 1.35, 0.12, 1.35);
      const claw = this.mesh('cone', 0xc0c6cc, [cx, 1.85, cz], [0.14, 0.22, 0.14]);
      claw.rotation.x = Math.PI;
      this.animated.push((t) => { claw.position.x = cx + Math.sin(t * 0.7) * 0.35; claw.position.y = 1.85 - Math.max(0, Math.sin(t * 0.9)) * 0.35; });
      for (let lane = 0; lane < 2; lane++) {
        const x = 0.6 + lane * 1.5;
        const ramp = this.box(0xa77b4f, x, 0.45, 0.9, 1.1, 0.12, 3.4); ramp.rotation.x = -0.18;
        this.box(0x2c3a5a, x, 1.2, -0.95, 1.2, 1.5, 0.3);
        for (let r = 0; r < 3; r++) { const ring = this.mesh('ring', [0xffd27a, 0xff8a3d, 0x5fe08a][r], [x, 1.0 + r * 0.24, -0.78], [0.18 + r * 0.05, 0.18 + r * 0.05, 1], this.world, true); ring.castShadow = false; }
      }
      this.box(0x6b4b8f, -3.2, 0.55, 2.8, 3.2, 1.1, 0.8);
      this.box(0xe8d8b0, -3.2, 1.13, 2.8, 3.3, 0.08, 0.9);
      for (let i = 0; i < 6; i++) this.mesh('sphere', [0xff9ad0, 0x8ae0ff, 0xffd27a][i % 3], [-4.4 + i * 0.48, 1.35, 2.8], [0.16, 0.18, 0.16]);
      const glow = new T.PointLight(0x9a7aff, 4, 10, 1.5); glow.position.set(0, 2.6, 0); this.world.add(glow);
      return;
    }
    if (type === 'bakery') {
      this.venueShell(0xd8c7a6, 0xe7d3b0, 0xd9c29c);
      for (let i = 0; i < 11; i++) for (let j = 0; j < 9; j++) if ((i + j) % 2) this.box(0xc9b48f, -5 + i, 0.125, -4 + j, 0.98, 0.01, 0.98);
      this.box(0xa4553f, -3.2, 1.3, -3.7, 2.6, 2.6, 1.2);
      this.box(0x8e4632, -3.2, 2.7, -3.7, 2.8, 0.2, 1.35);
      const mouth = this.mesh('box', 0xff8a3d, [-3.2, 0.95, -3.08], [1.2, 0.75, 0.04], this.world, true);
      this.animated.push((t) => { mouth.material.emissiveIntensity = 1.3 + Math.sin(t * 2.2) * 0.3 + Math.sin(t * 7.1) * 0.08; });
      const heat = new T.PointLight(0xff9a4a, this.model.dark ? 6 : 2.5, 5); heat.position.set(-3.2, 1, -2.6); this.world.add(heat);
      this.box(COLORS.wood, 1.4, 0.6, -1.2, 5.2, 1.2, 0.9);
      const glass = new T.Mesh(shapes.box, new T.MeshStandardMaterial({ color: 0xe8f4f6, transparent: true, opacity: 0.35, roughness: 0.05 }));
      glass.position.set(1.4, 1.5, -1.2); glass.scale.set(5.1, 0.6, 0.85); this.world.add(glass); this.disposables.push(glass.material);
      for (let i = 0; i < 16; i++) this.mesh(i % 3 ? 'sphere' : 'leaf', [0xd9a25e, 0xc7853f, 0xeccb8f][i % 3], [-0.9 + (i % 8) * 0.62, 1.32, -1.35 + Math.floor(i / 8) * 0.3], [0.2, 0.1, 0.16]);
      this.box(0x3b4a45, 2.2, 1.95, -4.35, 2.0, 1.2, 0.06);
      this.box(COLORS.cream, 2.2, 2.3, -4.31, 1.5, 0.05, 0.01); this.box(COLORS.cream, 2.0, 2.0, -4.31, 1.1, 0.05, 0.01); this.box(COLORS.cream, 2.3, 1.7, -4.31, 1.3, 0.05, 0.01);
      for (let s = 0; s < 3; s++) { this.box(COLORS.edge, 4.5, 0.5 + s * 0.6, -2.5, 0.9, 0.06, 1.6); for (let b = 0; b < 3; b++) this.mesh('leaf', 0xc7853f, [4.5, 0.62 + s * 0.6, -3 + b * 0.5], [0.3, 0.12, 0.18]); }
      this.box(0x5b6f68, 3.2, 1.35, -1.2, 0.5, 0.3, 0.4);
      this.table(0.4, 2.2);
      return;
    }
    if (type === 'pool') {
      this.venueShell(0xdde7e6, 0xbcd9dd, 0xc8e2e4);
      for (let i = 0; i < 16; i++) this.box(0xcfdcdb, -5.15 + i * 0.69, 0.125, 0, 0.02, 0.01, 9);
      this.box(0x2f6f86, 0.2, 0.08, -0.4, 6.4, 0.16, 5.2);
      const water = this.mesh('box', 0x4fb3c8, [0.2, 0.18, -0.4], [6.2, 0.04, 5.0], this.world, true);
      water.castShadow = false;
      this.animated.push((t) => { water.material.emissiveIntensity = 0.45 + Math.sin(t * 1.3) * 0.08; });
      for (let r = 0; r < 3; r++) for (let b = 0; b < 14; b++) {
        const buoy = this.mesh('sphere', b % 2 ? 0xffffff : 0xd84a5a, [-2.7 + b * 0.45, 0.24, -1.9 + r * 1.4], [0.07, 0.05, 0.07]);
        this.animated.push((t) => { buoy.position.y = 0.24 + Math.sin(t * 2 + b * 0.7 + r) * 0.015; });
      }
      for (let i = 0; i < 10; i++) {
        const h = hash('ripple' + i);
        const ripple = this.mesh('ring', 0xbfeaf2, [-2.6 + (h % 560) / 100, 0.22, -2.7 + ((h >> 10) % 460) / 100], [0.28, 0.28, 1]);
        ripple.rotation.x = -Math.PI / 2; ripple.castShadow = false;
        this.animated.push((t) => { const s = 0.2 + ((t * 0.35 + i * 0.17) % 1) * 0.5; ripple.scale.set(s, s, 1); });
      }
      this.box(COLORS.cream, 4.2, 1.5, -2.2, 0.8, 0.12, 0.7);
      for (const dx of [-0.35, 0.35]) for (const dz of [-0.3, 0.3]) this.box(0xd8d0bd, 4.2 + dx, 0.75, -2.2 + dz, 0.08, 1.5, 0.08);
      this.box(0xd84a5a, 4.2, 1.85, -2.45, 0.8, 0.55, 0.1);
      this.mesh('cylinder', 0xc9b28a, [3.9, 0.3, 2.6], [0.95, 0.6, 0.95]);
      const tub = this.mesh('cylinder', 0x6fd0de, [3.9, 0.6, 2.6], [0.85, 0.05, 0.85], this.world, true);
      tub.castShadow = false;
      for (let i = 0; i < 8; i++) {
        const bubble = this.mesh('sphere', 0xeaffff, [3.9 + Math.cos(i) * 0.5, 0.65, 2.6 + Math.sin(i) * 0.5], [0.05, 0.05, 0.05]);
        this.animated.push((t) => { bubble.position.y = 0.62 + ((t * 0.8 + i * 0.13) % 1) * 0.12; });
      }
      this.box(0xa4704a, -4.2, 1.2, -3.6, 1.6, 2.4, 1.3);
      this.box(0x8e5d3c, -4.2, 1.0, -2.93, 0.7, 1.9, 0.06);
      const steam = [0, 1, 2].map((i) => this.mesh('sphere', 0xf4f4f4, [-4.2 + i * 0.2, 2.5, -2.9], [0.14, 0.14, 0.14]));
      this.animated.push((t) => steam.forEach((s, i) => { s.position.y = 2.4 + ((t * 0.3 + i * 0.33) % 1) * 0.8; s.scale.setScalar(0.1 + ((t * 0.3 + i * 0.33) % 1) * 0.12); }));
      for (let i = 0; i < 4; i++) this.box([0xffffff, 0xd8e8f0, 0xf4dfba][i % 3], -4.6, 0.3 + i * 0.13, 2.2, 0.7, 0.12, 0.5);
      return;
    }
    if (type === 'studio') {
      this.venueShell(0xb99873, 0xe9e2d2, 0xdcd3bf);
      for (let i = 0; i < 26; i++) this.mesh('sphere', [0xc46457, 0x537fc3, 0xe5c363, 0x719b84, 0x9974d4][i % 5], [-5 + (i * 3.1) % 10, 0.125, -4 + (i * 2.3) % 8], [0.08 + (i % 3) * 0.03, 0.01, 0.06]);
      for (const x of [-4.1, -2.3]) { this.box(0xcfe6ee, x, 1.9, -4.38, 1.4, 2.0, 0.04); this.box(COLORS.cream, x, 1.9, -4.35, 0.06, 2.0, 0.05); }
      const wall = this.model.paintings || [];
      const titles = wall.length ? wall.map((p) => p.title) : ['the bell tower, late again', 'a pear on a blue cloth', 'the river at night', 'a portrait of a stranger'];
      titles.slice(0, 6).forEach((title, i) => this.hangPainting(title, 0.4 + (i % 3) * 1.4, 2.35 - Math.floor(i / 3) * 0.95, -4.36, i));
      this.box(COLORS.wood, -1.2, 0.8, 1.8, 3.2, 0.12, 1.0);
      for (const dx of [-1.4, 1.4]) for (const dz of [-0.4, 0.4]) this.box(COLORS.edge, -1.2 + dx, 0.38, 1.8 + dz, 0.09, 0.76, 0.09);
      for (let i = 0; i < 6; i++) { this.mesh('cylinder', 0xd8eef2, [-2.4 + i * 0.45, 0.98, 1.8], [0.1, 0.24, 0.1]); this.mesh('cylinder', COLORS.edge, [-2.4 + i * 0.45, 1.2, 1.8], [0.015, 0.34, 0.015]); }
      [[-3.9, 0.2], [2.6, -1.2], [3.8, 1.2]].forEach(([x, z], i) => this.furniture('easel', x, z, i + 1, 0.3 - i * 0.25));
      return;
    }
  }

  yard() {
    this.box(0x6e7b76, 0, -0.46, 0, 11, 0.78, 9);
    this.box(0x88a86f, 0, -0.03, 0, 11, 0.13, 9);
    for (let i = 0; i < 12; i++) { this.box(0xe8e0cc, -5.3 + i * 0.95, 0.55, -4.3, 0.12, 1.1, 0.08); }
    this.box(0xe8e0cc, 0, 0.85, -4.3, 11, 0.08, 0.06); this.box(0xe8e0cc, 0, 0.35, -4.3, 11, 0.08, 0.06);
    for (let i = 0; i < 10; i++) { this.box(0xe8e0cc, -5.4, 0.55, -4 + i * 0.9, 0.08, 1.1, 0.12); }
    this.tree(3.6, -2.8, 1.0, 2);
    for (const x of [-3.5, 0.5]) this.box(COLORS.edge, x, 1.1, -1.5, 0.08, 2.2, 0.08);
    this.box(COLORS.cream, -1.5, 2.05, -1.5, 4.0, 0.02, 0.02);
    [0xc46457, 0x537fc3, 0xf4dfba].forEach((c, i) => { const cloth = this.box(c, -2.6 + i * 1.1, 1.75, -1.5, 0.55, 0.6, 0.02); this.animated.push((t) => { cloth.rotation.x = Math.sin(t * 1.4 + i) * 0.12; }); });
    for (let i = 0; i < 9; i++) this.mesh('sphere', [0xe9cf96, 0xe9b5a5, 0xe9ead0][i % 3], [-4.5 + (i * 1.13) % 9, 0.15, 2.5 + (i % 3) * 0.5], [0.06, 0.08, 0.06]);
    this.model.furniture.forEach((name, i) => this.furniture(furnitureKind(name), -2.5 + (i % 4) * 1.8, 1.5 + Math.floor(i / 4) * 1.4, i));
  }

  /* ── WHO IS TALKING (Part 296) ─────────────────────────────────────────
   * A sighted player could not tell who spoke: the log said it, the picture
   * did not. A speech bubble rises over the figure that said it and fades.
   * Pure decoration: the canvas is aria-hidden and every word is already in
   * the log, which is the real record for everybody. */
  labelTexture(text, { bubble = false, gold = false } = {}) {
    const words = String(text || '').replace(/\s+/g, ' ').trim();
    const surface = document.createElement('canvas');
    const ctx = surface.getContext('2d');
    const font = bubble ? '26px sans-serif' : 'bold 24px sans-serif';
    ctx.font = font;
    const lines = [];
    if (bubble) {
      let line = '';
      for (const w of words.split(' ')) {
        const next = line ? line + ' ' + w : w;
        if (ctx.measureText(next).width > 330 && line) { lines.push(line); line = w; } else line = next;
        if (lines.length === 3) break;
      }
      if (lines.length < 3 && line) lines.push(line);
      if (lines.join(' ').length < words.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S*$/, '') + '…';
    } else lines.push(words.slice(0, 18));
    const width = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width)) + 36);
    const height = lines.length * 32 + (bubble ? 34 : 14);
    surface.width = width; surface.height = height;
    ctx.font = font;
    ctx.fillStyle = bubble ? 'rgba(255,252,240,0.96)' : gold ? 'rgba(92,64,12,0.86)' : 'rgba(22,30,34,0.78)';
    const r = 14, h = bubble ? height - 14 : height;
    ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(width - r, 0); ctx.quadraticCurveTo(width, 0, width, r); ctx.lineTo(width, h - r); ctx.quadraticCurveTo(width, h, width - r, h);
    if (bubble) { ctx.lineTo(width / 2 + 12, h); ctx.lineTo(width / 2, height); ctx.lineTo(width / 2 - 12, h); }
    ctx.lineTo(r, h); ctx.quadraticCurveTo(0, h, 0, h - r); ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0); ctx.fill();
    if (bubble) { ctx.strokeStyle = 'rgba(60,70,70,0.35)'; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.fillStyle = bubble ? '#1d2528' : gold ? '#ffe7a8' : '#f4f1e8';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, width / 2, 20 + i * 32 + (bubble ? 2 : -3)));
    const tex = new T.CanvasTexture(surface);
    tex.colorSpace = T.SRGBColorSpace;
    return { tex, aspect: width / height, lines: lines.length };
  }

  figureFor(who) {
    const w = String(who || '').toLowerCase().trim();
    if (!w) return null;
    if (w === 'self' || w === 'you') return this.figures.find((f) => f.self) || null;
    return this.figures.find((f) => String(f.name || '').toLowerCase() === w)
      || this.figures.find((f) => String(f.name || '').toLowerCase().split(' ')[0] === w.split(' ')[0])
      || null;
  }

  speak(who, text, kind = 'say') {
    if (!this.model || this.disposed) return;
    const figure = this.figureFor(who);
    if (!figure) return;
    const clean = String(text || '').replace(/^[^:"“]*(says|asks|exclaims|whispers)[^:"“]*[:,]?\s*/i, '').replace(/^["“]|["”]$/g, '').trim();
    if (!clean) return;
    const seconds = Math.min(9, 3.8 + clean.length * 0.045);
    this.bubbles = (this.bubbles || []).filter((b) => b.id !== figure.id);
    this.bubbles.push({ id: figure.id, name: figure.name, text: kind === 'emote' ? `(${clean})` : clean, until: performance.now() + seconds * 1000, total: seconds * 1000 });
    this.drawBubbles();
    if (!this.running) { this.render(); clearTimeout(this.bubbleTimer); this.bubbleTimer = setTimeout(() => { this.bubbles = []; this.drawBubbles(); this.render(); }, seconds * 1000); }
  }

  drawBubbles() {
    (this.bubbleSprites || []).forEach((s) => { this.world.remove(s); s.material.map.dispose(); s.material.dispose(); });
    this.bubbleSprites = [];
    const now = performance.now();
    this.bubbles = (this.bubbles || []).filter((b) => b.until > now);
    for (const b of this.bubbles) {
      const figure = this.figures.find((f) => f.id === b.id);
      if (!figure) continue;
      const label = this.labelTexture(b.text, { bubble: true });
      const sprite = new T.Sprite(new T.SpriteMaterial({ map: label.tex, depthTest: false, transparent: true }));
      const height = 0.42 + label.lines * 0.3;
      sprite.scale.set(height * label.aspect, height, 1);
      sprite.renderOrder = 5;
      sprite.userData.bubble = b;
      sprite.userData.figure = figure;
      this.world.add(sprite);
      this.bubbleSprites.push(sprite);
      this.placeBubble(sprite, now);
    }
  }

  placeBubble(sprite, now = performance.now()) {
    const f = sprite.userData.figure, b = sprite.userData.bubble;
    const scaleY = f.g.scale.y || 1;
    sprite.position.set(f.g.position.x, 2.35 * scaleY + sprite.scale.y / 2, f.g.position.z);
    const left = b.until - now;
    sprite.material.opacity = Math.max(0, Math.min(1, left / 600));
    sprite.visible = left > 0;
  }

  nameTag(person, g, look) {
    if (!this.nameTags) return;
    const first = String(person.name || '').split(' ')[0];
    if (!first) return;
    const label = this.labelTexture(first, { gold: !!person.self });
    const sprite = new T.Sprite(new T.SpriteMaterial({ map: label.tex, depthTest: false, transparent: true, opacity: 0.92 }));
    const animal = ['stray', 'pet'].includes(person.kind);
    const height = 0.38;
    sprite.scale.set(height * label.aspect / (look ? look.width : 1), height / (look ? look.height : 1), 1);
    sprite.position.set(0, animal ? 0.95 : 1.95, 0);
    sprite.renderOrder = 4;
    sprite.userData.nameTag = true;
    g.add(sprite);
  }

  setNameTags(on) {
    this.nameTags = !!on;
    this.key = null;
    if (this.lastRoom) this.update(this.lastRoom.room, this.lastRoom.hud);
  }

  sparkle(big = false) {
    const figure = this.figures.find((f) => f.self);
    if (!figure || !this.motion) return;
    const born = this.time;
    const pieces = [];
    for (let i = 0; i < (big ? 14 : 8); i++) {
      const star = this.mesh('sphere', [0xffd27a, 0xfff2b0, 0x8ae0ff][i % 3], [0, 0, 0], [0.06, 0.06, 0.06], this.world, true);
      star.castShadow = false;
      pieces.push({ star, a: (i / (big ? 14 : 8)) * Math.PI * 2 });
    }
    this.animated.push((t) => {
      const age = t - born;
      pieces.forEach(({ star, a }) => {
        const r = 0.3 + age * (big ? 0.9 : 0.6);
        star.position.set(figure.g.position.x + Math.cos(a + age) * r, 1.6 + age * 0.9, figure.g.position.z + Math.sin(a + age) * r);
        star.visible = age < 1.6;
      });
    });
  }

  weather() {
    if (!this.model.outdoor) return;
    if (this.model.weather === 'fog')
      this.scene.fog = new T.FogExp2(this.model.dark ? 0x19383f : 0xc3d3c6, 0.038);
    if (!['rain', 'storm', 'snow'].includes(this.model.weather)) return;
    const snow = this.model.weather === 'snow';
    const geometry = new T.BufferGeometry();
    const positions = new Float32Array(96 * 3);
    for (let i = 0; i < 96; i++) {
      positions[i * 3] = Math.sin(i * 34) * 5.4;
      positions[i * 3 + 1] = ((i % 19) / 19) * 5;
      positions[i * 3 + 2] = Math.cos(i * 51) * 4.4;
    }
    geometry.setAttribute('position', new T.BufferAttribute(positions, 3));
    const mat = new T.PointsMaterial({
      color: snow ? 0xf3f2df : 0xc1dbe0,
      size: snow ? 0.07 : 0.035,
      transparent: true,
      opacity: 0.8,
    });
    const particles = new T.Points(geometry, mat);
    this.world.add(particles);
    this.animated.push((t, dt) => {
      for (let i = 0; i < 96; i++) {
        positions[i * 3 + 1] -= dt * (snow ? 0.38 : 2.8);
        if (positions[i * 3 + 1] < 0.1) positions[i * 3 + 1] = 5;
      }
      geometry.attributes.position.needsUpdate = true;
    });
  }

  update(room, hud) {
    const model = sceneModel(room, hud);
    const key = JSON.stringify(model);
    if (key === this.key) return;
    this.key = key;
    this.entering = !!this.model;
    this.previousFigures =
      this.model?.id === model.id
        ? new Map(
            this.figures.map((f) => [
              f.id,
              { x: f.g.position.x, z: f.g.position.z, until: f.until, action: f.action },
            ]),
          )
        : new Map();
    this.model = model;
    this.clearWorld();
    this.scene.background = new T.Color(model.dark ? 0x142e39 : 0xc7d9ca);
    this.scene.fog = null;
    this.hemi.intensity = model.dark ? 1.35 : 2.7;
    this.sun.intensity = model.dark ? 1.2 : 4;
    this.sun.color.setHex(model.dark ? 0x95bdcd : 0xffe2b1);
    this.terrain();
    this.exitMarkers();
    if (model.hangout) this.gathering();
    model.people.forEach((p, i) => this.avatar(p, i));
    this.lastRoom = { room, hud };
    this.drawBubbles();
    this.animated.push(() => { (this.bubbleSprites || []).forEach((s) => this.placeBubble(s)); });
    this.weather();
    this.render();
    this.host.classList.add('has-stage');
    this.syncAnimation();
  }

  exitMarkers() {
    const anchors = { n: [0, -4.2], ne: [4.6, -3.5], e: [5.4, 0], se: [4.6, 3.5], s: [0, 4.2], sw: [-4.6, 3.5], w: [-5.4, 0], nw: [-4.6, -3.5] };
    let other = 0;
    for (const exit of this.model.exits) {
      const [x, z] = anchors[exit.dir] || [-3.5 + (other++ % 5) * 1.7, 4.6 + Math.floor((other - 1) / 5) * .6];
      const color = exit.locked || exit.missing ? 0xa6513f : exit.returning ? COLORS.brass : COLORS.teal;
      this.box(color, x, .08, z, .9, .12, .55);
      this.box(COLORS.wood, x, .62, z, .07, 1.1, .07);
      const surface = document.createElement('canvas');
      surface.width = 256; surface.height = 96;
      const ctx = surface.getContext('2d');
      ctx.fillStyle = '#203d44'; ctx.fillRect(0, 0, 256, 96);
      ctx.textAlign = 'center'; ctx.fillStyle = '#fff4d9';
      ctx.font = 'bold 25px sans-serif';
      ctx.fillText(exit.label.toUpperCase() + (exit.locked ? ' · LOCKED' : ''), 128, 33, 244);
      ctx.font = '23px sans-serif'; ctx.fillText(exit.to, 128, 73, 244);
      const texture = new T.CanvasTexture(surface); texture.colorSpace = T.SRGBColorSpace;
      const material = new T.SpriteMaterial({ map: texture, depthTest: false });
      const sign = new T.Sprite(material);
      sign.userData.interaction = exit.missing ? null : { direction: exit.dir };
      sign.userData.exitSign = true; sign.position.set(x, 1.45, z); sign.scale.set(3, 1.125, 1); sign.renderOrder = 2;
      this.world.add(sign);
    }
  }

  gathering() {
    const x = this.model.type === 'creek' ? 3.1 : -2.8;
    const z = 2.7;
    this.table(x, z);
    for (let i = 0; i < Math.min(6, this.model.hangout.guests.length); i++) {
      this.mesh(
        'cylinder',
        COLORS.cream,
        [x + 0.3, 0.9 + i * 0.025, z + 0.22],
        [0.17, 0.025, 0.17],
      );
    }
    if (/record/i.test(this.model.hangout.title)) {
      this.box(COLORS.ink, x - 0.32, 0.98, z - 0.15, 0.75, 0.18, 0.53);
      const record = this.mesh(
        'cylinder',
        0x222a2d,
        [x - 0.32, 1.08, z - 0.15],
        [0.23, 0.02, 0.23],
      );
      this.mesh('cylinder', 0xd7a25b, [x - 0.32, 1.1, z - 0.15], [0.08, 0.02, 0.08]);
      const label = this.box(COLORS.cream, 0.1, 0.02, 0, 0.035, 0.03, 0.15, record);
      this.animated.push((t) => {
        record.rotation.y = t * 1.2;
        label.visible = true;
      });
    }
    if (/story/i.test(this.model.hangout.title)) {
      this.box(0x936b68, x - 0.3, 0.91, z, 0.52, 0.12, 0.63);
      this.box(COLORS.cream, x - 0.3, 0.98, z, 0.46, 0.03, 0.57);
    }
  }

  cue(kinds) {
    if (!this.motion) return;
    const action = (kinds || []).some((k) => /dance/.test(k))
      ? 'dance'
      : (kinds || []).some((k) => /wave/.test(k))
        ? 'wave'
        : (kinds || []).some((k) => /^move/.test(k))
          ? 'walk'
          : '';
    if ((kinds || []).includes('ui.goal.done')) this.sparkle(true);
    else if ((kinds || []).includes('ui.want.done')) this.sparkle(false);
    const figure = this.figures.find((f) => f.index === 0);
    if (figure && action) {
      figure.action = action;
      figure.until = this.time + 2;
    }
  }

  resize() {
    if (this.disposed) return;
    const w = Math.max(1, this.host.clientWidth),
      h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    const half = Math.max(5.9, 8.8 / aspect) / this.zoom;
    Object.assign(this.camera, {
      left: -half * aspect,
      right: half * aspect,
      top: half,
      bottom: -half,
    });
    this.camera.updateProjectionMatrix();
    this.camera.position.set(Math.sin(this.angle) * 14, 11, Math.cos(this.angle) * 14);
    this.camera.lookAt(0, 1.1, 0);
    this.render();
  }

  view(turn = 0, zoom = 0) {
    this.angle = Math.max(-0.4, Math.min(1.5, this.angle + turn));
    this.zoom = Math.max(0.8, Math.min(1.3, this.zoom + zoom));
    this.resize();
  }
  render() {
    if (!this.disposed && this.model) this.renderer.render(this.scene, this.camera);
  }
  setMotion(on) {
    this.motion = on;
    if (!on) {
      this.animated.forEach((fn) => fn(0, 0));
      this.render();
    }
    this.syncAnimation();
  }
  syncAnimation() {
    if (this.disposed) return;
    const run = this.motion && this.visible && !document.hidden;
    if (run === this.running) return;
    this.running = run;
    this.lastTime = 0;
    this.renderer.setAnimationLoop(
      run
        ? (stamp) => {
            if (this.lastTime && stamp - this.lastTime < 32) return;
            const dt = this.lastTime ? Math.min(0.05, (stamp - this.lastTime) / 1000) : 0;
            this.lastTime = stamp;
            this.time += dt;
            this.animated.forEach((fn) => fn(this.time, dt));
            this.render();
          }
        : null,
    );
  }

  clearWorld() {
    (this.textures || []).forEach((t) => t.dispose());
    (this.disposables || []).forEach((m) => m.dispose());
    (this.bubbleSprites || []).forEach((s) => { s.material.map.dispose(); s.material.dispose(); });
    this.bubbleSprites = [];
    this.textures = [];
    this.disposables = [];
    this.animated = [];
    this.figures = [];
    this.world.traverse((obj) => {
      if (obj.userData.exitSign || obj.userData.nameTag) {
        obj.material.map.dispose();
        obj.material.dispose();
      }
      if (obj.isPoints) {
        obj.geometry.dispose();
        obj.material.dispose();
      }
    });
    this.world.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.intersection.disconnect();
    document.removeEventListener('visibilitychange', this.visibility);
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.clearWorld();
    this.materials.forEach((m) => m.dispose());
    this.waterfrontPainting.dispose();
    this.waterfrontMaterial.dispose();
    this.painting.dispose();
    this.paintingMaterial.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.host.classList.remove('has-stage');
  }
}

window.ReverieStage = { Stage, sceneModel, describePicture };
window.dispatchEvent(new Event('reverie-stage-ready'));
