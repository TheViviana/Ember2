# 测试辅助

## css-hooks.mjs

Node 原生测试无法加载 bundler 风格的 `.css` 模块。该 hook 在 `pnpm test` 启动时通过
`node --import` 注册，把所有 `.css` 导入映射为空模块，使测试可以直接 import engine 等
引用了 CSS 的真实模块。

只处理 `.css` 后缀，其他资源原样交给 Node；仅影响测试进程，不影响 Vite 构建和浏览器。