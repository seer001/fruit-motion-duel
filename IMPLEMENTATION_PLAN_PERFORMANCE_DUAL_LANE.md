# 效能彈性與雙人左右獨立模式：完整實作計畫

## 0. 文件用途

本文件是下一個 Codex session 的實作交接規格。開始修改前應先完整閱讀本文件，並以本文件的「已確認決策」「不在範圍內」及「完成條件」作為邊界。

本文件建立時尚未修改任何產品程式碼；目前工作樹原先為乾淨狀態。

## 1. 已由使用者確認的決策

1. 雙人模式維持單一完整攝影機影格、每個影格最多只做一次姿態推論；推論後才把玩家分配到左、右獨立區域。不可預設改成左右各跑一次模型。
2. 設定頁同時提供效能預設與進階單項設定。
3. 透明選項代表遊戲期間是否讓攝影機畫面顯示在遊戲圖層後方；透明與抗鋸齒改變時可以安全重建 Phaser renderer。
4. 雙人校正改成左右各自累積進度；一側暫時辨識失敗不得清空另一側進度。
5. 不再要求兩位玩家在每一個校正影格都同時清楚顯示雙耳；可使用頭部與肩膀／軀幹比例作為後援。
6. 仍必須等左右兩位玩家都完成校正、身份原子封存、指定主手就緒後，才可進入遊戲。

## 2. 目標

### 2.1 效能目標

- 讓不同硬體可選擇效能優先、平衡、畫質優先或自動模式。
- 首頁、設定、校正、結果等非遊戲畫面不再常駐執行 60 FPS Phaser WebGL renderer。
- 效能警告使用所選模式的門檻，不再以單一嚴格門檻套用所有裝置。
- 效能狀態與辨識狀態分開顯示，效能訊息不得遮蔽真正卡住校正的原因。
- 姿態模型、renderer 及視覺效果的設定能安全套用、保存與復原。

### 2.2 雙人目標

- 仍只處理一個完整影格及一次姿態推論。
- 左、右玩家各自取得候選、校正進度、身份、主手、刀光、碰撞及得分。
- 兩邊不必在每一幀同時達到完美品質，但最後仍要同時完成才可開始。
- 玩家短暫遮擋或某一側掉點時，不影響另一側已完成的校正。
- 中央安全區禁止得分刀點；玩家身份不得因跨區、重疊或候選順序改變而互換。

## 3. 明確不在本次範圍內

- 不改計分、連擊、炸彈、難度、腳本池或水果數量。
- 不改正式賽事流程、排行榜、換邊、同分加賽或資料保存規則。
- 不新增臉部辨識、生物特徵、LiDAR、原生 iOS App、第二台攝影機。
- 不預設實作左右各一套 Pose Landmarker 或每幀兩次推論。
- 不全面重畫 UI、美術或音效。
- 不以自動化測試宣稱實體雙人鏡頭已通過；最終仍需目標設備真人驗收。

## 4. 現況問題摘要

### 4.1 常駐 renderer

`AppController` 建構時立即建立 `FruitDuelGame`。Phaser 使用 1920×1080、透明、抗鋸齒、`high-performance` WebGL 並以 60 FPS 運作；即使首頁或校正頁沒有遊戲內容，Scene 仍持續更新及清空刀光 Graphics。

主要位置：

- `src/AppController.ts`：`game` 在 controller 建構期間建立。
- `src/game/FruitDuelGame.ts`：Phaser config 與 `DuelScene.update()`。
- `src/styles.css`：全螢幕透明圖層、drop-shadow、backdrop-filter。

### 4.2 效能診斷門檻不一致

校正 UI 在推論 p95 超過 45 ms 或 pipeline p95 超過 100 ms 時顯示效能不足；自適應控制器卻要超過 55／110 ms 才降載。介於兩組門檻之間時會持續警告但不採取行動。

`assessCalibrationHealth()` 又優先回傳效能不足，因此會遮蔽只辨識到一人、候選不合格、身份未封存或主手未就緒。

