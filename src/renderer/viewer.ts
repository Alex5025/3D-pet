import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';

/**
 * VRM 檢視核心 —— 逐行對照 pixiv/three-vrm 官方範例,不自創:
 *   - 相機 / 燈光 / 迴圈 / 載入流程 = examples/basic.html
 *   - 任意 VRM 檔即時替換(buffer 解析 + deepDispose 舊模型)= examples/dnd.html
 * overlay(桌面透明疊層)與 vrmtest(瀏覽器驗證頁)共用這一份,保證看到的是同一套渲染。
 */
export interface Viewer {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  currentVrm: () => VRM | null;
  /** 使用者位移/旋轉要套在這個容器上 —— vrm.scene 的 transform 屬於 loader
   *  (rotateVRM0 的轉正寫在那上面),直接覆寫會讓 VRM0 模型背對鏡頭。 */
  root: THREE.Group;
  loadFromUrl: (url: string) => Promise<VRM>;
  loadFromBuffer: (buf: ArrayBuffer) => Promise<VRM>;
  /** 視線跟隨:把注視點設到某個螢幕像素(官方 lookat.html 的公式) */
  setLookAt: (px: number, py: number) => void;
  /** 即時調整燈光(設定面板用);缺的欄位維持現值 */
  setLighting: (l: Partial<Lighting>) => void;
  /** 即時調整晃動強度(頭髮/衣服/胸部各自 0..2) */
  setSway: (s: Partial<Sway>) => void;
  /** 拍一張目前角色的小照片(透明背景 PNG dataURL)。side=true 從側面拍(臉朝右) */
  snapshot: (side: boolean) => string;
  /** 像素級命中探針:設定要檢測的螢幕座標(CSS px),負值 = 關閉 */
  setHitProbe: (x: number, y: number) => void;
  /** 上一幀探針位置的 alpha 是否非透明(= 游標壓在看得到的角色上) */
  isHit: () => boolean;
  /** 診斷:下一幀掃描整個畫面的 alpha,把「實際有像素的區域」印進 console */
  requestAlphaScan: () => void;
  /** 診斷:同步渲染一幀並讀某 CSS 座標的 alpha(不經探針,不受游標輪詢干擾) */
  alphaAt: (x: number, y: number) => number;
}

export interface Lighting {
  ambient: number; // 環境光強度
  directional: number; // 方向光強度
  x: number; // 光源位置(公尺,原點=角色腳邊);方向光的方向 = 位置 → 原點
  y: number;
  z: number; // +Z = 螢幕這側
  shade: number; // 陰影濃度 0..1:把 MToon 陰影色調暗的比例(0 = 模型原設定)
}

/** 晃動強度(0..2,1 = 模型原廠):依 spring 骨骼名稱分類各自控制 */
export interface Sway {
  hair: number; // 頭髮
  cloth: number; // 衣服(裙襬/袖/緞帶等)
  chest: number; // 胸部
  tail: number; // 尾巴(獸耳角色等;模型沒有尾巴骨骼時此項無作用)
}

export const DEFAULT_SWAY: Sway = { hair: 1, cloth: 1, chest: 1, tail: 1 };

export const DEFAULT_LIGHTING: Lighting = {
  ambient: Math.PI * 0.8,
  directional: Math.PI * 0.5,
  x: 0,
  y: 1,
  z: 2,
  shade: 0.35
};

