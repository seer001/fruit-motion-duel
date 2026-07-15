import type { Difficulty, Lane, Participant, ScoreBreakdown, TournamentEvent } from '../types/game';
import type { LeaderboardEntry } from '../tournament';
import {
  getPerformancePresetSettings,
  type PerformanceSettings,
  type PerformancePreset,
} from '../config/performance';
import { describeCameraDevices } from '../vision/camera-devices';
import { escapeHtml } from './dom';

const difficultyOptions = (selected: Difficulty): string =>
  (['easy', 'normal', 'hard'] as const)
    .map(
      (difficulty) => `
        <label>
          <input type="radio" name="difficulty" value="${difficulty}" ${difficulty === selected ? 'checked' : ''} />
          <span>${difficulty === 'easy' ? 'EASY' : difficulty === 'normal' ? 'NORMAL' : 'HARD'}</span>
        </label>`,
    )
    .join('');

export interface HomeScreenOptions {
  cameraReady: boolean;
  modelReady: boolean;
  demoMode: boolean;
  cameraLabel?: string;
  activeDeviceId?: string;
  savedEvent: TournamentEvent | null;
  devices: MediaDeviceInfo[];
  performanceSettings?: PerformanceSettings;
}

const selected = (active: boolean): string => active ? ' selected' : '';
const checked = (active: boolean): string => active ? ' checked' : '';

