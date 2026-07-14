import { expect, test, type Page } from '@playwright/test';

async function enableMouseDemo(page: Page): Promise<void> {
  await page.getByRole('button', { name: '滑鼠示範', exact: true }).click();
  await expect(page.locator('#camera-status')).toContainText('滑鼠示範模式');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /揮動你的手/ })).toBeVisible();
});

test('首頁呈現隱私、設備與三種遊戲入口', async ({ page }) => {
  await expect(page).toHaveTitle('果忍對決 Fruit Motion Duel');
  await expect(page.getByText('影像只在這台 Mac 上運算')).toBeVisible();
  await expect(page.getByRole('button', { name: '連接攝影機' })).toBeVisible();
  await expect(page.getByRole('button', { name: '開始練習' })).toBeVisible();
  await expect(page.getByRole('button', { name: '設定玩家' })).toBeVisible();
  await expect(page.getByRole('button', { name: '建立賽事' })).toBeVisible();
  await expect(page.getByRole('slider', { name: '音量' })).toHaveValue('0.72');
  // This waits through the real Worker/WASM/model initialization, exercising
  // GPU creation and the CPU fallback instead of only checking loading copy.
  await expect(page.getByText('✓ 多關節姿態模型已離線載入')).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('使用 iPhone 16 Pro 鏡頭')).toBeVisible();
  await expect(page.locator('.game-layer')).toHaveAttribute('data-renderer-state', 'absent');
  await expect(page.locator('.game-layer canvas')).toHaveCount(0);
  await expect(page.locator('#app')).toHaveAttribute('data-auto-performance-stage', '0');
});

test('鏡頭清單會優先顯示 iPhone 接續互通相機', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        async enumerateDevices(): Promise<MediaDeviceInfo[]> {
          return [
            {
              deviceId: 'mac-camera',
              groupId: 'mac',
              kind: 'videoinput',
              label: 'FaceTime HD Camera',
              toJSON: () => ({}),
            },
            {
              deviceId: 'iphone-camera',
              groupId: 'phone',
              kind: 'videoinput',
              label: 'iPhone 16 Pro Camera',
              toJSON: () => ({}),
            },
          ];
        },
        async getUserMedia(): Promise<never> {
          throw new DOMException('Not used in this test', 'AbortError');
        },
        addEventListener(): void {},
        removeEventListener(): void {},
      },
    });
  });
  await page.reload();

  const options = page.locator('#camera-select option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText('iPhone 16 Pro Camera');
  await expect(options.nth(0)).toContainText('iPhone 接續互通');
  await expect(options.nth(1)).toContainText('Mac 內建');
  await expect(page.getByText('已找到 iPhone 接續互通相機')).toBeVisible();
});

test('效能設定可保存、重整並恢復 Auto', async ({ page }) => {
  await expect(page.getByText('✓ 多關節姿態模型已離線載入')).toBeVisible({ timeout: 20_000 });
  await page.getByText('效能優先', { exact: true }).click();
  await expect(page.locator('input[name="performancePreset"][value="performance"]')).toBeChecked();
  await page.getByText('進階單項設定', { exact: true }).click();
  await page.getByLabel('遊戲後方顯示攝影機').uncheck();
  await page.getByRole('button', { name: '套用效能設定' }).click();

  await expect(page.locator('input[name="performancePreset"][value="performance"]')).toBeChecked();
  await expect(page.getByLabel('遊戲後方顯示攝影機')).not.toBeChecked();
  await expect(page.locator('#app')).toHaveAttribute('data-css-blur', 'false');
  await expect(page.locator('#app')).toHaveAttribute('data-auto-performance-stage', 'fixed');
  await expect(page.locator('.game-layer')).toHaveAttribute('data-renderer-state', 'absent');

  await page.reload();
  await expect(page.locator('input[name="performancePreset"][value="performance"]')).toBeChecked();
  await expect(page.getByLabel('遊戲後方顯示攝影機')).not.toBeChecked();

  await page.getByRole('button', { name: '恢復自動設定' }).click();
  await expect(page.locator('input[name="performancePreset"][value="auto"]')).toBeChecked();
  await expect(page.locator('#app')).toHaveAttribute('data-css-blur', 'true');
  await expect(page.locator('#app')).toHaveAttribute('data-auto-performance-stage', '0');
  expect(await page.evaluate(() =>
    localStorage.getItem('body-fruit-duel:performance-settings:v1'),
  )).toBeNull();
});

