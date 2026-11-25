/**
 * CR-20261119-09：判断 draw() 是否需要调用 NodeLayer.setNodes。
 *
 * 问题：draw() 只在 dirtyNodeIds.size > 0 时 setNodes；但 syncViewsFromDocument /
 * applyExternalDocument 会先把 dirtyNodeIds clear 再按新 nodeViews 填充——
 * 当 nodeViews 变空时 dirtyNodeIds 也变空，draw 跳过 setNodes，node-layer 内
 * 旧 DOM 残留（ghost）。
 *
 * 修复：引入 nodeLayerDirty 布尔标记视图已重建，即便 dirtyNodeIds 为空也触发
 * 一次 setNodes([])，让 node-layer 的移除循环清掉 alive 之外的旧元素。
 *
 * 本模块**只有纯函数、无 DOM 依赖**，node --test 链可直接单元测试。
 */

/**
 * 是否需要调用 NodeLayer.setNodes 重建节点层。
 *
 * @param nodeLayerDirty 视图层是否已重建（syncViewsFromDocument / applyExternalDocument 后置 true，
 *                       draw 内 setNodes 成功后复位 false）
 * @param dirtyCount dirtyNodeIds 当前数量
 * @returns true → 调 setNodes；false → 跳过（保持 60fps 拖拽性能）
 */
export function shouldSyncNodeLayer(nodeLayerDirty: boolean, dirtyCount: number): boolean {
  return nodeLayerDirty || dirtyCount > 0;
}
