/**
 * 常用系统提示词库：纯逻辑 + 可注入 storage，便于单测与后续换存储。
 */
export const PROMPT_LIBRARY_STORAGE_KEY = 'ember.ai.prompt-library.v1';
export const PROMPT_LIBRARY_MAX_ITEMS = 50;
export const PROMPT_NAME_MAX = 24;
export const PROMPT_CONTENT_MAX = 8000;

export interface SavedPrompt {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 内置提示词种子：首次加载时生成标准 SavedPrompt，之后完全按用户数据对待。 */
export interface BuiltinPromptSeed {
  readonly name: string;
  readonly content: string;
}

export const BUILTIN_PROMPTS: readonly BuiltinPromptSeed[] = [
  {
    name: '地道中英互译',
    content: '请将我提供的文本进行翻译。如果是中译英，请使用地道的商务/技术英语表达，避免中式英语；如果是英译中，请符合中文母语者的阅读习惯，信达雅兼顾。直接输出翻译结果，无需解释。',
  },
  {
    name: '会议记录转 Action Item',
    content: '请将上述杂乱的口语化会议记录整理成结构化的纪要。包含三部分：1. 核心议题；2. 达成的共识；3. 待办事项（Action Items），待办事项必须明确责任人和截止时间。',
  },
  {
    name: '提取实体与关系',
    content: '请分析上述内容，提取出其中的关键实体（如人物、组织、概念）以及它们之间的关系。请以 [实体A] -[关系]-> [实体B] 的格式逐行输出，方便我后续构建图谱。',
  },
  {
    name: '长文一键结构化',
    content: '请阅读上述连接的文档内容，提炼出 3-5 个核心观点。使用 Markdown 无序列表输出，每个观点附带一句简短的解释。最后用一句话总结全文的主旨。',
  },
  {
    name: '费曼学习法转化',
    content: '本画布用于个人知识管理。请用“费曼技巧”处理输入的信息：用通俗易懂的语言（像给 12 岁孩子解释一样）重述核心概念，并给出一个具体的类比示例。',
  },
  {
    name: '学术文献精读背景',
    content: '本画布用于精读学术论文或行业研报。请你在处理节点内容时，保持客观严谨，重点关注研究方法的合理性、数据的支撑度以及结论的局限性。',
  },
  {
    name: '产品 PRD 评审背景',
    content: '本画布正在进行产品需求评审。背景是一个面向 C 端的效率工具。请你在回答时，重点关注用户体验、边缘场景（Edge Cases）以及技术实现的可行性，切勿脱离实际业务空谈。',
  },
  {
    name: '头脑风暴狂人',
    content: '你是一个充满创意的思维拓展助手。当用户提出一个概念时，请从至少 3 个完全不同的维度（如技术、人文、商业）进行发散，并提供打破常规的见解，鼓励天马行空。',
  },
  {
    name: '极客代码审查员',
    content: '你是一名资深软件架构师。在回答代码问题时，请直奔主题，先给出可运行的代码片段，再解释核心逻辑。指出代码中的潜在 Bug 或性能瓶颈，不要废话。',
  },
  {
    name: '严谨学者型',
    content: '你是一名严谨、结构化的中文助手。优先基于用户提供的材料回答；不确定时明确说明，不要编造。输出使用简洁的 Markdown，必要时分点，避免冗长套话。',
  },
];

export interface PromptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type AddPromptFailure =
  | 'empty-name'
  | 'empty-content'
  | 'name-too-long'
  | 'content-too-long'
  | 'limit';

export type AddPromptResult =
  | { readonly ok: true; readonly items: readonly SavedPrompt[]; readonly prompt: SavedPrompt }
  | { readonly ok: false; readonly reason: AddPromptFailure };

export type RenamePromptResult =
  | { readonly ok: true; readonly items: readonly SavedPrompt[] }
  | { readonly ok: false; readonly reason: 'empty-name' | 'name-too-long' | 'not-found' };

function isSavedPrompt(value: unknown): value is SavedPrompt {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' && record.id !== '' &&
    typeof record.name === 'string' && record.name !== '' &&
    typeof record.content === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.updatedAt === 'number'
  );
}

