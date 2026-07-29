import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  type VRMAnimation
} from '@pixiv/three-vrm-animation';
import { perf } from './perf';

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
  /** 使用稍微落後角色的物理中心，讓拖曳整隻角色時產生受控的慣性晃動。 */
  enableRootMotionSway: () => void;
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
  /** 診斷:同步渲染一幀,讀多個 CSS 座標的 alpha 取最大(一次重繪讀多點,省重複渲染) */
  alphaMax: (pts: Array<[number, number]>) => number;
  /** 喚醒渲染:外部狀態變更(拖曳/縮放/面板改位置)時呼叫,恢復全速;idle 會自動節流省電 */
  wake: () => void;
  /** 切換情緒表情(官方 expressionManager,VRM 標準 preset:happy/angry/sad/relaxed/surprised;neutral=清除) */
  setExpression: (name: string) => void;
  /** 播放 VRMA 動作(官方 three-vrm-animation);播一次,播完停在最後一幀,不循環 */
  playVRMA: (buf: ArrayBuffer) => Promise<void>;
  /** 停止動作,回到靜止姿勢 */
  stopVRMA: () => void;
  /** 移除這隻寵物的 WebGL 畫布、模型與動畫資源。 */
  dispose: () => void;
}

export interface Lighting {
  type: 'directional' | 'point'; // 平行光(太陽,只看方向) / 點光源(燈泡,遠近有感)
  ambient: number; // 環境光強度
  directional: number; // 主光強度(兩種類型共用這個值)
  x: number; // 光源位置(公尺,原點=角色腳邊);平行光取方向,點光源整個位置都生效
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
  type: 'directional',
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
  // 點光源:distance 0 = 不截斷;decay 1(線性衰減)比物理的平方衰減好調,
  // 「遠近影響亮度與陰影分布」的手感仍然真實
  const pointLight = new THREE.PointLight(0xffffff, 0, 0, 1);
  scene.add(pointLight);

