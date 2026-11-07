import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const clamp = THREE.MathUtils.clamp;
const material = (color, roughness = .85, metalness = .02) => new THREE.MeshStandardMaterial({ color, roughness, metalness });

// Small deterministic textile maps give the upholstery and carpet a visible weave
// without shipping large image files or depending on an external asset service.
function textileTexture(seed, contrast = 18) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d');
  const image = context.createImageData(256, 256);
  let random = seed;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    random = (1664525 * random + 1013904223) >>> 0;
    const n = ((random >>> 24) - 128) / 128;
    const thread = (x % 4 === 0 ? 7 : 0) + (y % 5 === 0 ? -5 : 0);
    const value = Math.max(0, Math.min(255, 212 + n * contrast + thread));
    const i = (y * 256 + x) * 4;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function roundedBoxGeometry(width, height, depth, radius) {
  const geometry = new THREE.BoxGeometry(width, height, depth, 4, 4, 4);
  const p = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const inner = [width / 2 - radius, height / 2 - radius, depth / 2 - radius];
  for (let i = 0; i < p.count; i++) {
    const point = [p.getX(i), p.getY(i), p.getZ(i)];
    const base = point.map((v, axis) => clamp(v, -inner[axis], inner[axis]));
    const offset = point.map((v, axis) => v - base[axis]);
    const length = Math.hypot(...offset) || 1;
    p.setXYZ(i, base[0] + offset[0] * radius / length,
      base[1] + offset[1] * radius / length,
      base[2] + offset[2] * radius / length);
    normal.setXYZ(i, offset[0] / length, offset[1] / length, offset[2] / length);
  }
  p.needsUpdate = true;
  normal.needsUpdate = true;
  return geometry;
}

/** A WebGL hall. The camera remains at the actual selected seat in seat mode. */
export class CinemaView {
  constructor(canvas, onSeatClick) {
    this.canvas = canvas;
    this.onSeatClick = onSeatClick;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    // Retina at 2x quadruples the pixel work during video playback.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.36;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#09090d');
    this.scene.fog = new THREE.Fog('#09090d', 24, 52);
    this.camera = new THREE.PerspectiveCamera(50, 16 / 9, .08, 90);
    this.mode = 'seat';
    this.yaw = 0;
    this.pitch = .08;
    this.orbitYaw = 0;
    this.orbitPitch = .56;
    this.orbitRadius = 22;
    this.cameraTargets = { yaw: 0, pitch: .08, orbitYaw: 0, orbitPitch: .56, orbitRadius: 22, fov: 50 };
    this.motionFrame = null;
    this.lastMotionTime = 0;
    this.orbitTarget = new THREE.Vector3(0, 1.8, 10);
    this.hall = null;
    this.geometryCache = new Map();
    this.chairs = new Map();
    this.chairBatches = new Map();
    this.chairInstances = new Map();
    this.crowdMeshes = [];
    this.realPeople = new Map();
    this.realPeoplePrototypes = null;
    this.actualOccupied = new Set();
    this.clickTargets = [];
    this.selectedId = null;
    this.pointer = null;
    this.raycaster = new THREE.Raycaster();
    this.pointerVector = new THREE.Vector2();
    this.screenVideo = document.createElement('video');
    this.screenVideo.muted = true;
    this.screenVideo.defaultMuted = true;
    this.screenVideo.loop = true;
    this.screenVideo.playsInline = true;
    this.screenVideo.preload = 'auto';
    this.videoTexture = new THREE.VideoTexture(this.screenVideo);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.videoTexture.minFilter = THREE.LinearFilter;
    this.videoTexture.magFilter = THREE.LinearFilter;
    this.videoActive = false;
    this.audioEnabled = false;
    this.videoFrameRequest = null;
    this.screenVideo.addEventListener('loadeddata', () => this.showVideoOnScreen());
    this.screenVideo.addEventListener('loadedmetadata', () => {
      const sourceRatio = this.screenVideo.videoWidth / this.screenVideo.videoHeight;
      const visibleHeight = Math.min(1, sourceRatio / (10.72 / 4.44));
      this.videoTexture.repeat.set(1, visibleHeight);
      this.videoTexture.offset.set(0, (1 - visibleHeight) / 2);
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (event) => this.pointerDown(event));
    canvas.addEventListener('pointermove', (event) => this.pointerMove(event));
    canvas.addEventListener('pointerup', (event) => this.pointerUp(event));
    canvas.addEventListener('pointercancel', () => { this.pointer = null; });
    canvas.addEventListener('wheel', (event) => this.wheel(event), { passive: false });
    this.resize();
    this.loadAudienceModels();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width, rect.height, false);
    this.render();
  }