### 4.3 雙人校正過度同步

現有 `CalibrationCollector.add()` 只要任一玩家未通過就整幀不採樣，且每位玩家每個採樣影格都要求有效雙耳距。兩人必須同步累積 24 個合格影格，對廣角、低解析度及手部活動場景過於脆弱。

### 4.4 自適應控制器看不到校正失敗

自適應辨識救援主要使用 `assignedCandidateCount`。若模型已分配兩個人體，但雙耳、頭部品質或校正門檻失敗，系統仍認為成功辨識兩人，不會提高解析度救援。

## 5. 效能設定規格

### 5.1 建議資料模型

新增集中式設定模組，例如 `src/config/performance.ts`：

```ts
export type PerformancePreset =
  | 'auto'
  | 'performance'
  | 'balanced'
  | 'quality'
  | 'custom';

export type VisionModelPreference = 'auto' | 'lite' | 'full';
export type EffectsQuality = 'off' | 'low' | 'medium' | 'high';
export type PoseOverlayRate = 0 | 10 | 15 | 30;

export interface PerformanceSettings {
  version: 1;
  preset: PerformancePreset;
  modelPreference: VisionModelPreference;
  inferenceMaxDimension: 512 | 640 | 768 | 960;
  inferenceTargetFps: 15 | 20 | 24 | 30;
  maximumPoseCandidates: 2 | 3;
  spectatorReserve: boolean;
  gameRenderFps: 30 | 45 | 60;
  antialias: boolean;
  showCameraBehindGame: boolean;
  effectsQuality: EffectsQuality;
  poseOverlayRate: PoseOverlayRate;
  cssBlur: boolean;
}
```

必須以單一函式解析、驗證及正規化設定，禁止讓 UI、VisionClient 與 Phaser 各自保存不同預設值。

### 5.2 初始預設

以下數值是第一版實作基準，實體驗收後可以再調整：

| 預設 | 模型 | 最長邊 | 推論目標 | 候選 | 遊戲 FPS | 抗鋸齒 | 效果 | 骨架 |
|---|---|---:|---:|---:|---:|---|---|---:|
| 效能優先 | Lite | 512 | 15 | 2 | 30 | 關 | Low | 10 FPS |
| 平衡 | GPU Full／CPU Lite | 640 | 20 | 2 | 45 | 開 | Medium | 15 FPS |
| 畫質優先 | Full | 768 | 30 | 3 | 60 | 開 | High | 30 FPS |
| 自動 | 從平衡開始 | 512–960 | 15–30 | 2，必要時 3 | 30–60 | 依負載 | 依負載 | 10–30 FPS |

補充規則：

- 雙人模式一般只需兩個候選；第三候選只用於畫質模式、使用者明確開啟觀眾保留，或 Auto 已確認延遲健康且持續缺少登記玩家。
- `showCameraBehindGame` 應是所有預設都可覆寫的獨立選項。關閉時，攝影機仍供辨識使用，但遊戲畫面使用不透明背景以減少合成成本。
- 模型、透明與抗鋸齒是初始化級設定；不得在進行中的回合直接切換。

### 5.3 保存與套用

- 使用具版本號的 `localStorage` key，例如 `body-fruit-duel:performance-settings:v1`。
- 設定損毀或舊版本解析失敗時回復 Auto，不得阻止應用程式啟動。
- 設定只屬於本機裝置，不寫入賽事快照，不影響計分資料。
- 校正、倒數或遊戲中鎖定設定控制；只能返回首頁／設定畫面後變更。
- 需要重建模型或 renderer 時顯示明確的「正在套用設定」狀態，完成後才允許進入校正。
- 提供「恢復自動設定」按鈕。

## 6. Phaser 與視覺效果生命週期

### 6.1 AppController

將目前的：

```ts
private readonly game: FruitDuelGame;
```

重構為可延遲建立的 nullable instance。建議介面：

