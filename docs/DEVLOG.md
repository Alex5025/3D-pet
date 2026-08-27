# 開發日誌(DEVLOG)

VRM 桌寵(Electron + three.js + @pixiv/three-vrm)的議題記錄:每一條 = 症狀 → 根因 → 處理方式。
時間跨度 2026-07-19 ~ 2026-08-17。對應的 commit 見 `git log`。

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

## 12. 開發原則:資料的歸屬——未打包,就不進 Library

**事件**:幫使用者下載測試模型時,我順手把檔案放進 `~/Library/Application Support/vrm-pet/`(Electron 的 `userData`),設定檔也一直存在那裡。使用者質問:「我們的專案有建立成一個 application 了嗎?如果沒有,就不應該當作 Apple 的專案,應該要放在專案資料夾。」

**原則(重要)**:`~/Library/Application Support/` 是**已安裝應用程式**的資料目錄。專案還在 `npm run dev` 的開發階段,就不該以安裝好的 app 自居去佔用使用者的系統目錄——開發階段的一切資料(設定、下載的模型、快取)都應該住在**專案資料夾內**,和專案一起被看見、被管理、被刪除。散落在系統目錄的檔案,使用者看不到、專案刪了它們還在,就是垃圾。

**處理**:
- `configPath` 改以 `app.isPackaged` 分流:未打包 → `app.getAppPath()`(專案根目錄);將來真的打包成 `.app` 發佈,才切回 `userData`——屆時那才是正當用法。
- 模型集中在專案的 `models/`;`config.json` 在專案根目錄;兩者進 `.gitignore`(個人狀態與大檔不進版控)。
- `~/Library/Application Support/vrm-pet/` 整個刪除。

---

## 13. 驗證方法論(現行慣例)

1. 渲染/燈光改動 → `vrmtest.html`(與 overlay 共用同一份 `viewer.ts`)自驗,必要時用**像素量測/framebuffer diff** 取代目測。
2. IPC 鏈改動 → 直接寫 `config.json` 模擬、重啟看 log 回讀值。
3. `npm run typecheck` + `npm run build` 全過才請使用者驗收,一次到位。

---

## 14. 臂展範圍的透明區點不穿(包圍盒太粗)

**症狀**:角色四周約一個臂展的透明區域不會穿透點擊。

**根因**:效能修時把命中測試換成包圍盒——T-pose 盒寬 = 整個臂展,盒內透明角落被誤判成「壓在角色上」。

**處理**:兩段式命中——包圍盒只當 O(1) 預過濾(盒外直接穿透);盒內改讀**游標那 1 個像素的 alpha**(每幀渲染後 `readPixels`,晚一幀無感)。可點區域與可見輪廓像素級一致,連髮絲邊緣都對得上。

---

## 15. 換模型後點不到(SkinnedMesh 幾何邊界不可靠)

**症狀**:換上新模型後整隻點不到。

**根因**:包圍盒用 `Box3.setFromObject` 從 SkinnedMesh 幾何算——bind pose 幾何 + morph 目標會把邊界撐爆、偏移,盒子整個歪掉,預過濾把所有點擊擋光。

**處理**:改用**骨骼節點世界座標**建盒(幾百點、貼身形、永遠正確),外加皮肉邊距;同時對模型網格關閉視錐剔除(壞邊界也會讓 three 誤剔除整隻)。

**配套建設**:每次載入後跑**自我診斷**(`[hit] selftest`:盒測 + 十字五點像素採樣 + 全畫面 alphaScan),換任何模型點不點得到,看終端機 log 即知,不再消耗使用者測試。
**教訓**:第一版自檢跟游標輪詢共用探針,30ms 就被真游標覆蓋,讀到假 false,多追了兩輪幻影——自動化診斷必須走獨立通道,不能與生產路徑搶狀態。

---

## 16. 設定面板分頁化與角色控制

- 分頁:**光影**(強度/陰影/光源類型/光源位置墊)、**角色**(晃動/服裝/角色位置墊);右鍵選單「調整燈光…」「角色調整…」各自直達。
- **晃動強度四類**:頭髮/衣服/胸部/尾巴,依 spring 骨骼名分類(`ponytail` 特別排除歸頭髮),各自 0..2 縮放 stiffness/dragForce,原始值可精確還原。
- **服裝顯示**:從模型材質動態生成開關。兩個教訓:
  1. **只關材質、不關網格**——同一網格常同時裝著衣服與皮膚材質群組,關網格會把手臂連坐藏掉(實際踩過)。
  2. **模型作者刪皮膚是常態**——解剖 AvatarSample_D 證實:可見的手臂其實是上衣自帶的膚色袖套(幾何量測 x±0.55、肩高帶),真皮膚手臂被作者刪除;隱藏上衣手臂必然消失,任何軟體皆然。判斷準則:「不相關部位」跟著消失才是程式 bug。
- 墊子座標軸上色(X紅/Y綠/Z藍)、原點小人 = 當前角色實拍快照(換模型自動更新)。

---

## 17. 快照與視線的兩個修正

- **快照**:改用主渲染器 + 離屏 RenderTarget(第二個 WebGL context 會污染共享材質狀態,§9 的延伸實證);拍攝時臨時切標準亮光,面板小人不被使用者的暗光設定拍成剪影。
- **視線基準點**:官方 lookat 公式假設角色在螢幕中央;改成以**角色眼骨的螢幕投影**為正視原點——游標指著臉 = 直視觀看者,拖到哪都成立(數值驗證:指眼睛時偏移歸零)。

---

## 18. 光源類型:平行光 vs 點光源

使用者質疑「光源遠近應影響光線是否平行、進而影響陰影」——物理上正確,但 `DirectionalLight` 永遠平行、無距離概念(位置只是方向的工具)。誠實說明後加入**光源類型切換**:平行光(太陽)/ 點光源(燈泡,`decay=1` 線性衰減、遠近真實生效)。實測:點光源 z=1→亮度156、z=12→83;平行光兩者皆 149。

---

## 19. VRMA 動作播放與預設姿勢

- 生態調查:VRM 動作標準格式 = **VRMA(.vrma)**;VRoid 官方在 BOOTH 免費發佈 7 種動作包;BOOTH「立ちポーズ」多為 VRChat Unity 格式(不可用),挑檔要認明 .vrma。
- 接入 pixiv 官方 `@pixiv/three-vrm-animation`(與 three-vrm 同版),照官方範例:共用 GLTFLoader 註冊 `VRMAnimationLoaderPlugin`、`createVRMAnimationClip` + `AnimationMixer`、更新順序 mixer → vrm.update → render、掛 `VRMLookAtQuaternionProxy`。
- 行為:單次播放(`LoopOnce` + 停在末幀,不彈回 T-pose);右鍵「播放動作」子選單即時掃 `motions/`;拖 .vrma 即播;「停止動作」重置姿勢;換模型自動停清 mixer。
- **預設姿勢**:右鍵單選,即選即播存 config;每次模型載入完自動播一次——開機不再 T-pose。
- 骨骼驅動在驗證頁以數值確認(手臂旋轉隨時間連續變化)。

---

## 20. 資產集中管理

模型全部集中 `models/`(內建預設 AvatarSample_A 也搬入,`public/` 留符號連結——renderer 載入、驗證頁、打包全不用改,build 會把連結解析成真檔嵌入);動作集中 `motions/`。gitignore:`models/*` 全忽略、唯獨預設模型例外進版控,保證 clone 開箱可用。

---

## 21. 全專案 Code Review(2026-07-23)

功能穩定後做了一輪全檔審查(6 檔 ~1600 行),8 項發現全數修復(commit `b958a34`):

**高(正確性)**
1. **開機載入競態 + 重複載入**:renderer 啟動即載內建預設,main 又在 `did-finish-load` 推 config 模型——每次開機白載 14MB,且兩個載入並行、完成順序無保證,晚到的舊載入會把新模型 dispose 掉(靠運氣沒炸)。修:`get-boot-vrm` 單一載入路徑 + viewer 載入世代計數(過期結果丟棄並釋放)。實測開機 `vrm loaded` 從 2 次變 1 次。
2. **服裝過濾誤傷**:排除規則 `|line` 本意擋 FaceEyeline,卻會誤殺任何含 "line" 的服裝材質名(Marine_CLOTH 之類)——從清單消失且永久鎖定顯示。Eyeline 本就被 `face|eye` 涵蓋,移除冗餘 token。

**中(健壯性)**:`.vrm` 拖放副檔名大小寫;Tray 選單是開機快照(預設姿勢單選狀態不更新 → 變更時 `refreshTray()` 重建);設定墊 `pointercancel` 監聽器殘留;AnimationMixer 換播不 `uncacheRoot` 的 binding 洩漏。

**低(效率)**:診斷掃描 1.3 萬次逐點 `readPixels`(每次 GPU 同步)→ 一次讀整幅;resize 未重設 `devicePixelRatio`(跨 DPI 螢幕)。

**審過不動的**:IPC 安全姿勢(contextIsolation + 白名單 API)、同步讀檔(桌面 app 可接受)、滑桿事件的全場景 traverse(物件數少)、命中判定晚一幀語意(設計如此,有註解)。

**心得**:這輪的兩個真 bug 都是「歷史演進的殘留」——雙載入是推播機制疊在預設載入上的結果,`|line` 是為單一案例補的過寬規則。定期整檔重讀比事後追症狀便宜。

---

## 22. 效能優化:桌寵是「常駐背景程式」,不是遊戲(2026-07-23)

§21 的 review 只看正確性,這輪專看**常駐成本**——桌寵開機就掛著一整天,靜止時的每一分 CPU 都是純浪費。四組改動,全部先在 `vrmtest.html` 用數值驗證再進 app。

### A. idle 節流:靜止時把渲染降到 1/6

**問題**:官方 basic.html 的 rAF 迴圈是為「使用者正在看的 demo 頁」寫的,無條件每幀渲染。桌寵絕大多數時間是靜止的,60fps 全速渲染 + 每幀 `readPixels` 命中探針,只為了畫出一模一樣的畫面。

**做法**:最後活動後 3 秒進入節流,每 6 個 rAF 才渲染一次(60Hz ≈ 10fps);任何互動(拖曳/旋轉/縮放/游標移動/調燈/換模型/播動作)呼叫 `wake()` 立刻恢復全速。動作播放中每幀 `wake()`,視為持續活動。

**三個踩到的細節**:
1. **跳幀必須在 `clock.getDelta()` 之前 return**——否則 delta 被拆成碎片,節流等於白做。
2. **`dt` 要鉗制在 1/30 秒**。跳幀後 delta 變成 6 倍,spring bone 是 Verlet 積分,大步會過衝發散(頭髮直接爆開)。驗證方式:節流中突然 wake + 旋轉,掃全部骨架節點確認無 NaN(292 節點通過)。
3. **3 秒緩衝不能省**:互動停下的瞬間 spring bone 還在擺盪,立刻降到 10fps 會看得出來卡。要留時間讓物理安定。

**Wake 的來源必須收齊**:漏掉任何一個入口 = 該互動變成 10fps。實際收在 `applyState()`(拖曳/旋轉/縮放/面板全走這)、mousedown/mousemove/wheel、`setLighting`/`setSway`、載入完成、VRMA 播放/停止。`setLookAt` 則相反——**目標沒變就不 wake**,否則主行程重送同座標會讓節流永遠進不去。

### B. 主行程的同步 I/O(凍結整條主執行緒)

主行程是單執行緒,而它同時扛著 30ms 游標輪詢與全部 IPC。任何 `readFileSync` 都是全域凍結:

- **config 每次寫都 read+write**:設定滑桿的 `input` 每秒數十發 → 每秒數十次同步讀寫磁碟,拖滑桿時游標輪詢明顯卡頓。改成**記憶體單一真相**:啟動同步讀一次,之後只改記憶體 + 500ms debounce 非同步落盤。每秒最多 2 次非同步寫。
  - 落盤保底有兩條路:Tray「結束」走 `app.exit`,**不觸發 `before-quit`**,所以按鈕點下先 `flushConfigSync()`;cmd-Q 等其他路徑掛 `before-quit`。這種「快捷退出路徑繞過清理鉤子」的坑很容易漏。
- **VRM/VRMA 讀檔**:14MB 的模型 `readFileSync` = 主行程停住幾十毫秒。全改 `fs.promises.readFile`。順帶把 `existsSync` + `readFileSync` 兩次同步呼叫收成一次 `await readFile` + catch(讀不到就是 null,語意相同、少一次 stat)。
- **motions 目錄每次開選單掃兩輪**(播放動作 + 預設姿勢各一次 `readdirSync`)。改成快取 + `fs.watch` 監看,選單變純函式;popup 前再刷新一次當雙保險。

### C. 游標鏈路:一次移動不要做三次工

- **輪詢端**:座標沒變就不 send。但**保留每秒一次心跳**——renderer 的拖曳看門狗靠 `onCursor` 觸發,完全去重會餓死它,旗標卡住 = 疊層吃掉全桌面點擊(§10 的事故,那條看門狗是保險絲,不能拆)。`getBounds()` 也改快取(疊層 `movable:false`,只在螢幕配置變更時重取)。timer 改在 `did-finish-load` 後啟動並存 handle,renderer 重載不會疊出兩個 timer。
- **探針端**:`readPixels` 是 GPU 同步點(強制 flush 管線)。原本每幀都讀,現在只在**探針換座標**或**場景被 wake** 後才讀 —— 靜止 hover 從每幀一次降到零。
- **去重**:互動時 `onCursor` 與 DOM `mousemove` 會對同一次移動各做一遍 lookAt + 命中判定。用 `lastPointerAt` 判斷 DOM 事件流是否存活來擇一(而非只看 `interactive` 旗標)——設定面板搶焦點導致疊層漏 DOM 事件時,輪詢自動接手,視線不會凍結。

### D. 零散

`applyShade()` 只在陰影值真的改變時才 traverse 整棵材質樹(調亮度/位置不必);eye bone 在載入時解析一次而非每次游標事件查骨骼名;`alphaMax()` 一次渲染讀多點——自檢的十字五點原本連呼叫五次 `alphaAt`,等於白渲染四幀;`predev` 的 pkill 改用 `$(pwd)`,不再硬編目錄名。

### 驗證:fps 數字騙了我一輪

第一版驗證直接量 fps,數字全錯(節流時反而更高)。原因:驗證視窗被桌寵疊層遮擋,**rAF 脫離 vsync 自由跑**,絕對 fps 完全失去意義。改成量「渲染幀數 / rAF tick 數」的比例才對——那才是節流的真正語意。結果:活動 100% / 閒置 17%(恰好 1/6)/ 喚醒後 100%。

**教訓**:量效能要量**機制本身的不變量**(這裡是「幾個 tick 渲染一次」),不要量會被環境污染的衍生數字。

實機結果:閒置時 renderer CPU 約 8%,開機仍單次載入,預設姿勢照播,`[hit] selftest … OK,點得到`。

