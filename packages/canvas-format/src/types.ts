/** 画布 v3 的无损原文、渲染投影与可逆命令公共类型。 */

export interface CanvasDocument {
  readonly schemaVersion: 3;
  readonly nodes: readonly unknown[];
  readonly edges: readonly unknown[];
  readonly [key: string]: unknown;
}

export type CanvasSchemaIssueCode =
  | 'E_SCHEMA_FIELD'
  | 'E_SCHEMA_ID_DUP'
  | 'E_SCHEMA_EDGE_REF'
  | 'E_SCHEMA_PORT_DIR'
  | 'E_SCHEMA_GROUP'
  | 'E_SCHEMA_PATH_REF';

export interface CanvasSchemaIssue {
  readonly code: CanvasSchemaIssueCode;
  readonly path: string;
  readonly message: string;
  readonly nodeIndex?: number;
  readonly nodeId?: string;
  readonly edgeIndex?: number;
  readonly edgeId?: string;
}

export type CanvasPortDirection = 'in' | 'out';

export interface CanvasPort {
  readonly id: string;
  readonly dir: CanvasPortDirection;
  readonly name?: string;
  readonly [key: string]: unknown;
}

export interface CanvasEndpoint {
  readonly nodeId: string;
  readonly portId: string;
  readonly [key: string]: unknown;
}

interface CanvasNodeBase {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** 可选节点宽高；缺失时渲染层回退默认 160×96，不由投影补值。 */
  readonly w?: number;
  readonly h?: number;
  readonly ports: readonly CanvasPort[];
  readonly label?: string;
  readonly parentId?: string;
  readonly [key: string]: unknown;
}

export interface CanvasDocumentNode extends CanvasNodeBase {
  readonly type: 'document';
  readonly docPath: string;
}

export interface CanvasMediaNode extends CanvasNodeBase {
  readonly type: 'media';
  readonly kind: 'image' | 'audio' | 'video' | 'doc';
}

export interface CanvasTextNode extends CanvasNodeBase {
  readonly type: 'text';
  /** 分块子块元数据：仅 split 生成的块携带，chunkIndex/sourceNodeId 成对出现。 */
  readonly chunkIndex?: number;
  readonly sourceNodeId?: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  readonly type: 'group';
}

export interface CanvasAiNode extends CanvasNodeBase {
  readonly type: 'ai';
  /** 本节点提示词正文；缺省视为空提示词。 */
  readonly text?: string;
  /** CR-20261121-53：本节点选用的模型 id；未选择时缺省。 */
  readonly model?: string;
}

export interface CanvasPromptNode extends CanvasNodeBase {
  readonly type: 'prompt';
  /** CR-20261121-53：提示词正文（多行）；缺省视为空提示词。 */
  readonly text?: string;
}

/** 分块方式：只切分，或切分后逐块提炼。 */
export type CanvasSplitMode = 'split' | 'refine';

export interface CanvasSplitNode extends CanvasNodeBase {
  readonly type: 'split';
  /** 缺省视为 'split'。 */
  readonly mode?: CanvasSplitMode;
  /** 目标块大小（字符）；缺省时由调用方按 provider 预算决定。 */
  readonly chunkChars?: number;
  /** refine 模式的提炼提示词；缺省用内置默认指令。 */
  readonly text?: string;
  /** 提炼选用的模型 id；缺省用全局模型。 */
  readonly model?: string;
}

export interface CanvasMergeNode extends CanvasNodeBase {
  readonly type: 'merge';
  /** 汇总提示词；缺省用内置默认指令。 */
  readonly text?: string;
  /** 汇总选用的模型 id；缺省用全局模型。 */
  readonly model?: string;
}

export type CanvasNode =
  | CanvasDocumentNode
  | CanvasMediaNode
  | CanvasTextNode
  | CanvasGroupNode
  | CanvasAiNode
  | CanvasPromptNode
  | CanvasSplitNode
  | CanvasMergeNode;

/** 连线样式（纯渲染提示）：缺省键 = 实线 / 单向 / 默认色 / 曲线。 */
export type CanvasEdgeLine = 'solid' | 'dashed';
export type CanvasEdgeArrow = 'end' | 'both' | 'none';
export type CanvasEdgeColor = 'default' | 'primary' | 'success' | 'warning' | 'danger';
export type CanvasEdgeRoute = 'curve' | 'orthogonal';