```ts
private game: FruitDuelGame | null = null;

private async ensureGameRenderer(): Promise<FruitDuelGame>;
private sleepGameRenderer(): void;
private destroyGameRenderer(): void;
```

規則：

- 首頁、設定、校正、換邊、結果、排行榜：renderer 不存在或處於 sleep。
- 準備倒數前才 `ensureGameRenderer()` 並 wake。
- 回合結束離開遊戲畫面後 sleep。
- 透明或抗鋸齒改變時，只能在沒有進行中回合時 destroy/recreate。
- 所有 `this.game.*` 呼叫改成安全存取，避免 null race。

### 6.2 FruitDuelGame

建構子接收 renderer/effects config：

```ts
interface FruitDuelRenderSettings {
  targetFps: 30 | 45 | 60;
  antialias: boolean;
  transparent: boolean;
  effectsQuality: EffectsQuality;
}
```

新增 `sleep()`、`wake()`；重複呼叫必須冪等。若 Phaser 的 game loop sleep/wake 在目標版本不穩定，可使用 Scene sleep 配合 renderer pause，但必須用實測確認非遊戲畫面沒有 RAF 持續工作。

`DuelScene.update()` 應在沒有回合、沒有刀光且沒有動畫時最早返回；不可先執行 `drawTrails()` 再判斷 idle。

### 6.3 效果等級

集中定義各級效果，不在 Scene 內散落條件：

- Off：無切片粒子、無 camera shake、簡化刀光、無額外 popup tween。
- Low：每次切片約 3–4 顆粒子，簡化陰影與刀光。
- Medium：每次約 6–7 顆粒子，保留主要提示。
- High：維持目前約 10 顆粒子及完整提示。

CSS 以 root data attribute 或 class 控制 blur、drop-shadow、backdrop-filter；避免 JavaScript 逐元素修改 style。

## 7. Vision 設定與自適應策略

### 7.1 推論頻率

- 將 `AppController.startInferenceLoop()` 目前固定約 32 ms 的節流移入效能設定。
- 使用 `1000 / inferenceTargetFps` 計算提交間隔。
- 仍保留 VisionClient 單一 in-flight 與只保存最新 pending frame 的策略。
- 不得建立影格佇列或在雙人模式送出兩份 bitmap。

### 7.2 模型選擇

- Lite／Full 應成為明確 runtime config，不再只以 `gpuModelPath` 是否存在推測 model tier。
- 模型偏好變更時重新初始化 Worker；進行中回合不得切換。
- GPU 初始化失敗仍可安全回退 CPU；回退 CPU 時應遵守該預設對 CPU Lite 的限制。
- UI 顯示實際後端及實際模型，而非只顯示使用者期望值。

### 7.3 Auto 模式

Auto 從平衡設定開始，依序調整：

1. 先降低視覺效果與骨架更新率。
2. 再降低遊戲 renderer FPS。
3. 再降低推論解析度或候選數。
4. 延遲健康但辨識不足時，先提高解析度；只有疑似觀眾擠掉玩家時才升到三候選。

不可因單一影格立即切換。保留 sample window、cooldown 與 hysteresis，但效能門檻必須與 UI 共用同一份 policy。

### 7.4 效能健康政策

建議集中定義：

| 預設 | 目標 FPS | 最低可用 FPS | 推論 p95 | Pipeline p95 |
|---|---:|---:|---:|---:|
| 效能優先 | 15 | 12 | 75 ms | 160 ms |
| 平衡 | 20 | 16 | 60 ms | 130 ms |
| 畫質優先 | 30 | 20 | 45 ms | 100 ms |

狀態分三級：

- 良好：達到目標及主要延遲預算。
- 可用但降級：高於最低可用門檻，但未達目標；Auto 可逐步降載。
- 不足：低於最低可用門檻或延遲長時間超出約 1.5 倍預算。

這些狀態只描述效能，不直接解鎖或封鎖校正按鈕。真正的開始條件仍由身份與主手安全門檻決定。

## 8. 雙人左右獨立辨識