---

## 23. 多寵物、工作設定與對話入口(2026-07-24)

這輪把「單一桌寵 + 單一 `config.json`」擴充為可同時運行多隻角色的架構，並為日後把每隻角色連到不同 Codex 工作階段建立資料邊界。

### A. 每隻寵物都是獨立 runtime

- renderer 由單一 `viewer/state` 改為 `Map<petId, PetRuntime>`；每隻寵物分別持有 Viewer、模型、位置、燈光、晃動、服裝、對話泡泡與儲存 timer。
- 命中測試先逐隻檢查骨骼包圍盒，再讀該 Viewer 的 alpha；拖曳、旋轉、縮放、右鍵選單及檔案拖放只作用於游標命中的角色。
- 設定面板與所有 IPC 加入 `petId`，切換角色時不會把模型、工作目錄、Session ID 或顯示參數寫到另一隻角色。

### B. 運行資料格式 v2

開發模式資料移到 `runtime-data/`：`app.json` 只保存格式版本、順序與目前選取 ID，`pets/<UUID>.json` 保存單隻寵物的名稱、啟用狀態、工作目錄、Codex Session ID、VRM 路徑及角色參數。JSON 與 `pets/` 均忽略版控，只提交格式說明與 ignore 規則。

舊版 `runtime-data/config.json` 或根目錄 `config.json` 會自動遷移成第一隻寵物且保留原檔；移除寵物時設定搬到 `pets/.trash/`，避免不可逆刪除。測試可用 `VRM_PET_DATA_DIR` 隔離資料。

### C. 工作設定頁

右鍵選單加入「工作設定…」，先開啟設定分頁並顯示既有路徑，不會一點就直接彈出資料夾瀏覽器。使用者可在同一頁設定寵物名稱、是否顯示、工作目錄與 Codex Session ID，也可新增、切換或移除角色。此階段只完成綁定與持久化；輸入訊息實際送往指定 Codex Session 仍是後續功能。

### D. Hover 對話泡泡

滑鼠進入可見角色時顯示含輸入框的泡泡，移到泡泡可繼續操作，離開角色與泡泡後延遲 160ms 隱藏。Electron 疊層平時仍不可聚焦；只有按輸入框時暫時開啟 focus，失焦即恢復桌面穿透。

泡泡會依角色與視窗邊界選擇上、下、左、右，避免右上角角色被遮住。側邊距離原先被載入時的 T-pose 臂展撐大，後來改用目前姿勢的骨骼投影，加上少量衣服／髮絲邊距，箭頭能貼近畫面上真正看到的角色。

### E. 待機後拖曳仍有物理慣性

三個範例模型的 Spring Bone 都把 hips/root 設為 `center`，所以角色與 center 一起平移時 Verlet 積分看不到速度。Viewer 現在使用獨立物理中心，每幀跟隨角色 94%，並限制最大平移／旋轉落後量；拖曳會帶動頭髮、衣物與尾巴，又不會因快速位移讓短骨骼翻轉。

`vrmtest.html?rootMotion=1` 會等 Viewer 進入 3 秒 idle 節流後平移角色並量測 Spring Bone。回歸結果最大角度約 0.1476 rad(8.5°)，確認 `wake()` 能恢復全速且物理反應在受控範圍。另以右上角泡泡案例驗證完整位於視窗內且不與角色重疊；`npm run typecheck`、`npm run build` 均通過。

---

## 24. 寵物休眠與資源釋放(2026-07-24)

多寵物架構下,「不顯示的寵物」不該只是隱藏——每隻角色各持一個 **WebGL context**,而瀏覽器對 context 有硬上限(~16 個)。若休眠只是 `scene.remove` 而不釋放,反覆開關角色遲早撞上限、最舊的 context 被瀏覽器強制回收,畫面莫名黑掉。所以把 `enabled` 從「顯示/隱藏」正式升級為「**運行/休眠並釋放資源**」(UI 文案也從「隱藏」改為「休息中」)。

**釋放什麼**
- renderer:`removeRuntime` 呼叫 `viewer.dispose()`,其中 `renderer.dispose()`(GL 資源)之後補 **`renderer.forceContextLoss()`**——這一步才真正歸還 WebGL context;少了它,dispose 過的 renderer 仍佔著 context 名額。
- main:釋放該寵物的 `avatarIcons` / `wardrobeLists` 快取。

**休眠前先存位置**
`removeRuntime` 在拆掉 runtime 之前先 `saveState(petId, runtime.state)`,否則角色被拖過的最後位置會隨 runtime 一起消失,喚醒後跳回舊位。刪除路徑同樣會走到這裡,但 main 的 `save-state → updatePet` 有 `pets.get(id)` 守衛,對已刪除的寵物是 no-op,不會復活殭屍。

**單一變更點(code review 後收斂)**
「disable → 釋放快取」原本散在 `setPetEnabled` 與 `update-pet-meta` 兩處各記一份,日後易漏同步。改成**內建進 `updatePet`**:凡 `patch.enabled === false` 就釋放,無論來自選單、設定面板或未來任何路徑都一致。

**喚醒動線**
休息中的寵物在「切換寵物」選單中仍列出(標「(休息中)」)但**灰掉不可選**——避免選了牠變成 selectedPetId 卻沒有 runtime、桌面空無一物。喚醒有兩條路:牠正是目前角色時用選單的「喚醒目前角色」;否則到設定面板的寵物選單挑它、開啟即可。

**教訓**:`renderer.dispose()` ≠ 釋放 context。要真正歸還 GPU context 得 `forceContextLoss()`——這在「單一長駐 canvas」的 app 看不出來,一旦變成「多 context 動態增減」就會踩到瀏覽器上限。

---

## 25. 對話泡泡串接 Codex / Claude(v1 純問答)(2026-07-27)

按 `docs/AGENT-BRIDGE-DESIGN.md` 落地 v0+v1:泡泡輸入 → 每寵設定的 agent(Codex app-server / Claude CLI)→ 串流回泡泡。硬性約束:**不使用計費 API**——Claude 走 `claude -p` 吃本機訂閱登入(spawn 前剝除 `ANTHROPIC_API_KEY`),Agent SDK(強制 API key)排除。

### 架構落地

- **`src/main/agent/`**:`AgentProvider` 抽象(startSession/sendMessage/cancel/closeSession/dispose/shutdownSync)+ `AgentBridge`(單寵單 turn、全域上限 4、每 turn 恰一個終結事件、30s/5min 看門狗、resume 失敗清 id 重開)+ 三個 provider(codex/claude/mock)。消費端(泡泡/IPC/持久化)只認統一 `AgentEvent`,加後端或換內部實作零外溢。
- **CodexProvider = 長駐 app-server**(NDJSON JSON-RPC):v0 用 `codex app-server generate-ts` 拿官方協定(不猜格式),實測 initialize/thread/turn/interrupt/resume 全通。crash 偵測 → 進行中 turn 吐 error → 下次對話 lazy 重啟 + `thread/resume`(e2e 實測外部 pkill 後上下文完整保留)。v1 唯讀:`sandbox:'read-only'` + `approvalPolicy:'never'`,實測零 approval。
- **ClaudeProvider = 每 turn spawn `claude -p --output-format stream-json`**:prompt 走 stdin(claude 會等 stdin 3 秒的坑,順便解掉 argv 逃逸);`--resume` 續 session;`--include-partial-messages` 拿 delta 做打字機;`--disallowedTools "*"` 純問答。
- **session 持久化**:`profile.agent = { kind, sessionId }`(舊 `codexSessionId` 自動遷移、保留);bridge **只持久化 `session` 事件給的真 id**——claude 新 session 首 turn 才有 id,startSession 回傳的只是暫時 handle,不落盤。

### 踩到的坑

1. **SIGTERM 後 claude 會優雅吐 `result is_error:true` 再退出**——原以為殺行程=流中斷、由 bridge 補 `done ok:false`,實際會先收到錯誤 result,使用者主動取消被渲染成紅字錯誤。修法:provider 記 `cancelRequested`(WeakSet),取消中的 error result 轉 `done ok:false`。
2. **「每 turn spawn」的 provider 拿不到 workdir**——介面只在 startSession 給 workdir,claude 每 turn 都要 cwd。provider 內部存 handle→workdir 對映,init 拿到真 id 後補別名(cancel 用哪個 id 都找得到行程)。
3. **e2e 的 cancel 競態**——「寫 1000 字後取消」會輸給 claude 的寫作速度(8 秒寫完,cancel 撲空)。改成「等第一個 text 增量出現就取消」,確定 turn 在跑才殺。
4. **codex 忘了 yield session 事件**——threadId 在 startSession 就有(真 id),但 bridge 改成只從 session 事件持久化後,codex 的 threadId 從未落盤(in-memory 全過、重啟就丟)。e2e 抓到:每 turn 開頭補 session 事件,bridge 去重。

### UI 與生命週期

- 泡泡維持笨元件:新增回覆區(200px 可捲)/狀態列/停止鈕/Enter 送出,`AgentEvent` → 泡泡方法的對映在 main.ts。**中斷以停止鈕為主**——input disabled 會 blur → 視窗回不可聚焦,Esc 收不到。
- running 中移開游標:泡泡不藏(看進度)但 overlay 轉穿透,底下視窗照常點;游標回泡泡恢復互動可按停止。
- 生命週期集中:寵物休眠/刪除 → `closePetSession`(掛在 `updatePet` 的 disable 副作用旁);`before-quit` 與 Tray「結束」(不觸發 before-quit)都掛 `shutdownSync()`(同步 SIGTERM——`app.exit` await 不到 async dispose)。

### 驗證建設(headless,不開視窗)

`VRM_PET_AGENT_SELFTEST=1`(MockProvider 全鏈 11 項)/ `=claude`、`=codex`(真 CLI e2e 各 7 項:問答、session 回存、resume、cancel、休眠、crash 重連),exit code 供 CI 化;`VRM_PET_AGENT_MOCK=1` 供 UI 手動走查不耗額度。全部 PASS;`pgrep` 驗無 app-server 殭屍。

**教訓**:e2e 抓到的四個坑全是「單元層面正確、整合層面錯」的類型(取消語意、id 生命週期、競態)——mock 驗邏輯、真 CLI 驗契約,兩層缺一不可。

---

## 26. 點光源調整的往返:一次需求語意對齊失敗的完整記錄(2026-07-28)

使用者要「點光源的直徑調整」,前後三輪才收斂,中間做了一個整個退回的功能。過程值得記,教訓比程式碼值錢。

### 過程

1. **第一輪(做錯)**:把「直徑」實作成**照射截斷範圍**(`PointLight.distance` = 直徑/2,0=無限遠)。vrmtest 像素實測衰減生效(169→121→165),自以為完成。
2. **「看不出來影響」**:量化診斷發現兩層問題——(a) 預設環境光 0.8π 佔總亮度 94%,把點光源整個切掉也只暗 5%;(b) 光源預設距角色 2m,直徑 >4.5 全是死區。修了滑桿範圍,但這是在錯的需求上優化。
3. **「完全打不到點光源」**:讀使用者實際設定檔才看到真相——光源被拉到 13.3m 外、直徑存成 0.35,**截斷範圍(17cm)遠小於光源距離** → 點光源永遠照不到角色。「直徑=截斷」的設計與 ±20m 自由位置墊天生互斥。
4. **需求對齊**:使用者說「我要的是**光源的直徑**」(光源本體大小,不是照射範圍)→ 整個退回(`git revert`,5b6dda5)。
5. **真需求浮現**:「我要調整的是**亮度範圍**」——點光源線性衰減(intensity/距離),光源拉遠後強度上限 2π 完全不夠亮。這才是他從頭到尾撞到的牆。

### 最終落地(全部小改動)

- 點光源模式強度滑桿上限 **2π → 500**(切回平行光自動夾回 2π 防過曝);點光源模式數值顯示改原始值(500 用 π 表示法是「159.15 π」,不可讀)。
- 光源位置墊範圍 **±20 → ±100**(數值欄寬度同步加寬,守住「位數變化不重排」的舊要求)。
- 光源位置墊視角改 **XY(正面)+ YZ(側面)**,對齊角色位置墊的慣例。

### 教訓

1. **「功能正確」不等於「需求正確」**:第一輪有像素實測、有 gate,全綠——但驗證的是我自己的理解,不是使用者的意圖。名詞(「直徑」)有歧義時,先問「你期待看到什麼視覺變化」再動手,比做完再對齊便宜十倍。
2. **讀使用者的實際資料檔是最快的診斷**:三輪猜測不如一次 `cat runtime-data/pets/*.json`——光源 13.3m + 截斷 0.35 一眼看穿「打不到」;後續「亮度不夠」也是同一份檔案裡的 `directional: 5.3`(頂著舊上限)洩的底。
3. **參數之間會互相鎖死**:截斷範圍(≤6m)× 位置墊(±20m)兩個各自合理的範圍組合出「怎麼調都沒反應」;範圍類參數要一起設計,上限要互相蓋得住。
4. 退回用 `git revert` 保留過程——commit 訊息記下為什麼錯,比假裝沒發生過有價值。

---

## 27. v2:工具執行與審批(2026-07-28)

agent 從「唯讀問答」升級為「可動手改檔案、危險操作經泡泡核准」。每寵三檔權限:唯讀(預設)/ 可寫需核准 / 全自動。

### 審批管線

- **codex**:app-server 的審批是 **ServerRequest**(`item/commandExecution/requestApproval`,有 id 必須回覆)——stdout 分派器加第三類處理(先前只有 response/notification)。params 自帶 codex 寫好的中文 `reason` + 完整 `command`,泡泡描述零加工。回 `{decision:"accept"|"decline"}`。未知的 ServerRequest 一律自動 decline,絕不讓 server 掛著等。
- **claude**:`--permission-prompt-tool` 把權限詢問導向隨 app 附帶的 MCP 腳本(`permPromptServer.mjs`),腳本經本機 unix socket(隨機路徑+token)回連 main;每 turn 一份 mcp-config(env 帶 turnKey 做路由)。回 `{"behavior":"allow"|"deny"}`。
- **bridge**:`respondApproval(petId, requestId, allow)`;**等審批時看門狗暫停**(等人點頭不是卡死,5 分鐘硬中斷不可誤殺);泡泡新增審批區塊(黃底描述 + 允許/拒絕鈕)。

### 三個實測打臉的假設(全靠 e2e 抓)

1. **同 server 內 re-resume 換不了權限**:對已載入 thread 重新 `thread/resume` 帶新 sandbox,回應顯示 sandbox 仍是舊值——參數被靜默忽略。**全新 server 的 resume 才會套新參數**(sandbox/approval 都換、context 保留)→ 權限變更 = 重啟 app-server 再 resume(~1 秒,罕見操作可接受)。
2. **`on-request` 不保證詢問**:它是「模型自行判斷」,workspace 內的寫入常直接做(同 prompt 一次會問一次不問)。`ask` 的語意要保證詢問 → 改用 **`untrusted`**(只放行安全唯讀指令,其餘一律審批),allow/deny 兩向實測穩定。
3. **bridge 回存 sessionId 會洗掉 agent 設定**:session 事件的持久化整包覆寫 `agent`,model/effort/permission 全丟——自 model 功能上線就潛伏,selftest 加了「回存不洗設定」斷言後修正(展開既有設定再蓋 sessionId)。

