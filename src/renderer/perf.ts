/**
 * 效能量測計數器(dev/vrmtest 除錯用)。
 * 「renderedFrames / rafTicks 比例」是 idle 節流的機制不變量——量比例而非絕對 fps,
 * 才不會被疊層遮擋、螢幕更新率污染(DEVLOG §22 教訓)。
 * 多寵物時各 viewer 累加到同一組計數(看的是整個 renderer 行程的總量)。
 */
export const perf = {
  /** rAF callback 被呼叫的總次數(節流跳幀也算)。 */
  rafTicks: 0,
  /** 實際走完渲染路徑的幀數。 */
  renderedFrames: 0,
  /** 泡泡回覆區 markdown 重渲次數(串流優化前 ≈ token 到達率)。 */
  renderReplies: 0,
  /** 泡泡定位(骨骼投影)次數(hover 熱路徑)。 */
  bubblePositions: 0
};

declare global {
  interface Window {
    __perf?: typeof perf;
  }
}
window.__perf = perf;