### 8.1 推論架構

流程固定為：

```text
完整攝影機影格
  → 一次 Pose Landmarker 推論（最多 2／3 候選）
  → 共同候選品質檢查
  → 依頭部／追蹤中心分配左區與右區
  → 左、右各自追蹤及校正
  → 兩邊皆完成後原子封存
```

不得在預設流程中把畫面切成兩張圖片各推論一次。

### 8.2 區域規則

新增明確區域常數，避免 tracker、校正、遊戲各自使用不同數值：

- 左玩家校正區：約 normalized x `0.08–0.46`。
- 中央安全區：約 `0.46–0.54`。
- 右玩家校正區：約 `0.54–0.92`。

實際數值應集中在 balance/config 模組，並以實體鏡頭驗收微調。

校正期間：

- 候選頭部中心必須位於自己的區域。
- 位於中央安全區的候選不採樣。
- 同區出現多個近似候選時標示歧義，不得隨意挑選。
- 候選順序變化不得改變玩家顏色或 participant ID。

遊戲期間：

- 身份仍以已封存 head tracklet 為主，不因短暫跨中央而換人。
- 主手刀點進入中央安全區或對方區域時立即停止計分。
- 水果與碰撞仍只接受相同 participant/lane 的 trail。
- 一側失追只停用該側刀點；是否暫停整場沿用既有安全政策，除非另有需求，不在本次改規則。

## 9. 左右獨立校正

### 9.1 Collector 重構

將 `CalibrationCollector` 從「整幀全體成功才加入」改為每位 participant 獨立 buffer：

- 每一側獨立驗證及加入樣本。
- 某側無效只忽略該側當幀，不 return 阻止另一側。
- tracklet 連續性中斷時只清除該 participant 的 buffer。
- 一側 finalize 後凍結 profile，不再因另一側掉點而失去進度。
- 兩份 profile 都存在後，才呼叫 tracker 的原子 `lockIdentities()`。

建議每側初始要求 16 個穩定樣本；不要再要求 24 個完全同步樣本。

### 9.2 頭部要求

建議第一版規則：

- head center 至少由鼻尖加任一耳，或雙耳，共至少兩個可信頭部點形成。
- 每側 16 個總樣本中，至少 6 個樣本具有有效雙耳距；雙耳距只用於中位數比例，不要求每幀存在。
- 若雙耳樣本不足，不得直接用不可靠值；改以頭到肩偏移、肩寬與軀幹比例建立 identity anchor，並在 UI 顯示「頭部尺度使用肩膀後援」。
- 校正結構信心初始可由 0.50 調整到 0.45；頭部與肩膀細項門檻須有單元測試，且不得低到單一鼻點即可完成。
- profile 必須保留樣本數、可用耳距樣本數與採用的 identity 來源，供診斷顯示。

### 9.3 觀眾風險防護

左右獨立累積可能讓後進入空區的觀眾被誤當玩家，因此必須同時保留：

- 每側 buffer 綁定同一個穩定 headTrackletId。
- tracklet 改變只重置該側。
- 校正期間候選必須持續位於指定區域。
- 完成後顯示姓名、顏色、鎖定環，讓主持人確認。
- 兩份 profile 仍一次原子封存，禁止只鎖一人進遊戲。

### 9.4 主手就緒

- 身份封存後，左右各自累積指定主手就緒幀。
- 保留目前 `confidence >= 0.55` 與連續 3 幀，除非實體測試證明過嚴；本次不要先降低切擊安全門檻。
- 一側主手掉點只重置該側 hand readiness，不影響另一側。
- UI 分別顯示「身份完成／主手待確認」。

## 10. 診斷 UI

校正頁改成兩個彼此獨立的狀態卡及一個效能卡。

每側顯示：

- 該區原始候選數。
- 候選是否通過結構品質。
- head tracklet 是否穩定。
- 校正樣本 `n/16`。
- 雙耳比例樣本 `n/6` 或肩膀後援狀態。
- 身份是否封存。
- 指定主手信心與就緒幀數。