### 驗證

mock selftest 16 項(新增審批 allow/deny、設定不被洗)+ codex e2e 11 項 + claude e2e 11 項(各含審批 allow→檔案存在、deny→無檔案)全 PASS;無殭屍行程;typecheck/build 過。

**教訓**:官方枚舉值的「字面意思」不等於「行為保證」——`on-request` 聽起來像會問,實際是模型裁量。安全語意(必問)要選有硬保證的選項(`untrusted`),並用 e2e 把保證釘死。

---

## 28. v3:MCP 寵物工具——agent 操縱桌寵(2026-07-28)

桌寵從「顯示回覆的殼」變成 agent 可操縱的化身:agent 對話中可自主呼叫 `pet_play_motion`(播 VRMA 動作)、`pet_show_expression`(切表情)、`pet_speak`(泡泡說話)配合情緒表演。

### 架構

- **petToolsHub(main)**:本機 socket 中樞(隨機路徑+token),集中執行工具呼叫(動作=既有 vrma-play 通道、表情=新 expression-apply IPC、說話=chat-event 文字)。
- **petToolsServer.mjs**:隨 app 附帶的 stdio MCP 腳本,兩家 CLI 都掛它;開機先跟 hub 拿 manifest,**把 motions/ 實際檔名塞進工具 schema 的 enum**——agent 不會亂猜動作名。petId 由 env 帶入,多寵路由天然成立。
- **viewer**:`setExpression()` 照官方 `VRMExpressionManager.setValue`(標準 preset:happy/angry/sad/relaxed/surprised;情緒互斥,neutral 清除)。
- **persona 整合**:system prompt 框架加一句工具提示(「可配合情緒表演,不必等使用者要求」),與角色個性同一段注入。

### 掛載路徑(v3.0 實測)

- **codex**:`thread/start` 的 `config.mcp_servers` 覆寫可掛(免動使用者的 config.toml)。坑:MCP 工具呼叫的核准不是 v2 的 requestApproval,而是 **`mcpServer/elicitation/request`**(form 模式),回覆形狀是 `{action, content, _meta}`——用 `{decision}` 回會被當拒絕(v3.0 探測時「工具呼叫被拒」半天就是這個)。自家 pettools 自動放行;使用者 config.toml 裡其他 MCP server 的 elicitation 轉泡泡審批(message 欄位是現成人話)。
- **claude**:`--mcp-config` 與 v2 審批共用一份設定檔。唯讀模式原本 `--disallowedTools "*"` 會連寵物工具一起封——改 **`--permission-mode dontAsk` + `--allowedTools mcp__pettools__*` + 黑名單內建工具**:其他工具靜默拒絕、寵物工具放行;ask 模式則在 permission 詢問處對 `mcp__pettools__` 前綴自動 allow,不打擾使用者。

### 驗證

兩家 e2e 各 13 項全 PASS(新增:readonly 下請 agent 切表情 → 記錄型 hub 收到 `expr:happy`、turn 正常完成);mock selftest 16 項、開機煙霧、無殭屍行程、typecheck/build 全過。

**教訓**:同一個「核准」概念在 codex 協定裡有兩套完全不同的 ServerRequest(指令審批 vs MCP elicitation),form/schema 都不同——「回覆形狀錯 = 靜默拒絕」沒有任何錯誤訊息,只能靠逐請求 log 抓。

---

## 29. 設定面板擴充與首輪實機驗收修復(2026-07-28)

### 面板擴充(對話串接後的一批 UX 功能)

- **泡泡輸入框改 textarea**:Enter 送出、Shift+Enter 換行、**IME 選字的 Enter 不誤送**(`isComposing`——注音使用者的必修課);高度隨內容長、5 行封頂;上限 120→1000 字。
- **每寵模型與推理力度**:下拉選單——codex 動態拉 `model/list`(逐模型附支援力度,Sol 有到 `ultra`;lazy 啟動 app-server、成功才快取),claude 用實測過的別名(fable/opus/sonnet/haiku)。逐 turn 生效免重開對話;換家時自動歸預設。順帶抓到 **bridge 回存 sessionId 整包覆寫 agent、洗掉 model/effort 的潛伏 bug**(詳 §27)。
- **角色個性(persona)**:角色分頁自由文字,claude 逐 turn `--append-system-prompt`、codex 於 thread 建立/恢復 `developerInstructions`;實測貓娘句尾喵。
- **預設姿勢入面板**:main 抽共用 `setDefaultPose()`(白名單+存檔+雙向同步),右鍵選單與面板走同一入口。
- **喚醒/休息**改狀態切換按鈕(取代勾選框)。

### 首輪實機驗收(使用者真滑鼠實測)抓到的問題

1. **審批鈕點不到(幽靈泡泡)**:三寵環境下游標掃過別隻寵物,`visiblePetId` 被切走;泡泡命中判定(hover/mousedown/wheel)只認「目前寵物」的泡泡 → 審批中的泡泡看得到、點不到(疊層維持穿透,點擊全落到底下視窗)。**修法:命中判定改掃描所有寵物的可見泡泡**,壓中即恢復互動並認領 visiblePetId。
   **教訓**:headless e2e 蓋不到「疊層互動路由」這層——事件序全對,但 `setIgnoreMouseEvents` 的狀態機只有真滑鼠+多寵物才會暴露。單寵手測也不夠,**互動類驗收要用使用者的真實佈局**。
2. **「沒有請求權限,直接說被拒絕」**:設定其實正確(`permission: ask` 已落盤),元凶是 §11 的老坑變種——**vite 熱重載讓 renderer 拿到新 UI(能設定新欄位),main 行程卻還是舊碼**(不吃 permission、一律唯讀+never→codex 自動拒絕提權)。「設定看起來生效、行為卻是舊的」= 先懷疑 main 沒重啟。
3. **fileChange 審批描述退化成方法名**:`item/fileChange/requestApproval` 的 params 常只有可為 null 的 `reason`(協定如此),fallback 補人話「想修改工作目錄中的檔案」。
4. **自發表演不發生**:「你可以呼叫…」對模型太客氣,effort=low 時幾乎不做份外事。提示改**具體行為規則**(何時切表情/播動作/回報);另建議表演型寵物 effort ≥ medium。

---

## 30. 泡泡 Markdown 渲染與模型徽章(2026-07-28)

- **回覆區 Markdown 渲染**:agent 回覆本來就是 GFM,原樣顯示 `#`/```` ``` ````/`>` 難讀。接 `marked`(gfm + breaks)+ **DOMPurify 消毒**——agent 輸出是不可信文字,markdown 轉 HTML 必過消毒才上 DOM。串流逐段重渲(幾 KB 文字 marked 是微秒級);回覆區結構改為「md 容器 + 錯誤列」分離,beginTurn 用 `replaceChildren` 保容器清錯誤。
- **連結外開**:回覆裡的 `<a>` 攔截點擊,經 IPC 交給 main 的 `shell.openExternal`(僅放行 http/https)——疊層視窗絕不能被導航走。
- **模型/力度徽章**:泡泡標題下顯示「家別 · 模型 · 力度」(如 `Codex · gpt-5.6-sol · low`),資料來自 profile.agent,走既有 profiles 推播鏈,設定面板改完即時反映。這是使用者問「目前模型權重怎麼設定」後的可視化——狀態要看得見,不用問。
- 新依賴:`marked` + `dompurify`(泡泡渲染最小組合);另補 README(專案至此已是完整產品形態,值得一頁門面)。

---

## 31. Markdown 渲染沒生效——批次替換靜默失敗(2026-07-29)

- **症狀**(使用者實機截圖):徽章正常,但回覆區仍顯示原始 markdown(`## 今日任務`、`- [x] …` 原樣),且換行全被吃掉,比改之前更難讀。
- **根因**:§30 的改動用 Python `str.replace` 批次替換,其中 beginTurn+appendText 這段的舊字串比對不上(先前另一次修改動過該區),**`str.replace` 沒匹配就原樣返回、不報錯**——結果 marked/DOMPurify 管線、mdBox、CSS 全部就位,唯獨串流入口 `appendText` 還在 `append(document.createTextNode(chunk))`,`renderReply()` 從未被呼叫;新 CSS 的 `white-space: normal` 又把原始文字的換行吃掉,完全解釋截圖。
- **修法**:`appendText` 改為累積 `replyRaw` 後 `renderReply()` 逐段重渲;`beginTurn` 清 `replyRaw`、`replaceChildren(mdBox)` 保容器(舊版 `reply.textContent = ''` 甚至會把 mdBox 整個移出 DOM)。
- **驗證**:node 直跑 marked 確認截圖那段文字輸出正確 `<h2>`/`<li>`/`<code>`(含 task list checkbox);grep 確認 `renderReply()` 已被引用;typecheck + build 過。
- **教訓**:
  1. **`str.replace` 類批次替換必須驗證替換數**(替換前後 diff 行數、或改用「無匹配即報錯」的工具如 Edit/patch)——靜默失敗會做出「管線俱在、就是沒接上」這種最難一眼看穿的半成品。
  2. 「新功能完全沒效果但周邊(徽章/CSS)都有效」的組合,優先懷疑**同一批改動有部分沒落地**,而不是邏輯錯誤。

---

## 32. codex 個性(persona)對既有 thread 無效——resume 的 developerInstructions 是死欄位(2026-07-29)

- **症狀**(使用者實機):設定「句尾加喵」後,codex 寵物回覆完全沒有個性;第一輪修復(個性變更比照權限走「重啟 app-server + resume」重注)也無效。
- **逐層根因**(兩輪):
  1. 第一層(程式邏輯):persona 只在 thread 建立/恢復時注入,thread 已載入後改個性不觸發重注;且 `saved?.persona ?? opts?.persona` 讓舊快照壓過新值。修了,但沒效——因為還有第二層。
  2. 第二層(平台實證,最小 probe 抓到):**`thread/resume` 的 `developerInstructions` 根本不生效**——schema 有這欄位(generate-ts 可見),但 server 沿用 rollout 裡的舊指示,**連全新 server 的 resume 也一樣**(和 §27 的 sandbox 不同:sandbox 是「同 server 不套、新 server 會套」,developerInstructions 是全都不套)。所以「重啟+resume」對 persona 是白工。
- **正確通道(probe 實測)**:`thread/inject_items`——把 `{ type:'message', role:'developer', content:[{type:'input_text', …}] }` 塞進模型可見歷史。實測**即時生效**,還壓過 rollout 舊指示與歷史慣性(前幾輪都在喵,注入後立刻改汪)。
- **修法**:新 thread 維持 `thread/start` + `developerInstructions`(實測有效);既有 thread 改 `syncPersona()`——追蹤每 thread「已生效 persona」(resume 回來的標未知),與 profile 當下值不同就在 turn 前注入【角色設定更新】developer 訊息。個性變更**不再重啟 server**(重啟只留給權限變更);注入失敗不擋 turn,下輪重試。
- **驗證**:兩個最小 probe(start 注入喵 PASS;新 server resume 換汪 FAIL → inject_items 換汪 PASS)+ codex 真 CLI e2e 13 項全 PASS + mock selftest + typecheck/build。
- **教訓**:
  1. **schema 有欄位 ≠ server 會理它**(experimental 協定第二次犯:§27 sandbox、本次 developerInstructions)——每個「應該可以」的參數都要單獨 probe,而且要測「改得掉」而不只「設得上」。
  2. 修 bug 後使用者回報「沒效」,先做**繞過自家程式碼的最小 probe** 直接打協定,把「我的邏輯錯」和「平台不支援」拆開——第一輪修復方向對但通道是死的,不 probe 會一直在自家程式碼裡打轉。

---

## 33. 個性輸入框失焦漏存——獨立視窗吃不到 change 事件(2026-07-29)

- **症狀**(使用者實機):設定面板改完個性,直接點回桌寵對話,新個性沒生效——其實是**根本沒存檔**(§32 的注入機制是對的,但 profile 裡還是舊值)。
- **根因**:textarea 的 `change` 事件要「值變了**且**元素在頁面內失焦」才觸發。設定面板是**獨立視窗**,改完直接點桌寵是「切視窗」——頁面內沒有發生 blur,`change` 永遠不發。焦點在 textarea 上關窗/切窗,輸入就靜默丟失。
- **修法**(settings.ts):
  1. **輸入即存**:`input` 事件 + 500ms debounce;
  2. **失焦補存**:textarea `blur` 與 **window `blur`**(點回桌寵那一刻)立即 flush;
  3. **防回寫打架**:存檔會觸發 `pet-profiles-apply` 廣播,`loadSelectedPet` 原本無條件回寫 textarea——打字中(textarea 聚焦)會被蓋掉游標與內容,改為聚焦中不回寫。
- **教訓**:
  1. **多視窗 app 不能依賴 `change` 存檔**——`change`/頁面內 blur 的語意只在單頁內成立,跨視窗焦點切換要靠 window `blur` 或輸入即存兜底。
  2. 「即時存檔 + 廣播回寫」的組合必然打架,**回寫前要檢查該欄位是否正在編輯**(`document.activeElement`),否則修了漏存又引入蓋字。
  3. 設定「沒生效」要先分清是**沒存到**還是**沒套用**——這次和 §32 是同一個症狀的兩個獨立根因,先驗落盤值(config.json)再追注入鏈,能少走一輪。

---

## 34. 效能優化(六階段)與 e2e 抓到的 claude cancel 卡死(2026-07-29)

目標(使用者定):高負載降功率(最優先)、idle 耗電、互動流暢、串流卡頓、多寵記憶體。兩輪程式碼探索定位熱點後分六階段實作,每階段獨立 commit。

### 各階段摘要

