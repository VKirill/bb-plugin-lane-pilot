import type * as ThreeType from "three";

export type OfficeSceneOptions = {
  THREE: typeof import("three");
  scene: import("three").Scene;
  disposables: Array<{ dispose: () => void }>;
};

/**
 * Builds the bright isometric cutaway diorama office with pixel outlines
 * and detailed corporate clutter/props.
 */
export function buildOfficeDiorama({ THREE, scene, disposables }: OfficeSceneOptions): void {
  // Outline material: crisp dark slate
  const outlineMat = new THREE.LineBasicMaterial({
    color: 0x0f172a,
    transparent: true,
    opacity: 0.85,
  });
  disposables.push(outlineMat);

  const createMat = (color: number | string, opts?: { transparent?: boolean; opacity?: number }) => {
    const mat = new THREE.MeshLambertMaterial({
      color,
      transparent: opts?.transparent ?? false,
      opacity: opts?.opacity ?? 1.0,
    });
    disposables.push(mat);
    return mat;
  };

  const createBoxGeom = (w: number, h: number, d: number) => {
    const geom = new THREE.BoxGeometry(w, h, d);
    disposables.push(geom);
    return geom;
  };

  /**
   * Helper to create a mesh with dark crisp edge outlines
   */
  const createOutlinedBox = (
    w: number,
    h: number,
    d: number,
    mat: ThreeType.Material,
    skipEdges = false
  ): ThreeType.Mesh => {
    const geom = createBoxGeom(w, h, d);
    const mesh = new THREE.Mesh(geom, mat);
    if (!skipEdges) {
      const edges = new THREE.EdgesGeometry(geom);
      disposables.push(edges);
      const line = new THREE.LineSegments(edges, outlineMat);
      mesh.add(line);
    }
    return mesh;
  };

  // ==========================================
  // 1. DIORAMA BASE & WALLS (Cutaway slab)
  // ==========================================
  // Floor slab: 10.6 x 0.6 x 10.6, top surface at y = 0
  const slabWidth = 10.6;
  const slabDepth = 10.6;
  const slabHeight = 0.55;

  // Slab base / sides (darker diorama slab side)
  const slabBaseMat = createMat(0x475569);
  const slabBase = createOutlinedBox(slabWidth, slabHeight, slabDepth, slabBaseMat);
  slabBase.position.set(0, -slabHeight / 2, 0);
  scene.add(slabBase);

  // Top floor finish: Green carpet
  const carpetMat = createMat(0x7d9d80); // green carpet floor
  const carpet = createOutlinedBox(slabWidth - 0.1, 0.04, slabDepth - 0.1, carpetMat);
  carpet.position.set(0, 0.02, 0);
  scene.add(carpet);

  // Subtle floor tile / walkway accents
  const aisleMat = createMat(0x8fae92);
  const aisle = createOutlinedBox(3.6, 0.05, 7.8, aisleMat);
  aisle.position.set(0, 0.025, 0);
  scene.add(aisle);

  // --- Back-Left Wall: Peach (#fde8d7) with dark baseboard stripe ---
  const wallLeftMat = createMat(0xfde8d7); // Peach wall
  const wallBaseboardMat = createMat(0x1e293b); // Dark slate baseboard stripe
  const wallHeight = 4.0;
  const wallThick = 0.45;

  const wallLeftGroup = new THREE.Group();
  wallLeftGroup.position.set(-slabWidth / 2 + wallThick / 2, 0, 0);

  // Main back-left wall body
  const wallLeft = createOutlinedBox(wallThick, wallHeight, slabDepth, wallLeftMat);
  wallLeft.position.set(0, wallHeight / 2, 0);
  wallLeftGroup.add(wallLeft);

  // Dark baseboard stripe running along floor
  const baseboardLeft = createOutlinedBox(wallThick + 0.02, 0.24, slabDepth, wallBaseboardMat);
  baseboardLeft.position.set(0, 0.12, 0);
  wallLeftGroup.add(baseboardLeft);

  // Wall crown molding stripe at top
  const crownLeft = createOutlinedBox(wallThick + 0.04, 0.15, slabDepth, createMat(0xfed7aa));
  crownLeft.position.set(0, wallHeight - 0.075, 0);
  wallLeftGroup.add(crownLeft);

  scene.add(wallLeftGroup);

  // --- Back-Right Wall: Pale Yellow (#f8f3a6) with dark baseboard stripe ---
  const wallRightMat = createMat(0xf8f3a6); // Pale yellow wall
  const wallRightGroup = new THREE.Group();
  wallRightGroup.position.set(0, 0, -slabDepth / 2 + wallThick / 2);

  const wallRight = createOutlinedBox(slabWidth, wallHeight, wallThick, wallRightMat);
  wallRight.position.set(0, wallHeight / 2, 0);
  wallRightGroup.add(wallRight);

  const baseboardRight = createOutlinedBox(slabWidth, 0.24, wallThick + 0.02, wallBaseboardMat);
  baseboardRight.position.set(0, 0.12, 0);
  wallRightGroup.add(baseboardRight);

  const crownRight = createOutlinedBox(slabWidth, 0.15, wallThick + 0.04, createMat(0xfef08a));
  crownRight.position.set(0, wallHeight - 0.075, 0);
  wallRightGroup.add(crownRight);
  wallRightGroup.add(crownRight);

  scene.add(wallRightGroup);

  // ==========================================
  // 2. WALL FIXTURES: WINDOW & GLASS DOUBLE DOOR
  // ==========================================
  // Window on back-left wall: bright sky with window panes
  const winFrameMat = createMat(0x334155);
  const winGlassMat = createMat(0xbae6fd); // bright sky
  const winGroup = new THREE.Group();
  winGroup.position.set(-slabWidth / 2 + wallThick + 0.02, 2.4, -0.6);

  const winGlass = createOutlinedBox(0.06, 1.9, 2.6, winGlassMat);
  winGroup.add(winGlass);

  // Window mullions (vertical and horizontal frames)
  const winHoriz = createOutlinedBox(0.08, 0.08, 2.6, winFrameMat);
  winGroup.add(winHoriz);
  const winVert = createOutlinedBox(0.08, 1.9, 0.08, winFrameMat);
  winGroup.add(winVert);

  // Window sill
  const winSill = createOutlinedBox(0.2, 0.1, 2.8, createMat(0xf1f5f9));
  winSill.position.set(0.06, -0.98, 0);
  winGroup.add(winSill);

  scene.add(winGroup);

  // Glass double door on back-right wall
  const doorGroup = new THREE.Group();
  doorGroup.position.set(2.8, 0, -slabDepth / 2 + wallThick + 0.02);

  const doorFrameMat = createMat(0x0f172a);
  const doorGlassMat = createMat(0x93c5fd, { transparent: true, opacity: 0.55 });
  const doorWidth = 1.8;
  const doorHeight = 3.1;

  // Frame outer
  const doorFrame = createOutlinedBox(doorWidth, doorHeight, 0.08, doorFrameMat);
  doorFrame.position.set(0, doorHeight / 2, 0);
  doorGroup.add(doorFrame);

  // Glass panels
  const doorGlassLeft = new THREE.Mesh(createBoxGeom(0.78, doorHeight - 0.2, 0.04), doorGlassMat);
  doorGlassLeft.position.set(-0.43, doorHeight / 2, 0);
  doorGroup.add(doorGlassLeft);

  const doorGlassRight = new THREE.Mesh(createBoxGeom(0.78, doorHeight - 0.2, 0.04), doorGlassMat);
  doorGlassRight.position.set(0.43, doorHeight / 2, 0);
  doorGroup.add(doorGlassRight);

  // Silver handles
  const handleMat = createMat(0xe2e8f0);
  const handleLeft = createOutlinedBox(0.04, 0.45, 0.1, handleMat);
  handleLeft.position.set(-0.08, 1.4, 0.04);
  doorGroup.add(handleLeft);

  const handleRight = createOutlinedBox(0.04, 0.45, 0.1, handleMat);
  handleRight.position.set(0.08, 1.4, 0.04);
  doorGroup.add(handleRight);

  scene.add(doorGroup);

  // ==========================================
  // 3. PROJECTOR SCREEN & WHITEBOARD
  // ==========================================
  // Projector screen on back-left wall (wide meeting screen)
  const projGroup = new THREE.Group();
  projGroup.position.set(-slabWidth / 2 + wallThick + 0.02, 2.4, 2.3);

  const projHousing = createOutlinedBox(0.12, 0.14, 2.7, createMat(0x0f172a));
  projHousing.position.set(0, 1.05, 0);
  projGroup.add(projHousing);

  const projScreen = createOutlinedBox(0.05, 1.9, 2.5, createMat(0xf8fafc));
  projGroup.add(projScreen);

  // Chart diagram / slide graphics on the screen
  const slideChartMat = createMat(0x38bdf8);
  const slideBar1 = createOutlinedBox(0.06, 0.45, 0.25, slideChartMat);
  slideBar1.position.set(0.01, -0.3, -0.6);
  projGroup.add(slideBar1);

  const slideBar2 = createOutlinedBox(0.06, 0.75, 0.25, createMat(0x10b981));
  slideBar2.position.set(0.01, -0.15, -0.2);
  projGroup.add(slideBar2);

  const slideBar3 = createOutlinedBox(0.06, 1.1, 0.25, createMat(0xf59e0b));
  slideBar3.position.set(0.01, 0.05, 0.2);
  projGroup.add(slideBar3);

  scene.add(projGroup);

  // Whiteboard with scribbles on back-right wall
  const wbGroup = new THREE.Group();
  wbGroup.position.set(-1.8, 2.2, -slabDepth / 2 + wallThick + 0.03);

  const wbFrame = createOutlinedBox(2.6, 1.6, 0.06, createMat(0x94a3b8));
  wbGroup.add(wbFrame);

  const wbBoard = createOutlinedBox(2.46, 1.46, 0.07, createMat(0xffffff));
  wbGroup.add(wbBoard);

  // Scribble blocks & flow chart sticky notes on whiteboard
  const notePink = createOutlinedBox(0.24, 0.24, 0.08, createMat(0xf472b6));
  notePink.position.set(-0.7, 0.3, 0);
  wbGroup.add(notePink);

  const noteYellow = createOutlinedBox(0.24, 0.24, 0.08, createMat(0xfef08a));
  noteYellow.position.set(-0.35, 0.3, 0);
  wbGroup.add(noteYellow);

  const noteCyan = createOutlinedBox(0.24, 0.24, 0.08, createMat(0x67e8f9));
  noteCyan.position.set(0.0, 0.3, 0);
  wbGroup.add(noteCyan);

  // Marker tray at bottom
  const markerTray = createOutlinedBox(1.6, 0.05, 0.12, createMat(0x475569));
  markerTray.position.set(0, -0.82, 0.04);
  wbGroup.add(markerTray);

  scene.add(wbGroup);

  // ==========================================
  // 4. CENTRAL MEETING TABLE & TABLETOP CLUTTER
  // ==========================================
  // Long table: 4.4 x 0.18 x 2.1 in light birch / blonde oak
  const tableGroup = new THREE.Group();
  const tableMat = createMat(0xd4a373); // blonde oak
  const tableBevelMat = createMat(0xbc8a5f);
  const tableLegMat = createMat(0x1e293b);

  const tableTop = createOutlinedBox(4.4, 0.18, 2.1, tableMat);
  tableTop.position.set(0, 0.95, 0);
  tableGroup.add(tableTop);

  const tableRim = createOutlinedBox(4.36, 0.06, 2.06, tableBevelMat);
  tableRim.position.set(0, 0.86, 0);
  tableGroup.add(tableRim);

  // Heavy steel legs / supports
  const legPositions = [
    [-1.9, 0.44, -0.75],
    [1.9, 0.44, -0.75],
    [-1.9, 0.44, 0.75],
    [1.9, 0.44, 0.75],
  ];
  for (const [lx, ly, lz] of legPositions) {
    const leg = createOutlinedBox(0.2, 0.88, 0.2, tableLegMat);
    leg.position.set(lx!, ly!, lz!);
    tableGroup.add(leg);
  }

  // --- Table Clutter: Laptops, Monitor, Coffee Cups, Paper Stacks ---
  const laptopMat = createMat(0x334155);
  const laptopScreenMat = createMat(0x0284c7);
  const cupMat1 = createMat(0xef4444);
  const cupMat2 = createMat(0x3b82f6);
  const paperMat = createMat(0xf8fafc);

  // Laptop 1 (Owner/West end)
  const lt1Base = createOutlinedBox(0.38, 0.03, 0.26, laptopMat);
  lt1Base.position.set(-1.2, 1.055, -0.45);
  tableGroup.add(lt1Base);
  const lt1Screen = createOutlinedBox(0.38, 0.24, 0.03, laptopScreenMat);
  lt1Screen.position.set(-1.2, 1.18, -0.58);
  lt1Screen.rotation.x = -0.15;
  tableGroup.add(lt1Screen);

  // Laptop 2 (East end)
  const lt2Base = createOutlinedBox(0.38, 0.03, 0.26, laptopMat);
  lt2Base.position.set(1.2, 1.055, 0.45);
  tableGroup.add(lt2Base);
  const lt2Screen = createOutlinedBox(0.38, 0.24, 0.03, laptopScreenMat);
  lt2Screen.position.set(1.2, 1.18, 0.58);
  lt2Screen.rotation.x = 0.15;
  tableGroup.add(lt2Screen);

  // Central Monitor on stand
  const monStand = createOutlinedBox(0.25, 0.02, 0.25, tableLegMat);
  monStand.position.set(0, 1.05, 0);
  tableGroup.add(monStand);
  const monPole = createOutlinedBox(0.06, 0.22, 0.06, tableLegMat);
  monPole.position.set(0, 1.16, 0);
  tableGroup.add(monPole);
  const monScreen = createOutlinedBox(0.65, 0.42, 0.05, createMat(0x0f172a));
  monScreen.position.set(0, 1.34, 0);
  tableGroup.add(monScreen);
  const monDisplay = createOutlinedBox(0.58, 0.36, 0.02, createMat(0x38bdf8));
  monDisplay.position.set(0, 1.34, 0.035);
  tableGroup.add(monDisplay);

  // Coffee cups
  const cup1 = createOutlinedBox(0.1, 0.12, 0.1, cupMat1);
  cup1.position.set(-1.6, 1.1, -0.2);
  tableGroup.add(cup1);

  const cup2 = createOutlinedBox(0.1, 0.12, 0.1, cupMat2);
  cup2.position.set(0.6, 1.1, -0.5);
  tableGroup.add(cup2);

  // Paper sheet stacks
  const papers1 = createOutlinedBox(0.3, 0.03, 0.4, paperMat);
  papers1.position.set(-0.6, 1.055, 0.4);
  papers1.rotation.y = 0.2;
  tableGroup.add(papers1);

  const papers2 = createOutlinedBox(0.3, 0.02, 0.35, paperMat);
  papers2.position.set(1.6, 1.055, -0.3);
  papers2.rotation.y = -0.15;
  tableGroup.add(papers2);

  scene.add(tableGroup);

  // ==========================================
  // 5. BLACK WHEELED OFFICE CHAIRS
  // ==========================================
  // Chair template builder: 5-prong rolling caster base, post, seat cushion, backrest
  const chairMat = createMat(0x18181b); // dark black office mesh
  const casterMat = createMat(0x09090b);
  const chromeMat = createMat(0x94a3b8);

  const createWheeledChair = (x: number, z: number, angle: number): ThreeType.Group => {
    const cg = new THREE.Group();
    cg.position.set(x, 0, z);
    cg.rotation.y = angle;

    // Wheeled 5-star / cross base at floor level
    const starBase1 = createOutlinedBox(0.54, 0.05, 0.1, casterMat);
    starBase1.position.set(0, 0.06, 0);
    cg.add(starBase1);

    const starBase2 = createOutlinedBox(0.1, 0.05, 0.54, casterMat);
    starBase2.position.set(0, 0.06, 0);
    cg.add(starBase2);

    // Wheels / casters
    const wheelGeom = createBoxGeom(0.08, 0.06, 0.08);
    const wLocs = [
      [-0.24, 0.03, 0],
      [0.24, 0.03, 0],
      [0, 0.03, -0.24],
      [0, 0.03, 0.24],
    ];
    for (const [wx, wy, wz] of wLocs) {
      const wh = new THREE.Mesh(wheelGeom, casterMat);
      wh.position.set(wx!, wy!, wz!);
      cg.add(wh);
    }

    // Chrome gas-lift center column
    const column = createOutlinedBox(0.08, 0.34, 0.08, chromeMat);
    column.position.set(0, 0.24, 0);
    cg.add(column);

    // Seat cushion (curved/ergonomic square)
    const seatPad = createOutlinedBox(0.54, 0.1, 0.52, chairMat);
    seatPad.position.set(0, 0.44, 0);
    cg.add(seatPad);

    // Ergonomic high backrest
    const back = createOutlinedBox(0.52, 0.54, 0.08, chairMat);
    back.position.set(0, 0.72, -0.24);
    cg.add(back);

    // Armrests
    const armLeft = createOutlinedBox(0.06, 0.22, 0.32, chairMat);
    armLeft.position.set(-0.28, 0.58, -0.02);
    cg.add(armLeft);

    const armRight = createOutlinedBox(0.06, 0.22, 0.32, chairMat);
    armRight.position.set(0.28, 0.58, -0.02);
    cg.add(armRight);

    return cg;
  };

  // Place 8 chairs at the official table seat coordinates
  const chairSeats = [
    { x: -2.6, z: 0, angle: Math.PI / 2 },
    { x: 2.6, z: 0, angle: -Math.PI / 2 },
    { x: -1.4, z: -1.6, angle: 0 },
    { x: 0, z: -1.6, angle: 0 },
    { x: 1.4, z: -1.6, angle: 0 },
    { x: -1.4, z: 1.6, angle: Math.PI },
    { x: 0, z: 1.6, angle: Math.PI },
    { x: 1.4, z: 1.6, angle: Math.PI },
  ];
  for (const s of chairSeats) {
    scene.add(createWheeledChair(s.x, s.z, s.angle));
  }

  // ==========================================
  // 6. WORKSTATION DESKS & CRT / PC TOWERS & CABLES
  // ==========================================
  const deskLocations = [
    { x: -3.6, z: -2.5, angle: 0 },
    { x: -3.6, z: 2.5, angle: 0 },
    { x: 3.6, z: -2.5, angle: 0 },
  ];
  const deskWoodMat = createMat(0xd4a373);
  const pcTowerMat = createMat(0x1e293b);
  const crtMat = createMat(0xf1f5f9);
  const crtGlowMat = createMat(0x38bdf8);
  const cableMat = createMat(0x09090b);

  for (const dl of deskLocations) {
    const dg = new THREE.Group();
    dg.position.set(dl.x, 0, dl.z);

    // Desk top and side panels
    const deskMesh = createOutlinedBox(1.5, 0.88, 0.9, deskWoodMat);
    deskMesh.position.set(0, 0.44, 0);
    dg.add(deskMesh);

    // CRT Monitor
    const crtBody = createOutlinedBox(0.48, 0.42, 0.42, crtMat);
    crtBody.position.set(0, 1.1, 0);
    dg.add(crtBody);

    const crtScreen = createOutlinedBox(0.4, 0.34, 0.04, crtGlowMat);
    crtScreen.position.set(0, 1.1, 0.22);
    dg.add(crtScreen);

    // Keyboard
    const kb = createOutlinedBox(0.4, 0.03, 0.16, crtMat);
    kb.position.set(0, 0.895, 0.3);
    dg.add(kb);

    // PC Tower on floor beside desk
    const tower = createOutlinedBox(0.24, 0.54, 0.48, pcTowerMat);
    tower.position.set(-0.65, 0.27, 0);
    dg.add(tower);

    // Black cables on floor behind desk
    const cable = createOutlinedBox(1.2, 0.02, 0.04, cableMat);
    cable.position.set(0, 0.01, -0.38);
    dg.add(cable);

    scene.add(dg);
  }

  // ==========================================
  // 7. FILING CABINET, BINS, CARDBOARD BOX, BAGS
  // ==========================================
  // Tall filing cabinet against back-left wall
  const cabinetMat = createMat(0x475569);
  const cabinet = createOutlinedBox(1.1, 2.3, 0.7, cabinetMat);
  cabinet.position.set(-4.5, 1.15, -4.2);
  scene.add(cabinet);

  // Drawer lines & silver handles on cabinet
  for (let i = 0; i < 3; i++) {
    const handle = createOutlinedBox(0.2, 0.04, 0.05, createMat(0xe2e8f0));
    handle.position.set(-4.5, 0.6 + i * 0.65, -3.82);
    scene.add(handle);
  }

  // Cardboard box with packing tape stripe
  const boxMat = createMat(0xb45309);
  const tapeMat = createMat(0xfef08a);
  const cardBox = createOutlinedBox(0.65, 0.55, 0.65, boxMat);
  cardBox.position.set(-3.7, 0.275, -4.3);
  cardBox.rotation.y = 0.25;
  scene.add(cardBox);

  const tape = createOutlinedBox(0.66, 0.08, 0.66, tapeMat);
  tape.position.set(-3.7, 0.52, -4.3);
  tape.rotation.y = 0.25;
  scene.add(tape);

  // Wastebasket / recycling bins (two bins as specified)
  const binMat1 = createMat(0x0f172a); // dark bin
  const bin1 = createOutlinedBox(0.35, 0.48, 0.35, binMat1);
  bin1.position.set(-2.5, 0.24, -2.6);
  scene.add(bin1);

  const binMat2 = createMat(0x2563eb); // blue recycling bin
  const bin2 = createOutlinedBox(0.35, 0.48, 0.35, binMat2);
  bin2.position.set(4.4, 0.24, 2.3);
  scene.add(bin2);

  // Backpack leaning against desk leg
  const backpackMat = createMat(0x0369a1);
  const backpack = createOutlinedBox(0.35, 0.46, 0.28, backpackMat);
  backpack.position.set(-2.7, 0.23, -2.1);
  backpack.rotation.z = 0.15;
  scene.add(backpack);

  // Tall tote / laptop bag near meeting table
  const toteMat = createMat(0x9a3412);
  const tote = createOutlinedBox(0.18, 0.52, 0.38, toteMat);
  tote.position.set(-2.2, 0.26, 0.9);
  tote.rotation.y = 0.3;
  scene.add(tote);

  // ==========================================
  // 8. COFFEE SPOT & COUNTER
  // ==========================================
  const coffeeGroup = new THREE.Group();
  coffeeGroup.position.set(4.2, 0, 3.8);

  const coffeeCounterMat = createMat(0xf1f5f9); // bright counter
  const counterBase = createOutlinedBox(1.3, 1.05, 1.5, coffeeCounterMat);
  counterBase.position.set(0, 0.525, 0);
  coffeeGroup.add(counterBase);

  // Countertop top surface
  const counterTop = createOutlinedBox(1.36, 0.08, 1.56, createMat(0x1e293b));
  counterTop.position.set(0, 1.08, 0);
  coffeeGroup.add(counterTop);

  // Coffee maker machine
  const makerBase = createOutlinedBox(0.42, 0.5, 0.42, createMat(0x09090b));
  makerBase.position.set(0, 1.34, 0);
  coffeeGroup.add(makerBase);

  // Glass coffee pot with brew
  const potGlass = createOutlinedBox(0.28, 0.28, 0.28, createMat(0x78350f));
  potGlass.position.set(0, 1.25, 0.12);
  coffeeGroup.add(potGlass);

  // Stack of clean ceramic mugs on counter
  const mug1 = createOutlinedBox(0.12, 0.12, 0.12, createMat(0xfbbf24));
  mug1.position.set(-0.4, 1.18, 0.2);
  coffeeGroup.add(mug1);

  const mug2 = createOutlinedBox(0.12, 0.12, 0.12, createMat(0xf87171));
  mug2.position.set(-0.4, 1.18, -0.15);
  coffeeGroup.add(mug2);

  scene.add(coffeeGroup);

  // ==========================================
  // 9. POTTED PLANTS (Foliage & terracotta pots)
  // ==========================================
  const potMat = createMat(0xea580c); // terracotta
  const leafMatDark = createMat(0x166534); // rich green
  const leafMatLight = createMat(0x22c55e); // bright green

  const plantLocs = [
    { x: 4.2, z: -4.2 },
    { x: -4.2, z: 4.2 },
  ];
  for (const pl of plantLocs) {
    const pg = new THREE.Group();
    pg.position.set(pl.x, 0, pl.z);

    const pot = createOutlinedBox(0.7, 0.75, 0.7, potMat);
    pot.position.set(0, 0.375, 0);
    pg.add(pot);

    const mainBush = createOutlinedBox(0.85, 0.95, 0.85, leafMatDark);
    mainBush.position.set(0, 1.1, 0);
    pg.add(mainBush);

    const topBush = createOutlinedBox(0.65, 0.65, 0.65, leafMatLight);
    topBush.position.set(0, 1.6, 0);
    pg.add(topBush);

    scene.add(pg);
  }
}