效能卡顯示：

- 選用預設及是否已自動降級。
- 實際 backend、model、input dimension、max poses。
- 推論 FPS、推論 p95、pipeline p95。
- renderer FPS、抗鋸齒、透明及 effects 等級。

診斷訊息順序：

1. 每側辨識／校正的阻塞原因。
2. 效能狀態另行顯示。
3. 不得再用單一 `assessCalibrationHealth()` 回傳值覆蓋所有原因。

## 11. 預計修改檔案

### 新增

- `src/config/performance.ts`
- `src/config/performance.test.ts`
- 視需要新增 `src/vision/lane-calibration.ts` 及測試；也可在保持可讀性的前提下重構現有 tracker。

### 修改

- `src/types/game.ts`：效能設定、Worker 初始化與診斷型別。
- `src/AppController.ts`：設定套用、保存、renderer lifecycle、推論節流、左右校正流程。
- `src/game/FruitDuelGame.ts`：可設定 renderer、sleep/wake、效果品質、中央安全區防護。
- `src/vision/visionClient.ts`：runtime settings、明確模型選擇、統一 adaptation policy。
- `src/vision/pose-runtime-config.ts`：明確 model tier、候選與 backend config。
- `src/vision/pose-worker.ts`：接收明確設定；仍維持每影格一次推論。
- `src/vision/vision-adaptation.ts`：由 preset policy 驅動，加入 calibration-stall feedback。
- `src/vision/calibration-diagnostics.ts`：效能與辨識狀態分離。
- `src/vision/tracker.ts`：左右區域約束、獨立樣本、可缺失 head span。
- `src/ui/screens.ts`：效能設定與左右診斷 UI。
- `src/ui/AppShell.ts`：骨架更新節流／顯示控制。
- `src/styles.css`：效能 class、透明／不透明背景、效果等級。
- 相關單元測試、`tests/e2e/app.spec.ts`、`README.md`。

## 12. 建議實作順序

### 階段 A：建立安全基線

1. 跑 `npm run test:run`、`npm run build`、`npm run test:e2e`。
2. 增加 renderer lifecycle 及現有校正門檻的 characterization tests。
3. 記錄目前首頁／校正頁 RAF 與推論診斷，作為前後比較基線。

### 階段 B：效能設定與保存

1. 建立設定 schema、預設、驗證、localStorage migration。
2. 建立首頁設定 UI 與進階控制。
3. 先只測試設定值正確保存、恢復及鎖定，不立即改 vision/game 行為。

### 階段 C：renderer lifecycle

1. 延遲建立 Phaser。
2. 加入 sleep/wake/recreate。
3. 套用 FPS、抗鋸齒、透明及 effects config。
4. 驗證首頁與校正頁不再有 Phaser RAF 常駐。

### 階段 D：Vision 設定

1. 套用推論 FPS、解析度、模型及候選設定。
2. 統一 UI 與 adaptation 門檻。
3. 加入 Auto hysteresis 與 calibration-stall feedback。
4. 驗證每個攝影機影格最多一次推論，且 profile 切換不造成 Worker 卡住。

### 階段 E：左右獨立校正

1. 抽出 lane bounds。
2. 重構 collector 為 per-player buffers。
3. 放寬 head span 要求並保留原子封存。
4. 主手 readiness 改成分側累積。
5. 增加中央區域及跨區安全測試。

### 階段 F：診斷與文件

1. 分離效能卡與左右辨識卡。
2. 更新 debug overlay、README 與主持人操作說明。
3. 執行全套測試及實體設備驗收。

每一階段完成後都應保持 build 與 tests 綠燈；不要累積到最後才一次修復。

## 13. 必要測試

### 13.1 設定

- 所有 preset 解析為預期設定。
- Custom 值驗證及非法 localStorage 回復 Auto。
- 重整頁面後設定保留。
- 回合進行中無法改初始化級設定。
- 透明／抗鋸齒變更只重建一次 renderer，沒有重複 event listener。

