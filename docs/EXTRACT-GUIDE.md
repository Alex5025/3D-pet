# Unity 遊戲 → VRM/VRMA 抽取教學

把 Unity 遊戲裡的角色模型與動作轉成桌寵能用的 `.vrm` / `.vrma`。以 Steam 遊戲「Your Mom」為實例,但流程對其他 Unity 遊戲通用(mono 版最順;IL2CPP 只影響 MonoBehaviour 解析,網格/動作不受影響)。

> **授權提醒**:遊戲資產受著作權保護。抽出來的模型與動作**僅限個人使用**,不要散布轉出的檔案。

背景知識與踩坑記錄見 [DEVLOG §48](DEVLOG.md);工具都在專案的 `extract-yourmom/`。

## 0. 環境準備

```bash
cd extract-yourmom
python3 -m venv .venv
./.venv/bin/pip install UnityPy TypeTreeGeneratorAPI
```

- **UnityPy**:解 Unity bundle/.assets 的核心。
- **TypeTreeGeneratorAPI**:.assets 檔不內嵌 MonoBehaviour typetree,要靠它從遊戲的 `Managed/*.dll` 現場生成(彈簧骨參數需要);bundle 通常內嵌,不裝也能出模型。

## 1. 找資產

macOS 的 Steam 遊戲在 `~/Library/Application Support/Steam/steamapps/common/<遊戲名>/`。Unity 遊戲的資產在 `*.app/Contents/Resources/Data/` 下:

| 檔案 | 內容 |
|---|---|
| `StreamingAssets/**` | 執行期載入的 AssetBundle(魔數 `UnityFS`)——DLC 角色常在這 |
| `sharedassets0.assets` + `.resS`/`.resource` | 場景內建資產(主角模型、動作常在這) |
| `level0`、`resources.assets` | 場景與 Resources 資產 |
| `Managed/*.dll` | mono 組件(typetree 生成用;有 `VRM10.dll`/`VRCSDK` 代表角色是 VRM/VRChat 系,結構會很標準) |

## 2. 偵察:裡面有什麼

用 UnityPy 快速盤點(`peek.py`/`listclips.py` 是現成範例):

```python
import UnityPy
env = UnityPy.load("路徑/sharedassets0.assets")
for o in env.objects:
    if o.type.name in ("SkinnedMeshRenderer", "Avatar", "AnimationClip"):
        ...  # 讀 read_typetree() 看名字、骨數、時長
```

要確認的三件事:
1. **SkinnedMeshRenderer**:哪些網格、幾根骨、掛在哪個根節點下(場景裡可能同角色多套服裝實體,各有自己的 Animator 根)。
2. **Avatar**:humanoid 對應的來源(`m_HumanBoneIndex` + `m_TOS`)。
3. **AnimationClip**:`genericBindings` 裡 `typeID==95, path==0` 的是 humanoid 肌肉 clip(可轉 VRMA);`typeID==4` 是一般 Transform 曲線(綁死特定骨架,通常不可重定向)。

## 3. 抽模型:`build_vrm.py`

```bash
# bundle(根節點名是角色 GameObject 名)
./.venv/bin/python build_vrm.py "<Data>/StreamingAssets/CharacterBundles/vivian" vivian.vrm Vivian
# 場景資產(根節點名 = 該服裝實體的 Animator GameObject 名)
./.venv/bin/python build_vrm.py "<Data>/sharedassets0.assets" rosette_maid.vrm Rosette_Maid
```

做的事:網格+蒙皮+貼圖 → glTF、`m_Shapes` blendshape → morph target、Avatar → VRM humanoid、VRCPhysBone → VRM 彈簧骨、MMD/英文 blendshape 命名 → VRM 表情 preset(候選名單制,兩種命名都吃)。

換新遊戲要注意的調整點:
- **收哪些網格**:Vivian 走固定清單、其他角色自動收「啟用中且骨數 > 10」的 SMR(排除槍等道具)——新角色視情況調這段。
- **表情對應**:`expressions` 區的候選名單,對不到會印警告,照警告補新名字即可。
- **mecanim 骨序**:`HUMAN_BONES` 順序是 mecanim 內部序(**UpperChest 在 Chest 之後第 9 位**),千萬別改回 C# HumanTrait 順序——會讓 Neck 以後全部錯位、動作左右交叉(DEVLOG §48 坑 1)。

## 4. 抽動作:`build_vrma.py`

```bash
# 全部 humanoid clip(排除 proxy_*)
./.venv/bin/python build_vrma.py "<Data目錄>" vrma
# 只轉指定 clip
./.venv/bin/python build_vrma.py "<Data目錄>" vrma greet_04,idle_00
```

Unity 的全身動作存的是**肌肉空間曲線**(每條 muscle 一個 -1~1 值),轉換需要 Avatar 的限位資料(preQ/postQ/sgn/limits),所以腳本會從同一份資產抓 Avatar。輸出是**正規化骨架**的 VRMA(three-vrm-animation 的重定向前提),套到任何 VRM 都能播。

自動處理的特例:
- 零時長 clip(姿勢)→ 輸出兩幀定格。
- 部分繫結 clip(手勢只有手指曲線)→ 只輸出有曲線的骨、不動 hips;單獨播時身體維持原姿勢。

## 5. 驗證(必做)

**不能開 `npm run dev` 來驗**——predev 會 pkill Electron,把正在跑的桌寵一起殺掉。用獨立 vite + headless Chrome:

```bash
npx vite serve src/renderer --port 5199 --strictPort &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --remote-debugging-port=9333 --user-data-dir=/tmp/chrome-vrmtest about:blank &
cp extract-yourmom/xxx.vrm src/renderer/public/__test.vrm   # 暫置,驗完刪

# 截圖(cdp-shot.mjs:載模型 → 執行任意 JS → 截圖;CDP_W/CDP_H 調視窗)
node extract-yourmom/cdp-shot.mjs /__test.vrm /tmp/shot.png \
  "__viewer.setExpression('happy');__viewer.wake();'ok'" 800
# 播動作驗證
node extract-yourmom/cdp-shot.mjs /__test.vrm /tmp/shot.png \
  "(async()=>{const b=await (await fetch('/xxx.vrma')).arrayBuffer();await __viewer.playVRMA(b);__viewer.wake();return 'ok';})()" 1500
```

檢查清單:T-pose 正面(臉朝鏡頭)、貼圖無破圖、六種表情有可見變化、`?rootMotion=1` 彈簧骨會晃、idle 動作第 0 幀是自然站姿(手臂上舉=骨序錯,見 DEVLOG §48)。結構驗證:`npx --yes @gltf-transform/cli validate xxx.vrm`。

## 6. 裝進桌寵

```bash
cp xxx.vrm models/                 # Tray 選單 → 選 VRM 檔
cp yyy.vrma "motions/動作-名字.vrma"  # 資料夾有 watcher,即時進泡泡/Tray 選單
```

命名慣例:`動作-`(全身動作)/`姿勢-`(定格)/`手勢-`(僅手指,單獨播身體會回預設姿勢)前綴分組;原名對照表維護在 `motions/動作對照表.txt`。取名前先用第 5 步逐個截圖看內容,不要瞎翻檔名。

## 已抽成果(Your Mom)

- `models/Vivian.vrm`、`models/Rosette_Maid.vrm`(Rosette 另有 `Rosette_cs` 便服/`Rosette_Maid_cat` 貓女僕/`Rosette_Swim01`/`Rosette_Swim02` 泳裝實體,用第 3 步換根節點名即可再抽)
- `motions/` 85 個:動作 46、姿勢 29、手勢 10