function performanceSettingsPanel(settings: PerformanceSettings): string {
  const presets: Array<{ value: PerformancePreset; label: string; detail: string }> = [
    { value: 'auto', label: '自動', detail: '從平衡開始並依負載調整' },
    { value: 'performance', label: '效能優先', detail: '15 FPS · Lite · 30 FPS renderer' },
    { value: 'balanced', label: '平衡', detail: '20 FPS · 自動模型 · 45 FPS renderer' },
    { value: 'quality', label: '畫質優先', detail: '30 FPS · Full · 60 FPS renderer' },
    { value: 'custom', label: '進階自訂', detail: '逐項控制本機負載' },
  ];
  return `
    <form class="performance-settings" id="performance-settings-form">
      <div class="performance-settings-heading">
        <div>
          <p class="eyebrow">DEVICE PERFORMANCE</p>
          <h2>效能與畫質</h2>
          <p>設定只保存在這台裝置，不寫入賽事與分數。模型、透明及抗鋸齒只會在沒有進行中回合時套用。</p>
        </div>
        <span class="chip" data-performance-apply-status>目前：${settings.preset === 'custom' ? '進階自訂' : settings.preset.toUpperCase()}</span>
      </div>
      <div class="performance-preset-grid" role="radiogroup" aria-label="效能預設">
        ${presets.map(({ value, label, detail }) => `
          <label>
            <input type="radio" name="performancePreset" value="${value}"${checked(settings.preset === value)} />
            <span><strong>${label}</strong><small>${detail}</small></span>
          </label>
        `).join('')}
      </div>
      <details class="performance-advanced"${settings.preset === 'custom' ? ' open' : ''}>
        <summary>進階單項設定</summary>
        <div class="performance-control-grid">
          <label>姿態模型
            <select name="modelPreference">
              <option value="auto"${selected(settings.modelPreference === 'auto')}>自動（GPU Full／CPU Lite）</option>
              <option value="lite"${selected(settings.modelPreference === 'lite')}>Lite</option>
              <option value="full"${selected(settings.modelPreference === 'full')}>Full（CPU 後援仍為 Lite）</option>
            </select>
          </label>
          <label>推論最長邊
            <select name="inferenceMaxDimension">
              ${[512, 640, 768, 960].map((value) => `<option value="${value}"${selected(settings.inferenceMaxDimension === value)}>${value}px</option>`).join('')}
            </select>
          </label>
          <label>推論目標
            <select name="inferenceTargetFps">
              ${[15, 20, 24, 30].map((value) => `<option value="${value}"${selected(settings.inferenceTargetFps === value)}>${value} FPS</option>`).join('')}
            </select>
          </label>
          <label>姿態候選上限
            <select name="maximumPoseCandidates">
              <option value="2"${selected(settings.maximumPoseCandidates === 2)}>2</option>
              <option value="3"${selected(settings.maximumPoseCandidates === 3)}>3</option>
            </select>
          </label>
          <label>遊戲 renderer
            <select name="gameRenderFps">
              ${[30, 45, 60].map((value) => `<option value="${value}"${selected(settings.gameRenderFps === value)}>${value} FPS</option>`).join('')}
            </select>
          </label>
          <label>視覺效果
            <select name="effectsQuality">
              ${(['off', 'low', 'medium', 'high'] as const).map((value) => `<option value="${value}"${selected(settings.effectsQuality === value)}>${value.toUpperCase()}</option>`).join('')}
            </select>
          </label>
          <label>骨架更新
            <select name="poseOverlayRate">
              ${[0, 10, 15, 30].map((value) => `<option value="${value}"${selected(settings.poseOverlayRate === value)}>${value === 0 ? '關閉' : `${value} FPS`}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="performance-switch-grid">
          <label><input type="checkbox" name="spectatorReserve"${checked(settings.spectatorReserve)} /> 保留第三位觀眾候選</label>
          <label><input type="checkbox" name="antialias"${checked(settings.antialias)} /> Phaser 抗鋸齒</label>
          <label><input type="checkbox" name="showCameraBehindGame"${checked(settings.showCameraBehindGame)} /> 遊戲後方顯示攝影機</label>
          <label><input type="checkbox" name="cssBlur"${checked(settings.cssBlur)} /> 介面模糊與合成效果</label>
        </div>
      </details>
      <div class="button-row performance-actions">
        <button class="btn btn-primary" type="submit" id="apply-performance-settings">套用效能設定</button>
        <button class="btn btn-ghost" type="button" id="restore-auto-settings">恢復自動設定</button>
      </div>
    </form>
  `;
}

export function homeScreen(options: HomeScreenOptions): string {
  const performanceSettings = options.performanceSettings ?? getPerformancePresetSettings('auto');
  const deviceChoices = describeCameraDevices(options.devices);
  const deviceOptions = deviceChoices
    .map(
      (device) =>
        `<option value="${escapeHtml(device.deviceId)}"${device.deviceId === options.activeDeviceId ? ' selected' : ''}>${escapeHtml(device.displayLabel)}</option>`,
    )
    .join('');
  const hasIPhoneCamera = deviceChoices.some(({ category }) => category === 'iphone-continuity');
  const labelsAvailable = deviceChoices.some(({ labelsAvailable: available }) => available);

  return `
    <div class="hero-grid">
      <div>
        <p class="eyebrow">LOCAL · PRIVATE · BODY MOTION</p>
        <h1>揮動你的手，<br />切開勝負。</h1>
        <p class="lead">單人練習與雙人鏡頭體感切水果。影像只在這台 Mac 上運算，不錄影、不上傳；正式賽採獨立鏡像腳本與左右換邊。</p>
      </div>
      <div class="device-card">
        <h3>設備檢查</h3>
        <p>${options.cameraReady ? `已連接：${escapeHtml(options.cameraLabel ?? '攝影機')}` : options.demoMode ? '目前使用滑鼠示範模式。' : '開始前請允許攝影機權限。'}</p>
        <div class="field camera-picker">
          <div class="camera-picker-heading">
            <label for="camera-select">鏡頭來源</label>
            <button class="btn-link" type="button" id="refresh-cameras">重新搜尋</button>
          </div>
          <select id="camera-select">
            ${deviceOptions || '<option value="">自動選擇可用鏡頭</option>'}
          </select>
          <p class="camera-picker-note">
            ${hasIPhoneCamera ? '✓ 已找到 iPhone 接續互通相機，並排在建議位置。' : labelsAvailable ? '尚未看到 iPhone；確認接續互通設定後按「重新搜尋」。' : '首次授權後才會顯示鏡頭名稱；請先連接一次再重新搜尋。'}
          </p>
        </div>
        <div class="button-row">
          <button class="btn btn-primary" type="button" id="connect-camera">${options.cameraReady ? '重新連接' : '連接攝影機'}</button>
          <button class="btn btn-ghost" type="button" id="enable-demo">${options.demoMode ? '已啟用示範' : '滑鼠示範'}</button>
        </div>
        <div class="status-cluster" style="margin-top: 14px">
          <span class="chip">${options.modelReady ? '✓ 多關節姿態模型已離線載入' : '⏳ 多關節姿態模型載入中'}</span>
        </div>
        <details class="iphone-camera-help"${hasIPhoneCamera ? ' open' : ''}>
          <summary>使用 iPhone 16 Pro 鏡頭</summary>
          <ol>
            <li>Mac 與 iPhone 使用相同 Apple 帳號並開啟雙重認證、Wi-Fi、藍牙與「接續互通相機」。</li>
            <li>將 iPhone 鎖定、橫放並固定，後置鏡頭朝向玩家；活動現場建議以 USB 連接並信任這台 Mac。</li>
            <li>按「重新搜尋」，選擇標有「iPhone 接續互通」的項目，再按「連接攝影機」。</li>
          </ol>
          <p><strong>能力說明：</strong>iPhone 的畫質與取景可能提高姿態辨識穩定性，但瀏覽器只會收到一般彩色影像，無法讀取 LiDAR 深度圖。</p>
        </details>
      </div>
    </div>

    ${performanceSettingsPanel(performanceSettings)}

    <div class="mode-grid" style="margin-top: 28px">
      <article class="mode-card" data-mode="solo-practice">
        <div class="mode-icon" aria-hidden="true">🎯</div>
        <p class="eyebrow">SOLO PRACTICE</p>
        <h2>單人練習</h2>
        <p>單人使用完整畫面練習主手切擊，可自選 30–60 秒與難度，不計入賽事排名。</p>
        <button class="btn btn-primary" type="button" id="choose-solo-practice">開始練習</button>
      </article>
      <article class="mode-card" data-mode="casual">
        <div class="mode-icon" aria-hidden="true">⚡</div>
        <p class="eyebrow">CASUAL DUEL</p>
        <h2>休閒對戰</h2>
        <p>45 秒、每人單一指定主手、自由選擇難度。適合暖身、體驗及設備測試。</p>
        <button class="btn btn-primary" type="button" id="choose-casual">設定玩家</button>
      </article>
      <article class="mode-card" data-mode="tournament">
        <div class="mode-icon" aria-hidden="true">🏆</div>
        <p class="eyebrow">TOURNAMENT</p>
        <h2>正式賽事</h2>
        <p>13–30 人、單一主手、兩局換邊、預賽前二進冠軍賽，成績逐局保存。</p>
        <button class="btn btn-primary" type="button" id="choose-tournament">建立賽事</button>
      </article>
    </div>
    ${
      options.savedEvent
        ? `<div class="info-card" style="margin-top: 20px">
            <p class="eyebrow">RECOVERY AVAILABLE</p>
            <h3>發現未完成賽事：${escapeHtml(options.savedEvent.config.title)}</h3>
            <p>${options.savedEvent.participants.filter(({ rankingEligible }) => rankingEligible).length} 位參賽者 · ${options.savedEvent.config.difficulty.toUpperCase()} · ${escapeHtml(options.savedEvent.phase)}</p>
            <div class="button-row">
              <button class="btn btn-primary" id="resume-event" type="button">恢復賽事</button>
              <button class="btn btn-danger" id="discard-event" type="button">刪除紀錄</button>
            </div>
          </div>`
        : ''
    }
  `;
}

export interface SoloPracticeSetupDefaults {
  playerName: string;
  activeHand: Participant['activeHand'];
  posture: Participant['posture'];
  difficulty: Difficulty;
  durationMs: 30_000 | 45_000 | 60_000;
}

export function soloPracticeSetupScreen(
  defaults: SoloPracticeSetupDefaults = {
    playerName: '練習玩家',
    activeHand: 'right',
    posture: 'standing',
    difficulty: 'easy',
    durationMs: 30_000,
  },
): string {
  return `
    <p class="eyebrow">SOLO PRACTICE SETUP</p>
    <h2>單人練習設定</h2>
    <p class="lead">站在鏡頭中央，以指定主手在完整畫面切水果。這個模式適合熟悉動作、測試鏡頭位置與挑戰自己的最高連擊。</p>
    <form id="solo-practice-form">
      <div class="setup-grid solo-setup-grid" style="margin-top: 24px">
        <article class="player-card" style="--accent: var(--lime)">
          <p class="eyebrow">PLAYER</p>
          <div class="field"><label for="solo-player-name">玩家名稱</label><input id="solo-player-name" name="playerName" maxlength="24" value="${escapeHtml(defaults.playerName)}" required /></div>
          <div class="field">
            <span class="field-label">切擊主手</span>
            <div class="segmented segmented-two">
              <label><input type="radio" name="activeHand" value="left" ${defaults.activeHand === 'left' ? 'checked' : ''} /><span>左手</span></label>
              <label><input type="radio" name="activeHand" value="right" ${defaults.activeHand === 'right' ? 'checked' : ''} /><span>右手</span></label>
            </div>
          </div>
          <div class="field">
            <span class="field-label">姿勢</span>
            <div class="segmented segmented-two">
              <label><input type="radio" name="posture" value="standing" ${defaults.posture === 'standing' ? 'checked' : ''} /><span>站姿</span></label>
              <label><input type="radio" name="posture" value="seated" ${defaults.posture === 'seated' ? 'checked' : ''} /><span>坐姿</span></label>
            </div>
          </div>
        </article>
        <aside class="info-card">
          <p class="eyebrow">SESSION</p>
          <div class="field">
            <span class="field-label">難度</span>
            <div class="segmented">${difficultyOptions(defaults.difficulty)}</div>
          </div>
          <div class="field">
            <span class="field-label">練習時間</span>
            <div class="segmented">
              <label><input type="radio" name="duration" value="30000" ${defaults.durationMs === 30_000 ? 'checked' : ''} /><span>30 秒</span></label>
              <label><input type="radio" name="duration" value="45000" ${defaults.durationMs === 45_000 ? 'checked' : ''} /><span>45 秒</span></label>
              <label><input type="radio" name="duration" value="60000" ${defaults.durationMs === 60_000 ? 'checked' : ''} /><span>60 秒</span></label>
            </div>
          </div>
          <div class="practice-tips">
            <div class="chip">👁️ 頭、肩、軀幹保持入鏡</div>
            <div class="chip">🤺 手肘與手腕保持可見</div>
            <div class="chip">🎯 只有指定主手可得分</div>
          </div>
        </aside>
      </div>
      <div class="button-row" style="margin-top: 24px">
        <button class="btn btn-ghost" type="button" id="back-home">返回</button>
        <button class="btn btn-primary" type="submit">進入單人校正</button>
      </div>
    </form>
  `;
}

export function casualSetupScreen(): string {
  return `
    <p class="eyebrow">CASUAL SETUP</p>
    <h2>休閒對戰設定</h2>
    <p class="lead">每位玩家只有一個指定主手切點，雙人合計固定兩點。若使用滑鼠示範，按住並在左右半場揮動。</p>
    <form id="casual-form">
      <div class="player-grid" style="margin-top: 24px">
        <article class="player-card" style="--accent: var(--lane-left)">
          <p class="eyebrow">LEFT PLAYER</p>
          <div class="field"><label for="casual-left-name">玩家名稱</label><input id="casual-left-name" name="leftName" maxlength="24" value="藍隊玩家" required /></div>
          <div class="field">
            <span class="field-label">切擊主手</span>
            <div class="segmented segmented-two">
              <label><input type="radio" name="leftHand" value="left" /><span>左手</span></label>
              <label><input type="radio" name="leftHand" value="right" checked /><span>右手</span></label>
            </div>
          </div>
        </article>
        <article class="player-card" style="--accent: var(--lane-right)">
          <p class="eyebrow">RIGHT PLAYER</p>
          <div class="field"><label for="casual-right-name">玩家名稱</label><input id="casual-right-name" name="rightName" maxlength="24" value="橘隊玩家" required /></div>
          <div class="field">
            <span class="field-label">切擊主手</span>
            <div class="segmented segmented-two">
              <label><input type="radio" name="rightHand" value="left" /><span>左手</span></label>
              <label><input type="radio" name="rightHand" value="right" checked /><span>右手</span></label>
            </div>
          </div>
        </article>
      </div>
      <div class="field" style="margin-top: 24px">
        <span class="field-label">難度</span>
        <div class="segmented">${difficultyOptions('normal')}</div>
      </div>
      <div class="button-row" style="margin-top: 24px">
        <button class="btn btn-ghost" type="button" id="back-home">返回</button>
        <button class="btn btn-primary" type="submit">進入校正</button>
      </div>
    </form>
  `;
}

export function tournamentSetupScreen(): string {
  return `
    <p class="eyebrow">TOURNAMENT SETUP</p>
    <h2>建立正式賽事</h2>
    <p class="lead">每行一位參賽者，可加上主手與姿勢：<strong>名稱 | R 或 L | standing 或 seated</strong>。活動開始後難度與名單即鎖定。</p>
    <form id="tournament-form">
      <div class="setup-grid" style="margin-top: 24px">
        <div>
          <div class="field"><label for="event-title">活動名稱</label><input id="event-title" name="title" maxlength="42" value="果忍對決錦標賽" required /></div>
          <div class="field">
            <div class="inline-fields" style="justify-content: space-between"><label for="roster-input">參賽名單</label><strong id="roster-count">0 / 30</strong></div>
            <textarea id="roster-input" name="roster" placeholder="小明 | R | standing&#10;小華 | L | seated" required></textarea>
          </div>
          <button class="btn btn-ghost" type="button" id="fill-sample-roster">填入 13 人示例</button>
        </div>
        <aside class="info-card">
          <h3>正式規則</h3>
          <p>每人固定一隻主手；每場兩個 25 秒小局並換邊。預賽前二進行兩個 30 秒冠軍小局。</p>
          <div class="field">
            <span class="field-label">整場難度</span>
            <div class="segmented">${difficultyOptions('normal')}</div>
          </div>
          <div class="chip">🔒 影像不儲存</div>
          <div class="chip">↔ 兩局實際換邊</div>
          <div class="chip">🎯 隱藏等效腳本</div>
        </aside>
      </div>
      <div class="button-row" style="margin-top: 24px">
        <button class="btn btn-ghost" type="button" id="back-home">返回</button>
        <button class="btn btn-primary" type="submit">鎖定名單並排程</button>
      </div>
    </form>
  `;
}

export interface CalibrationPlayerView {
  participant: Participant;
  lane: Lane;
  progress: number;
}

export function calibrationScreen(
  players: readonly CalibrationPlayerView[],
  options: { halfLabel: string; demoMode: boolean },
): string {
  const sampleTarget = 16;
  const calibrationFlowCopy = players.length === 1
    ? '系統會獨立累積這位玩家的校正樣本，完成後封存身份設定。'
    : '左右兩側會各自獨立累積校正樣本；一側先完成後會固定該側結果，另一側可繼續收集。只有兩側都完成後，才會一次原子封存兩份身份設定。';
  const playerCard = ({ participant, lane, progress }: CalibrationPlayerView): string => `
    <article class="calibration-player" data-lane="${lane}" data-player-id="${escapeHtml(participant.id)}">
      <p class="eyebrow">${lane.toUpperCase()} LANE</p>
      <h2>${escapeHtml(participant.displayName)}</h2>
      <p>${participant.activeHand === 'left' ? '左手' : '右手'}主手 · ${participant.posture === 'seated' ? '坐姿' : '站姿'}</p>
      <div class="calibration-state${progress >= 1 ? ' is-ready' : ''}">
        ${progress >= 1 ? '✓ 校正完成' : `${Math.round(progress * 100)}% 偵測中`}
      </div>
      <dl class="calibration-player-diagnostics" aria-label="${escapeHtml(participant.displayName)} 辨識品質">
        <div><dt>巷道候選</dt><dd data-player-lane-candidates>0 / 0</dd></div>
        <div><dt>校正樣本</dt><dd data-player-samples>${Math.round(Math.min(1, Math.max(0, progress)) * sampleTarget)}/${sampleTarget}</dd></div>
        <div><dt>耳距樣本</dt><dd data-player-ears>0/6</dd></div>
        <div><dt>結構備援</dt><dd data-player-fallback>等待樣本</dd></div>
        <div><dt>身份</dt><dd data-player-identity data-player-tracking>等待分配</dd></div>
        <div><dt>主手信心</dt><dd data-player-hand>0% 未就緒</dd></div>
        <div><dt>身體品質</dt><dd data-player-quality>—</dd></div>
        <div><dt>可靠點</dt><dd data-player-reliable>0/17</dd></div>
      </dl>
    </article>`;

  return `
    <p class="eyebrow">PLAYER CALIBRATION · ${escapeHtml(options.halfLabel)}</p>
    <h2>${players.length === 1 ? '站在鏡頭中央' : '站進自己的顏色區域'}</h2>
    <p class="lead">正面朝向鏡頭並保持頭部與雙肩清楚入鏡。${calibrationFlowCopy}接著讓主手自然垂下，再緩慢舉至肩高。大型手部圓環定位在拇指／食指／小指中離手臂最遠的當幀實測點，不向外推測手指或工具；肩膀上下約一個軀幹長即可涵蓋遊戲上下緣，不必把手伸出鏡頭。</p>
    <div class="status-cluster" style="justify-content: center">
      <span class="chip">◎ 大圓環＝最外側的當幀實測手部點</span>
      <span class="chip">🔒 頭部色環＝已封存的玩家身份</span>
      <span class="chip">↕ 手留在鏡頭內即可到達上下緣</span>
      <span class="chip">👥 其他入鏡者會被辨識為觀眾並忽略</span>
    </div>
    <section class="calibration-diagnostics" data-calibration-diagnostics data-health="measuring" aria-live="polite">
      <article class="calibration-diagnostic-card calibration-recognition-card" data-recognition-health data-health="measuring">
        <div class="calibration-health">
          <strong data-diag-recognition-label data-diag-health-label>正在量測${players.length === 1 ? '單人' : '雙人'}辨識…</strong>
          <span data-diag-recognition-instruction data-diag-health-instruction>${players.length === 1 ? '請留在畫面中央' : '左右玩家可分別累積；請各自留在自己的色區'}，穩定站立約 1 秒。</span>
        </div>
        <dl class="calibration-metrics" aria-label="即時辨識診斷">
          <div><dt>原始人體</dt><dd data-diag-raw>0</dd></div>
          <div><dt>合格候選</dt><dd data-diag-accepted>0/${players.length}</dd></div>
          <div><dt>已分配</dt><dd data-diag-assigned>0/${players.length}</dd></div>
          <div><dt>身份封存</dt><dd data-diag-locked>0/${players.length}</dd></div>
        </dl>
      </article>
      <article class="calibration-diagnostic-card calibration-performance-card" data-performance-health data-health="measuring">
        <div class="calibration-health">
          <strong data-diag-performance-label>正在量測效能…</strong>
          <span data-diag-performance-instruction>效能狀態獨立顯示，不會覆蓋玩家辨識與校正原因。</span>
        </div>
        <dl class="calibration-metrics" aria-label="即時效能診斷">
          <div><dt>效能設定</dt><dd data-diag-profile>正在讀取</dd></div>
          <div><dt>姿態模型</dt><dd data-diag-model>STARTING</dd></div>
          <div><dt>推論輸入</dt><dd data-diag-input>—</dd></div>
          <div><dt>推論吞吐</dt><dd data-diag-throughput>STARTING · 0.0 FPS</dd></div>
          <div><dt>p95 延遲</dt><dd data-diag-latency>推論 0 / 全流程 0 ms</dd></div>
          <div><dt>Renderer</dt><dd data-diag-renderer>等待啟用</dd></div>
        </dl>
      </article>
    </section>
    <div class="calibration-layout${players.length === 1 ? ' is-single' : ''}" style="margin-top: 24px">
      ${players.map((view, index) => `${index > 0 ? '<div class="safe-divider">中央安全區</div>' : ''}${playerCard(view)}`).join('')}
    </div>
    <div class="button-row" style="justify-content: center; margin-top: 24px">
      <button class="btn btn-ghost" type="button" id="cancel-calibration">取消</button>
      <button class="btn btn-primary" type="button" id="approve-calibration" ${players.every(({ progress }) => progress >= 1) || options.demoMode ? '' : 'disabled'}>
        ${options.demoMode ? '示範模式直接開始' : '校正完成，繼續'}
      </button>
    </div>
  `;
}

export function soloPracticeResultScreen(
  participant: Participant,
  score: ScoreBreakdown,
  durationMs: number,
  difficulty: Difficulty,
): string {
  const accuracyDenominator = score.fruitHits + score.fruitMisses;
  const accuracy = accuracyDenominator > 0
    ? Math.round((score.fruitHits / accuracyDenominator) * 100)
    : 0;
  const difficultyLabel = difficulty === 'easy' ? 'EASY' : difficulty === 'normal' ? 'NORMAL' : 'HARD';
  return `
    <div class="solo-result-heading">
      <p class="eyebrow">SOLO PRACTICE COMPLETE</p>
      <h2>${escapeHtml(participant.displayName)} 的練習成績</h2>
      <p class="lead">${difficultyLabel} · ${Math.round(durationMs / 1000)} 秒 · ${participant.activeHand === 'left' ? '左手' : '右手'}主手</p>
    </div>
    <div class="solo-score-hero">
      <span class="muted">總分</span>
      <strong>${score.score.toLocaleString()}</strong>
    </div>
    <div class="practice-stat-grid">
      <article><span>命中水果</span><strong>${score.fruitHits}</strong></article>
      <article><span>命中率</span><strong>${accuracy}%</strong></article>
      <article><span>最長連擊</span><strong>${score.maxCombo}</strong></article>
      <article><span>誤觸炸彈</span><strong>${score.bombsHit}</strong></article>
    </div>
    <p class="muted practice-result-note">漏果 ${score.fruitMisses} 會顯示在練習統計中，但不會扣分；這份成績不計入正式賽排名。</p>
    <div class="button-row" style="justify-content: center; margin-top: 24px">
      <button class="btn btn-primary" id="solo-replay" type="button">同設定再練一次</button>
      <button class="btn btn-ghost" id="solo-settings" type="button">調整設定</button>
      <button class="btn btn-ghost" id="solo-home" type="button">回主畫面</button>
    </div>
  `;
}

export function practiceReadyScreen(players: Participant[], durationMs: number): string {
  return `
    <p class="eyebrow">PRACTICE ROUND</p>
    <h2>${players.map(({ displayName }) => escapeHtml(displayName)).join('　VS　')}</h2>
    <p class="lead">先進行 ${Math.round(durationMs / 1000)} 秒不計分練習。水果只屬於自己的半場；正式賽請只使用登記主手。</p>
    <div class="info-card">
      <h3>安全提醒</h3>
      <p>雙腳／輪椅留在地貼範圍，不跨越中央帶、不跳躍、不踢腿。周圍觀眾請退出鏡頭畫面。</p>
    </div>
    <div class="button-row" style="margin-top: 24px">
      <button class="btn btn-primary" type="button" id="start-practice">開始練習</button>
    </div>
  `;
}

export function swapScreen(players: Participant[], minimumSeconds: number): string {
  return `
    <p class="eyebrow">SIDE SWAP</p>
    <h2>交換左右位置</h2>
    <p class="lead">${players.map(({ displayName }) => escapeHtml(displayName)).join(' 與 ')} 請實際交換地貼。姓名與顏色仍綁定玩家 ID，下一局會重新校正。</p>
    <div class="info-card">
      <h3>休息與安全</h3>
      <p>至少休息 ${minimumSeconds} 秒。坐姿玩家請固定椅腳；輪椅請重新鎖定煞車。</p>
      <div class="hud-timer" id="swap-timer" style="display: inline-block">${minimumSeconds}</div>
    </div>
    <div class="button-row" style="margin-top: 24px">
      <button class="btn btn-primary" id="confirm-swap" type="button" disabled>位置已交換，重新校正</button>
    </div>
  `;
}

export function reviewScreen(
  players: Participant[],
  scores: Record<string, ScoreBreakdown>,
  label: string,
): string {
  return `
    <p class="eyebrow">HOST REVIEW · ${escapeHtml(label)}</p>
    <h2>確認技術有效性</h2>
    <p class="lead">主持人只能確認有效或以技術理由作廢，不能修改分數。</p>
    <div class="result-grid" style="margin-top: 22px">
      ${players
        .map((player) => {
          const score = scores[player.id];
          return `<article class="result-card">
            <p class="eyebrow">${escapeHtml(player.displayName)}</p>
            <div class="hud-points">${(score?.score ?? 0).toLocaleString()}</div>
            <p>水果 ${score?.fruitHits ?? 0} · 漏果 ${score?.fruitMisses ?? 0} · 炸彈 ${score?.bombsHit ?? 0} · 最長連擊 ${score?.maxCombo ?? 0}</p>
          </article>`;
        })
        .join('')}
    </div>
    <div class="field" style="margin-top: 22px">
      <label for="void-reason">技術作廢原因（只有作廢時需要）</label>
      <input id="void-reason" maxlength="120" placeholder="例如：攝影機斷線、身份追蹤交換" />
    </div>
    <div class="button-row">
      <button class="btn btn-primary" id="confirm-result" type="button">確認成績</button>
      <button class="btn btn-danger" id="void-result" type="button">作廢並重跑本局</button>
    </div>
  `;
}

export function leaderboardScreen(
  title: string,
  entries: readonly LeaderboardEntry[],
  options: { allQualifiersDone: boolean; finalActive: boolean },
): string {
  return `
    <p class="eyebrow">LIVE LEADERBOARD</p>
    <h2>${escapeHtml(title)}</h2>
    <div class="leaderboard" style="margin-top: 22px">
      ${entries
        .map(
          (entry) => `<div class="leader-row">
            <div class="rank">${entry.rank}</div>
            <div><strong>${escapeHtml(entry.displayName)}</strong><div class="muted">命中 ${entry.fruitHits} · 漏果 ${entry.fruitMisses} · 炸彈 ${entry.bombsHit}</div></div>
            <span class="chip">${entry.halvesConfirmed}/2 局</span>
            <div class="score-value">${entry.score.toLocaleString()}</div>
          </div>`,
        )
        .join('') || '<p class="muted">尚無已確認成績。</p>'}
    </div>
    <div class="button-row" style="margin-top: 24px">
      ${
        options.finalActive
          ? '<button class="btn btn-primary" id="continue-final" type="button">準備冠軍賽</button>'
          : options.allQualifiersDone
            ? '<button class="btn btn-primary" id="start-final" type="button">鎖定前二，開始冠軍賽</button>'
            : '<button class="btn btn-primary" id="next-heat" type="button">下一組上場</button>'
      }
      <button class="btn btn-ghost" id="return-home" type="button">回主畫面</button>
    </div>
  `;
}

export function championScreen(champion: Participant, finalEntries: readonly LeaderboardEntry[]): string {
  return `
    <div style="text-align: center">
      <div style="font-size: 5rem" aria-hidden="true">🏆</div>
      <p class="eyebrow">TOURNAMENT CHAMPION</p>
      <h1>${escapeHtml(champion.displayName)}</h1>
      <p class="lead" style="margin-inline: auto">冠軍只依冠軍賽兩個新腳本小局的合計成績產生。</p>
      <div class="result-grid" style="margin-top: 26px">
        ${finalEntries
          .map(
            (entry) => `<article class="result-card">
              <p class="eyebrow">FINAL RANK ${entry.rank}</p>
              <h2>${escapeHtml(entry.displayName)}</h2>
              <div class="hud-points">${entry.score.toLocaleString()}</div>
              <p>水果 ${entry.fruitHits} · 漏果 ${entry.fruitMisses} · 炸彈 ${entry.bombsHit}</p>
            </article>`,
          )
          .join('')}
      </div>
      <div class="button-row" style="justify-content: center; margin-top: 26px">
        <button class="btn btn-primary" id="finish-event" type="button">完成並返回主畫面</button>
      </div>
    </div>
  `;
}
