/**
 * CR-20261119-11：画布共享常量（MIN 尺寸 / 命中热区 / 端口让位）。
 *
 * 本文件**只有常量、零 import**。engine.ts、resize-math.ts、interaction.ts 都从它 import，
 * 消除 ESM 循环（engine.ts 曾本地定义 RESIZE_HANDLE_HIT，resize-math.ts 需要它当默认参数，
 * engine 又要 import resize-math → 循环）。
 */

/** CR-20261118-05 + CR-20261119-11：缩放下限。上限复用格式层 MAX_NODE_DIMENSION。 */
export const MIN_NODE_WIDTH  = 80;
export const MIN_NODE_HEIGHT = 48;

/** CR-20261119-11：角/边缘命中热区基准（原在 engine.ts 本地定义）。 */
export const RESIZE_HANDLE_HIT = 12;

/** CR-20261119-11：端口命中热区（原在 engine.ts 本地定义；spec §4.2 写 14px，属既有偏差，本 CR 不修）。 */
export const PORT_HALF_HIT = 12;

/** CR-20261119-11：端口让位外推。端口 zone 内点 port；zone 外才点 resize。
 *  12–16px 是死区（落 node）。 */
export const PORT_LEAVE = PORT_HALF_HIT + 4;  // 16

/** CR-20261121-46：视频原生控件条保留高度（WebKit 内联控件叠加在视频底部）。
 *  按压落在这条带内交给原生控件（不建手势/不捕获）；其余画面放行给画布拖拽。 */
export const MEDIA_CONTROL_STRIP_PX = 44;