- **P0 量測基座**:`window.__perf` 計數器(rAF tick/渲染幀/泡泡重渲/骨骼投影)。量「render/rAF 比例」這個機制不變量,不量會被遮擋污染的絕對 fps(§22 教訓)。
- **P1 main IO**:petToolsHub/permServer socket 改逐行切割並截斷 buffer(原本只讀第一行、不截斷——潛伏正確性 bug);motions fs.watch 加 300ms debounce(原單次變動多次重建整個 Tray);config 落盤改 dirty-set 非同步只寫髒檔(原任何變更全量同步寫全部檔案;退出路徑保留同步全量,`app.exit` 不觸發 before-quit)。
- **P2 功率檔位(核心)**:`powerMonitor` 四檔——normal(AC)/eco(電池或微熱)/critical(過熱)/suspended(鎖屏/睡眠),聯動游標輪詢(30/60/120ms/停)與渲染節流(idleSkip 6/12/20、活動幀上限 60/30/20fps、暫停)。**心跳不變量**:`sameLimit = 1000/interval`,任何輪詢頻率下強制心跳都 ≈1s,拖曳看門狗(1200ms 判死)不餓死;suspended 時 renderer 主動清拖曳旗標(輪詢停了,看門狗不會再被觸發)。全寵休息=停輪詢。
- **P3 串流**:main 端 33ms 合併 text delta(原每 token 一次 IPC;非 text 事件先 flush 嚴格保序);renderer 端 renderReply 改 rAF 批次;replyRaw 60k 上限(截頭保尾切段落邊界、補奇數 code fence 防後文全變 code block)。整輪成本 O(n²)→O(n)。
- **P4 hover 熱路徑**:泡泡定位(整棵骨骼投影 60-120/s)加 100ms 節流;containsPoint 的 getBoundingClientRect(強制 layout)加 100ms 快取;游標輪詢在 DOM mousemove 流存活時整段跳過(原 setLookAt 重複做兩份);runtimeAt/screenToWorld 免每呼叫配置;settings render() rAF 合併 + 高頻 IPC 50ms trailing 節流。
- **P5 多寵記憶體**:VRM 讀檔快取(mtime 比對,N 寵同模型只讀一次,30s 釋放);viewer resize listener 洩漏修復;mcp-config 重用;模型清單 10 分鐘 TTL。
- **否決**:單 renderer 多 viewport——與「逐行對照官方範例」原則正面衝突(hit probe/snapshot/wake 集全部要重寫),現狀「每寵一份完整官方結構」反而最忠實;「休息」已是資源閥門。

### e2e 全回歸抓到的既有 bug:claude cancel 三層卡死

P5 收尾跑 claude 真 CLI e2e,6 項 FAIL(cancel 起全數連鎖)。**不是效能改動造成**——是 §29 表演規則提示之後 claude e2e 從未重跑,行為變化(模型先玩工具、60 秒不吐字)踩出三層舊 bug:

1. **孤兒 MCP 子行程佔住 stdio**:cancel SIGKILL 殺了 claude,但它 spawn 的 petToolsServer.mjs 沒有「stdin 關閉即退出」,孤兒佔著繼承的 fd → 宿主行程的 `close` 事件永遠不來 → queue 不終結 → turn 卡死。修:MCP 腳本 `rl.on('close', () => process.exit(0))`。
2. **晚到的 close 刪掉新 turn 的註冊(race)**:同 session 連續兩 turn 共用同一個 id 當 `running` 的 key;上一 turn 的 `close` 若在下一 turn spawn 之後才到,無條件 `running.delete(id)` 會把新 turn 的 child 刪掉 → cancel 找不到行程(debug 實錄 `child=無`)。以前被第 1 層 bug 蓋住(close 根本不來就不會刪)——**修一層露一層**。修:close 清理只刪「仍指向本 child」的條目。
3. **保險**:cancel 後 2.5 秒 close 還沒處理就強制 push done ok:false + 收隊(任何未知的 stdio 佔用都不再卡死 turn)。

修畢 claude/codex 真 CLI e2e 各 13 項全 PASS。

### 量測(3 寵,AC/normal 檔)

| | 優化前 | 優化後 |
|---|---|---|
| main idle | 1.0–5.5% | 0.8–1.1% |
| renderer idle | 8.0%(低點) | 6.5–7.6% |

normal 檔 idle 參數未變,大頭在:eco/critical/suspended 檔位(電池/過熱/鎖屏,原本鎖屏照樣 30ms 輪詢+10fps 渲染)、hover(骨骼投影降一個數量級)、串流(O(n²)→O(n))。

### 教訓

1. **修一層 bug 可能露出被它蓋住的下一層**(孤兒佔 fd → close 不來 → delete race 從不觸發):修完必須跑完整回歸,而不是只驗這次改的路徑。
2. **行為型提示(表演規則)改變模型行為 = e2e 前提改變**:提示改完要重跑受影響家別的 e2e,不能只跑改動的那家。
3. 以 pid/child 身份做清理判斷,**不要以共用 key 無條件刪**——凡是「上一代的延遲回呼」都可能踩到新一代的狀態。

---

## 35. 拖放檔案穿透疊層——疊層視窗收不到 OS 拖放,接收窗解法(2026-07-30)

- **症狀**(使用者實機):把檔案拖到寵物身上放開,參考檔案功能毫無反應,**檔案還被 Finder 移到桌面**——拖放整個穿透疊層。
- **三輪實驗定位**(每輪一次真實拖曳):
  1. 診斷 log:拖曳全程 **0 個 drag 事件**(連 dragenter 都沒有)→ 視窗不是拖放目的地。
  2. 加 log 看 hover 鏈:拖曳中 `interactive → true` **有**發生(游標壓到寵物時視窗確實切成可互動)→ 推翻「hover 鏈斷掉」;先假設「目的地資格在拖曳 session 開始時定案、中途 setIgnoreMouseEvents 無效」。
  3. 決定性實驗:**從啟動就永遠可互動**(setIgnoreMouseEvents(false))照樣 0 事件 → 推翻第 2 步的假設——**疊層視窗的屬性組合(透明 + panel + 不可聚焦 + screen-saver 置頂層)天生收不到 macOS 拖放**,與 click-through 狀態無關。對照組:同 app 開一個「不透明+可聚焦+floating」的一般小視窗,dragenter/DROP 全收到。
- **解法(仿 Finder 彈簧資料夾)**:拖曳進行中「亮出新視窗」是系統允許的——
  1. **全域檔案拖曳偵測**([dragMonitor.ts](../src/main/agent/../dragMonitor.ts)):長駐一個 osascript(JXA)子行程,輪詢拖曳剪貼簿 `NSPasteboard(drag)` 的 changeCount(拖曳開始遞增)+ `NSEvent.pressedMouseButtons`(左鍵放開=結束),且只認內容含 `file-url` 的拖曳(拖文字/視窗不觸發);掛掉自動重啟、連續失敗即停用不擾民。
  2. **偵測到拖曳開始** → main 向 renderer 要各寵的螢幕矩形(`projectedPetBounds` 投影)→ 在每隻寵物位置亮出**一般屬性**(不透明+可聚焦+floating,`showInactive` 不搶焦點)的小接收窗「📎 放開加入參考檔案」;半透明用 `setOpacity(0.72)` 而非 `transparent` 屬性(後者就是死因之一的嫌疑組合)。
  3. 接收窗共用主 preload(webUtils 取路徑 → 既有 `ref-files-add` IPC);**.vrm/.vrma 也走接收窗**維持換模型/播動作語意——疊層收不到拖放代表原本的「拖放換模型」其實也是壞的,一併救回。拖曳結束(放開左鍵)緩 300ms 收窗,讓 drop 先處理完。
- **教訓**:
  1. **「有 handler ≠ 收得到事件」**:桌面疊層這種特殊視窗,OS 層級的能力(拖放目的地資格)要用實驗驗證,不能只看 DOM 層寫了什麼。renderer 端的 drop handler 從 v1 就在,直到使用者真的拖了才發現整條路是斷的——**headless e2e 與瀏覽器驗證頁都蓋不到「OS 把不把事件給你」這層**。
  2. 逐步實驗設計:每輪只驗一個假設(有沒有成為目的地 → hover 鏈有沒有動 → 資格是否 session 開始定案 → 哪組視窗屬性可行),四次拖曳就從「完全不知道」走到「平台結論 + 可行解」。
  3. macOS 平台實證(勿改回去):透明+panel+不可聚焦+screen-saver 層的視窗**收不到任何拖放**,永遠可互動也沒用;但拖曳中途「新出現」的一般視窗可以收(Finder 彈簧資料夾同原理)。

---

## 36. 對話泡泡圖片附件、按壓鎖定與外側狀態提示(2026-08-03)

- **剪貼簿圖片**:輸入框支援直接貼上 PNG/JPEG/WebP,泡泡只顯示附件數量、不產生縮圖;允許純圖片訊息。renderer 每輪最多收 4 張、單張 8 MiB,main IPC 再做 MIME、base64、數量與長度檢查。Codex 使用 app-server 原生 `{ type:'image', url:dataURL }` 輸入(以本機 generate-ts 核對協定);Claude 將圖片寫入短命暫存檔並提示 Read 工具讀取,turn 結束立即刪除。Mock bridge 自驗補純圖片訊息傳遞案例。
- **按住不收合**:泡泡顯示時若滑鼠按下,renderer 記住當下泡泡並取消隱藏計時;游標離開角色或泡泡仍保持展開,直到 mouseup 才重新依游標位置判斷。blur/visibilitychange 與寵物移除會清除鎖定,避免漏掉 mouseup 後永久卡住。
- **常駐圖釘**:泡泡依自身位於螢幕左/右半邊,把控制放到遠離螢幕中心的外側上角。34px 隱形感應區只有在游標靠近時才淡入 14px 圓形圖釘;啟用後泡泡不再因 hover 切換或游標移開而收合。
- **已讀狀態提示**:外側下角顯示「燈點 + 單行小字」,區分執行中(藍)、等待核准(橘)、完成(綠)、錯誤(紅);進行中狀態會脈動,並遵守 `prefers-reduced-motion`。狀態改變時重新出現,游標停留 500ms 視為已讀後淡出。
- **驗證**:`npm run typecheck`、`npm run build`、`git diff --check` 通過。沙箱禁止 Electron dev server 監聽 `::1:5173`,因此本輪未完成實機 UI 操作驗收。

---

## 37. 獨立「沙盒設定」視窗——由桌寵直接管理專案 Codex 設定(2026-08-03)

- **需求**:使用者要在桌寵設定中調整工作專案的 Codex 沙盒,按下後直接在工作目錄生效,不把「修改權限」再交給受該權限限制的 AI 執行。
- **介面與風險隔離**:右鍵選單把「沙盒設定…」獨立放在一般「設定」之外,另開專用視窗；一般設定頁完全移除沙盒分頁、DOM 與 renderer 邏輯,無法從光影/角色/動作/工作頁切換進去。專用視窗可選 `approval_policy`、`sandbox_mode`、`sandbox_workspace_write.network_access`;預設推薦 `on-request + workspace-write + network`,完整存取另有二次警告。頁面可直接選擇寵物與工作目錄,並明示套用目錄、設定檔路徑與重新開啟 Codex 工作階段後生效。
- **卡在讀取的回復**:讀取期間只停用「套用」而不鎖住下拉選單;IPC 讀取 4 秒、寫入 8 秒未回覆會顯示可理解的錯誤並恢復操作,避免 main/preload 尚未重載或磁碟異常時整頁永久停用。另拒絕非一般檔案的 `config.toml`,避免讀到 FIFO 等特殊檔案時懸置。
- **安全邊界**:renderer 只傳固定 enum/boolean,preload 暴露受限 IPC;main 只接受獨立沙盒視窗的 sender（一般設定視窗呼叫會被拒絕）,再驗寵物與工作目錄,拒絕 `.codex`/`config.toml` 符號連結,不接受任意路徑、腳本或 shell 字串。寫入採同目錄暫存檔 + rename 原子替換。
- **保留既有設定**:更新器只替換 root 的 `approval_policy`/`sandbox_mode` 與 `[sandbox_workspace_write]` 的 `network_access`,其餘 model、MCP、writable_roots 等內容原樣保留;若偵測到 granular approval 等進階格式,套用前在頁面警告會被標準選項取代。
- **驗證**:新增純函式合併/解析 selftest;另以獨立 probe 驗證既有 model/MCP/writable_roots 保留且三項設定可讀回。`npm run typecheck`、`npm run build`、一般設定與獨立沙盒頁 DOM id 對照及 `git diff --check` 通過。

---

## 38. 工作目錄辨識與遠距縮放收尾(2026-08-03)

- **工作目錄辨識**:泡泡顯示專案根目錄名稱並保留完整路徑提示；設定視窗與右鍵寵物選單依標準化後的工作目錄分組，未設定工作目錄的寵物集中顯示，讓多專案環境較容易辨識。
- **遠距縮放**:桌面滾輪縮小上限由相機距離 12 放寬到 30，同步把 PerspectiveCamera far plane 從 20 調整為 100，避免相機超過舊裁切面後角色整隻消失。
- **驗證**:`npm run typecheck`、`npm run build` 與 pre-commit secrets 檢查通過。

---

## 39. 審批拒絕回饋、泡泡收合與寵物系統重啟(2026-08-03)

- **執行中泡泡收合**:修正 `busy` 被誤當成常駐條件；未釘選的泡泡在 agent 執行期間仍會於游標移開後收起，只有使用者主動開啟圖釘才保持展開。
- **拒絕時可附調整方向**:審批區加入最多 1000 字的回饋欄位與內容捲軸。Claude 直接把文字放入 permission deny message；Codex 舊協定使用 rejection，新協定在 decline 後用 `turn/steer` 把調整方向送進同一 turn。收起審批框前主動 blur，避免透明 overlay 留在鍵盤輸入模式造成桌面像卡住；審批回覆失敗時顯示錯誤並中斷 turn。
- **單寵重啟**:右鍵選單可只重建目前角色的 renderer、模型、泡泡與 agent runtime，保留 transform、profile 與已持久化 session；provider 關閉最多等待 2 秒，避免單寵重啟被外部程序卡死。
- **整體重啟最終方案**:Electron 啟動時將自身 PID 寫入 `runtime-data/pet-system.pid`，選單只觸發固定地端腳本 `scripts/restart-pet-system.sh`。腳本讀 PID，先送 SIGTERM、5 秒未退出再送 SIGKILL，等待 electron-vite 釋放資源後於專案根目錄重新執行 `npm run dev`；過程寫入 `runtime-data/pet-system-restart.log`。不再使用 `app.relaunch()`，也不由 Electron 傳入或推測重啟命令。
- **實機驗收**:使用者確認地端腳本重啟成功。另通過 shell 語法檢查、`npm run typecheck`、`npm run build` 與 `git diff --check`。

---

## 40. 效能二輪:待機動作成本與 ProMotion 盲點(2026-08-04)

**背景**:待機動作上線後,閒置 renderer CPU 從 P5 基線的 6.5–7.6% 漲回 15–35%。逐項排查發現兩層原因,第二層是所有節流參數共同的盲點。

### 第一層:待機動作的隱性成本(三個修正)

1. **動作結束的全速尾巴**:`finished` 後仍要熬過完整 IDLE_DELAY(3 秒)才進節流——那個緩衝是給「使用者互動後」spring bone 安定用的,動作播完只需 ~0.6 秒。修:`finished` 時回撥 `lastActiveAt`。
2. **多寵同時播**:各寵 timer 獨立,常兩寵同時全速疊 GPU。修:全域互斥(10 秒窗口),同時只有一寵播,撞鎖順延;輪流動視覺上也更自然。
3. **待機播放半幀率**:`vrma-play` IPC 加 lowPower 旗標(只有待機排程帶),viewer 播放期跳幀加倍(≈30fps);手動選單與 agent 的 `pet_play_motion` 維持全速。MAX_DT 既有鉗制保護物理。