export function createViewer(opts: { transparent: boolean; background?: number }): Viewer {
  // renderer —— official basic.html(僅加透明背景參數,桌面疊層需要)
  const renderer = new THREE.WebGLRenderer({ alpha: opts.transparent, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  if (opts.transparent) renderer.setClearAlpha(0);
  document.body.appendChild(renderer.domElement);

  // camera —— official basic.html
  const camera = new THREE.PerspectiveCamera(30.0, window.innerWidth / window.innerHeight, 0.1, 20.0);
  camera.position.set(0.0, 1.0, 5.0);
  camera.lookAt(0.0, 1.0, 0.0);

  // scene
  const scene = new THREE.Scene();
  if (!opts.transparent && opts.background != null) scene.background = new THREE.Color(opts.background);

  // light —— 「強環境光墊底 + 螢幕方向光給動態」(驗證頁實測的預設 0.8π / 0.5π):
  //  - 環境光把所有表面(含衣服配飾)墊到不會出現暗面 → 任何旋轉角度都亮
  //  - 方向光從觀看者方向(+Z)打,讓明暗漸層/光澤隨旋轉流動,角色不會死板
  //  - 純環境光試過:均勻但光澤完全靜止;純方向光試過:側面必進 MToon 陰影色
  // 注意:VRoid 髮絲的天使環高光有一部分畫死在貼圖上,那部分不隨旋轉移動。
  // 數值可由設定面板即時調整(setLighting),預設 = DEFAULT_LIGHTING。
  const ambientLight = new THREE.AmbientLight(0xffffff, DEFAULT_LIGHTING.ambient);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, DEFAULT_LIGHTING.directional);
  scene.add(dirLight);
  scene.add(dirLight.target); // target 要在場景裡,matrixWorld 才會更新

  let vrm: VRM | null = null; // 提前宣告:下面的 applyShade 會在載入前就被呼叫
  const lighting: Lighting = { ...DEFAULT_LIGHTING };

  /* 陰影濃度:VRoid 系模型的材質常把方向陰影整個關死(實測解剖過,非程式問題):
   *   1) 陰影色 = 受光色(純白)→ 就算進入陰影,顏色也一樣
   *   2) shadingShift = 1 → 任何角度都判定為「受光」,陰影計算根本不會發生
   * 所以這個滑桿拉兩個槓桿(都是 uniform,免重編,原始值存 userData 可還原):
   *   - 陰影色依比例調暗
   *   - shadingShift 從原值往 -0.1 內插(把被關死的陰影重新打開)
   * 0 = 完全尊重模型原設定。 */
  function applyShade(): void {
    if (!vrm) return;
    vrm.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats as Array<
        THREE.Material & {
          isOutline?: boolean;
          shadeColorFactor?: THREE.Color;
          shadingShiftFactor?: number;
          shadingToonyFactor?: number;
        }
      >) {
        if (m.isOutline || !m.shadeColorFactor) continue;
        const ud = m.userData;
        if (!ud['origShade']) {
          ud['origShade'] = m.shadeColorFactor.clone();
          ud['origShift'] = m.shadingShiftFactor ?? 0;
          ud['origToony'] = m.shadingToonyFactor ?? 0.9;
        }
        const shift = ud['origShift'] as number;
        const toony = ud['origToony'] as number;
        const s = lighting.shade;
        if (/skin/i.test(m.name)) {
          // 皮膚完全豁免:VRoid 刻意把皮膚做成平光(陰影色=受光色),保證臉/手/腳
          // 在任何光線下同色 —— 對皮膚施加任何角度陰影,不同朝向的部位必然色差
          // (臉朝前、腿朝下),調參數只是換一種岔法。立體感交給衣服和頭髮。
          m.shadeColorFactor.copy(ud['origShade'] as THREE.Color);
          m.shadingShiftFactor = shift;
          m.shadingToonyFactor = toony;
        } else {
          m.shadeColorFactor.copy(ud['origShade'] as THREE.Color).multiplyScalar(1 - s);
          // shift 往 -0.1 拉:重新打開被 shift=1 關死的陰影計算
          m.shadingShiftFactor = shift + (-0.1 - shift) * s;
          // toony 往 0.5 拉:VRoid 常設 toony=1(硬邊、擠在極端角度,正面幾乎看不見),
          // 柔化後明暗漸層才會在身體/衣服上鋪開 —— 沒有這步就是「只有臉會跟光」。
          m.shadingToonyFactor = toony + (0.5 - toony) * s;
        }
      }
    });
  }

  /** 燈光錨定:方向光以「角色」為參考座標系(位置 = 角色 + 偏移,方向指向角色)。
   *  animate 每幀呼叫(角色被拖曳時跟著走);setLighting 也立即呼叫一次,
   *  避免 rAF 被節流(背景分頁)時位置停在舊值。 */
  function anchorLight(): void {
    dirLight.position.set(
      root.position.x + lighting.x,
      root.position.y + lighting.y,
      root.position.z + lighting.z
    );
    if (lighting.x === 0 && lighting.y === 0 && lighting.z === 0) dirLight.position.z += 1; // 偏移=0 時方向未定義
    dirLight.target.position.copy(root.position);
  }

  /* 晃動強度:縮放 spring bone 物理,依骨骼名稱分類(頭髮/胸部/其餘=衣服)各自控制。
   * 1 = 原廠;<1 加大阻尼、加硬 → 不太晃;>1 變軟 → 更飄。原始值存在 joint 上可還原。 */
  const sway: Sway = { ...DEFAULT_SWAY };

  function swayCategory(boneName: string): keyof Sway {
    if (/hair/i.test(boneName)) return 'hair';
    if (/bust|breast|chest|oppai/i.test(boneName)) return 'chest';
    if (/(?<!pony)tail|shippo/i.test(boneName)) return 'tail'; // ponytail 馬尾是頭髮,排除
    return 'cloth';
  }

  function applySway(): void {
    const joints = vrm?.springBoneManager?.joints;
    if (!joints) return;
    for (const j of joints) {
      const jj = j as typeof j & { _orig?: { stiffness: number; dragForce: number } };
      if (!jj._orig) jj._orig = { stiffness: j.settings.stiffness, dragForce: j.settings.dragForce };
      const s = Math.max(0, sway[swayCategory(j.bone.name)]);
      j.settings.stiffness = jj._orig.stiffness * (s < 0.05 ? 50 : 1 / s);
      j.settings.dragForce = Math.min(1, Math.max(0, jj._orig.dragForce + (1 - s) * 0.4));
    }
  }

  function setSway(s: Partial<Sway>): void {
    Object.assign(sway, s);
    applySway();
  }

  function setLighting(l: Partial<Lighting>): void {
    Object.assign(lighting, l);
    ambientLight.intensity = lighting.ambient;
    dirLight.intensity = lighting.directional;
    anchorLight();
    applyShade();
  }

  // 使用者位移/旋轉的容器;vrm.scene 的 transform 保留給 loader
  const root = new THREE.Group();
  scene.add(root);

  // lookat —— official lookat.html:注視目標掛在 camera 底下
  const lookAtTarget = new THREE.Object3D();
  camera.add(lookAtTarget);
  scene.add(camera); // camera 有子物件時要在場景裡,lookAtTarget 的世界座標才會更新

  // 視線公式照 official lookat.html,但「正視基準點」改成角色眼睛的螢幕投影:
  // 官方假設角色站在畫面中央;我們的角色會被拖到任何位置,
  // 游標指著她的眼睛時應該是「直視你」(偏移 0),偏離眼睛才轉視線。
  const _eyeWorld = new THREE.Vector3();
  function setLookAt(px: number, py: number): void {
    let cx = 0.5 * window.innerWidth;
    let cy = 0.5 * window.innerHeight;
    const h = vrm?.humanoid;
    const eyeBone =
      h?.getNormalizedBoneNode('leftEye') ?? h?.getNormalizedBoneNode('head');
    if (eyeBone) {
      eyeBone.getWorldPosition(_eyeWorld).project(camera);
      cx = (_eyeWorld.x * 0.5 + 0.5) * window.innerWidth;
      cy = (-_eyeWorld.y * 0.5 + 0.5) * window.innerHeight;
    }
    lookAtTarget.position.x = 10.0 * ((px - cx) / window.innerHeight);
    lookAtTarget.position.y = -10.0 * ((py - cy) / window.innerHeight);
  }

  // gltf and vrm —— official basic.html
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  function onLoaded(gltf: { userData: { vrm?: VRM }; scene: THREE.Group }): VRM {
    const next = gltf.userData.vrm as VRM;

    // official 範例的載入後優化與朝向校正
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.combineMorphs(next);
    VRMUtils.rotateVRM0(next); // VRM0 校正為面朝 +Z(相機那側)

    // 官方 dnd.html:換模型前把舊的整個 dispose
    if (vrm) {
      root.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
    }
    vrm = next;
    root.add(vrm.scene); // 原尺寸,不縮放;掛在 root 下,使用者 transform 動 root
    // SkinnedMesh 的 geometry 邊界(bind pose + morph 撐爆)不可靠,
    // three 會據此誤剔除整隻模型 → 關掉逐物件剔除(單一角色,成本可忽略)
    vrm.scene.traverse((o) => (o.frustumCulled = false));
    if (vrm.lookAt) vrm.lookAt.target = lookAtTarget; // official lookat.html
    applyShade(); // 換模型後套用目前的陰影濃度
    applySway(); // 換模型後套用目前的晃動強度
    console.log('[viewer] vrm loaded');
    return vrm;
  }

  function loadFromUrl(url: string): Promise<VRM> {
    return new Promise((res, rej) =>
      loader.load(url, (g) => res(onLoaded(g)), undefined, rej)
    );
  }

  // 官方 dnd.html 的替換路徑:拿到檔案內容(ArrayBuffer)直接 parse
  function loadFromBuffer(buf: ArrayBuffer): Promise<VRM> {
    return new Promise((res, rej) => loader.parse(buf, '', (g) => res(onLoaded(g)), rej));
  }

  /* 像素級命中探針:hover 判定要「與看得到的完全一致」——透明處必須穿透。
   * 包圍盒(T-pose 臂展寬)會把角色四周的透明角落誤判成可互動(實際發生過)。
   * 做法:每幀渲染完,在同一個 task 內 readPixels 讀游標那 1 個像素的 alpha。 */
  const probe = { x: -1, y: -1 };
  let probeHit = false;
  let scanRequested = false;
  const _probePix = new Uint8Array(4);
  function setHitProbe(x: number, y: number): void {
    probe.x = x;
    probe.y = y;
  }
  function isHit(): boolean {
    return probeHit;
  }

  // animate —— official basic.html + 燈光錨定 + 命中探針
  const clock = new THREE.Clock();
  function animate(): void {
    requestAnimationFrame(animate);
    anchorLight(); // 拖曳角色時光跟著走(平移不變);旋轉仍會改變受光面
    if (vrm) vrm.update(clock.getDelta());
    renderer.render(scene, camera);

    if (probe.x >= 0) {
      const gl = renderer.getContext();
      const dpr = renderer.getPixelRatio();
      const px = Math.round(probe.x * dpr);
      const py = Math.round(renderer.domElement.height - probe.y * dpr);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _probePix);
      probeHit = _probePix[3] > 16; // alpha 門檻:髮絲半透明邊緣也算命中
    } else {
      probeHit = false;
    }

    if (scanRequested) {
      scanRequested = false;
      const gl = renderer.getContext();
      const W = renderer.domElement.width;
      const H = renderer.domElement.height;
      const dpr = renderer.getPixelRatio();
      const b = new Uint8Array(4);
      let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, count = 0;
      for (let gy = 0; gy < H; gy += 24) {
        for (let gx = 0; gx < W; gx += 24) {
          gl.readPixels(gx, gy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
          if (b[3] > 16) {
            count++;
            if (gx < minX) minX = gx;
            if (gx > maxX) maxX = gx;
            if (gy < minY) minY = gy;
            if (gy > maxY) maxY = gy;
          }
        }
      }
      // 回報成 CSS px、y 從頂部算(和 probe 的輸入座標同一座標系)
      console.log(
        count === 0
          ? '[viewer] alphaScan: 整個畫面沒有任何非透明像素(角色沒被渲染!)'
          : `[viewer] alphaScan: 角色像素範圍 x=${Math.round(minX / dpr)}..${Math.round(maxX / dpr)} ` +
            `y=${Math.round((H - maxY) / dpr)}..${Math.round((H - minY) / dpr)} (CSS px, 取樣點 ${count})`
      );
    }
  }
  animate();

  function requestAlphaScan(): void {
    scanRequested = true;
  }

  function alphaAt(x: number, y: number): number {
    renderer.render(scene, camera); // readPixels 只在同一個 task 的 render 後有效
    const gl = renderer.getContext();
    const dpr = renderer.getPixelRatio();
    gl.readPixels(
      Math.round(x * dpr),
      Math.round(renderer.domElement.height - y * dpr),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _probePix
    );
    return _probePix[3];
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /** 設定面板的原點小人用:以角色為中心拍正面/側面小圖(側面 = 從 -X 拍,臉朝畫面右)。
   *  ⚠️ 一定要用「主渲染器 + 離屏 RenderTarget」拍——另開第二個 WebGLRenderer 會與
   *  主 context 共用材質並污染著色狀態(實測:拍完後 body 不再回應光的方向)。 */
  const SNAP_W = 120;
  const SNAP_H = 160;
  function snapshot(side: boolean): string {
    const cam = new THREE.PerspectiveCamera(25, SNAP_W / SNAP_H, 0.1, 20);
    const p = root.position;
    if (side) cam.position.set(p.x - 3.9, p.y + 0.85, p.z);
    else cam.position.set(p.x, p.y + 0.85, p.z + 3.9);
    cam.lookAt(p.x, p.y + 0.85, p.z);

    // 用標準亮光拍(拍完還原):面板小人的亮度不該被使用者當下的燈光設定綁架
    // (環境光調到 0 的話,拍出來會是黑剪影)
    const keepAmbient = ambientLight.intensity;
    const keepDir = dirLight.intensity;
    ambientLight.intensity = Math.PI;
    dirLight.intensity = 0;

    const rt = new THREE.WebGLRenderTarget(SNAP_W, SNAP_H);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);

    ambientLight.intensity = keepAmbient;
    dirLight.intensity = keepDir;
    const buf = new Uint8Array(SNAP_W * SNAP_H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, SNAP_W, SNAP_H, buf);
    renderer.setRenderTarget(prev);
    rt.dispose();

    // GPU 讀回來的像素是上下顛倒的,翻回來畫進 2D canvas 再輸出 PNG
    const cv = document.createElement('canvas');
    cv.width = SNAP_W;
    cv.height = SNAP_H;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(SNAP_W, SNAP_H);
    for (let y = 0; y < SNAP_H; y++) {
      img.data.set(buf.subarray((SNAP_H - 1 - y) * SNAP_W * 4, (SNAP_H - y) * SNAP_W * 4), y * SNAP_W * 4);
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }

  return { scene, camera, renderer, currentVrm: () => vrm, root, loadFromUrl, loadFromBuffer, setLookAt, setLighting, setSway, snapshot, setHitProbe, isHit, requestAlphaScan, alphaAt };
}