test('滑鼠示範可設定單人練習並進入單人校正', async ({ page }) => {
  await enableMouseDemo(page);
  await page.getByRole('button', { name: '開始練習' }).click();

  await expect(page.getByRole('heading', { name: '單人練習設定' })).toBeVisible();
  await page.getByLabel('玩家名稱').fill('果影');
  await page.getByText('左手', { exact: true }).click();
  await page.getByText('坐姿', { exact: true }).click();
  await page.getByText('NORMAL', { exact: true }).click();
  await page.getByText('45 秒', { exact: true }).click();
  await page.getByRole('button', { name: '進入單人校正' }).click();

  await expect(page.getByRole('heading', { name: '站在鏡頭中央' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '果影' })).toBeVisible();
  await expect(page.getByText('左手主手 · 坐姿')).toBeVisible();
  await expect(page.locator('.calibration-player')).toHaveCount(1);
  await expect(page.locator('.game-layer')).toHaveAttribute('data-renderer-state', 'absent');
  const start = page.getByRole('button', { name: '示範模式直接開始' });
  await expect(start).toBeEnabled();
  await start.click();

  await expect(page.locator('.game-hud')).toBeVisible();
  await expect(page.locator('.hud-left-name')).toHaveText('果影');
  await expect(page.locator('.hud-score[data-lane="right"]')).toBeHidden();
  await expect(page.getByRole('button', { name: '結束遊戲' })).toBeVisible();
  await expect(page.locator('#app')).toHaveClass(/is-solo-arena/);
  const hostDockBox = await page.locator('.host-dock').boundingBox();
  expect(hostDockBox?.height).toBeLessThan(120);
  await expect(page.locator('.game-layer')).toHaveAttribute('data-renderer-state', 'awake');
  await expect(page.locator('.game-layer canvas')).toHaveCount(1);

  await page.getByRole('button', { name: '結束遊戲' }).click();
  await expect(page.getByRole('heading', { name: '單人練習設定' })).toBeVisible();
  await expect(page.locator('.game-layer')).toHaveAttribute('data-renderer-state', 'sleeping');
});

test('攝影機權限被拒時保留在安全啟動頁並顯示可恢復提示', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        async getUserMedia(): Promise<never> {
          throw new DOMException('Permission denied by test', 'NotAllowedError');
        },
        async enumerateDevices(): Promise<MediaDeviceInfo[]> {
          return [];
        },
        addEventListener(): void {},
        removeEventListener(): void {},
      },
    });
  });
  await page.reload();

  await page.getByRole('button', { name: '連接攝影機' }).click();
  await expect(page.getByText(/攝影機權限遭拒/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /揮動你的手/ })).toBeVisible();
  await expect(page.locator('#camera-status')).toContainText('鏡頭尚未就緒');
});

test('滑鼠示範可完成休閒設定並進入雙人校正', async ({ page }) => {
  await enableMouseDemo(page);
  await page.getByRole('button', { name: '設定玩家' }).click();

  await expect(page.getByRole('heading', { name: '休閒對戰設定' })).toBeVisible();
  await page.getByLabel('玩家名稱').nth(0).fill('海藍');
  await page.getByLabel('玩家名稱').nth(1).fill('夕橘');
  await page.getByText('HARD', { exact: true }).click();
  await expect(page.locator('input[name="difficulty"][value="hard"]')).toBeChecked();
  await page.getByRole('button', { name: '進入校正' }).click();

  await expect(page.getByRole('heading', { name: '站進自己的顏色區域' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '海藍' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '夕橘' })).toBeVisible();
  await expect(page.locator('.calibration-player')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '示範模式直接開始' })).toBeEnabled();
});

test('13 人示例名單可鎖定、排程並進入練習準備', async ({ page }) => {
  await enableMouseDemo(page);
  await page.getByRole('button', { name: '建立賽事' }).click();

  await expect(page.getByRole('heading', { name: '建立正式賽事' })).toBeVisible();
  await page.getByLabel('活動名稱').fill('現場煙霧測試賽');
  await page.getByRole('button', { name: '填入 13 人示例' }).click();
  await expect(page.locator('#roster-count')).toHaveText('13 / 30');
  await page.getByRole('button', { name: '鎖定名單並排程' }).click();

  await expect(page.getByRole('heading', { name: '站進自己的顏色區域' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('.calibration-player')).toHaveCount(2);
  await page.getByRole('button', { name: '示範模式直接開始' }).click();

  await expect(page.getByText('先進行 10 秒不計分練習')).toBeVisible();
  await expect(page.getByRole('button', { name: '開始練習' })).toBeVisible();
});