### 第二層(真正的大頭):節流參數是 60Hz 思維,ProMotion 白燒一倍

**診斷路徑**:對照組(無待機動作)CPU 依然 28–31% → 動作不是主因;新增 `VRM_PET_PERF_LOG=1`(main 每 5 秒 `executeJavaScript` 讀 `window.__perf`,疊層開不了 DevTools 的唯一通道)看 render/rAF 比例——**rAF 計數 1000/5s 曝露螢幕是 ~100–120Hz**:`IDLE_SKIP=6` 在 120Hz 上只降到 20fps(設計是 10fps),「全速」更是直接跑 120fps。

**修**:viewer 以 EMA 估實際幀距(`rafDtEma`),幀距 <12ms(>83Hz)時所有跳幀 ×2,把有效幀率鎖回 60Hz 設計值(活動 ≤60fps、閒置 ~10fps、eco 30fps…全檔位自動適用)。

**量測(兩寵、無待機動作、ProMotion 螢幕)**:

| | 修正前 | 修正後 |
|---|---|---|
| renderer 閒置 | 28–31% | **9–10%** |
| GPU 行程 | 21–24% | **5.4%** |
| 閒置 render/rAF | ≥0.38 | **0.08**(=1/12 ✓) |

另:dragMonitor(拖曳偵測 helper,常駐 0.4–0.9%)接上功率檔位——suspended 或全寵休息時暫停輪詢,與游標輪詢同進退。

**教訓**:所有「每 N 幀」的節流參數都隱含了 60Hz 假設;高更新率螢幕(ProMotion)上 rAF 是 120Hz,固定 N 的實際效果全部砍半。**跳幀參數要用「目標 fps」思維換算,不能用固定除數**;而 rAF 計數本身就是最便宜的螢幕更新率偵測器。

---

## 41. 對話佇列:輸入不鎖、排隊接續(2026-08-04)

**需求**:turn 進行中不鎖輸入框,再送出的訊息排隊;turn 完自動取下一則;泡泡列出排隊訊息可逐則 ✕;停止只停當前、佇列續行;架構預留中控面板(對各寵指派任務)。

**設計要點與踩掉的坑**(細節見 AGENT-BRIDGE-DESIGN §10):

1. **onTurnFinished 不能掛 runTurn 內部的 finally**——早退路徑(無 workspace、backstop)不經 try/finally,掛錯位置佇列會永久卡死。掛在 `chatSend` 的 `runTurn().finally(...)`:任何路徑都觸發,且在 running=false 之後的 microtask,時序天然正確。
2. **「佇列已滿」不可走 error 事件**——renderer 對任何 error 無條件 `endTurn`,會把進行中 turn 的 UI 誤終結。`chat-send` 改 `ipcMain.handle`,泡泡同步拿 `{queued, position, reason}`。
3. **beginTurn 不可再清輸入框**——佇列自動接續時使用者可能正在打下一句,原本的清空會洗字。清空移到「invoke 回覆已接受」時(`clearComposer`);同理 beginTurn/endTurn 不再 disable/enable 輸入框。
4. **全域上限釋放要 dispatchAll**——上限 4 是跨寵計數,寵 A 結束釋放的名額可能輪到寵 B;依各寵隊首等候時間排序防飢餓。
5. **turnStart 事件解耦「送出」與「開始執行」**:只由 main dispatcher 發(bridge 不發),renderer 據此 beginTurn;與 33ms text 合併器天然保序(非 text 事件先 flush;done 在 finally 前、turnStart 在 finally 後)。
6. 就地錯誤(workspace 未設)原本用 `endTurn(false)` 顯示——busy 中會誤終結,新增 `showError`(不動 busy)。

**驗證**:selftest 佇列 12 項(純邏輯 + mock 全鏈:排 3 依序接續、中途移除、cancel 續行、turnStart 保序)、bubbletest 7 項(busy 可打字、打字不被接續洗掉、✕ 回呼、showError 不動 busy 等)、typecheck/build 全綠。

**追加(同日):任務歸屬語意**——使用者釐清:泡泡投入必綁定該寵(從誰的泡泡進來就誰做,模組層強制缺 assignee 拒收);中控台將來可投**不綁定**任務進公用池,任何「啟用中且已設工作目錄」的寵物在自己佇列空檔時領取(claim 時才寫入 assignee)。綁定佇列永遠優先於領公用單;寵物休息只清自己的綁定佇列、公用池不動;喚醒即觸發 dispatchAll 領單。selftest 歸屬 7 項(必綁拒收/公用投單/clear 不動池/claim 最舊/removeUnbound/綁定優先/空檔依序領)全 PASS。

**教訓**:改「樂觀 UI」(先 beginTurn 再送)為「事件驅動 UI」(turnStart 才 beginTurn)時,所有原本綁在樂觀路徑上的副作用(清輸入框、鎖定、清附件)都要逐一重新歸位——它們各自屬於「送出被接受」「開始執行」「結束」三個不同時刻,混在一起就是這次三個坑的根源。

## 42. 新增寵物自動建立預設工作目錄(2026-08-06)

**需求**:新寵物的 `workspacePath` 原本完全不填,只靠建立後自動打開「工作」分頁提醒手動選;使用者忘記調整就會被 bridge 擋下,或隨手選到不該用的目錄造成工作區污染。改為新增寵物當下自動在 `<根位置>/<寵物名>_<建立時間>/` 建好專屬目錄並寫入 profile;根位置是全域設定(預設 `~/Documents/PetWorkspaces`),可在設定面板「工作」分頁變更。

**設計要點**:

1. **全域設定的落點**:專案原本沒有任何全域使用者設定容器——逐寵設定在 `pets/<id>.json`,`app.json` 只有 registry 三欄。新欄位 `defaultWorkspaceRoot` 直接加進 `AppRegistry`(optional、schemaVersion 不升版):persist 是整個 registry `JSON.stringify`,零改動;但 `loadConfigSync` 以字面量嚴格重建 registry,**必須補讀回該欄位否則重啟就被洗掉**(legacy 遷移路徑不用動,不填 = 用預設值)。
2. **純函式與 fs 分層**(`workspaceDefaults.ts`,循 `sandboxConfig` 先例):名稱消毒(去 `/\:*?"<>|` 與控制字元、空白移除「寵物 3」→「寵物3」、去頭尾點、截 60 字、全空退 `'pet'`)、時間戳 `YYYY-MM-DD_HH-mm-ss`、同秒碰撞加 `-2`/`-3` 序號——這三層是純函式,selftest 直接驗;fs 包裝 `createDefaultWorkspace` 任何失敗(根位置唯讀、磁碟拔除)回 `null`,寵物照建、`workspacePath` 維持未設定,退回原本 bridge 擋門行為,不彈 dialog 不加新錯誤路徑。
3. **兩個入口零分叉**:Tray「新增寵物」與設定面板 ＋ 鈕都收斂在 `createNewPet()`,只改這一處;建立後照舊自動開「工作」分頁,正好讓使用者看到自動配好的路徑。
4. **變更根位置只影響之後新增**:`createNewPet` 呼叫當下才讀 `workspaceRoot()`,既有寵物 profile 不碰;刪除寵物也不動已建目錄(裡面可能有 agent 產出、多寵可共用 workspace,循 removePet「只搬 .trash 不硬刪」的保守慣例)。
5. **IPC 循既有安全慣例**:`choose-workspace-root` 僅接受 settingsWin 的 sender;dialog 前 `app.focus({steal:true})`(背景 app 的 dialog 會被壓住);變更後 `workspace-root-apply` 推播回設定面板即時更新。

**驗證**:typecheck 綠;selftest 補 5 項純函式檢查(消毒去空白/去不合法字元/全符號退 pet/名稱_時間戳格式/同秒碰撞序號)全 PASS;fs 層以 esbuild 轉譯實測:正常建立、同秒連建第二個帶 `-2`、`/System` 下唯讀根位置回 null 留 log。

## 43. 中控面板 v1:多寵總覽、指派任務、審批代答(2026-08-06)

**需求**:實作 §41 與 AGENT-BRIDGE-DESIGN §10 預留的中控面板——多寵狀態總覽(只顯示狀態燈號)、指派任務(綁定/公用池)、佇列顯示與撤單、寵物控制(休息/喚醒/開新對話/工作目錄)、逐寵沙盒設定入口、系統重啟/結束、審批可在中控直接核准。

**設計要點**:

1. **文件約定原樣兌現**:公用池 API(`unboundSummaries`/`removeUnbound`)從零接線到首度接上;`onChanged(undefined)` 的 no-op「先不廣播」改為推快照;中控走自己的 `control-enqueue`(sender 限 controlWin,`chat-send` 保持泡泡專用)。**enqueue 不自動派發**——成功後必補 `dispatch(assignee)` 或 `dispatchAll()`,否則公用單躺到下一次 turn 結束才被領。
2. **全量快照而非事件差分**:中控吃 `ControlStatusSnapshot`(每寵 phase/佇列 + 公用池),50ms trailing debounce 推播;開窗先 `control-status-get` 拿 snapshot——晚開視窗只靠事件流會漏掉進行中的 turn,這是 bridge 必須新增 `petStates()` 的原因(states Map 模組私有,原本只暴露 canAccept)。`text` 增量一律不進中控:33ms 合併節奏的高頻 IPC 不打第二視窗,中控只要燈號。
3. **審批雙 UI 的 race 在源頭擋**:bridge 的 `PetAgentState` 新記 `pendingApproval`(requestId+description;pending 審批原本只存在事件流裡,晚開窗拿不到 description);`respondApproval` 加 requestId guard——不符掛著的審批直接忽略,否則過期 id 打到 provider 走 catch → error 事件 + cancel,誤殺進行中 turn。回覆成功發新事件 `approvalResolved`(**非終結事件**,renderer 只收合審批 UI 不得 endTurn),泡泡新增 `hideApproval`(中控代答後泡泡原本會殘留過期按鈕;收合前必須 blur,循透明層輸入模式的既有坑)。
4. **安全邊界**:`chat-approval`/`chat-queue-remove`/`new-session`/`choose-workspace` 只放寬到 controlWin 這一個具名視窗;`sandbox-settings-get/set` **維持只收 sandboxSettingsWin**——中控每寵只放按鈕開既有隔離視窗,不內嵌、不打穿高風險寫檔通道的視窗隔離。`system-quit` 同 Tray:app.exit 不觸發 before-quit,必先 shutdownSync(§22 已知坑)。
5. **型別收斂**:`QueuedMessageSummary.source` 原是寬鬆 string,與 chatQueue 的聯集平行定義——收斂為 `ChatTaskSource`('bubble'|'control'|'selftest')一份維護,中控據此標色。
6. **刻意不做**:頭像(無 invoke getter)、公用池投圖片、審批 feedback 欄、controltest 自驗頁(UI 全依賴 window.pet,瀏覽器開不了,mock 整層 preload 成本超過收益)。

**驗證**:typecheck 綠;selftest 補 7 項(中控帶/缺 assignee 歸屬、池滿 20 拒收、removeUnbound 不存在回 false、petStates 審批快照、錯誤 requestId 被忽略、approvalResolved 事件、回覆後清空)全 PASS(共 52 項);`npm run build` 確認 control.html 進 bundle(vite renderer input 漏加會 dev 正常 build 白畫面的已知坑);dev 短跑無啟動錯誤。

**追加(同日):v2 改版——逐寵列表與任務帳本**。使用者定案:版面改為逐寵一列(名稱/工作區/喚醒休息/狀態/逐寵指令輸入),清醒與休息分區、各按最後回報新→舊(bridge petStates 補 lastActivity;休息列輸入禁用);公用任務發佈可**限定工作區 = 指定運行路徑**(`restrictWorkspace` 進 QueuedTask,`claimUnbound(petId, workspacePath)` 跳過不合格單取最舊合格,dispatcher 補 `workspaceOf` dep;領單寵物本來就在自己 workspacePath 執行,限定即保證 cwd);新增**任務帳本**回答「誰收到/在哪執行/執行狀態」——佇列的單被領走就消失,無從追蹤,帳本(`ControlTaskRecord`,只收中控投的任務)記 queued→running→done/failed/removed 全程,公用池單在**領走那一刻**補接收者與執行位置,`runningTaskByPet` 把逐寵的 done/error 事件對回任務 id(泡泡任務不進帳本、不進這張表,天然不干擾);已終結保留 50 筆、記憶體不落盤。`enqueue` 回傳 id 供帳本鍵;中控全量重繪會清 DOM,各列輸入框草稿與焦點以 petId 暫存重繪後回填。selftest 補 5 項(enqueue id、限定工作區跳過/normalize/全池不合格)全 PASS。

## 44. 狀態膠囊已讀前不隨泡泡收合消失(2026-08-06)

**症狀**:寵物完成/失敗任務時,泡泡外側下角的狀態膠囊(§36 的外側狀態提示)會在游標移開、泡泡 160ms 自動收合(§39 busy 不再常駐)時一起消失——使用者沒看到結果就不見了。

**根因**:膠囊 DOM 是 `.pet-speech-bubble` 的子節點,收合時父層 `opacity: 0; visibility: hidden` 整棵蓋掉。狀態資料其實沒被清(endTurn 後無 reset timer),純可見性問題。

**處理**:父層隱藏拿掉 `opacity: 0` 只留 `visibility: hidden`(CSS visibility 可被子元素覆寫,opacity 不行——這就是差別所在);加規則讓「已定位過(.placed)且未讀(:not(.read))」的膠囊在泡泡收合後 `visibility: visible` 突圍留在原位。已讀機制照舊(hover 500ms 標 read 淡出)。配套:(1) `showAt` 加 `reveal` 參數與 `.placed` 標記,`positionSpeechBubble` 新增 placeOnly 模式——泡泡從未打開過(如從中控派工)時,turnStart/approval/done/error 事件會把膠囊定位到寵物旁,否則會停在未定位的 0,0;done 時順便校正位置(執行期間寵物可能被拖走)。(2) `containsPoint` 在泡泡收合時改判膠囊 rect(有自己的 100ms 快取)——游標壓上殘留膠囊時視窗才會轉互動,`updateHover` 的 bubbleHit 分支順勢重新展開泡泡看內容。

**教訓(自驗環境)**:bubbletest 在背景分頁跑時 `document.visibilityState === 'hidden'`,**CSS transition 不推進**,computed style 永遠停在起始值——量測 visibility 前要先把 `getAnimations()` 的 CSSTransition `finish()` 掉(infinite keyframes 如脈動點不能 finish,要過濾),否則會把轉場延遲誤判成規則沒生效。瀏覽器自驗 5 項(收合留存/已讀淡出/失敗紅膠囊/containsPoint 命中語意/執行中膠囊)全過。

## 45. i18n 四語支援:繁中/英/日/韓(2026-08-06)

