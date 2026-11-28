import { registerHooks } from 'node:module';

// Node 原生测试不识别 bundler 的 CSS 模块导入；测试期统一映射为空模块。
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export default {};', shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});