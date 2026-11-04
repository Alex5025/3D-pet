import { BrowserWindow, powerMonitor, screen } from 'electron';
import { type DragMonitor } from './dragMonitor';
import { createResourceScope } from './resourceScope';
import type { PetProfile } from './runtimeTypes';

export interface PowerDeps {
  readonly win: BrowserWindow | null;
  readonly pets: Map<string, PetProfile>;
  readonly dragMonitor: DragMonitor | null;
}

/** power 的狀態與資源由此實例管理；建立時不註冊 IPC 或啟動背景工作。 */
export function createPower(deps: PowerDeps) {
  const scope = createResourceScope();

  let overlayBounds: Electron.Rectangle = { x: 0, y: 0, width: 0, height: 0 };

  // 主顯示器變更(換螢幕/改解析度/闔蓋切外接)時,疊層要跟著鋪滿新的主顯示——
  // 視窗不會自己調整;不同步的話新螢幕比舊視窗寬的部分成為界外,寵物站在那裡就被切掉。
  function syncOverlayBounds(): void {
    if (!deps.win || deps.win.isDestroyed()) return;
    const target = screen.getPrimaryDisplay().bounds;
    const current = deps.win.getBounds();
    if (
      current.x !== target.x || current.y !== target.y ||
      current.width !== target.width || current.height !== target.height
    ) {
      deps.win.setBounds(target);
    }
    overlayBounds = deps.win.getBounds();
  }

  /* ── 游標輪詢中央控制 + 功率檔位(效能優化階段 2)──
   * click-through 視窗收不到被動 mousemove(§平台實證),輪詢是必要之惡;
   * 但頻率交給功率檔位決定,鎖屏/睡眠/全寵休息時完全停掉。 */
  let cursorTimer: NodeJS.Timeout | null = null;

  let cursorPollMs = 30;

  function setCursorPoll(intervalMs: number | null): void {
    if (cursorTimer) {
      scope.clearInterval(cursorTimer);
      cursorTimer = null;
    }
    if (intervalMs === null) return;
    cursorPollMs = intervalMs;
    // 心跳不變量:renderer 拖曳看門狗(1200ms 判死)依賴 ≈1s 一次的強制心跳,
    // 任何輪詢頻率下 sameLimit 都要換算回「約 1 秒」而不是固定次數
    const sameLimit = Math.max(1, Math.round(1000 / intervalMs));
    let lastX = -1e9;
    let lastY = -1e9;
    let sameCount = 0;
    cursorTimer = scope.interval(() => {
      if (!deps.win || deps.win.isDestroyed()) return;
      const point = screen.getCursorScreenPoint();
      if (point.x === lastX && point.y === lastY && ++sameCount < sameLimit) return;
      sameCount = 0;
      lastX = point.x;
      lastY = point.y;
      deps.win.webContents.send('cursor', { x: point.x - overlayBounds.x, y: point.y - overlayBounds.y });
    }, intervalMs);
  }

  /** 功率檔位:normal(AC)/ eco(電池或微熱)/ critical(過熱)/ suspended(鎖屏/睡眠)。 */
  const POWER_TIERS = {
    normal: { pollMs: 30, idleSkip: 6, idleDelayMs: 3000, activeSkip: 1 },
    eco: { pollMs: 60, idleSkip: 12, idleDelayMs: 1500, activeSkip: 2 },
    critical: { pollMs: 120, idleSkip: 20, idleDelayMs: 1000, activeSkip: 3 }
  } as const;

  type PowerTier = keyof typeof POWER_TIERS | 'suspended';

  let onBattery = false;

  let thermal = 'nominal';

  let screenOff = false;
  // 鎖屏或系統睡眠
  let powerTier: PowerTier | null = null;
  // null = 尚未套用過(開機首套必發)

  function computeTier(): PowerTier {
    if (screenOff) return 'suspended';
    if (thermal === 'serious' || thermal === 'critical') return 'critical';
    if (onBattery || thermal === 'fair') return 'eco';
    return 'normal';
  }

  function currentProfilePayload(): Record<string, unknown> {
    if (powerTier === 'suspended' || powerTier === null) {
      return { tier: powerTier ?? 'normal', paused: powerTier === 'suspended', ...POWER_TIERS.normal };
    }
    return { tier: powerTier, paused: false, ...POWER_TIERS[powerTier] };
  }

  function anyPetEnabled(): boolean {
    return [...deps.pets.values()].some((profile) => profile.enabled !== false);
  }

  function applyPowerTier(): void {
    const next = computeTier();
    if (next === powerTier) return;
    powerTier = next;
    console.log(`[power] 功率檔位 → ${next}(battery=${onBattery} thermal=${thermal} screenOff=${screenOff})`);
    deps.win?.webContents.send('power-profile-apply', currentProfilePayload());
    refreshCursorPoll();
  }

  /** 輪詢頻率 = 檔位 × 有沒有醒著的寵物(全休息時輪詢沒有意義)。拖曳偵測 helper 同進退。 */
  function refreshCursorPoll(): void {
    if (scope.disposed) return;
    const alive = powerTier !== 'suspended' && anyPetEnabled();
    if (!alive) setCursorPoll(null);
    else setCursorPoll(POWER_TIERS[(powerTier ?? 'normal') as keyof typeof POWER_TIERS].pollMs);
    deps.dragMonitor?.setActive(alive);
  }
  // updatePet(enabled 變更)經此重算
  const isIdleMotionPaused = () => powerTier === 'suspended';
  // 鎖屏/睡眠不播待機動作

  const updatePowerState = (): void => {
    onBattery = powerMonitor.isOnBatteryPower();
    try {
      thermal = powerMonitor.getCurrentThermalState(); // macOS 專屬;其他平台 unknown
    } catch {
      thermal = 'unknown';
    }
    applyPowerTier();
  };
  async function start() {
    if (!scope.start()) return;

    syncOverlayBounds();

    scope.listen(screen, 'display-metrics-changed', syncOverlayBounds);

    scope.listen(screen, 'display-added', syncOverlayBounds);

    scope.listen(screen, 'display-removed', syncOverlayBounds);

    scope.listen(powerMonitor, 'on-battery', updatePowerState);

    scope.listen(powerMonitor, 'on-ac', updatePowerState);

    scope.listen(powerMonitor, 'thermal-state-change', updatePowerState);

    scope.listen(powerMonitor, 'lock-screen', () => { screenOff = true; applyPowerTier(); });

    scope.listen(powerMonitor, 'unlock-screen', () => { screenOff = false; updatePowerState(); });

    scope.listen(powerMonitor, 'suspend', () => { screenOff = true; applyPowerTier(); });

    scope.listen(powerMonitor, 'resume', () => { screenOff = false; updatePowerState(); });

    if (deps.win) scope.listen(deps.win.webContents, 'did-finish-load', () => {
      // renderer 重載會失去檔位狀態:重送當前 profile 再重啟輪詢(沿用防疊 timer 的既有防護)
      deps.win?.webContents.send('power-profile-apply', currentProfilePayload());
      refreshCursorPoll();
    });

    updatePowerState();
    // dragMonitor 建立後同步一次啟停狀態(開機時全寵休息的情境)

    // VRM_PET_PERF_LOG=1:每 5 秒把 renderer 的 render/rAF 比例印到終端機。
    // 疊層開不了 DevTools(平台限制),這是唯一能在真 overlay 上讀 __perf 的通道;
    // 比例是節流機制不變量:閒置該 ≈1/idleSkip,持續 ≈1.0 = 有東西一直在喚醒渲染。
    if (process.env['VRM_PET_PERF_LOG'] === '1') {
      let last = { raf: 0, ren: 0, pos: 0 };
      scope.interval(() => {
        void (async () => {
          try {
            const perf = await deps.win?.webContents.executeJavaScript('window.__perf') as
              { rafTicks: number; renderedFrames: number; bubblePositions: number; } | undefined;
            if (!perf) return;
            const dRaf = perf.rafTicks - last.raf;
            const dRen = perf.renderedFrames - last.ren;
            const dPos = perf.bubblePositions - last.pos;
            last = { raf: perf.rafTicks, ren: perf.renderedFrames, pos: perf.bubblePositions };
            console.log(`[perf] 5s: rAF=${dRaf} render=${dRen} ratio=${dRaf ? (dRen / dRaf).toFixed(2) : '-'} bubblePos=${dPos}`);
          } catch { /* renderer 重載間隙 */ }
        })();
      }, 5_000);
    }
  }
  return {
    get refreshCursorPoll() { return refreshCursorPoll; },
    get isIdleMotionPaused() { return isIdleMotionPaused; },
    get overlayBounds() { return overlayBounds; },
    get powerTier() { return powerTier; },
    start,
    dispose: () => scope.dispose(),
  };
}
export type Power = ReturnType<typeof createPower>;