**需求**:全 UI(Tray/設定面板/中控面板/泡泡/dialog/錯誤訊息)加 i18n,AI prompt 也跟隨 UI 語言(影響 AI 回覆語言);設定入口在設定面板「工作」分頁全域區塊;預設跟隨系統語系(zh*→繁中,en/ja/ko 對應,其他退英文);切換即時生效。

**架構決策**:

1. **字典一語一檔**(`shared/i18n/` 五檔,約 210 key):zh-Hant 是基準(`MessageKey = keyof typeof zhHant`),其餘三語 `satisfies Record<MessageKey, string>`——**漏翻/多翻都是編譯期錯誤**,不需 runtime 檢查工具。`t(key, params)` 自帶 `{name}` 插值,fallback 當前語→zh-Hant→key 原文。純 TS 零相依,main/renderer/selftest 共用,不破壞 chatQueue「純邏輯」慣例。
2. **語言存 `registry.locale`**(照 defaultWorkspaceRoot 先例,loadConfigSync 重建點讀回保留)。**時序陷阱**:normalizeProfile 的預設寵物名(寵物 N)在 loadConfigSync 內產生——開頭先 peek registry 檔的 locale 再 setLocale,否則首載缺名寵物拿到錯語言的名字。預設名是**建立當下語言寫成資料**,不回溯。
3. **切換鏈**:`locale-set`(sender 限 settingsWin)→ main setLocale → 廣播 `locale-apply` 三視窗 → refreshTray/setToolTip/setTitle → **清 modelListCache**(claude 模型 label 含翻譯,10 分鐘快取會殘留舊語言;renderer 端 modelLists 快取同清)。
4. **靜態 HTML 走 `data-i18n` 屬性 + applyI18nDom() 掃描**(textContent/title/placeholder/aria-label 四種),原繁中文字保留在標籤內當 fallback 兼可讀。含 markup 的 label(X/Y 軸標)把文字尾段包進獨立 span 才能標注。
5. **模組常數陷阱**:control.ts 的 PHASE_LABEL/STATUS_LABEL 這種模組層 `Record<..,string>` 會在載入時凍住舊語言——一律改函式取值。
6. **泡泡換語言 = 逐元素更新不重建**(重建丟串流回覆):create 時寫死的 ~15 處靜態標籤集中成 `applyStaticTexts()`,`applyLocale()` 重呼叫;暫態文字(思考中…/膠囊當下狀態)留舊語言到下一事件,明文接受。中控/設定面板則靠全量重繪天然支援。
7. **AI prompt 跟語言**:persona 前綴/表演規則/審批描述/拒絕回饋/圖片提示全 t()。codex 的 syncContext 以組合字串比對——**換語言使比對值改變,下個 turn 自動 inject 新語言指示,免額外邏輯**(程式內註解明寫此依賴)。
8. **刻意不翻**:sandboxConfig 的 MANAGED_COMMENT(寫入使用者 config.toml 的資料,移除邏輯靠精確比對)、codex clientInfo.title、console.log/selftest/註解/docs、語言下拉的語言自稱(業界慣例)。

**驗證**:typecheck 綠(四語字典 key 齊全由型別保證);selftest 補 5 項(resolveLocale 對應/插值/缺參數保留/假 key 不炸/切語言取值不同)全 PASS;build 綠;bubbletest 瀏覽器自驗四語切換(label 插值/placeholder/按鈕)全對;dev 短跑無開機錯誤。

## 46. MMD/PMX 與 ARP rig 進 VRM:自建轉檔管線(2026-08-09)

**背景**:想擴充模型來源。網路上的角色多半不是現成 VRM——MMD 圈是 `.pmx`、VRChat 圈是 `.unitypackage` 或 `.blend`,BOOTH 上標「VRM 對應」的也常常只附前兩者。

**做法**:Blender headless(`blender -b --python`)+ Node 後處理,沉澱成四支腳本:

- `blender-pmx-import.py` / `blender-pmx-to-vrm.py`:mmd_tools 匯入 PMX → MMD 日文骨名對映 VRM humanoid → 匯出 VRM0
- `blender-arp-to-vrm.py`:Auto-Rig Pro rig → VRM1
- `vrm0-fix-mmd-materials.mjs`:MMD 材質 → MToon
- `vrm1-add-springs.mjs`:VRM1 依骨名找鏈補 `VRMC_springBone`

**踩到的坑(全部有實測)**:

1. **Blender addon 的啟用順序**:`addon_utils.enable()` 必須在 `wm.read_factory_settings()` **之後**——反過來會被 factory reset 清掉,運算子註冊不到(`bpy.ops.mmd_tools.import_model` not found)。
2. **GBK 檔名炸掉貼圖**:PMX 的 zip 用 GBK 編碼,macOS 用 `ditto` 解出來檔名變亂碼 → PMX 內以原名引用貼圖找不到 → mmd_tools 塞 1×1 空白圖進去,模型渲染成全白。**依檔案大小把檔名對回去**才解決。(`unzip` 更慘,直接 `Illegal byte sequence` 解不出來。)
3. **貼圖接錯欄位**:mmd_tools 把貼圖接在 `emissiveTexture` 且 `baseColorFactor` 為黑,VRM 讀的是 `baseColorTexture` → 白模。轉接後才有顏色。
4. **描邊寬度單位**:`_OutlineWidthMode: 1`(世界座標)配 `_OutlineWidth: 0.08` = 8cm 厚的描邊殼,整層蓋住模型,看起來像白模加黑塊。改用相對模式(`Mode 0` + `0.5`)才對。
5. **ARP rig 的變形骨四散**:控制骨架把變形骨掛在根控制器下,自動對映會錯亂(head→脊椎、右小腿→右手)。得先**重建人形父子鏈**(26 處改 parent,rest pose 與權重不動)再指派。
6. **檔案裡不只一個角色**:Ren♡Ai 的 .blend 內含一個沒綁骨架的參考模型,要先剔除。

**教訓**:轉檔不是專案核心能力,腳本當「工具箱」留著即可,別做成產品功能——實測下來,現成 VRM 10 分鐘搞定,Blender 路線一小時起跳且每個模型的坑都不一樣。

## 47. MMD 轉制模型的三個顯示問題(2026-08-09)

**症狀 A:粉髮渲染成白髮**,還帶黑色塊。同一個檔在別的 app(Steam 的 VRM 播放器)顯示正常——**問題在我們的渲染**。

**根因 A**:MMD 的球面貼圖(sphere/spa)是「加法疊加」的反光層,轉檔工具常輸出成**不透明材質**;那張貼圖近乎純白,於是白色高光殼把底下的本體色整片蓋掉。逐一比對材質後發現罪魁是 `kami+` / `maegami+` 這種「+」結尾的外殼層。

**處理 A**:`viewer.ts` 載入後新增 `fixSphereOverlayMaterials`——材質名以 `+` 結尾者改回 `AdditiveBlending` + 不寫深度。對所有 MMD 轉制模型通用。

**症狀 B:腰帶垂飾硬邦邦、會穿過腿**。

**根因 B**:那些骨的名字是**簡體中文**(`结带`/`后带`/`頭绳`),而 `vrm-enrich.mjs` 的 pattern 只認日文(髪/スカート/袖/胸),整組漏掉 → 完全沒有 spring bone。

**處理 B**:新增「帯」與「紐」兩個骨群(腰帶吃腿部 collider、髮繩吃頭部 collider),既有 pattern 補簡繁中文;`swayCategory` 同步支援,設定面板的滑桿才調得到。神子的 spring 關節 227 → 290。

**症狀 C:設定面板整個點不動**,以為壞了。

**根因 C**:角色分頁的「選擇 VRM 檔」對話框沒掛父視窗 = app 層級 modal,開著時凍結同 app 所有視窗。使用者沒注意到對話框開在別處。

**處理 C**:改掛設定視窗成 sheet(循 `chooseWorkspace` 慣例)。

**教訓**:「同一個檔在別的 app 正常」是最有價值的一句回報——它把問題從模型端一刀切到渲染端。收到這種對照時應優先重現,而不是先懷疑素材。

## 48. 光源色溫(2026-08-09)

**需求**:桌寵的光偏死白,想要暖色/冷色氛圍。

**處理**:`Lighting` 新增選填的 `temperature`(Kelvin),`kelvinToColor()` 以 Tanner Helland 近似式換算 RGB,**同時套在環境光/平行光/點光源三盞上**——只染主光會出現「主光暖、環境光白」的違和。6500K 落在純白附近,所以中性時等同沒著色;舊設定檔缺欄位視為 6500,既有寵物外觀不變。

**容易漏的點**:角色頭像快照是 `setLighting` 之外的**獨立打光路徑**(強制標準亮光拍),色溫也要在那裡還原成白光,否則面板小人會被染色。

**後續修正(§48b,同日)**:滑桿方向。物理上 Kelvin 越小越暖,照數值排就是「左暖右冷」,與 Lightroom 那類工具的習慣相反,手會拉錯邊。改成**位置與 Kelvin 鏡射**(`TEMP_MIRROR = 1800 + 12000`,自身即反函數):存檔與渲染仍是實際 Kelvin(viewer 一行沒改),只有 UI 位置翻面,軌道漸層同步改成冷→白→暖。

**教訓**:物理正確 ≠ 介面正確。既有工具的肌肉記憶優先於數值方向,兩者衝突時在 UI 層鏡射,不要動資料語意。

## 49. 上次對話回填(2026-08-09)

**症狀**:agent session 本來就續著(AI 記得上下文),但重啟後泡泡是空的,使用者看不到聊到哪。

**處理**:`sendChatEvent` 是所有 agent 事件的**唯一匯流點**,在那裡累積逐字稿(turnStart 記使用者訊息、text 累積回覆、done/error 落盤),不必在多處各記一份。存 `runtime-data/transcripts/<petId>.json`——**刻意不放進寵物設定檔**:設定檔會被拖曳位置高頻改寫,幾十 KB 的逐字稿混進去等於每次拖動都重寫一遍。落盤只發生在 turn 結束。

**生命週期**:開新對話與刪除寵物清掉紀錄(`clearTranscriptHook`,循 `clearChatQueueHook` 慣例);休息不清(只是釋放資源,對話還在)。

**競態**:回填是非同步 pull,泡泡端必須讓「進行中的一輪」優先——`restoreTranscript` 在 busy 或已有內容時直接跳過,否則會蓋掉已經開始串流的當前輪。

## 50. 中控面板:就地改名與全域分頁(2026-08-10)

**需求 A**:中控看得到全部寵物卻改不了名(改名只有設定面板的角色分頁能做)。

**處理 A**:名稱改成外觀不變的按鈕,點一下切輸入框;Enter/失焦送出、Esc 取消。**關鍵約束**:中控快照每 50ms 就可能重繪整個列表,編輯狀態放在 DOM 上會打到一半被洗掉——`renamingPetId` 與草稿存模組層、重繪後補回焦點與游標位置(循既有 `draftByPet` / `focusedPetInput` 慣例)。Enter 會連帶觸發 blur,以 `settled` 旗標保證只送一次。

**需求 B**:「全域:新寵物預設位置」掛在總覽最下方,要捲到底,且語意上像跟某隻寵物有關。

**處理 B**:獨立成第三個分頁(總覽/全域設定/沙盒設定)。接線不動——路徑在模組載入時就 pull 過,不受分頁隱藏影響。

**附帶**:中控一直沒有驗證頁,這次補了 `__applySnapshot` 鉤子,可直接開 `control.html` 灌快照測列表行為(`window.pet` 用測試專用 preload 補一份 stub——頁面模組載入當下就會呼叫 `onSwitchTab`,事後補 stub 來不及)。

## 51. ⌘Q 誤觸:兩種殺法,兩層防護(2026-08-10)

**症狀**:太容易不小心按到 ⌘Q,一按整窩寵物全收掉。

**第一層(不夠)**:`before-quit` 加二次確認對話框。用非同步 dialog(同步版會卡住 main 的 event loop,登出/關機時整台機器等在這裡);預設鈕與 cancelId 都指向取消;先 `app.focus({ steal: true })`(背景 app 的 dialog 會被壓在其他視窗底下)。確認後走 `app.exit`,不再回到 before-quit。

**回報:加了確認後按 ⌘Q 仍直接關閉,沒有任何提示。**

**真正的根因**:查行程祖先鏈發現

```
PyCharm → zsh(IDE 內嵌終端機)→ npm run dev → electron-vite → Electron
```

寵物系統掛在 IDE 的終端機下,**⌘Q 是 IDE 收到的**;IDE 一結束,整個 process group 吃到 SIGHUP 全滅——外部訊號,Electron 的 `before-quit` 根本不會執行。第一層只擋得住「焦點在寵物自己視窗」那條路。

**第二層(真正的解)**:`scripts/start-pet-system.sh` + `npm run start`——nohup 忽略 SIGHUP、有 setsid 就另開 session、再 disown 脫離 job control,讓寵物活得比啟動它的終端機久。腳本另有 PID 守門(已在運行就不重複啟動),避免 `predev` 的 pkill 把既有實例殺掉。

**教訓**:「加了防護還是沒生效」時,先確認**防護所在的那條路徑有沒有被執行**,而不是檢查防護本身的邏輯。行程祖先鏈(`ps -o ppid=,command=` 往上追)是最快的判別工具。日常啟動走 `npm run start`,`npm run dev` 只在要看即時 log 時用。

## 52. 泡泡寬度可調與點擊已讀(2026-08-09~10)

**寬度**:泡泡原本寫死寬度,長回覆很難讀。改成 `width: max-content` 隨內容伸縮 + 密度上限(醒著 ≤4 隻用半屏、>4 隻用三分之一屏),另加左右邊緣拖曳把手可手動設上限、雙擊還原。

- **調窄後拉不回來**:放開時把手動寬度寫成 inline `max-width`,而 CSS 的 `max-width` 永遠壓過 `width` → 下次拖曳只改 width 完全無效。修法是拖曳開始時先把當前寬度固定成 inline `width`、再清掉舊的 `max-width`。
- **把手拖不動**:疊層視窗的 `setPointerCapture` **靜默失敗**(呼叫不丟錯但 `hasPointerCapture` 為 false),游標一離開把手事件就斷。改把 move/up 掛在 `window` 上(與寵物拖曳同一套解法,已補進 CLAUDE.md 平台實證)。
- **把手凸出泡泡外 6px**,`bubbleAt` 涵蓋不到 → 按在把手上會被判成「按在寵物身上」而開始拖寵物。補 `isResizing()` 讓 hover 邏輯在拖曳期間保持互動。

**點擊已讀**:狀態膠囊原本只有「hover 膠囊本體滿 500ms」一條已讀路徑,但使用者常常是直接點進泡泡讀回覆——明明看到了卻還亮著未讀。泡泡根元素掛 `pointerdown` → `markActivityRead`(事件冒泡,點內部任何元素都算)。用 pointerdown 而非 click,拖曳把手那類「按下不放」的操作也算。

