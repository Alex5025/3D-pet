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
}

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

  // light —— 「任何旋轉角度朝向使用者的面都不出現暗塊」:
  //  - 方向光從觀看者方向(+Z)打,官方的固定世界方向會讓旋轉後的臉進陰影
  //  - 側面(法線與光垂直)單靠方向光仍會掉進 MToon 陰影色 → 補環境光抬起來
  //  - 0.6π + 0.6π 是在驗證頁實測的組合:側面臉乾淨、正面不過曝
  const light = new THREE.DirectionalLight(0xffffff, Math.PI * 0.6);
  light.position.set(0.0, 0.0, 1.0).normalize();
  scene.add(light);
  scene.add(new THREE.AmbientLight(0xffffff, Math.PI * 0.6));

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
  let vrm: VRM | null = null;
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
    root.add(vrm.scene); // 原尺寸,不縮放、不動任何材質;掛在 root 下,使用者 transform 動 root
    if (vrm.lookAt) vrm.lookAt.target = lookAtTarget; // official lookat.html
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

  // animate —— official basic.html
  const clock = new THREE.Clock();
  function animate(): void {
    requestAnimationFrame(animate);
    if (vrm) vrm.update(clock.getDelta());
    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { scene, camera, renderer, currentVrm: () => vrm, root, loadFromUrl, loadFromBuffer, setLookAt };
}
