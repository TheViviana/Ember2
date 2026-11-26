/**
 * 命令面板标签索引：首次打开时惰性构建，按 T0 文档 SHA 缓存。
 * 只在面板打开且库索引变化时刷新；正文不进入常驻状态。
 */
import { useEffect, useRef, useState } from 'react';
import { docApi } from '../../data/app-api.ts';
import { parseFrontmatter } from '../../core/markdown.ts';
import { normalizeTagList } from '../../core/tag-path.ts';
import type { DocMeta } from '../../core/vault-index.ts';

export type PaletteTagMap = ReadonlyMap<string, readonly string[]>;

interface TagSnapshot {
  readonly source: ReadonlyMap<string, DocMeta>;
  readonly tags: PaletteTagMap;
}

const EMPTY_TAGS: PaletteTagMap = new Map();

export function usePaletteTags(
  enabled: boolean,
  docs: ReadonlyMap<string, DocMeta>,
): PaletteTagMap {
  const cache = useRef(new Map<string, { sha256: string; tags: readonly string[] }>());
  const [snapshot, setSnapshot] = useState<TagSnapshot | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const sources = [...docs.values()];
    void Promise.all(sources.map(async (doc) => {
      const cached = cache.current.get(doc.path);
      if (cached?.sha256 === doc.sha256) return [doc.path, cached.tags] as const;
      try {
        const { text } = await docApi.read(doc.path);
        const tags = normalizeTagList(parseFrontmatter(text).frontmatter?.tags ?? []);
        cache.current.set(doc.path, { sha256: doc.sha256, tags });
        return [doc.path, tags] as const;
      } catch {
        return [doc.path, [] as readonly string[]] as const;
      }
    })).then((entries) => {
      if (!cancelled) setSnapshot({ source: docs, tags: new Map(entries) });
    });
    return () => { cancelled = true; };
  }, [enabled, docs]);

  return snapshot?.source === docs ? snapshot.tags : EMPTY_TAGS;
}