  setHall(cinema, seats, movie) {
    const key = `${cinema.id}:${movie.id}:${seats.map((s) => s.occupied ? s.id : '').filter(Boolean).join(',')}`;
    if (key === this.hallKey) return;
    this.setFilmSource(movie);
    this.hallKey = key;
    if (this.hall) {
      this.scene.remove(this.hall);
      this.hall.traverse((object) => {
        if (object.userData.sharedAudienceModel) {
          if (object.userData.ownedAudienceMaterial) object.material.dispose();
          return;
        }
        if (object.geometry) object.geometry.dispose();
        if (object.material?.map && object.material.map !== this.videoTexture) object.material.map.dispose();
        if (object.material && !Array.isArray(object.material)) object.material.dispose();
      });
    }
    this.screenMesh = null;
    this.chairs.clear(); this.chairBatches.clear(); this.chairInstances.clear(); this.crowdMeshes = [];
    this.realPeople.clear(); this.actualOccupied.clear(); this.clickTargets = [];
    this.geometryCache.clear();
    this.hall = new THREE.Group(); this.scene.add(this.hall);
    this.buildHall(cinema, seats, movie);
    this.setSeat(seats.find((s) => s.id === this.selectedId) || seats[0], false);
  }

  setFilmSource(movie) {
    const trailer = movie.trailer_url || null;
    if (this.currentTrailer === trailer) return;
    this.currentTrailer = trailer;
    this.disableAudio();
    this.screenVideo.pause();
    if (trailer) this.screenVideo.src = trailer;
    else this.screenVideo.removeAttribute('src');
    this.screenVideo.load();
  }

  loadAudienceModels() {
    this.canvas.dataset.audienceModel = 'loading';
    new GLTFLoader().load('/models/audience-near.glb', (gltf) => {
      const names = ['Avery', 'Riley', 'Nora'];
      this.realPeoplePrototypes = names.map((name) => {
        let model = null;
        gltf.scene.traverse((child) => {
          if (child.name.startsWith(`${name}_`) && child.name.includes('authored_figure')) model = child;
        });
        if (!model) return null;
        const clone = model.clone(true);
        clone.position.set(0, 0, 0);
        clone.traverse((object) => { object.userData.sharedAudienceModel = true; });
        return clone;
      }).filter(Boolean);
      this.canvas.dataset.audienceModel = this.realPeoplePrototypes.length ? 'ready' : 'empty';
      if (this.hall?.userData.seats) {
        this.syncAudienceModels();
        this.updateAudience();
        this.render();
      }
    }, undefined, (error) => {
      this.canvas.dataset.audienceModel = 'error';
      console.warn('Audience 3D model unavailable; using procedural figures', error);
    });
  }

  syncAudienceModels() {
    if (!this.realPeoplePrototypes?.length || !this.hall?.userData.seats || !this.seat) return;
    // Detailed 3D people are retained beside the visitor; the rest use a
    // three-draw-call instanced crowd. This keeps nearby faces realistic.
    const nearby = this.hall.userData.seats.filter((seat) => seat.id !== this.selectedId && (
      this.mode === 'overview' ? this.actualOccupied.has(seat.id)
        : Math.abs(seat.row_number - this.seat.row_number) <= 1 && Math.abs(seat.x - this.seat.x) <= 2.7
    )).sort((a, b) => Math.abs(a.x - this.seat.x) + Math.abs(a.z - this.seat.z)
      - Math.abs(b.x - this.seat.x) - Math.abs(b.z - this.seat.z)).slice(0, 16);
    const wanted = new Set(nearby.map((seat) => seat.id));
    for (const [seatId, model] of this.realPeople) {
      if (wanted.has(seatId)) continue;
      model.parent?.remove(model);
      model.traverse((object) => {
        if (object.userData.ownedAudienceMaterial) object.material.dispose();
      });
      this.realPeople.delete(seatId);
    }
    for (const seat of nearby) {
      if (this.realPeople.has(seat.id)) continue;
      const group = this.chairs.get(seat.id);
      if (!group) continue;
      const source = this.realPeoplePrototypes[(seat.row_number * 3 + seat.seat_number) % this.realPeoplePrototypes.length];
      const model = source.clone(true);
      const variant = seat.row_number * 13 + seat.seat_number * 7;
      const hairColors = ['#2c2524', '#4d3a31', '#756357', '#403737', '#a28d7c', '#302d31'];
      const fabricColors = ['#ddd7d0', '#b9c3ca', '#cab6b1', '#b9b9c6', '#c3c1b7'];
      model.traverse((object) => {
        if (!object.isMesh || !object.material) return;
        const name = `${object.name} ${object.material.name}`.toLowerCase();
        if (/(short04|afro01|bob01|braid01|hairline|scalp roots)/.test(name)) {
          object.material = object.material.clone();
          object.material.color.multiply(new THREE.Color(hairColors[variant % hairColors.length]));
          object.userData.ownedAudienceMaterial = true;
        } else if (/(casualsuit|cotton t-shirt|^top|^bottom)/.test(name)) {
          object.material = object.material.clone();
          object.material.color.multiply(new THREE.Color(fabricColors[(variant + 2) % fabricColors.length]));
          object.userData.ownedAudienceMaterial = true;
        }
      });
      model.rotation.y = Math.PI + ((seat.seat_number % 5) - 2) * .05;
      model.scale.setScalar(seat.kind === 'sofa' ? 1.04 : .96 + (seat.seat_number % 4) * .015);
      model.position.set(0, .14, -.11);
      model.visible = true;
      model.traverse((object) => { object.userData.sharedAudienceModel = true; });
      group.add(model);
      this.realPeople.set(seat.id, model);
    }
  }

