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
} from './presentation.mjs?v=173';

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

/** A decorative view only. It never requests game data, plays sound, or sends commands. */
export class Stage {
  constructor(host, onFailure) {
    this.host = host;
    this.onFailure = onFailure;
    this.materials = new Map();
    this.animated = [];
    this.figures = [];
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
    if (type === 'town') this.town();
    else this.interior();
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
    } else {
      for (let i = 0; i < 27; i++)
        this.box(i % 3 ? 0xc4a27b : 0xb4916d, 0, 0.07, -4.35 + i * 0.335, 11, 0.1, 0.31);
    }
    this.box(0x87a39a, 0, 1.5, -4.5, 11, 3, 0.16);
    this.box(0xb6c5ac, -5.5, 1.5, 0, 0.16, 3, 9);
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
      this.model.furniture.forEach((name, i) => {
        const pos = positions[i % 8];
        this.furniture(furnitureKind(name), pos[0] + Math.floor(i / 8) * 0.35, pos[1], i);
      });
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
    const g = this.group(x, 0, z);
    if (['stray', 'pet'].includes(person.kind)) {
      this.mesh('leaf', 0xb98968, [0, 0.22, 0], [0.28, 0.22, 0.5], g);
      this.mesh('sphere', 0xb98968, [0, 0.43, 0.37], [0.19, 0.19, 0.19], g);
      for (const dx of [-0.1, 0.1])
        this.mesh('cone', 0x7e614e, [dx, 0.63, 0.37], [0.09, 0.16, 0.08], g);
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
    const figure = {
      id: person.id,
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
    if (model.hangout) this.gathering();
    model.people.forEach((p, i) => this.avatar(p, i));
    this.weather();
    this.render();
    this.host.classList.add('has-stage');
    this.syncAnimation();
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
    this.animated = [];
    this.figures = [];
    this.world.traverse((obj) => {
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
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.intersection.disconnect();
    document.removeEventListener('visibilitychange', this.visibility);
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.clearWorld();
    this.materials.forEach((m) => m.dispose());
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