/** 首次安装/首次进入时把内置提示词写成标准 SavedPrompt；之后不再自动注入。 */
function createBuiltinPrompts(now: number): readonly SavedPrompt[] {
  return BUILTIN_PROMPTS.map((seed, index) => ({
    id: makeId(now + index),
    name: seed.name,
    content: seed.content,
    createdAt: now,
    updatedAt: now,
  }));
}

/** 容错加载：损坏 JSON、旧版本、夹杂非法条目都不抛错，只保留合法条目。 */
export function loadPromptLibrary(storage: PromptStorage): readonly SavedPrompt[] {
  let raw: string | null;
  try {
    raw = storage.getItem(PROMPT_LIBRARY_STORAGE_KEY);
  } catch {
    return [];
  }
  // 仅当 key 完全不存在时注入内置提示词；已存在（包括空数组）一律尊重用户数据。
  if (raw === null) {
    const seeded = createBuiltinPrompts(Date.now());
    savePromptLibrary(storage, seeded);
    return seeded;
  }
  if (raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return [];
    const items = (parsed as { readonly items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    const seen = new Set<string>();
    const valid: SavedPrompt[] = [];
    for (const item of items) {
      if (!isSavedPrompt(item) || seen.has(item.id)) continue;
      seen.add(item.id);
      valid.push(item);
      if (valid.length >= PROMPT_LIBRARY_MAX_ITEMS) break;
    }
    return valid;
  } catch {
    return [];
  }
}

export function savePromptLibrary(
  storage: PromptStorage,
  items: readonly SavedPrompt[],
): void {
  try {
    storage.setItem(
      PROMPT_LIBRARY_STORAGE_KEY,
      JSON.stringify({ version: 1, items }),
    );
  } catch {
    // 存储不可用（隐私模式/配额满）时静默失败，调用方仍可继续编辑当前提示词。
  }
}

function makeId(now: number): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `prompt_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function addPrompt(
  items: readonly SavedPrompt[],
  input: { readonly name: string; readonly content: string },
  now: number = Date.now(),
): AddPromptResult {
  const name = input.name.trim();
  const content = input.content.trim();
  if (name === '') return { ok: false, reason: 'empty-name' };
  if (content === '') return { ok: false, reason: 'empty-content' };
  if (name.length > PROMPT_NAME_MAX) return { ok: false, reason: 'name-too-long' };
  if (content.length > PROMPT_CONTENT_MAX) return { ok: false, reason: 'content-too-long' };
  if (items.length >= PROMPT_LIBRARY_MAX_ITEMS) return { ok: false, reason: 'limit' };

  const prompt: SavedPrompt = {
    id: makeId(now),
    name,
    content,
    createdAt: now,
    updatedAt: now,
  };
  return { ok: true, items: [prompt, ...items], prompt };
}

export function removePrompt(
  items: readonly SavedPrompt[],
  id: string,
): readonly SavedPrompt[] {
  return items.filter((item) => item.id !== id);
}

export function renamePrompt(
  items: readonly SavedPrompt[],
  id: string,
  name: string,
  now: number = Date.now(),
): RenamePromptResult {
  const trimmed = name.trim();
  if (trimmed === '') return { ok: false, reason: 'empty-name' };
  if (trimmed.length > PROMPT_NAME_MAX) return { ok: false, reason: 'name-too-long' };
  let found = false;
  const next = items.map((item) => {
    if (item.id !== id) return item;
    found = true;
    return { ...item, name: trimmed, updatedAt: now };
  });
  return found ? { ok: true, items: next } : { ok: false, reason: 'not-found' };
}

export function addPromptFailureLabel(reason: AddPromptFailure): string {
  switch (reason) {
    case 'empty-name':
      return '名称不能为空';
    case 'empty-content':
      return '当前提示词为空，无法保存';
    case 'name-too-long':
      return `名称最多 ${PROMPT_NAME_MAX} 字`;
    case 'content-too-long':
      return `提示词最多 ${PROMPT_CONTENT_MAX} 字`;
    case 'limit':
      return `最多保存 ${PROMPT_LIBRARY_MAX_ITEMS} 条`;
  }
}