  let vrm: VRM | null = null; // 提前宣告:下面的 applyShade 會在載入前就被呼叫
  let disposed = false;
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
    pointLight.position.copy(dirLight.position); // 點光源同一個錨定位置(遠近真實生效)
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
    wake();
  }

  function enableRootMotionSway(): void {
    const manager = vrm?.springBoneManager;
    if (!manager) return;
    // VRM 常把 hips/root 設為 center；角色與 center 一起平移時，Verlet 看不到位移。
    // 改用獨立中心並讓它略微落後 root，既能產生拖曳慣性，也避免直接切成 world-space
    // 時短髮絲骨骼因一次較大的滑鼠位移而翻轉。切換座標系後必須 reset。
    root.updateWorldMatrix(true, true);
    root.getWorldPosition(rootMotionPosition);
    root.getWorldQuaternion(rootMotionQuaternion);
    root.getWorldScale(rootMotionScale);
    rootMotionCenter.position.copy(rootMotionPosition);
    rootMotionCenter.quaternion.copy(rootMotionQuaternion);
    rootMotionCenter.scale.copy(rootMotionScale);
    rootMotionCenter.updateMatrixWorld(true);
    for (const joint of manager.joints) joint.center = rootMotionCenter;
    manager.reset();
    rootMotionSwayEnabled = true;
    wake();
  }

  function setLighting(l: Partial<Lighting>): void {
    const prevShade = lighting.shade;
    Object.assign(lighting, l);
    ambientLight.intensity = lighting.ambient;
    const isPoint = lighting.type === 'point';
    dirLight.intensity = isPoint ? 0 : lighting.directional;
    pointLight.intensity = isPoint ? lighting.directional : 0;
    anchorLight();
    if (lighting.shade !== prevShade) applyShade(); // 只調亮度/位置時不必整棵材質樹重走
    wake();
  }

  // 使用者位移/旋轉的容器;vrm.scene 的 transform 保留給 loader
  const root = new THREE.Group();
  scene.add(root);

  // Spring Bone 專用的世界座標中心。每幀跟隨 94%，保留小幅位移作為慣性輸入；
  // 最大落後距離另有限制，避免快速拖曳或設定面板瞬移讓骨骼彈飛。
  const rootMotionCenter = new THREE.Object3D();
  const rootMotionPosition = new THREE.Vector3();
  const rootMotionQuaternion = new THREE.Quaternion();
  const rootMotionScale = new THREE.Vector3();
  const rootMotionLag = new THREE.Vector3();
  const ROOT_MOTION_FOLLOW = 0.94;
  const MAX_ROOT_MOTION_LAG = 0.012;
  const MAX_ROOT_ROTATION_LAG = 0.05;
  let rootMotionSwayEnabled = false;
  scene.add(rootMotionCenter);

  function updateRootMotionCenter(): void {
    if (!rootMotionSwayEnabled) return;
    root.updateWorldMatrix(true, false);
    root.getWorldPosition(rootMotionPosition);
    root.getWorldQuaternion(rootMotionQuaternion);
    root.getWorldScale(rootMotionScale);
    rootMotionCenter.position.lerp(rootMotionPosition, ROOT_MOTION_FOLLOW);
    rootMotionLag.subVectors(rootMotionPosition, rootMotionCenter.position);
    if (rootMotionLag.lengthSq() > MAX_ROOT_MOTION_LAG ** 2) {
      rootMotionCenter.position
        .copy(rootMotionPosition)
        .addScaledVector(rootMotionLag.normalize(), -MAX_ROOT_MOTION_LAG);
    }
    rootMotionCenter.quaternion.slerp(rootMotionQuaternion, ROOT_MOTION_FOLLOW);
    const rotationLag = rootMotionCenter.quaternion.angleTo(rootMotionQuaternion);
    if (rotationLag > MAX_ROOT_ROTATION_LAG) {
      rootMotionCenter.quaternion.slerp(
        rootMotionQuaternion,
        1 - MAX_ROOT_ROTATION_LAG / rotationLag,
      );
    }
    rootMotionCenter.scale.copy(rootMotionScale);
    rootMotionCenter.updateMatrixWorld(true);
  }

  // lookat —— official lookat.html:注視目標掛在 camera 底下
  const lookAtTarget = new THREE.Object3D();
  camera.add(lookAtTarget);
  scene.add(camera); // camera 有子物件時要在場景裡,lookAtTarget 的世界座標才會更新

  // 視線公式照 official lookat.html,但「正視基準點」改成角色眼睛的螢幕投影:
  // 官方假設角色站在畫面中央;我們的角色會被拖到任何位置,
  // 游標指著她的眼睛時應該是「直視你」(偏移 0),偏離眼睛才轉視線。
  const _eyeWorld = new THREE.Vector3();
  let eyeBone: THREE.Object3D | null = null; // 載入時解析一次,免每次游標事件都查骨骼名字
  function setLookAt(px: number, py: number): void {
    let cx = 0.5 * window.innerWidth;
    let cy = 0.5 * window.innerHeight;
    if (eyeBone) {
      eyeBone.getWorldPosition(_eyeWorld).project(camera);
      cx = (_eyeWorld.x * 0.5 + 0.5) * window.innerWidth;
      cy = (-_eyeWorld.y * 0.5 + 0.5) * window.innerHeight;
    }
    const tx = 10.0 * ((px - cx) / window.innerHeight);
    const ty = -10.0 * ((py - cy) / window.innerHeight);
    // 游標沒動時主行程仍可能重送同座標:目標沒變就不喚醒,idle 節流才守得住
    if (Math.abs(tx - lookAtTarget.position.x) > 1e-3 || Math.abs(ty - lookAtTarget.position.y) > 1e-3) {
      lookAtTarget.position.x = tx;
      lookAtTarget.position.y = ty;
      wake();
    }
  }

  // gltf and vrm —— official basic.html;動作 —— official three-vrm-animation loader-plugin.html
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  /* VRMA 動作播放(官方範例原樣:mixer.update → vrm.update → render) */
  let mixer: THREE.AnimationMixer | null = null;

  async function playVRMA(buf: ArrayBuffer): Promise<void> {
    if (!vrm) return;
    const gltf = await new Promise<{ userData: { vrmAnimations?: VRMAnimation[] } }>((res, rej) =>
      loader.parse(buf, '', res, rej)
    );
    const anim = gltf.userData.vrmAnimations?.[0];
    if (!anim) throw new Error('檔案裡沒有 VRM 動作');
    const clip = createVRMAnimationClip(anim, vrm);
    disposeMixer();
    mixer = new THREE.AnimationMixer(vrm.scene);
    mixer.addEventListener('finished', () => {
      mixerActive = false; // 播完(clamp 停在最後一幀)就允許進入 idle 節流
    });
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1); // 播一次就好,不循環
    action.clampWhenFinished = true; // 播完停在動作的最後一幀(不彈回 T-pose)
    action.play();
    mixerActive = true;
    wake();
    console.log('[viewer] vrma playing (once)');
  }

  /** 停掉並釋放 mixer(uncacheRoot 清 binding 快取,連播不累積) */
  function disposeMixer(): void {
    mixerActive = false;
    if (!mixer) return;
    mixer.stopAllAction();
    mixer.uncacheRoot(mixer.getRoot() as THREE.Object3D);
    mixer = null;
  }

  function stopVRMA(): void {
    disposeMixer();
    // 骨骼會停在最後一幀,重置回綁定姿
    (vrm?.humanoid as { resetNormalizedPose?: () => void } | undefined)?.resetNormalizedPose?.();
    wake();
  }

  /* 載入世代:並行載入(不同來源同時發起)只認最後發起的那個,
   * 過期的完成結果直接丟棄並釋放,不准覆蓋新模型(code review R1 競態)。 */
  let loadSeq = 0;

  function onLoaded(gltf: { userData: { vrm?: VRM }; scene: THREE.Group }, seq: number): VRM {
    const next = gltf.userData.vrm as VRM;
    if (disposed || seq !== loadSeq) {
      VRMUtils.deepDispose(next.scene);
      throw new Error('此載入已被更新的載入取代,結果丟棄');
    }

    // official 範例的載入後優化與朝向校正
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.combineMorphs(next);
    VRMUtils.rotateVRM0(next); // VRM0 校正為面朝 +Z(相機那側)

    // 官方 dnd.html:換模型前把舊的整個 dispose(動作 mixer 綁在舊骨架上,一併停掉)
    disposeMixer();
    if (vrm) {
      root.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
    }
    vrm = next;
    root.add(vrm.scene); // 原尺寸,不縮放;掛在 root 下,使用者 transform 動 root
    // SkinnedMesh 的 geometry 邊界(bind pose + morph 撐爆)不可靠,
    // three 會據此誤剔除整隻模型 → 關掉逐物件剔除(單一角色,成本可忽略)
    vrm.scene.traverse((o) => (o.frustumCulled = false));
    if (vrm.lookAt) {
      vrm.lookAt.target = lookAtTarget; // official lookat.html
      // official three-vrm-animation:VRMA 內含視線軌時需要這個 proxy 才能驅動
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = 'lookAtQuaternionProxy';
      vrm.scene.add(proxy);
    }
    // 視線基準的眼睛骨骼只在這裡解析一次(setLookAt 每次游標事件都會用到)
    eyeBone =
      next.humanoid?.getNormalizedBoneNode('leftEye') ??
      next.humanoid?.getNormalizedBoneNode('head') ??
      null;
    applyShade(); // 換模型後套用目前的陰影濃度
    applySway(); // 換模型後套用目前的晃動強度
    wake();
    console.log('[viewer] vrm loaded');
    return vrm;
  }

  function loadFromUrl(url: string): Promise<VRM> {
    const seq = ++loadSeq;
    return new Promise((res, rej) =>
      loader.load(
        url,
        (g) => {
          try {
            res(onLoaded(g, seq));
          } catch (e) {
            rej(e);
          }
        },
        undefined,
        rej
      )
    );
  }

  // 官方 dnd.html 的替換路徑:拿到檔案內容(ArrayBuffer)直接 parse
  function loadFromBuffer(buf: ArrayBuffer): Promise<VRM> {
    const seq = ++loadSeq;
    return new Promise((res, rej) =>
      loader.parse(
        buf,
        '',
        (g) => {
          try {
            res(onLoaded(g, seq));
          } catch (e) {
            rej(e);
          }
        },
        rej
      )
    );
  }

  /* 像素級命中探針:hover 判定要「與看得到的完全一致」——透明處必須穿透。
   * 包圍盒(T-pose 臂展寬)會把角色四周的透明角落誤判成可互動(實際發生過)。
   * 做法:每幀渲染完,在同一個 task 內 readPixels 讀游標那 1 個像素的 alpha。 */
  const probe = { x: -1, y: -1 };
  let probeHit = false;
  let probeDirty = false; // readPixels 是 GPU 同步點:只在「探針換座標」或「場景被 wake」後才重讀
  let scanRequested = false;
  const _probePix = new Uint8Array(4);
  function setHitProbe(x: number, y: number): void {
    if (x === probe.x && y === probe.y) return; // 輪詢重送同座標:上次讀的 alpha 仍有效
    probe.x = x;
    probe.y = y;
    probeDirty = true;
  }
  function isHit(): boolean {
    return probeHit;
  }

  // animate —— official basic.html + 燈光錨定 + 命中探針 + idle 節流
  // 節流不動官方渲染路徑,只是閒置時跳過多餘的幀(桌寵絕大多數時間是靜止的)
  const IDLE_DELAY_MS = 3000; // 最後活動後的全速緩衝:讓 spring bone 有時間安定
  const IDLE_SKIP = 6; // 節流時每 6 個 rAF 才渲染一次(60Hz 螢幕 ≈ 10fps)
  const MAX_DT = 1 / 30; // 跳幀後 getDelta 變大:鉗制單步 dt,防 spring bone(Verlet)大步過衝爆掉
  let lastActiveAt = performance.now();
  let frameNo = 0;
  let mixerActive = false; // 動作播放中 = 持續活動(finished 事件後清除)

  function wake(): void {
    lastActiveAt = performance.now();
    probeDirty = true; // 場景要變了,上次讀的探針 alpha 不可信
  }

  const clock = new THREE.Clock();
  function animate(): void {
    if (disposed) return;
    requestAnimationFrame(animate);
    frameNo++;
    perf.rafTicks++;
    if (mixerActive) wake(); // 播動作期間視為持續活動(角色在動,探針也要每幀重讀)
    const idle = performance.now() - lastActiveAt > IDLE_DELAY_MS;
    if (idle && frameNo % IDLE_SKIP !== 0) return; // 跳幀要在 getDelta 之前,delta 才不會被拆碎
    perf.renderedFrames++;

    anchorLight(); // 拖曳角色時光跟著走(平移不變);旋轉仍會改變受光面
    const dt = Math.min(clock.getDelta(), MAX_DT);
    if (mixer) mixer.update(dt); // 官方順序:mixer 先動骨架,vrm.update 再套約束/物理
    updateRootMotionCenter();
    if (vrm) vrm.update(dt);
    renderer.render(scene, camera);

    if (probe.x >= 0) {
      if (probeDirty) {
        probeDirty = false;
        const gl = renderer.getContext();
        const dpr = renderer.getPixelRatio();
        const px = Math.round(probe.x * dpr);
        const py = Math.round(renderer.domElement.height - probe.y * dpr);
        gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _probePix);
        probeHit = _probePix[3] > 16; // alpha 門檻:髮絲半透明邊緣也算命中
      }
    } else {
      probeHit = false;
    }

    if (scanRequested) {
      scanRequested = false;
      const gl = renderer.getContext();
      const W = renderer.domElement.width;
      const H = renderer.domElement.height;
      const dpr = renderer.getPixelRatio();
      // 一次讀整幅再用 CPU 掃:逐點 readPixels 每次都是 GPU 同步,一萬多次會卡一大下
      const full = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, full);
      let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, count = 0;
      for (let gy = 0; gy < H; gy += 24) {
        for (let gx = 0; gx < W; gx += 24) {
          if (full[(gy * W + gx) * 4 + 3] > 16) {
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

  function alphaMax(pts: Array<[number, number]>): number {
    renderer.render(scene, camera); // readPixels 只在同一個 task 的 render 後有效
    const gl = renderer.getContext();
    const dpr = renderer.getPixelRatio();
    let max = 0;
    for (const [x, y] of pts) {
      gl.readPixels(
        Math.round(x * dpr),
        Math.round(renderer.domElement.height - y * dpr),
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _probePix
      );
      if (_probePix[3] > max) max = _probePix[3];
    }
    return max;
  }

  function alphaAt(x: number, y: number): number {
    return alphaMax([[x, y]]);
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(window.devicePixelRatio); // 跨螢幕(不同 dpr)時解析度要跟上
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
    const keepPoint = pointLight.intensity;
    ambientLight.intensity = Math.PI;
    dirLight.intensity = 0;
    pointLight.intensity = 0;

    const rt = new THREE.WebGLRenderTarget(SNAP_W, SNAP_H);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);

    ambientLight.intensity = keepAmbient;
    dirLight.intensity = keepDir;
    pointLight.intensity = keepPoint;
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

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    loadSeq++;
    disposeMixer();
    if (vrm) {
      root.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
      vrm = null;
    }
    scene.remove(rootMotionCenter);
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  }

  /** 情緒表情(官方 VRMExpressionManager.setValue;vrm.update 每幀套用)。互斥:設新情緒時清掉其他情緒 preset。 */
  function setExpression(name: string): void {
    const manager = vrm?.expressionManager;
    if (!manager) return;
    const emotions = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
    if (name !== 'neutral' && !emotions.includes(name)) return;
    for (const emotion of emotions) manager.setValue(emotion, emotion === name ? 1.0 : 0.0);
    wake();
  }

  return { scene, camera, renderer, currentVrm: () => vrm, root, loadFromUrl, loadFromBuffer, setLookAt, setLighting, setSway, enableRootMotionSway, snapshot, setHitProbe, isHit, requestAlphaScan, alphaAt, alphaMax, wake, setExpression, playVRMA, stopVRMA, dispose };
}