### 13.2 Renderer

- 首頁、設定、校正、結果頁 renderer sleep 或不存在。
- 倒數前 wake，離開遊戲後 sleep。
- 30／45／60 FPS config 正確傳入 Phaser。
- Off／Low／Medium／High 的粒子數與效果符合設定。

### 13.3 Vision

- 15／20／24／30 FPS 節流。
- 512／640／768／960 bitmap 尺寸。
- Lite／Full 初始化及 GPU→CPU fallback。
- 2／3 candidates 切換。
- UI health 與 adaptation 使用相同 policy。
- performance/degraded 狀態不遮住 recognition reason。

### 13.4 雙人校正

- 左側連續成功、右側掉點時左側仍能完成。
- 右側之後完成時才原子封存兩人。
- 一側 tracklet 改變只清除該側。
- 16 個樣本中 6 個有效雙耳距可完成。
- 無雙耳距但頭肩比例穩定時可使用明確後援策略；單一頭點不可完成。
- 中央區候選不採樣。
- 兩人候選順序每幀交換仍不換身份。
- 主手 readiness 分側累積，兩側皆通過才解鎖開始按鈕。

### 13.5 遊戲

- 每人只有一個指定主手刀點。
- 左玩家不可切右區物件，反之亦然。
- 刀點進入中央區立即停止得分。
- 一側失追不產生幽靈刀點或身份交換。
- 單人模式不受雙人 lane collector 影響。
- 正式賽與休閒對戰既有流程仍通過。

## 14. 完成條件

只有同時滿足以下項目才算完成：

- 首頁可選 Auto、效能優先、平衡、畫質優先與進階自訂。
- 模型、解析度、推論 FPS、候選數、render FPS、抗鋸齒、攝影機背景、effects、骨架頻率都有可用設定，且保存後重整不遺失。
- 首頁與校正頁沒有常駐 Phaser 60 FPS loop。
- 效能與辨識診斷分離，門檻一致。
- 雙人仍只使用一次完整影格推論。
- 左右校正各自累積，一側失敗不清除另一側。
- 不再要求每個校正影格都有雙耳，但不允許單一不可靠頭點完成身份。
- 兩人身份及主手都完成前無法開始。
- 中央安全區與 lane ownership 在追蹤、刀光、碰撞及得分層都有效。
- `npm run test:run`、`npm run build`、`npm run test:e2e` 全部通過。
- 工作樹沒有與此需求無關的修改。
- README 明確標示實體雙人追蹤仍需目標設備驗收，不誇大自動化測試結果。

## 15. 實體驗收矩陣

至少在目標 Mac 與實際攝影機測量：

- 單人／雙人。
- Auto／效能優先／平衡／畫質優先。
- 攝影機背景開／關。
- 抗鋸齒開／關。
- 站姿／坐姿。
- 720p30 來源；若使用 iPhone 接續互通，也單獨記錄。

每組記錄：

- backend、model、input size、max poses。
- 推論 FPS、inference p50/p95、pipeline p50/p95。
- 左右校正完成時間。
- raw／accepted／assigned／locked／hand-ready 比率。
- 遊戲中有效追蹤率、暫停次數、身份交換事件。
- 操作者主觀感受：延遲、刀點穩定、畫面流暢與安全性。

若雙人 Auto／平衡在目標設備仍無法穩定完成，不要直接加入第二次推論；先依診斷判斷是解析度、候選數、區域分配、head anchor 或主手品質問題，再決定是否另立 ROI 實驗項目。

## 16. 下一個 session 建議開場指令

> 請先完整閱讀 `IMPLEMENTATION_PLAN_PERFORMANCE_DUAL_LANE.md`，依已確認範圍分階段實作。先建立基線與設定 schema，再處理 renderer lifecycle、Vision 設定、左右獨立校正與診斷。每個階段跑相關測試，不要修改計分、難度、賽事規則，也不要把雙人改成每幀兩次姿態推論。
