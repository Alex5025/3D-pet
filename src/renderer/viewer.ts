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
  loadFromUrl: (url: string) => Promise<VRM>;
  loadFromBuffer: (buf: ArrayBuffer) => Promise<VRM>;
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

  // light —— official basic.html(一盞,不多加)
  const light = new THREE.DirectionalLight(0xffffff, Math.PI);
  light.position.set(1.0, 1.0, 1.0).normalize();
  scene.add(light);

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
      scene.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
    }
    vrm = next;
    scene.add(vrm.scene); // 原尺寸,不縮放、不動任何材質
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

  return { scene, camera, renderer, currentVrm: () => vrm, loadFromUrl, loadFromBuffer };
}
