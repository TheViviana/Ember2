// 本实现与 core vault-index.ts 的 tree 字段排序规则保持一致，但作为 UI 渲染专用逻辑独立存在，以便未来支持过滤和自定义排序。
/**
 * 扁平索引 → 嵌套目录树的纯数据转换。
 *
 * - 输入是 core 索引的 `Map<path, DocMeta>`，输出只包含 UI 需要的 path / name / children；
 * - 目录在前、文件在后，同层按名称码点排序（与 core 的稳定排序一致）；
 * - 可选 `orderFor`：为某目录登记自定义顺序后，按登记顺序排列（未登记项默认追加）；
 * - 不读写任何状态，不依赖 React，便于单元测试。
 */
import type { DocMeta } from '../../core/vault-index';

export interface BuildTreeOptions {
  /** 返回某目录的登记子节点顺序；未登记返回 undefined → 走默认排序。 */
  readonly orderFor?: (dirPath: string) => readonly string[] | undefined;
  /** 已知空目录（如 pendingDirs 兜底的占位路径）：同名 meta 按目录节点处理。 */
  readonly dirs?: ReadonlySet<string>;
}

export interface TreeFileNode {
  readonly kind: 'file';
  readonly name: string;
  readonly path: string;
}

export interface TreeDirNode {
  readonly kind: 'dir';
  readonly name: string;
  readonly path: string;
  readonly children: readonly TreeNode[];
}

export type TreeNode = TreeDirNode | TreeFileNode;

/** 展开状态下的可见行；只含原始值，便于 TreeRow 做 memo 比较。 */
export interface TreeRowDescriptor {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly kind: 'dir' | 'file';
  readonly hasChildren: boolean;
}

interface MutableDir {
  readonly name: string;
  readonly path: string;
  readonly dirs: Map<string, MutableDir>;
  readonly files: Map<string, TreeFileNode>;
}

function createDir(name: string, path: string): MutableDir {
  return { name, path, dirs: new Map(), files: new Map() };
}

export function buildTree(
  docs: ReadonlyMap<string, DocMeta>,
  options: BuildTreeOptions = {},
): readonly TreeNode[] {
  const root = createDir('', '');

  for (const meta of docs.values()) {
    const segments = meta.path.split('/').filter((segment) => segment.length > 0);
    const fileName = segments.pop();
    if (fileName === undefined) continue;

    let dir = root;
    for (const segment of segments) {
      const childPath = dir.path === '' ? segment : `${dir.path}/${segment}`;
      let child = dir.dirs.get(segment);
      if (!child) {
        child = createDir(segment, childPath);
        dir.dirs.set(segment, child);
      }
      dir = child;
    }

    const filePath = segments.length === 0 ? fileName : `${segments.join('/')}/${fileName}`;
    if (options.dirs?.has(filePath)) {
      // CR-20261123：空目录以占位 meta 传入，按目录节点登记，避免被当成同名文件。
      dir.dirs.set(fileName, createDir(fileName, filePath));
      continue;
    }
    dir.files.set(fileName, { kind: 'file', name: fileName, path: filePath });
  }

  return materialize(root, options.orderFor);
}

/** 取某目录在树中的直接子节点名（dir 为空串返回根层）。找不到目录返回空数组。 */
export function dirChildrenNames(
  nodes: readonly TreeNode[],
  dir: string,
): readonly string[] {
  if (dir === '') return nodes.map((node) => node.name);
  let current = nodes;
  for (const segment of dir.split('/')) {
    const found = current.find((node) => node.kind === 'dir' && node.name === segment);
    if (found === undefined || found.kind !== 'dir') return [];
    current = found.children;
  }
  return current.map((node) => node.name);
}

/** 深度优先展开可见节点：目录折叠时只保留自身一行。 */
export function flattenVisible(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
): readonly TreeRowDescriptor[] {
  const rows: TreeRowDescriptor[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') {
      rows.push({
        path: node.path,
        name: node.name,
        depth,
        kind: 'file',
        hasChildren: false,
      });
      continue;
    }

    rows.push({
      path: node.path,
      name: node.name,
      depth,
      kind: 'dir',
      hasChildren: node.children.length > 0,
    });
    if (expanded.has(node.path)) {
      rows.push(...flattenVisible(node.children, expanded, depth + 1));
    }
  }
  return rows;
}

function materialize(
  dir: MutableDir,
  orderFor?: (dirPath: string) => readonly string[] | undefined,
): readonly TreeNode[] {
  const children: TreeNode[] = [
    ...[...dir.dirs.values()].map((child) => ({
      kind: 'dir' as const,
      name: child.name,
      path: child.path,
      children: materialize(child, orderFor),
    })),
    ...[...dir.files.values()],
  ];
  return sortChildren(children, orderFor?.(dir.path));
}

/**
 * 排序子节点：
 *  - 未登记顺序（order 为 undefined/空）→ 默认：目录在前、文件在后，各自按名称码点；
 *  - 已登记顺序 → 先按登记顺序排现存项，未登记项保持「目录在前、文件在后」追加在末尾。
 */
function sortChildren(
  children: readonly TreeNode[],
  order: readonly string[] | undefined,
): readonly TreeNode[] {
  if (order === undefined || order.length === 0) {
    return defaultOrder(children);
  }
  const byName = new Map<string, TreeNode>();
  for (const child of children) byName.set(child.name, child);
  const ordered: TreeNode[] = [];
  const used = new Set<string>();
  for (const name of order) {
    const node = byName.get(name);
    if (node !== undefined && !used.has(name)) {
      ordered.push(node);
      used.add(name);
    }
  }
  const remaining = children.filter((child) => !used.has(child.name));
  return [...ordered, ...defaultOrder(remaining)];
}

function defaultOrder(children: readonly TreeNode[]): readonly TreeNode[] {
  const dirs = children
    .filter((c): c is TreeDirNode => c.kind === 'dir')
    .sort((a, b) => compareName(a.name, b.name));
  const files = children
    .filter((c): c is TreeFileNode => c.kind === 'file')
    .sort((a, b) => compareName(a.name, b.name));
  return [...dirs, ...files];
}

/** 码点比较（非 localeCompare），保证不同系统排序一致。 */
function compareName(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
