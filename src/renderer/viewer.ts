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
}

export interface Lighting {
  ambient: number; // 環境光強度
  directional: number; // 方向光強度
  x: number; // 光源位置(公尺,原點=角色腳邊);方向光的方向 = 位置 → 原點
  y: number;
  z: number; // +Z = 螢幕這側
  shade: number; // 陰影濃度 0..1:把 MToon 陰影色調暗的比例(0 = 模型原設定)
}

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
        THREE.Material & { isOutline?: boolean; shadeColorFactor?: THREE.Color; shadingShiftFactor?: number }
      >) {
        if (m.isOutline || !m.shadeColorFactor) continue;
        const ud = m.userData;
        if (!ud['origShade']) {
          ud['origShade'] = m.shadeColorFactor.clone();
          ud['origShift'] = m.shadingShiftFactor ?? 0;
        }
        m.shadeColorFactor.copy(ud['origShade'] as THREE.Color).multiplyScalar(1 - lighting.shade);
        const orig = ud['origShift'] as number;
        m.shadingShiftFactor = orig + (-0.1 - orig) * lighting.shade;
      }
    });
  }

  function setLighting(l: Partial<Lighting>): void {
    Object.assign(lighting, l);
    ambientLight.intensity = lighting.ambient;
    dirLight.intensity = lighting.directional;
    applyShade();
    // 光源「位置」不在這裡設:燈的座標系以角色為原點(見 animate 內的錨定),
    // 拖動角色時光與角色的相對關係不變。
  }
  setLighting({});

  // 使用者位移/旋轉的容器;vrm.scene 的 transform 保留給 loader
  const root = new THREE.Group();
  scene.add(root);

  // lookat —— official lookat.html:注視目標掛在 camera 底下
  const lookAtTarget = new THREE.Object3D();
  camera.add(lookAtTarget);
  scene.add(camera); // camera 有子物件時要在場景裡,lookAtTarget 的世界座標才會更新

  // official lookat.html 的 mousemove 公式,原樣照抄
  function setLookAt(px: number, py: number): void {
    lookAtTarget.position.x = 10.0 * ((px - 0.5 * window.innerWidth) / window.innerHeight);
    lookAtTarget.position.y = -10.0 * ((py - 0.5 * window.innerHeight) / window.innerHeight);
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
    if (vrm.lookAt) vrm.lookAt.target = lookAtTarget; // official lookat.html
    applyShade(); // 換模型後套用目前的陰影濃度
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

  // animate —— official basic.html + 燈光錨定
  const clock = new THREE.Clock();
  function animate(): void {
    requestAnimationFrame(animate);

    // 方向光以「角色」為參考座標系:位置 = 角色位置 + 面板偏移,方向恆指向角色。
    // 拖動角色 → 光跟著走,打光完全不變;旋轉角色 → 受光面照樣流動(燈不隨旋轉)。
    dirLight.position.set(
      root.position.x + lighting.x,
      root.position.y + lighting.y,
      root.position.z + lighting.z
    );
    if (lighting.x === 0 && lighting.y === 0 && lighting.z === 0) dirLight.position.z += 1; // 偏移=0 時方向未定義
    dirLight.target.position.copy(root.position);

    if (vrm) vrm.update(clock.getDelta());
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, currentVrm: () => vrm, root, loadFromUrl, loadFromBuffer, setLookAt, setLighting };
}