## 53. 疊層視窗不跟隨主顯示器變更(2026-08-09)

**症狀**:某隻寵物被切掉一半,只剩螢幕邊緣一條。

**根因**:疊層視窗只在建立時依 `screen.getPrimaryDisplay().bounds` 設一次大小。app 在筆電內建螢幕(1710×1107)啟動,之後換到外接螢幕(1920×1080),視窗沒跟著調整——右側 210px 成了「界外」,站在那裡的寵物幾乎全在視窗外,游標座標換算也整個偏掉。原本的 `display-metrics-changed` 只更新座標快取、不動視窗。

**處理**:改為 `syncOverlayBounds()`——主顯示器變更/新增/移除時把視窗重新 `setBounds` 鋪滿目前的主顯示,並同步游標換算用的快取;啟動時也跑一次保底。


## 54. 多寵記憶體:貼圖降階(2026-08-10)

**背景**:專案主打「養一群就是工程團隊」,但沒人量過多寵的實際成本。做了 `perftest.html?pets=N` 壓力頁(N 份 viewer,與 overlay 同一條路徑),配合 main 的 `app.getAppMetrics()` 讀 GPU/Renderer 行程真實記憶體。

**量到的基線**(AvatarSample_A,dpr=1):

| N | GPU | Renderer | 貼圖數 | shader program | drawCall/幀 | FPS |
|---|---|---|---|---|---|---|
| 1 | 165MB | 284MB | 36 | 10 | 99 | 60 |
| 3 | 346MB | 549MB | 108 | 30 | 297 | 60 |
| 6 | 601MB | 865MB | 216 | 60 | 594 | 60 |
| 9 | 869MB | 1197MB | 324 | 90 | 891 | 60 |

**判讀**:FPS 全程 60 → 瓶頸不是算力,是記憶體;每隻約 +88MB GPU,且貼圖/program/drawCall 全部線性增長(同一個模型載入 N 次就存 N 份)。

**兩個被否定的假設**(都靠實測排除,沒有憑感覺改):

1. **抗鋸齒/全螢幕 framebuffer 是主因** → 關掉 antialias 重測:601MB vs 602MB,**完全沒差**。
2. **`Object.values(material)` 掃得到貼圖** → 實際回傳空集合。MToon 是 ShaderMaterial,**貼圖掛在 `uniforms.<name>.value`,不是自有屬性**;第一版的降階程式因此完全沒執行,量出來「沒效果」差點讓人誤判方向。修正掃描方式(自有屬性 + uniforms 兩邊都收)後才真正生效。

**根因**:模型內含 2048px 貼圖(單張解碼 16MB)。實測 AvatarSample_A 的貼圖解碼後共 **102MB**(4×2048、15×1024…),神子是 80MB(5×2048)。桌寵在螢幕上只有幾百像素高,2048 是過度規格,而每隻寵物各自持有一份完整副本。

**處理**:`capTextureSize()` 在載入後、**進場景前**把貼圖邊長壓到 1024(用 canvas 重繪、`needsUpdate`)。時機是關鍵——大圖一旦上傳 GPU,再換只是多花一次頻寬。同一張貼圖被多材質共用時只處理一次。

**效果**:

| N | GPU(前→後) | 節省 |
|---|---|---|
| 1 | 165 → 141MB | −15% |
| 3 | 346 → 249MB | −28% |
| 6 | 601 → 401MB | **−33%** |
| 9 | 869 → 555MB | **−36%** |

每隻增量 88MB → 52MB。臉部極限特寫(相機距頭 0.42m,遠近於實際使用)確認眼睛高光、睫毛、唇線都清晰,無可見劣化。

**還沒做的**:真正的天花板是「N 個 WebGL context 各存一份資源」——同款模型的貼圖無法跨 context 共用。要再往下砍得改成單一 renderer + scissor 分區渲染,並讓多隻共用貼圖(材質可 clone,貼圖引用共享)。那是動到 `viewer.ts` 核心的手術,等有實際需求(常態 6 隻以上)再評估。

---

## 55. Git 提交與推送前檢查(2026-07-29，2026-08-11 補記)

專案原本只靠貢獻者記得手動執行檢查，容易把型別錯誤、建置失敗或疑似憑證帶進 Git 歷史。這輪加入專案共用的 `.githooks/`，並由 `npm ci` 觸發的 `prepare` 自動設定 `core.hooksPath`，不必每位開發者手動複製 hook。

### 檢查分工

- **pre-commit**：先執行 `npm run check:secrets` 掃描已暫存檔案，再執行 `npm run typecheck`。密鑰掃描只看 index，因此不會因工作樹裡尚未準備提交的內容阻擋提交，也能確保檢查的正是即將進入 commit 的版本。
- **pre-push**：執行 `npm run check:secrets:all` 掃描所有追蹤檔案，再執行 `npm run build`，把成本較高的完整檢查留到推送前，兼顧每次提交的速度與遠端分支品質。
- **全量稽核**：`node scripts/check-secrets.mjs --tracked` 可掃描所有追蹤檔案，適合初次導入或定期檢查。

密鑰檢查涵蓋常見私鑰、雲端與平台 token、JWT、含帳密 URL，以及疑似硬編碼的密碼／金鑰欄位；會跳過二進位檔並允許明確的範例 placeholder。它是提交前的快速防線，不取代專業 secret scanner 或已曝光憑證的撤銷與重新簽發。

### 文件入口

根目錄新增 `README.md`，集中說明環境需求、啟動方式、桌寵操作、AI 權限、開發指令、Git hooks 與運行資料位置，讓初次進入專案的人不必先讀完整 DEVLOG 才能開始使用。

## 46. 泡泡就地換工作目錄、輸入歷史與交辦列(2026-08-17)

**內容**:(1) 工作目錄改成徽章列第一顆 chip——點了直接開資料夾對話框改這隻寵的 cwd(重用設定面板同一條 choose-workspace IPC;main 改完 sendPetProfiles,徽章由 reconcile 寫回,renderer 不接回傳值)。未設定時也顯示「選擇工作目錄…」當最短補救入口。徽章列改恆開、chip 抽共用工廠(pointerdown + stopPropagation,沿 §67a2112 的選單關閉坑)。(2) 輸入框 ↑/↓ 叫回送出過的訊息(像 shell):只留記憶體上限 50 筆、連續重複不收;空白時按 ↑ 進歷史,內容一改就退出翻閱,方向鍵還給多行編輯;IME 選字中(isComposing)絕不攔。(3) `beginTurn(text)` 帶原話——交辦內容釘在回覆上方(兩行截斷,title 全文),多寵同時在跑時一眼認出哪句交給了誰;重啟回填時同列顯示「上次你說」。applyLocale 一併重套 chip 文字與交辦列前綴。bubbletest 補 onChooseWorkspace 計數與 beginTurn 帶字案例。

## 47. 第三家 provider:agy(Antigravity CLI)串接(2026-08-17)

**評估**:`agy`(v1.1.13)介面與 claude CLI 高度同構(`--print` + `--output-format stream-json`、`--conversation <id>` resume、`--model/--effort/--mode`),AgentProvider 介面本就多家設計,claudeProvider 整份當樣板。一次接入 Gemini 3.x 全系列 + Claude 4.6 + GPT-OSS。

**煙霧測試定案**(樣本存 scratchpad/agy-smoke):事件形狀 `init`(conversation_id + 工具清單 + permission_mode)→ `step_update`(agent_response 的 text_delta / tool 的 tool_name)→ `result`(status)。**文字整段一次到達非逐字增量**,解析器仍做同 step 後綴防重,兩種語意都安全。**headless 下需權限的工具被 CLI 自動拒絕**(「Add an allow-rule under permissions.allow」)——所以 readonly = 預設行為(天然唯讀)、auto = `--dangerously-skip-permissions`、plan = `--mode plan`;**ask 做不了**(無 permission-prompt 等效),三層過濾:泡泡運行模式選單不列、設定面板選項禁用、petIpc 白名單最後防線。寵物工具 MCC v1 不接(無逐 turn mcp-config 旗標,不碰全域 settings.json)。

**實作要點**:
1. `agyProvider.ts` 複製 claudeProvider 骨架(EventQueue、pending-N handle、cancel 2.5s 強制終結保險、close 只刪仍指向本 child 的條目全保留);resume 改 `--conversation`;無 `--append-system-prompt` → persona/參考檔案走 **codex 式上下文注入**(組合值變了才在 prompt 前綴【上下文更新】,換語言自動觸發重注入)。
2. **`--print` 是帶值旗標(Go flag 風格)**:prompt 必須當它的參數值;光給 `-p` 再餵 stdin 會把下一個旗標吃成問題本身(E2E 抓到:回覆變成「請說明 --output-format 的用法」)。這是與 claude(stdin 餵 prompt)最大的差異。
3. **模型 id 把力度編在尾碼**(gemini-3.7-flash-high):listModels 執行 `agy models` 解析 `id\t label`,三檔位齊的摺疊成「基底 + efforts」,spawn 時接回尾碼;無檔位變體的(claude-* 等)原樣列出走 `--effort` 旗標。
4. AgentKind 加 'agy' 的接線:型別會抓的(providers record、harness、union)不會漏;**七處靜默 fallback 逐一修**(petIpc/agent-models 白名單、settings selectedKind、main.ts 兩處三元、泡泡供應商 chip 的 label/選單/轉型)。

**驗證**:typecheck/build 綠;mock selftest 補 3 項 petMeta 斷言(agy 合法/ask 被擋/plan·auto 照收)全 PASS;`VRM_PET_AGENT_SELFTEST=agy` 真 CLI E2E 七項全 PASS(一問一答+conversation 回存/resume/cancel 競態/取消後 session 續用)。

**追加(同日):agy 亂碼修正**——實機對話出現 `���`:agy 長回覆會分多個 `text_delta` 增量片段,CLI 以 **byte 邊界**切割,多位元組字元在接縫兩側各自解碼成 U+FFFD,**壞字已編進 JSON,片段層無法修復**;但 `result.response` 全文乾淨。修法:agy 的文字片段只緩衝不發,`result` 時一次發出乾淨全文(result 沒帶才退回緩衝片段);片段到達時發 `thinking` 餵 bridge 看門狗,長回覆才不會 5 分鐘無事件被硬中斷。代價:agy 回覆不逐段顯示、完成時一次出現(claude/codex 串流不受影響)。E2E 的 cancel 段改等第二個 thinking(原等首個 text,現在 text 在結尾才來)。另修重啟回填:上次回覆為空(agy 工具被拒的空 turn)不再打開空的回覆框。

**再追加(同日):泡泡切不了 agy 模型**——模型選單只剩「預設模型」:`agy models` 在 **stdin 是掛著的 pipe 時會等輸入直到逾時**(execFile 預設 stdio 如此,實測 SIGTERM 收場),`stdin: 'ignore'` 才正常吐清單——listModels 改 spawn + stdin ignore + 10s 逾時。另外裸基底模型 id(gemini-3.7-flash)會被 agy 拒絕:錯誤訊息明載「requires --effort」且證實原生就吃「基底 model + --effort」組合——放棄接尾碼,一律傳 `--model 基底 --effort 力度`,基底模型未選力度時退 medium(不在清單取第一個;gemini-3.1-pro 實際只有 low/high)。實測:listModels 7 模型與 agy 自家 UI 一致、選模型未選力度可正常對話。

## 48. Unity 遊戲資產抽取:VRM/VRMA 轉換管線(2026-08-17~21)

**目標**:從 Steam 遊戲 Your Mom(Unity 6000.0.48f1)抽出角色模型與動作給桌寵用。角色是 VRChat avatar 形式的 Unity 資產(場景裡的 Rosette 五套服裝實體 + StreamingAssets bundle 裡的 Vivian),沒有現成 VRM;動作 171 個 AnimationClip,全身動作是 humanoid **肌肉曲線**(muscle clip),不是骨骼旋轉。工具鏈:`extract-yourmom/`(python venv + UnityPy 1.25),教學見 [EXTRACT-GUIDE.md](EXTRACT-GUIDE.md)。

**管線**:
- `build_vrm.py`:bundle/.assets → VRM 1.0。網格/蒙皮/貼圖/blendshape→VRM 表情(候選名單制,相容 MMD 與英文命名)/Avatar→humanoid 對應/VRCPhysBone→VRMC_springBone。座標系 Unity 左手→glTF 右手一律 x 翻轉:位置 `(-x,y,z)`、四元數 `(x,-y,-z,w)`、三角形反繞向、UV `v'=1-v`、bindpose `M·B·M`(M=diag(-1,1,1,1))。
- `build_vrma.py`:muscle clip → VRMA。StreamedClip 是「time + 每鍵 `(curveIndex, c0..c3)` 三次多項式」流;binding 佔位規則 Transform 位置/旋轉/縮放各佔 3/4/3 槽、其餘每條 1 槽;muscle 值→骨骼旋轉走 swing-twist(`preQ ⊗ st(x·w, y, z) ⊗ postQ⁻¹`,限位選 max/-min、乘 sgn),twist 沿四肢鏈按 armTwist/legTwist 權重下推;hips 由 RootT/RootQ 經**質心重建**(四肢根建座標系 + HumanBoneMass 加權質心)。數學出自 lox9973/uvw.js 的 HumanPoseHandler(AssetStudio 只有 curve 解碼,humanoid 轉換直接跳過,別在那找)。
- `cdp-shot.mjs`:headless Chrome CDP + `npx vite serve src/renderer` 驅動 vrmtest.html 截圖自驗。**不能用 `npm run dev` 驗**——predev 的 pkill 會把正在跑的桌寵殺掉。

**踩過的坑**(症狀 → 根因):
1. **動作播放手臂上舉、左右交叉,但模型與表情全正常** → mecanim `m_HumanBoneIndex` 的骨序 **UpperChest 插在 Chest 之後第 9 位**,與 C# HumanTrait 列舉(UpperChest 在最後)不同;錯用後 Neck 以後全部錯位一格,「leftUpperArm」實際指到右肩。模型渲染不經 humanoid 對應表所以看不出來,播動作才爆。
2. **VRMA 數學驗算正確、瀏覽器裡姿勢全毀** → three-vrm-animation 的重定向假設 VRMA 骨架是**正規化**的(rest 旋轉全 identity,UniVRM 輸出慣例);直接塞 Unity 骨架 rest(腿骨帶 175° 軸向旋轉)必錯。修法:節點位移=rest 世界位置差、rest 旋轉省略,軌值 = `W_rest(parent)⊗W_t(parent)⁻¹⊗W_t(node)⊗W_rest(node)⁻¹`。
3. **.assets 的 MonoBehaviour 讀不出**(bundle 卻可以)→ .assets 不內嵌 typetree;用 `TypeTreeGeneratorAPI` 從遊戲 Managed DLL 現場生成接到 `env.typetree_generator`(PhysBone 參數全靠這個)。
4. **ConstantClip 解出來是 list 不是 dict** → 它的欄位名就叫 `data`,通用的 `{"data": …}` unwrap 會誤剝一層。
5. **手勢 clip 播放時整個人沉到地下** → 手勢只繫手指曲線,沒 RootT;muscles=0 + 質心重建把 hips 放到原點。修法:**部分 VRMA**——只輸出有曲線的骨、無 root 曲線不寫 hips 軌,手勢變成可疊加的部分動畫(單獨播身體維持原姿勢)。
6. **three 載入丟 `normalizeSkinWeights` 讀不到 count** → 單骨蒙皮網格(headdress/beret)只有 JOINTS 沒 WEIGHTS(權重隱含 1),補 `(1,0,0,0)`。