export interface CanvasEdgeStyle {
  readonly line?: CanvasEdgeLine;
  readonly arrow?: CanvasEdgeArrow;
  readonly color?: CanvasEdgeColor;
  readonly route?: CanvasEdgeRoute;
  readonly [key: string]: unknown;
}

export interface CanvasEdge {
  readonly id: string;
  readonly from: CanvasEndpoint;
  readonly to: CanvasEndpoint;
  readonly label?: string;
  readonly flow?: string;
  /** 可选渲染样式；未知子键由旧版本原样保留。 */
  readonly style?: CanvasEdgeStyle;
  readonly [key: string]: unknown;
}

export interface CanvasProjection {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
}

export interface CanvasInspection {
  readonly issues: readonly CanvasSchemaIssue[];
  readonly projection: CanvasProjection;
}

export interface CanvasValidation {
  readonly valid: boolean;
  readonly issues: readonly CanvasSchemaIssue[];
}

export interface CanvasPortInput {
  readonly id: string;
  readonly dir: CanvasPortDirection;
  readonly name?: string;
  readonly [key: string]: unknown;
}

export interface CanvasEndpointInput {
  readonly nodeId: string;
  readonly portId?: string;
  readonly [key: string]: unknown;
}

export interface CanvasNodeInput {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w?: number;
  readonly h?: number;
  readonly type?: 'document' | 'media' | 'text' | 'group' | 'ai' | 'prompt' | 'split' | 'merge';
  readonly ports?: readonly CanvasPortInput[];
  readonly label?: string;
  readonly parentId?: string;
  readonly docPath?: string;
  readonly kind?: 'image' | 'audio' | 'video' | 'doc';
  readonly mode?: CanvasSplitMode;
  readonly chunkChars?: number;
  readonly [key: string]: unknown;
}

export interface CanvasEdgeInput {
  readonly id: string;
  readonly from: CanvasEndpointInput;
  readonly to: CanvasEndpointInput;
  readonly label?: string;
  readonly flow?: string;
  readonly style?: CanvasEdgeStyle;
  readonly [key: string]: unknown;
}

export interface CanvasMoveEntry {
  readonly id: string;
  readonly dx: number;
  readonly dy: number;
}

/** 画布级元信息变更：目前只承载 AI 背景，null=删除字段。 */
export interface CanvasMetaChanges {
  readonly aiContext?: string | null;
}

export type CanvasCommand =
  | { readonly kind: 'move'; readonly entries: readonly CanvasMoveEntry[] }
  | { readonly kind: 'addNode'; readonly node: CanvasNodeInput; readonly index?: number }
  | { readonly kind: 'removeNode'; readonly id: string }
  | { readonly kind: 'restoreNode'; readonly entry: CanvasNodeInput; readonly index: number }
  | { readonly kind: 'addEdge'; readonly edge: CanvasEdgeInput; readonly index?: number }
  | { readonly kind: 'removeEdge'; readonly id: string }
  | { readonly kind: 'updateCanvasMeta'; readonly changes: CanvasMetaChanges }
  | {
      readonly kind: 'updateNode';
      readonly id: string;
      readonly changes: {
        readonly label?: string | null;
        readonly docPath?: string | null;
        readonly w?: number | null;
        readonly h?: number | null;
        /** ai/prompt 节点正文；null 删除字段。 */
        readonly text?: string | null;
        /** CR-20261121-53：ai 节点选用模型；null 删除字段（未选择）。 */
        readonly model?: string | null;
        /** split 节点的分块方式；null 删除字段（缺省 split）。 */
        readonly mode?: CanvasSplitMode | null;
        /** split 节点的目标块大小；null 删除字段（按预算）。 */
        readonly chunkChars?: number | null;
      };
    };

export interface CanvasCommandError {
  readonly commandIndex: number;
  readonly code: CanvasSchemaIssueCode | 'E_MUTATE_COMMAND' | 'E_MUTATE_TARGET';
  readonly message: string;
  readonly path?: string;
}

export type CanvasMutateResult =
  | {
      readonly ok: true;
      readonly document: CanvasDocument;
      /** 已按可直接整批 undo 的顺序排列，调用方不得再次反转。 */
      readonly inverse: readonly CanvasCommand[];
      readonly inspection: CanvasInspection;
    }
  | {
      readonly ok: false;
      readonly kind: 'document';
      readonly issues: readonly CanvasSchemaIssue[];
    }
  | {
      readonly ok: false;
      readonly kind: 'command';
      readonly errors: readonly CanvasCommandError[];
    };