  addBox(w, h, d, x, y, z, mat, parent = this.hall) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  }

  addRoundedBox(w, h, d, radius, x, y, z, mat, parent = this.hall) {
    const key = `${w}:${h}:${d}:${radius}`;
    if (!this.geometryCache.has(key)) this.geometryCache.set(key, roundedBoxGeometry(w, h, d, radius));
    const mesh = new THREE.Mesh(this.geometryCache.get(key), mat);
    mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  }

  buildHall(cinema, seats, movie) {
    const maxRow = Math.max(...seats.map((s) => s.row_number));
    const farZ = Math.max(...seats.map((s) => s.z)) + 3.4;
    const halfWidth = Math.max(6.75, Math.max(...seats.map((s) => Math.abs(s.x))) + 1.3);
    this.hallHalfWidth = halfWidth;
    const carpetMap = textileTexture(17, 26);
    carpetMap.repeat.set(10, 16);
    const wallMap = textileTexture(43, 12);
    wallMap.repeat.set(2, 8);
    const wall = new THREE.MeshStandardMaterial({ color: '#29252b', map: wallMap, roughness: .94 });
    const floor = new THREE.MeshStandardMaterial({ color: '#382b32', map: carpetMap, roughness: 1 });
    const trim = material('#504347', .4, .62);
    const aisle = new THREE.MeshBasicMaterial({ color: '#d37d55' });
    const dim = new THREE.MeshBasicMaterial({ color: '#4a2623' });
    this.addBox(halfWidth * 2, .3, farZ + 2, 0, -.26, farZ / 2, floor);
    this.addBox(.16, 7, farZ + 2, -halfWidth, 3.25, farZ / 2, wall);
    this.addBox(.16, 7, farZ + 2, halfWidth, 3.25, farZ / 2, wall);
    this.ceiling = this.addBox(halfWidth * 2, .16, farZ + 2, 0, 6.77, farZ / 2, material('#17161c'));
    this.ceiling.visible = this.mode === 'seat';
    this.addBox(halfWidth * 2, 7, .3, 0, 3.25, -.05, material('#0b0b0e'));
    this.addBox(halfWidth * 2, 2, .25, 0, .85, .1, material('#111015'));
    // Each step corresponds to one row in the seat map.
    for (let row = 1; row <= maxRow; row++) {
      const rowSeats = seats.filter((s) => s.row_number === row);
      const z = rowSeats[0]?.z ?? 3.5 + row * 1.35;
      const tier = (row - 1) * .17;
      this.addBox(halfWidth * 2 - .25, .17 + tier, 1.35, 0, (tier - .17) / 2, z, floor);
      this.addBox(halfWidth * 2 - .25, .015, .035, 0, tier + .006, z - .62, dim);
      for (const side of [-1, 1]) {
        this.addRoundedBox(.045, .02, 1.05, .009, side * (halfWidth - .7), tier + .025, z, aisle);
      }
    }
    // Acoustic wall bays, brass reveals, exit aisle lights and ceiling coves.
    for (let z = 3.3; z < farZ; z += 2.7) {
      for (const side of [-1, 1]) {
        this.addBox(.055, 4.9, 2.25, side * (halfWidth - .19), 3.1, z + 1.08, material('#342d33', .94));
        this.addBox(.055, 5.7, .045, side * (halfWidth - .27), 3.35, z, trim);
        this.addBox(.05, .32, .13, side * (halfWidth - .25), .48, z, aisle);
        this.addRoundedBox(.12, .64, .24, .045, side * (halfWidth - .34), 3.46, z + .19, material('#bd9977', .45, .65));
        this.addRoundedBox(.13, .49, .13, .04, side * (halfWidth - .41), 3.46, z + .19,
          new THREE.MeshBasicMaterial({ color: '#ffbc89' }));
        if (z < 4) {
          const point = new THREE.PointLight('#ff9965', 1.2, 4.5);
          point.position.set(side * (halfWidth - .43), 3.4, z + .2); this.hall.add(point);
        }
      }
    }
    for (let z = 2; z < farZ; z += 7.2) {
      this.addBox(halfWidth * 1.65, .035, .07, 0, 6.59, z, material('#76584e', .35, .7));
      if (Math.abs(z - farZ / 2) < 4) {
        const light = new THREE.PointLight('#ffcfaa', 1.65, 10);
        light.position.set(0, 6.35, z); this.hall.add(light);
      }
    }
    this.hall.add(new THREE.HemisphereLight('#aab6d6', '#3a2631', 1.2));
    this.hall.add(new THREE.AmbientLight('#b4adbd', .42));
    const screenGlow = new THREE.PointLight('#d8e5ff', 22, 25);
    screenGlow.position.set(0, 3.5, 1.4); this.hall.add(screenGlow);
    this.addBox(11.82, 5.35, .24, 0, 3.28, .29, material('#0c0a0d', .45));
    this.addBox(11.53, 5.18, .08, 0, 3.28, .43, material('#7e5d51', .38, .7));
    this.addBox(11.45, 5.12, .25, 0, 3.28, .43, material('#020204', .25));
    this.addBox(10.95, 4.65, .07, 0, 3.28, .65, material('#5d5b65', .25, .7));
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(10.72, 4.44),
      new THREE.MeshBasicMaterial({ map: movie.trailer_url && this.screenVideo.readyState >= 2 ? this.videoTexture : this.createScreenTexture(movie), toneMapped: false, side: THREE.DoubleSide })
    );
    screen.position.set(0, 3.28, .69); this.hall.add(screen); this.screenMesh = screen;
    this.addBox(11.7, .11, .6, 0, .63, .75, material('#070608'));
    const upholsteryMap = textileTexture(91, 18);
    upholsteryMap.repeat.set(2, 2);
    const chairMaterials = {
      velvet: new THREE.MeshStandardMaterial({ color: '#934b59', map: upholsteryMap, roughness: .91 }),
      sofa: new THREE.MeshStandardMaterial({ color: '#855161', map: upholsteryMap, roughness: .92 }),
      seam: material('#512a37'), shell: material('#251f29', .74), arm: material('#241e24', .67),
      metal: material('#6f5b54', .35, .75), cup: material('#08090d', .3, .45),
    };
    for (const seat of seats) {
      const sofa = seat.kind === 'sofa', width = sofa ? 1.37 : .64;
      const group = new THREE.Group();
      group.position.set(seat.x, (seat.row_number - 1) * .17, seat.z);
      group.userData.seatId = seat.id;
      this.hall.add(group); this.chairs.set(seat.id, group);
      this.buildSeat(seat, width, sofa, chairMaterials);
      if (seat.occupied) this.actualOccupied.add(seat.id);
    }
    this.flushChairBatches();
    this.buildCrowdInstances(seats);
    this.marker = new THREE.Group();
    const markerBall = new THREE.Mesh(new THREE.SphereGeometry(.18, 12, 9), new THREE.MeshBasicMaterial({ color: '#ff765e' }));
    const markerRing = new THREE.Mesh(new THREE.TorusGeometry(.33, .035, 6, 22), new THREE.MeshBasicMaterial({ color: '#ff8e73' }));
    markerRing.rotation.x = Math.PI / 2;
    this.marker.add(markerBall, markerRing);
    this.marker.visible = this.mode === 'overview';
    this.hall.add(this.marker);
    this.hall.userData = { cinemaId: cinema.id, movieId: movie.id, seatCount: seats.length, seats };
  }

  chairGeometry(key, create) {
    if (!this.geometryCache.has(key)) this.geometryCache.set(key, create());
    return this.geometryCache.get(key);
  }

  queueChairPart(seat, role, geometry, mat, x, y, z, rotationX = 0) {
    const key = `${geometry.uuid}:${mat.uuid}`;
    if (!this.chairBatches.has(key)) this.chairBatches.set(key, { geometry, mat, role, entries: [] });
    const tier = (seat.row_number - 1) * .17;
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(seat.x + x, tier + y, seat.z + z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rotationX, 0, 0)),
      new THREE.Vector3(1, 1, 1)
    );
    this.chairBatches.get(key).entries.push({ seatId: seat.id, matrix });
  }

  buildSeat(seat, width, sofa, mat) {
    const upholstery = sofa ? mat.sofa : mat.velvet;
    const armX = width / 2 + .11;
    const round = (role, w, h, d, radius, x, y, z, surface) => {
      const geometry = this.chairGeometry(`chair-round:${w}:${h}:${d}:${radius}`,
        () => roundedBoxGeometry(w, h, d, radius));
      this.queueChairPart(seat, role, geometry, surface, x, y, z);
    };
    const box = (role, w, h, d, x, y, z, surface) => {
      const geometry = this.chairGeometry(`chair-box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));
      this.queueChairPart(seat, role, geometry, surface, x, y, z);
    };
    round('shell', width + .16, .82, .18, .055, 0, .85, .31, mat.shell);
    round('back', width + .035, .65, .125, .058, 0, .89, .414, upholstery);
    round('headrest', width * .8, .14, .13, .05, 0, 1.22, .426, upholstery);
    round('cushion', width + .11, .22, .68, .07, 0, .47, -.095, upholstery);
    round('base', width + .12, .055, .62, .022, 0, .335, -.08, mat.shell);
    round('seam', width * .76, .023, .032, .01, 0, .7, .485, mat.seam);
    for (const side of [-1, 1]) {
      round('sideback', .075, .48, .12, .03, side * (width / 2 - .02), .85, .43, upholstery);
      round('arm-shell', .17, .61, .7, .045, side * armX, .59, -.07, mat.shell);
      round('arm-top', .19, .13, .64, .045, side * armX, .87, -.07, mat.arm);
      box('arm-post', .055, .32, .055, side * armX, .28, .24, mat.metal);
      const ring = this.chairGeometry('chair-cup-ring', () => new THREE.TorusGeometry(.065, .012, 5, 12));
      this.queueChairPart(seat, 'cup-ring', ring, mat.metal, side * armX, .95, -.23, Math.PI / 2);
      const cup = this.chairGeometry('chair-cup-well', () => new THREE.CylinderGeometry(.055, .048, .085, 12));
      this.queueChairPart(seat, 'cup-well', cup, mat.cup, side * armX, .905, -.23);
    }
    round('stem', .2, .38, .22, .035, 0, .15, .15, mat.metal);
    round('foot', width * .68, .04, .47, .016, 0, .02, .11, mat.shell);
  }

  flushChairBatches() {
    for (const { geometry, mat, role, entries } of this.chairBatches.values()) {
      const mesh = new THREE.InstancedMesh(geometry, mat, entries.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.seatIds = entries.map((entry) => entry.seatId);
      entries.forEach((entry, index) => {
        mesh.setMatrixAt(index, entry.matrix);
        if (!this.chairInstances.has(entry.seatId)) this.chairInstances.set(entry.seatId, []);
        this.chairInstances.get(entry.seatId).push({ mesh, index, matrix: entry.matrix });
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (role === 'back' || role === 'cushion') this.clickTargets.push(mesh);
      this.hall.add(mesh);
    }
    this.chairBatches.clear();
  }

  setChairVisible(seatId, visible) {
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const { mesh, index, matrix } of this.chairInstances.get(seatId) || []) {
      mesh.setMatrixAt(index, visible ? matrix : hidden);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  buildCrowdInstances(seats) {
    const geometry = new THREE.SphereGeometry(1, 12, 8);
    const hairCap = new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI * .65);
    const parts = [
      { name: 'body', height: .98, scale: [.23, .37, .19], geometry, colors: ['#38404c', '#4a3b43', '#354649', '#514139', '#393844', '#55525a'] },
      { name: 'head', height: 1.43, scale: [.15, .18, .14], geometry, colors: ['#b98c78', '#a37764', '#885b49', '#be9a84', '#795348', '#ad826f'] },
      { name: 'hair', height: 1.43, scale: [.163, .187, .15], geometry: hairCap, colors: ['#211a19', '#3c2923', '#514035', '#1d1b22', '#6c5446', '#342b2a'] },
    ];
    this.crowdMeshes = parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, material('#bbb0ae', .94), seats.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      this.hall.add(mesh);
      return { ...part, mesh };
    });
  }

  updateAudience() {
    if (!this.hall?.userData.seats) return;
    for (const [seatId, model] of this.realPeople) {
      model.visible = seatId !== this.selectedId && (this.mode === 'seat' || this.actualOccupied.has(seatId));
    }
    const fallback = this.hall.userData.seats.filter((seat) =>
      seat.id !== this.selectedId && !this.realPeople.has(seat.id) &&
      (this.mode === 'seat' || this.actualOccupied.has(seat.id)));
    const rotation = new THREE.Quaternion();
    for (const part of this.crowdMeshes) {
      const { mesh } = part;
      mesh.count = fallback.length;
      fallback.forEach((seat, index) => {
        const tier = (seat.row_number - 1) * .17;
        mesh.setMatrixAt(index, new THREE.Matrix4().compose(
          new THREE.Vector3(seat.x, tier + part.height, seat.z - .1),
          rotation,
          new THREE.Vector3(...part.scale)
        ));
        mesh.setColorAt(index, new THREE.Color(part.colors[(seat.row_number * 7 + seat.seat_number * 3) % part.colors.length]));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  showVideoOnScreen() {
    if (!this.currentTrailer || this.screenVideo.readyState < 2 || !this.screenMesh || this.screenMesh.material.map === this.videoTexture) return;
    this.screenMesh.material.map.dispose();
    this.screenMesh.material.map = this.videoTexture;
    this.screenMesh.material.needsUpdate = true;
    this.render();
  }

  setVisible(visible) {
    if (this.videoActive === visible) return;
    this.videoActive = visible;
    if (visible) {
      if (!this.currentTrailer) return;
      if (this.audioEnabled) this.audioContext?.resume().catch(() => {});
      this.screenVideo.play().catch(() => { /* Keep the static screen if autoplay is blocked. */ });
      this.scheduleVideoFrame();
    } else {
      this.screenVideo.pause();
      this.audioContext?.suspend().catch(() => {});
      if (this.videoFrameRequest !== null) {
        if (this.screenVideo.cancelVideoFrameCallback) this.screenVideo.cancelVideoFrameCallback(this.videoFrameRequest);
        else cancelAnimationFrame(this.videoFrameRequest);
        this.videoFrameRequest = null;
      }
    }
  }

  async enableAudio() {
    if (!this.currentTrailer) throw new Error('У этого фильма нет трейлера');
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('Spatial audio is unavailable');
    if (!this.audioContext) {
      const context = new Context();
      const source = context.createMediaElementSource(this.screenVideo);
      const splitter = context.createChannelSplitter(2);
      const mix = context.createGain();
      source.connect(splitter);
      for (const [channel, x] of [[0, -4], [1, 4]]) {
        const speaker = context.createPanner();
        speaker.panningModel = 'HRTF';
        speaker.distanceModel = 'inverse';
        speaker.refDistance = 3.8;
        speaker.maxDistance = 40;
        speaker.rolloffFactor = 1.15;
        if (speaker.positionX) {
          speaker.positionX.value = x;
          speaker.positionY.value = 3.28;
          speaker.positionZ.value = .69;
        } else speaker.setPosition(x, 3.28, .69);
        splitter.connect(speaker, channel);
        speaker.connect(mix);
      }
      mix.connect(context.destination);
      this.audioContext = context;
      this.audioMix = mix;
    }
    this.audioEnabled = true;
    this.updateAudioListener();
    this.screenVideo.muted = false;
    try {
      await this.audioContext.resume();
      await this.screenVideo.play();
    } catch (error) {
      this.disableAudio();
      throw error;
    }
  }

  disableAudio() {
    this.audioEnabled = false;
    this.screenVideo.muted = true;
    this.audioContext?.suspend().catch(() => {});
  }

  updateAudioListener() {
    if (!this.audioContext || !this.seat) return;
    const context = this.audioContext;
    const listener = context.listener;
    const eyeY = 1.64 + (this.seat.row_number - 1) * .17;
    const position = [this.seat.x, eyeY, this.seat.z + .03];
    const forward = [Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)];
    if (listener.positionX) {
      for (const [param, value] of [[listener.positionX, position[0]], [listener.positionY, position[1]], [listener.positionZ, position[2]], [listener.forwardX, forward[0]], [listener.forwardY, forward[1]], [listener.forwardZ, forward[2]]]) {
        param.setTargetAtTime(value, context.currentTime, .035);
      }
    } else {
      listener.setPosition(...position);
      listener.setOrientation(...forward, 0, 1, 0);
    }
    const side = Math.min(1, Math.abs(this.seat.x) / this.hallHalfWidth);
    this.audioMix.gain.setTargetAtTime(.9 * (1 - side * .4), context.currentTime, .08);
  }

  scheduleVideoFrame() {
    if (!this.videoActive || this.videoFrameRequest !== null) return;
    if (this.screenVideo.requestVideoFrameCallback) {
      this.videoFrameRequest = this.screenVideo.requestVideoFrameCallback(() => {
        this.videoFrameRequest = null;
        if (this.motionFrame === null) this.requestRender();
        this.scheduleVideoFrame();
      });
    } else {
      this.videoFrameRequest = requestAnimationFrame((time) => {
        this.videoFrameRequest = null;
        if (time - (this.lastVideoRender || 0) >= 32) {
          this.lastVideoRender = time;
          if (this.motionFrame === null) this.requestRender();
        }
        this.scheduleVideoFrame();
      });
    }
  }

  createScreenTexture(movie) {
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 500;
    const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    const theme = movie.theme;
    const gradients = {
      violet: ['#050b29', '#323176', '#aa5b90'],
      amber: ['#140c13', '#674032', '#e79956'],
      blue: ['#051729', '#164b69', '#52b6ad'],
    };
    const colors = gradients[theme] || gradients.violet;
    const background = ctx.createLinearGradient(0, 0, w, h);
    background.addColorStop(0, colors[0]); background.addColorStop(.52, colors[1]); background.addColorStop(1, colors[2]);
    ctx.fillStyle = background; ctx.fillRect(0, 0, w, h);
    if (theme === 'violet') {
      for (let i = 0; i < 145; i++) {
        const x = (i * 419) % w, y = (i * 191) % h;
        ctx.fillStyle = `rgba(255,255,255,${.25 + (i % 5) * .12})`;
        ctx.beginPath(); ctx.arc(x, y, i % 11 ? 1.2 : 2.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = '#e8a5d275'; ctx.lineWidth = 42;
      ctx.beginPath(); ctx.ellipse(870, 300, 460, 92, -.3, 0, Math.PI * 2); ctx.stroke();
      const planet = ctx.createRadialGradient(840, 180, 20, 930, 260, 215);
      planet.addColorStop(0, '#ffe0be'); planet.addColorStop(.3, '#ad79bd'); planet.addColorStop(1, '#292651');
      ctx.fillStyle = planet; ctx.beginPath(); ctx.arc(910, 270, 180, 0, Math.PI * 2); ctx.fill();
    } else if (theme === 'amber') {
      ctx.fillStyle = '#1d171bd9';
      for (let i = 0; i < 18; i++) {
        const x = i * 82 - 20, height = 80 + (i * 79) % 260;
        ctx.fillRect(x, h - height, 63, height);
        ctx.fillStyle = '#ffc48d55';
        for (let j = 0; j < 4; j++) ctx.fillRect(x + 9 + j * 13, h - height + 20, 5, 8);
        ctx.fillStyle = '#1d171bd9';
      }
      const moon = ctx.createRadialGradient(780, 145, 5, 780, 145, 170);
      moon.addColorStop(0, '#fff5dd'); moon.addColorStop(.2, '#ffd0a3'); moon.addColorStop(1, '#ffd0a300');
      ctx.fillStyle = moon; ctx.beginPath(); ctx.arc(780, 145, 170, 0, Math.PI * 2); ctx.fill();
    } else {
      for (let i = 0; i < 28; i++) {
        const x = (i * 173) % w, y = (i * 271) % h, radius = 8 + i % 4 * 8;
        ctx.strokeStyle = `rgba(175,241,238,${.12 + i % 3 * .08})`;
        ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = '#072435bb'; ctx.beginPath(); ctx.moveTo(0, h); ctx.quadraticCurveTo(450, 250, 1200, 440); ctx.lineTo(1200, h); ctx.fill();
      ctx.strokeStyle = '#80dad65e'; ctx.lineWidth = 11;
      for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(-30, 300 + i * 55); ctx.bezierCurveTo(300, 250 + i * 45, 700, 375 + i * 10, 1230, 255 + i * 70); ctx.stroke(); }
    }
    const shade = ctx.createLinearGradient(0, 0, 760, 0);
    shade.addColorStop(0, '#05070be8'); shade.addColorStop(1, '#05070b00');
    ctx.fillStyle = shade; ctx.fillRect(0, 0, 800, h);
    ctx.fillStyle = '#ff705c'; ctx.fillRect(67, 68, 53, 5);
    ctx.fillStyle = '#fff8ef'; ctx.font = '700 110px system-ui, sans-serif';
    ctx.fillText(movie.title.toUpperCase(), 65, 286, 660);
    ctx.font = '500 29px system-ui, sans-serif'; ctx.fillStyle = '#f4e9e3cf';
    ctx.fillText(movie.tagline, 70, 344, 680);
    ctx.font = '700 17px system-ui, sans-serif'; ctx.letterSpacing = '6px';
    ctx.fillText('ЭКРАН  •  КИНО БЛИЖЕ', 70, 446);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    if (movie.poster) {
      const poster = new Image();
      poster.onload = () => {
        ctx.save();
        ctx.shadowColor = '#0008'; ctx.shadowBlur = 30;
        ctx.fillStyle = '#0c090d'; ctx.fillRect(817, 31, 310, 438);
        ctx.drawImage(poster, 827, 41, 290, 418);
        ctx.restore();
        texture.needsUpdate = true;
        this.render();
      };
      poster.src = movie.poster;
    }
    return texture;
  }

  setSeat(seat, render = true) {
    if (!seat) return;
    this.stopCameraMotion();
    if (this.selectedId) this.setChairVisible(this.selectedId, true);
    this.selectedId = seat.id; this.seat = seat;
    if (this.mode === 'seat') this.setChairVisible(seat.id, false);
    this.syncAudienceModels();
    this.updateAudience();
    if (this.marker) this.marker.position.set(seat.x, (seat.row_number - 1) * .17 + 1.75, seat.z);
    this.yaw = 0; this.pitch = .08;
    this.cameraTargets.yaw = 0; this.cameraTargets.pitch = .08;
    this.updateCamera(); if (render) this.render();
  }

  setMode(mode) {
    this.stopCameraMotion();
    this.mode = mode === 'overview' ? 'overview' : 'seat';
    if (this.ceiling) this.ceiling.visible = this.mode === 'seat';
    if (this.marker) this.marker.visible = this.mode === 'overview';
    if (this.seat) this.setChairVisible(this.seat.id, this.mode === 'overview');
    this.syncAudienceModels();
    this.updateAudience();
    this.resetLook(true);
  }

  resetLook(instant = false) {
    Object.assign(this.cameraTargets, {
      yaw: 0, pitch: .08, orbitYaw: 0, orbitPitch: .67, orbitRadius: 22,
      fov: this.mode === 'seat' ? 50 : 52,
    });
    if (!instant) return this.startCameraMotion();
    this.stopCameraMotion();
    this.yaw = this.cameraTargets.yaw; this.pitch = this.cameraTargets.pitch;
    this.orbitYaw = this.cameraTargets.orbitYaw; this.orbitPitch = this.cameraTargets.orbitPitch;
    this.orbitRadius = this.cameraTargets.orbitRadius; this.camera.fov = this.cameraTargets.fov;
    this.camera.updateProjectionMatrix(); this.updateCamera(); this.render();
  }

  stopCameraMotion() {
    if (this.motionFrame !== null) cancelAnimationFrame(this.motionFrame);
    this.motionFrame = null;
  }

  startCameraMotion() {
    if (this.motionFrame !== null) return;
    this.lastMotionTime = performance.now();
    this.motionFrame = requestAnimationFrame((time) => this.advanceCamera(time));
  }

  advanceCamera(time) {
    this.motionFrame = null;
    if (this.pendingRender) { cancelAnimationFrame(this.pendingRender); this.pendingRender = null; }
    const elapsed = Math.min(.05, Math.max(.001, (time - this.lastMotionTime) / 1000));
    this.lastMotionTime = time;
    const blend = 1 - Math.exp(-elapsed * 12);
    let remaining = 0;
    for (const [key, target] of Object.entries(this.cameraTargets)) {
      const current = key === 'fov' ? this.camera.fov : this[key];
      const difference = target - current;
      remaining = Math.max(remaining, Math.abs(difference));
      const next = Math.abs(difference) < .001 ? target : current + difference * blend;
      if (key === 'fov') {
        if (this.camera.fov !== next) { this.camera.fov = next; this.camera.updateProjectionMatrix(); }
      } else this[key] = next;
    }
    this.updateCamera();
    this.render();
    if (remaining > .001) this.motionFrame = requestAnimationFrame((nextTime) => this.advanceCamera(nextTime));
  }

  updateCamera() {
    if (this.mode === 'overview') {
      const a = this.orbitPitch, r = this.orbitRadius;
      this.camera.position.set(this.orbitTarget.x + Math.sin(this.orbitYaw) * Math.cos(a) * r,
        this.orbitTarget.y + Math.sin(a) * r,
        this.orbitTarget.z + Math.cos(this.orbitYaw) * Math.cos(a) * r);
      this.camera.lookAt(this.orbitTarget);
    } else if (this.seat) {
      const eyeY = 1.64 + (this.seat.row_number - 1) * .17;
      this.camera.position.set(this.seat.x, eyeY, this.seat.z + .03);
      const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
      this.camera.lookAt(this.camera.position.clone().add(dir));
    }
    this.updateAudioListener();
  }

  pointerDown(event) {
    this.pointer = { x: event.clientX, y: event.clientY, moved: false };
    this.canvas.setPointerCapture(event.pointerId);
  }
  pointerMove(event) {
    if (!this.pointer) return;
    const dx = event.clientX - this.pointer.x, dy = event.clientY - this.pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.pointer.moved = true;
    this.pointer.x = event.clientX; this.pointer.y = event.clientY;
    if (this.mode === 'overview') {
      this.cameraTargets.orbitYaw = clamp(this.cameraTargets.orbitYaw - dx * .006, -.9, .9);
      this.cameraTargets.orbitPitch = clamp(this.cameraTargets.orbitPitch + dy * .004, .25, 1.23);
    } else {
      this.cameraTargets.yaw = clamp(this.cameraTargets.yaw - dx * .005, -1.25, 1.25);
      this.cameraTargets.pitch = clamp(this.cameraTargets.pitch + dy * .004, -.42, .55);
    }
    this.startCameraMotion();
  }
  pointerUp(event) {
    if (!this.pointer) return;
    const moved = this.pointer.moved; this.pointer = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (moved || this.mode !== 'overview') return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointerVector.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height * 2 - 1));
    this.raycaster.setFromCamera(this.pointerVector, this.camera);
    const hit = this.raycaster.intersectObjects(this.clickTargets, false)[0];
    const seatId = hit?.object.userData.seatIds?.[hit.instanceId];
    if (seatId) this.onSeatClick(seatId);
  }
  wheel(event) {
    event.preventDefault();
    if (this.mode === 'overview') this.cameraTargets.orbitRadius = clamp(this.cameraTargets.orbitRadius + Math.sign(event.deltaY) * 1.5, 14, 40);
    else this.cameraTargets.fov = clamp(this.cameraTargets.fov + Math.sign(event.deltaY) * 3, 45, 90);
    this.startCameraMotion();
  }
  nudge(yaw, pitch) {
    if (this.mode === 'overview') {
      this.cameraTargets.orbitYaw = clamp(this.cameraTargets.orbitYaw + yaw, -.9, .9);
      this.cameraTargets.orbitPitch = clamp(this.cameraTargets.orbitPitch + pitch, .25, 1.23);
    } else {
      this.cameraTargets.yaw = clamp(this.cameraTargets.yaw + yaw, -1.25, 1.25);
      this.cameraTargets.pitch = clamp(this.cameraTargets.pitch + pitch, -.42, .55);
    }
    this.startCameraMotion();
  }
  requestRender() {
    if (this.pendingRender) return;
    this.pendingRender = requestAnimationFrame(() => {
      this.pendingRender = null;
      this.render();
    });
  }
  render() {
    if (!this.canvas.parentElement.getBoundingClientRect().width || !this.hall) return;
    const now = performance.now();
    this.renderer.render(this.scene, this.camera);
    this.lastRenderMs = performance.now() - now;
    this.statFrames = (this.statFrames || 0) + 1;
    if (!this.statStart) this.statStart = now;
    if (now - this.statStart >= 1000) {
      this.canvas.dataset.renderFps = String(Math.round(this.statFrames * 1000 / (now - this.statStart)));
      this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
      this.canvas.dataset.renderMs = this.lastRenderMs.toFixed(1);
      this.statStart = now;
      this.statFrames = 0;
    }
  }
}
