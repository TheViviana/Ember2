import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const alias = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: [
      // 精确匹配索引文件；子路径 '#doc-model/markdown/pipeline' 映射到 src/ 目录下真实文件，
      // 避免字符串前缀 alias 把子路径拼成 index.ts/...（五轮修复）
      { find: /^#doc-model$/, replacement: alias('./packages/doc-model/src/index.ts') },
      { find: /^#doc-model\/(.*)$/, replacement: alias('./packages/doc-model/src/$1') },
      { find: /^#canvas-format$/, replacement: alias('./packages/canvas-format/src/index.ts') },
      { find: /^#canvas-format\/(.*)$/, replacement: alias('./packages/canvas-format/src/$1') },
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'safari16',
    sourcemap: false,
    rollupOptions: {
      output: {
        // 按依赖域拆包：React / CodeMirror / Markdown+KaTeX / Tauri SDK 各自独立，
        // 避免单包过大，并让阅读模式懒加载的 KaTeX 分包单独按需加载。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (
            id.includes('/@codemirror/lang-markdown/') ||
            id.includes('/@lezer/markdown/') ||
            id.includes('/@codemirror/language-data/')
          ) {
            return 'editor-markdown';
          }
          if (
            id.includes('/@codemirror/view/') ||
            id.includes('/@codemirror/state/') ||
            id.includes('/@codemirror/language/') ||
            id.includes('/@lezer/')
          ) {
            return 'editor-core';
          }
          if (id.includes('/@codemirror/') || id.includes('/codemirror/')) {
            return 'editor-vendor';
          }
          if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) {
            return 'react-vendor';
          }
          if (id.includes('/katex/')) return 'katex-vendor';
          if (
            id.includes('/unified/') ||
            id.includes('/remark-') ||
            id.includes('/micromark') ||
            id.includes('/mdast') ||
            id.includes('/unist') ||
            id.includes('/vfile') ||
            id.includes('/yaml/')
          ) {
            return 'markdown-vendor';
          }
          if (id.includes('/@tauri-apps/')) return 'tauri-vendor';
          return undefined;
        },
      },
    },
  },
});