**產出**:`models/Vivian.vrm`(23.6MB,65 條彈簧骨)、`models/Rosette_Maid.vrm`(20.2MB,42 條);`motions/` 85 個 VRMA(動作 46/姿勢 29/手勢 10),**每個都截圖看過才取中文名**,原名對照在 `motions/動作對照表.txt`。表情六態 + 口型 + 眨眼全接到 VRM expression preset,桌寵的 `pet_show_expression`/`pet_play_motion` 直接可用。

**驗證方法論**:肌肉數學先在 Python 端 FK 驗(手臂方向向量與正規化組合一致才進瀏覽器);結構過 `npx @gltf-transform/cli validate`;視覺全靠 vrmtest.html 截圖,彈簧骨用 `?rootMotion=1` 自動判定(注意內建閾值對高阻尼參數過嚴,0.0000 rad 才是真的沒動)。

## 49. Windows 相容與雙平台安裝包(2026-08-24)

**問題**:渲染與 IPC 本來大多是 Electron 共用碼，但開發啟動用 `pkill`/`$(pwd)`、整體重啟硬編 `/bin/zsh`、全域檔案拖曳只靠 macOS JXA，Agent helper 又從 `app.getAppPath()/src` 啟動。結果是 Windows 連 `npm run dev` 都過不了；即使只把 `out/` 塞進 Electron，安裝版的 helper 也會指進 asar，外部 Node 無法執行。

**處理**:

1. 新增 `platform.ts` 集中視窗層級、macOS panel/跨工作區、外部 helper 實體路徑，以及本機 IPC 位址。Unix 使用 socket 檔，Windows 改用 `\\.\pipe\...` named pipe。
2. `predev` 改成 Node 腳本依 PID 檔清理；安裝版重啟使用 `app.relaunch()`，開發版由跨平台 launcher 等舊 Electron 結束後重新執行 npm。另加 single-instance lock，第二次啟動只叫出中控。
3. 參考檔案驗證由 `startsWith('/')` 改用 `path.isAbsolute()`，Windows 的 `C:\...` 不再被丟棄。泡泡新增 📎 系統選檔入口；Windows/Linux 因 native dialog 不能同時選檔案與資料夾，先選模式再開對應 dialog。macOS 的 JXA 全域拖曳保留，Windows 第一版用此入口可靠降級。
4. 加入 Electron Builder：Windows x64 產 NSIS、macOS arm64 產 DMG/ZIP；Agent `.mjs` 以 `extraResources` 放到 asar 外，設定與運行資料則落在系統 `userData`。Vite 以自訂 plugin 明確輸出預設 VRM，不再依賴 Windows checkout 可能失真的 symlink。
5. 新增雙平台 GitHub Actions；production HTML sanitizer 同步升級，`npm audit --omit=dev` 歸零。ImageGen 產生 1024px 桌寵圖示作為兩平台打包來源。

**驗證**:`typecheck`、production build、`git diff --check` 全過；macOS unpacked app 執行 MockProvider 全鏈 selftest 全 PASS；Windows x64 cross-package 與 NSIS 成功，helper/asar/預設 VRM 均在正確位置。實際 DMG 已安裝至 `/Applications/VRM Pet.app` 並正常啟動 main、GPU、renderer，運行資料正確建立在 `~/Library/Application Support/VRM Pet`。

**仍需外部環境**:Windows 11 真機的透明視窗、DPI、多螢幕與 Explorer 重啟回歸；正式公開發行前的 Windows Authenticode、macOS Developer ID/notarization；Windows 原生全域拖曳 helper。未簽章產物只供內部測試。

## 50. 安裝版預設模型備援與動作授權稽核(2026-08-26)

**問題**:`electron-builder.files` 只收 `out/**` 與 `package.json`。Vite 雖會把 `AvatarSample_A.vrm` 輸出到 renderer 並收入 `app.asar`，但 `models/`、`motions/` 本身不會進安裝包；正式版又從系統 `userData/motions/` 掃描動作，乾淨安裝後因此沒有動作可選。預設模型若只依賴 asar 內的 renderer 資產，也缺少可寫資料目錄中的實體檔備援。

**模型處理**:`models/AvatarSample_A.vrm` 另以 `extraResources` 放到 `Resources/models/AvatarSample_A.vrm`。正式版啟動時檢查 `userData/models/AvatarSample_A.vrm`，不存在才建立目錄並從 app resources 複製；既有檔案一律保留、不覆寫。renderer 內原有的 `/AvatarSample_A.vrm` 照常保留，形成「asar 內建載入 + userData 實體備援」兩條路徑。

**動作授權結論**:現有動作不能因為「免費取得」就視為無著作權。pixiv 官方 7 個 VRMA 的著作權仍屬 pixiv，隨附條款禁止以可抽取形式再散布；另外 85 個中文動作來自遊戲資產抽取，`EXTRACT-GUIDE.md` 已明載僅限個人使用、不得散布。因此本次不把任何現有 `.vrma` 塞入安裝包；日後只可加入明確為 CC0、公有領域，或授權明文允許隨應用程式再散布的動作，並應連同授權與來源證明入版控。

**驗證**:`npm run typecheck`、`npm run build`、`npm run pack` 全過；實際 macOS unpacked app 同時確認 `Resources/models/AvatarSample_A.vrm` 與 `app.asar/out/renderer/AvatarSample_A.vrm` 存在，沒有誤收任何 `.vrma`。

**安裝實測補記(2026-08-27)**:資源雖已正確打包與複製，乾淨設定的預設寵物仍不可見。根因是 `get-boot-vrm` 對沒有自訂 `vrmPath` 的寵物回傳 `null`，renderer 隨後載入絕對網址 `/AvatarSample_A.vrm`；dev server 能解析這個網址，但 production 的 `file://` 會把它指到磁碟根目錄。修正為 main 在沒有自訂路徑時直接從 `userData/models/AvatarSample_A.vrm` 讀取 buffer，與自訂模型共用既有快取及 IPC 載入路徑，不再依賴 production URL 解析。

## 51. 介面重設計①:設計語言 token 化,三介面統一色票(2026-08-27)

**背景**:泡泡(淺色薰衣草紫)、設定面板(深色 #1c1c20 靛紫)、中控面板(深色 #17171c 另一色號靛紫)三套視覺各自為政,DESIGN-TODO 定案為雙主題 token 化(跟隨系統深淺)。設計稿與規範:`docs/design/redesign-v1.html`。

**做法**:新增 `src/renderer/tokens.css`——只放 CSS 變數不放元件樣式(疊層視窗背景必須保持透明,此檔不畫任何背景)。淺色為 `:root` 預設,深色走 `prefers-color-scheme` 跟隨系統;`data-theme` 覆寫僅供自驗頁強制切換。三個介面接上:control.html 與 settings.html 各加 `<link>`,speechBubble.css 檔首 `@import`(由 speechBubble.ts 的 CSS import 鏈帶進 overlay)。版面完全不動,只把硬編碼色票換成變數;色溫漸層與 XYZ 軸色是語意色,保留字面值。狀態色順帶對齊:泡泡狀態點 working 由藍改綠、done 由綠改藍,與中控任務徽章(執行中=綠、已完成=藍)一致。

**驗證**:typecheck/build 過;因寵物系統正在跑,不用 `npm run dev`(predev 會 pkill Electron 誤殺寵物),改起獨立 `npx vite src/renderer` + headless Chrome CDP(`Emulation.setEmulatedMedia` 模擬 prefers-color-scheme)截 bubbletest/control/settings 三頁深淺共六張,泡泡尾巴與卡片同色、深色下輸入框/徽章/佇列列對比正常。

## 52. 介面重設計②:中控面板卡片化(2026-08-27)

**改動**:清醒寵物由 6 欄 grid 列改為卡片(`repeat(auto-fill, minmax(360px, 1fr))`,窄視窗自動降單欄):標頭=狀態點+可改名名稱+工作區膠囊+休息鈕,狀態列右側掛新對話/目錄小字鈕,審批改為嵌在輸入列上方的黃色橫幅。休息寵物收成膠囊列(狀態點+名稱+喚醒),不再佔整列高度——代價是休息中不能就地改名/選目錄,喚醒後即可。任務帳本失敗列加左緣紅條(`inset box-shadow`)。沙盒分頁整區包進紅框危險區(紅底標頭+紅色系套用鈕),與一般設定視覺隔離。焦點回復選擇器同步改 `.pet-card`、對象縮為清醒清單(輸入框只在清醒卡片上)。

**驗證**:中控沒有獨立驗證頁,但 control.ts 檔尾掛著 `window.__applySnapshot`;瀏覽器下模組頂層會碰 `window.pet`,用 CDP `Page.addScriptToEvaluateOnNewDocument` 先注入 stub 再開頁即可灌假快照。截深淺+沙盒+任務表四張;互動回歸(灌快照→打草稿→再灌快照)確認草稿保留、改名狀態跨重繪保留、喚醒鈕存在。

**驗證環境的坑**:headless 頁面沒有焦點時 `focus` 事件不發(`activeElement` 有設但 listener 不觸發);開 CDP `Emulation.setFocusEmulationEnabled` 後又出現「移除聚焦元素會發 blur」的模擬行為(實測 `input.remove()` → blur fired),真實 Chrome/Electron 移除聚焦元素不發 blur——所以焦點回復與改名保留在焦點模擬下會誤判失敗,屬環境假象。要在 headless 驗這兩條路徑,只能各驗一半:不開模擬驗「狀態跨重繪」,開模擬驗「事件有掛上」。

## 53. 介面重設計③:設定面板(2026-08-27)

**改動**:分頁與光源類型切換改 segmented control(內凹槽+浮起選中鈕,與新設計語言一致);光源/光源位置/晃動強度/服裝顯示/角色位置五個區塊右上角各加「還原預設」小字鈕——光源還原 type/強度/色溫但不動位置,位置反之,解決「調壞了沒有回頭路」;四個拖曳墊加方位文字提示(正面墊:上/下/左/右;側視墊:上/下/身後/朝你),不用只靠軸色理解空間。i18n 新增 settings.resetSection 與六個方位鍵(四語系)。注意:加了區塊鈕的 h3 要把 data-i18n 移到內層 span,否則 applyI18nDom 的 textContent 會把按鈕洗掉。

**驗證**:CDP 注入 window.pet stub(settings.ts 需要的面比中控寬:getPetCollection/getWardrobe/getMotionList 等)開 settings.html;互動回歸:環境光滑桿調到 0.64π → 按光源區塊還原 → 回 0.80π(=DEFAULT_LIGHTING.ambient);深淺各截光影/角色分頁,服裝勾選狀態正確套用。

## 54. 介面重設計④:泡泡發現性與分節排版(2026-08-27)

**改動**:隱藏功能常駐微顯——圖釘從 hover 才出現改為常駐 55% 透明度(hover/釘選回全尺寸全不透明),寬度把手豎條常駐 35%(hover 全顯);佇列與參考檔案各加節標(佇列(n)/參考檔案,i18n 四語系新增 bubble.queueHeader/refsHeader)與上緣分隔線,四塊內容不再擠成一團;回覆區上限 200px 改 min(38vh, 440px)(疊層視窗全螢幕,vh=螢幕高)。節標在 setQueue/setRefFiles 重建清單時一併生成,換語言後下次重繪即更新(與既有列項 title 行為一致)。

**驗證**:bubbletest.html 深淺各一張——節標與分隔線、常駐把手豎條、外角常駐圖釘皆可見;typecheck/build 過。

**至此 DESIGN-TODO 四步實作順序全部完成**:tokens.css(§51)→ 中控卡片化(§52)→ 設定面板(§53)→ 泡泡(§54)。剩餘的深水區項目(對話歷史往上翻、服裝縮圖命名、模型選擇器、動作預覽)仍留在 DESIGN-TODO 待辦。

## 55. 介面重設計⑤:寵物右鍵選單自繪(2026-08-27)

**動機**:原生 Electron Menu 無法套用設計語言;疊層視窗不可聚焦,自繪 DOM 也是泡泡下拉(bubble-agent-menu)已驗證的路線。

**做法**:新增 `petMenu.ts`/`petMenu.css`,結構比照 main 的 `petMenu()`(切換寵物/播放動作/預設姿勢/設定/中控/沙盒/選 VRM/重置/重啟/休息/新增/重啟系統/結束)。子選單不做飛出面板(疊層上易超出邊界),改就地換頁+「‹ 返回」列;radio 頁(預設姿勢/切換寵物)以 ✓ 標記現值,休息寵物灰掉,「結束」紅色 danger。動作經六個新 IPC(`menu-play-motion` 含 motions/ 白名單、`menu-stop-motion`、`menu-open-settings`、`menu-open-control`、`menu-reset-state`、`menu-restart-pet`)回 main 走與 Tray 相同的函式;Tray 仍用原生選單。`main.ts` 右鍵改呼叫 `showPetMenu`,`updateHover` 開頭加選單開啟守衛(保持互動、不收合泡泡);點選單外 mousedown(捕獲階段)收合。

**驗證**:新增 `menutest.html`(掛 `window.__menu`,stub window.pet、動作記到陣列)。互動回歸全過:播放動作後選單關閉且動作有記錄、切換寵物頁群組標/休息灰階/現值勾號正確、結束鈕 danger、點外收合。深淺截圖 OK。清單上限 `calc(100vh - 120px)`,主頁一般整頁可見,動作幾十個時才捲動。

## 56. 介面重設計⑥:設定面板卡片化(2026-08-27)

**改動**:每個設定群組包進 `.card`(光影 2 卡、角色 4 卡、動作 2 卡;工作分頁的 workspace-card 統一圓角),區塊標題由紫色改回主文字色(卡片已承擔分組,紫標題到處都是反而吵)。順修既有的拖曳墊撐爆問題:座標數值原在標題列預留 104px 造成 pad-box 超過半寬、卡片被撐出橫向捲軸——數值移進墊內右上角(`.pad-val`,等寬數字),`.pad-box` 改 `flex: 1 1 0; min-width: 0`,兩墊乖乖各分一半。服裝/待機清單列底色 bg-hover → bg-inset(白卡上 6% 透明度幾乎看不見)。

**驗證**:CDP stub 深淺截光影/角色/動作三分頁,無橫向捲軸,墊內數值顯示正確。
