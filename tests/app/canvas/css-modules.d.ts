/**
 * 浏览器验收页经 engine.ts 间接导入 CSS Modules；tests/tsconfig 只含 node 类型，
 * 这里补最小声明，避免为验收页改根配置。
 */
declare module '*.module.css' {
  const styles: Record<string, string | undefined>;
  export default styles;
}
