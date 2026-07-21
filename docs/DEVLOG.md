# 開發日誌(DEVLOG)

VRM 桌寵(Electron + three.js + @pixiv/three-vrm)的議題記錄:每一條 = 症狀 → 根因 → 處理方式。
時間跨度 2026-07-19 ~ 2026-07-21。對應的 commit 見 `git log`。

---

## 0. 專案全刪重建(最重要的一課)

**背景**:第一版渲染層是自創架構——「Y-down 正交相機、1 單位 = 1 像素、把 VRM 模型放大約 160 倍塞進像素座標」。結果膚色整片暗紅、臉部糊塊,連續多輪材質 hack(藏描邊、關 depthWrite、改 outline 模式)全部失敗或引入新問題,並反覆消耗使用者做「重啟 + 截圖」的驗證往返。

**根因**:MToon 的描邊(`worldCoordinates`,單位=公尺)與臉部半透明疊層的深度排序,都只在「透視相機 + 原尺寸」的官方假設下正確。放大 160 倍讓深色描邊(#44101a)糊滿膚色;正交相機讓描邊外擴失控。唯一一次渲染正確,就是完全照官方 `examples/basic.html` 設定跑的那次。

**處理**:使用者下令整個專案(含 git 歷史)刪除重建。新專案的渲染核心 `src/renderer/viewer.ts` 逐行對照官方 `basic.html`(相機/燈光/迴圈/載入)與 `dnd.html`(buffer 解析替換 + deepDispose),零自創。核心需求收斂為一件事:**隨意替換任何 VRM 檔**(Tray 選單 dialog + 拖放)。

**教訓(已寫入 CLAUDE.md 最高原則)**:用不熟的渲染庫,先讀完官方 examples 再寫第一行;渲染改動先在 `vrmtest.html` 瀏覽器驗證頁自驗,使用者只看最終結果。

---

## 1. Electron 二進位安裝損壞

**症狀**:`npm run dev` 報 `Error: Electron uninstall`;重裝後又報 `Library not loaded: Electron Framework`(dist 只有 312KB,解壓不完整)。

**根因**:npm postinstall 的下載靜默失敗,快取壞掉。

**處理**:清掉 `~/Library/Caches/electron`,直接 `curl` 官方 release zip 解壓進 `node_modules/electron/dist`,手寫 `path.txt`。

---

## 2. macOS click-through 視窗收不到 mousemove

**症狀**:疊層 `setIgnoreMouseEvents(true, { forward: true })` 後,滑鼠壓在角色上毫無反應——`forward` 的 mousemove 在 macOS 的 `focusable:false` panel 視窗上實測收不到。

**處理**:主行程每 30ms `screen.getCursorScreenPoint()` 輪詢,換算成視窗座標推給 renderer;renderer 據此做 hover 判定與視線跟隨。這條路不依賴焦點與視窗事件,實測穩定。

---

## 3. Steam 桌寵功能對齊

參考商店頁面逐項實作:視線跟隨游標(官方 `lookat.html` 公式)、左鍵拖曳移動、右鍵拖曳旋轉、右鍵點擊原生選單、滾輪縮放、位置/角度/縮放/選過的 VRM 存 `config.json`。Steam 平台服務(成就/工作坊/雲存檔)為平台功能,不適用本地 app。

---

## 4. 縮放時角色中心漂移

**症狀**:滾輪縮放(相機 dolly)時,被拖離畫面中心的角色會朝光軸中心滑動。

**根因**:透視投影下,離軸物體的螢幕位置隨相機距離改變。

**處理**:縮放時以「模型中心釘在原螢幕像素」反推補償角色座標(`錨點' = 光軸中心 + (錨點-中心) × 距離比`)。用投影數學驗證:拖到角落連續縮放兩段,漂移 0.0000 px。

---

## 5. 旋轉功能蓋掉 rotateVRM0(角色背對鏡頭)

**症狀**:角色預設朝向錯亂,rotation 設 0 時看到背面。

**根因**:`VRMUtils.rotateVRM0()` 的轉正寫在 `vrm.scene.rotation` 上,而使用者旋轉功能直接覆寫同一個 rotation。

**處理**:使用者的位移/旋轉一律套在外層 `root` 容器(Group),`vrm.scene` 的 transform 完全保留給 loader。

---

## 6. 燈光的演進(多輪往返)

1. **官方 (1,1,1) 固定世界方向**:旋轉角色時受光面跟著轉走,臉會進陰影。
2. **改從觀看者方向 (+Z) 打**:側面(法線⊥光)仍掉進 MToon 陰影色——單一方向光物理上救不了。
3. **純環境光 π**:全身均勻,但光澤完全靜止、角色死板。
4. **定案:環境光 0.8π 墊底 + 螢幕方向光 0.5π 給動態**——任何角度不出現暗面,明暗漸層隨旋轉流動。在驗證頁以 45°/90° 實測。
5. **燈光錨定角色座標系**:方向光位置 = 角色位置 + 面板偏移、target = 角色,每幀更新;`setLighting` 也立即套用一次(防 rAF 節流)。拖曳角色打光完全不變(平移不變性以像素驗證),旋轉仍會改變受光面。

---

## 7. 「方向光的方向沒有作用」——VRoid 材質解剖

**症狀**:調整光的方向,畫面毫無變化;後來又變成「只有臉會跟光」。

**深挖過程**(在驗證頁用 Lambert 探測球、紅光探測、材質 dump、整張 framebuffer 像素 diff 逐步隔離):

- VRoid 匯出的材質把方向陰影**從三個層面關死**:
  1. `shadeColor = 純白`(= 受光色):就算進入陰影,顏色也一樣;
  2. `shadingShift = 1`:任何角度都判定為受光,陰影計算根本不執行(body/衣服/鞋);
  3. `shadingToony = 1`:明暗交界是硬邊、擠在極端角度——就算打開陰影,正面也幾乎看不見。臉的材質天生 toony=0.05(柔和),所以「只有臉會動」。
- 期間兩個誤導:(a) 過曝——環境光+方向光同開太強時,白衣的受光/陰影面都剪到 255,一切差異被淹掉;(b) 瀏覽器背景分頁的 rAF 完全凍結,驗證頁的動畫迴圈停擺,量到的是凍結幀(誤判成「改壞了」)。

**處理**:「陰影濃度」滑桿一次拉**三個槓桿**(全是 uniform,免重編,原始值存 `material.userData` 可還原):陰影色依比例調暗、shift 往 -0.1 內插、toony 往 0.5 柔化。0 = 完全尊重模型原設定。以整張畫面像素 diff 驗證:光源左右對調時頭/軀幹/腿皆有大量像素變化。

---

## 8. 設定面板(即時調參 UI)

- 獨立小視窗(疊層 `focusable:false` 塞不了操作 UI),右鍵角色/Tray 開啟,單例。
- 資料流:拉桿/拖點 → IPC → main 寫 `config.json` + 轉發疊層即時套用;疊層拖曳角色時也回推面板同步。
- 光源位置從滑桿演進為 **XZ(俯視)+ YZ(側視)平面拖曳墊**(座標軸 X 紅/Y 綠/Z 藍,同 3D 慣例);角色位置另有 XY/ZY 墊。
- 墊中央的原點小人從 emoji 演進為**當前載入角色的實拍快照**(正面/側面),換模型自動更新。

---

## 9. 快照污染著色狀態

**症狀**:加了「角色快照」功能後,燈光行為異常。

**根因**:快照另開第二個 `WebGLRenderer`(第二個 WebGL context)渲染同一份材質,污染共享狀態。

**處理**:改用**主渲染器 + 離屏 WebGLRenderTarget** 拍照,`readRenderTargetPixels` 讀回、翻 Y、2D canvas 輸出 PNG。鐵律:同一份場景/材質永遠只碰一個 WebGL context。

---

## 10. 「滑鼠點不到東西」(全桌面被鎖)三部曲

**症狀**:整個桌面點不到任何東西——全螢幕透明疊層卡在「可互動」狀態,吃掉所有點擊。先後三個根因:

1. **漏接 mouseup**:拖曳旗標只靠 mouseup 清除,macOS 的非聚焦 panel 可能漏接;旗標卡住後,輪詢的恢復路徑被 `if (!dragging)` 擋死 → 永久卡死。
   **修**:看門狗——拖曳狀態下超過 1.2 秒沒有任何 DOM 指標事件(真拖曳時事件連續)即強制解除;`blur`/`visibilitychange` 也清旗標。
2. **SkinnedMesh raycast 逐頂點**:hover 判定對整隻 VRM `intersectObject`,three 對 SkinnedMesh 是逐頂點骨骼變換,幾萬頂點 × 每 30ms 把 renderer 主執行緒吃滿,滑鼠事件全面卡死。
   **修**:命中測試改 **O(1) 包圍盒**(載入時量一次局部 Box3,測試時平移到 root 位置,`ray.intersectsBox`)。
3. **renderer 崩潰無保險**:若 renderer 死在互動狀態,視窗永遠吃點擊。
   **修**:主行程掛 `render-process-gone` / `unresponsive` 保險絲,強制恢復穿透並重載。

---

## 11. 開發環境的坑

- **殘留 Electron 行程**:electron-vite 的 Ctrl+C 常殺不乾淨,舊行程跑舊碼會徹底誤導測試(多次「以為修了沒效」都是這個)。`package.json` 的 `predev` 自動 `pkill` 保險。
- **主行程/preload 改動不會熱重載**:一律完整重啟驗證。
- **瀏覽器驗證頁的背景分頁 rAF 凍結**:量測時要嘛把分頁調到前景,要嘛在同一個 task 內手動 `renderer.render()` 再 `readPixels`,不可依賴動畫迴圈。

---

## 12. 驗證方法論(現行慣例)

1. 渲染/燈光改動 → `vrmtest.html`(與 overlay 共用同一份 `viewer.ts`)自驗,必要時用**像素量測/framebuffer diff** 取代目測。
2. IPC 鏈改動 → 直接寫 `config.json` 模擬、重啟看 log 回讀值。
3. `npm run typecheck` + `npm run build` 全過才請使用者驗收,一次到位。
