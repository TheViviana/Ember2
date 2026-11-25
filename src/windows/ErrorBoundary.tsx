/**
 * 错误边界（应用级 + 单窗口级）。
 *
 * 渲染异常不再黑屏：fallback 显示错误消息 + stack 前 10 行 + 复制/重试。
 * 放在 windows 层供 WindowFrame 直接复用；应用入口也使用同一实现（app → windows 合法）。
 * 样式全部走 --ember-* tokens（global.css 已加载）。
 */
import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';

export type ErrorBoundaryScope = 'app' | 'window';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** app：全屏兜底；window：仅占满当前浮窗内容区，其他窗口继续可用。 */
  readonly scope?: ErrorBoundaryScope;
  /** 变化时自动清除错误（窗口重新打开/切换内容后不残留旧 fallback）。 */
  readonly resetKey?: string;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

function fallbackStyle(scope: ErrorBoundaryScope): CSSProperties {
  if (scope === 'app') {
    return {
      position: 'fixed',
      inset: 0,
      zIndex: 9000,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '12px',
      padding: '24px',
      boxSizing: 'border-box',
      fontFamily: 'var(--font-body)',
      color: 'var(--ember-text-primary)',
      background: 'var(--ember-bg-base)',
    };
  }
  return {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    height: '100%',
    padding: '12px',
    boxSizing: 'border-box',
    overflow: 'auto',
    fontFamily: 'var(--font-body)',
    color: 'var(--ember-text-primary)',
    background: 'var(--ember-bg-base)',
  };
}

const BOX_STYLE: CSSProperties = {
  maxWidth: '720px',
  width: '100%',
  padding: '20px',
  background: 'var(--ember-bg-surface)',
  border: '1px solid var(--ember-border-strong)',
  borderRadius: '8px',
  boxSizing: 'border-box',
};

const STACK_STYLE: CSSProperties = {
  margin: '0 0 12px',
  padding: '10px',
  maxHeight: '180px',
  overflow: 'auto',
  fontSize: '11px',
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  color: 'var(--ember-text-muted)',
  background: 'var(--ember-bg-base)',
  border: '1px solid var(--ember-border-subtle)',
  borderRadius: '6px',
};

const BUTTON_STYLE: CSSProperties = {
  padding: '6px 14px',
  fontSize: '12px',
  fontFamily: 'var(--font-body)',
  color: 'var(--ember-text-primary)',
  background: 'transparent',
  border: '1px solid var(--ember-border)',
  borderRadius: '6px',
  cursor: 'pointer',
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  // React 19 类型未在 Component 上声明该静态钩子——不能标 override（noImplicitOverride）。
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] 渲染异常', error, info.componentStack);
  }

  private handleCopy = (): void => {
    const error = this.state.error;
    if (error === null) return;
    const text = `${error.message}\n${error.stack ?? ''}`;
    void navigator.clipboard
      .writeText(text)
      .then(() => console.error('[ErrorBoundary] 错误信息已复制'))
      .catch((copyError: unknown) => {
        console.error('[ErrorBoundary] 复制失败', copyError);
      });
  };

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const scope = this.props.scope ?? 'app';
    const stackLines = (error.stack ?? '').split('\n').slice(0, 10).join('\n');
    return (
      <div style={fallbackStyle(scope)} role="alert">
        <div style={BOX_STYLE}>
          <h1 style={{ margin: '0 0 8px', fontSize: '16px' }}>界面出错了</h1>
          <p style={{ margin: '0 0 12px', fontSize: '13px', overflowWrap: 'anywhere' }}>
            {error.message}
          </p>
          <pre style={STACK_STYLE}>{stackLines}</pre>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button type="button" style={BUTTON_STYLE} onClick={this.handleCopy}>
              复制错误
            </button>
            <button
              type="button"
              style={BUTTON_STYLE}
              onClick={scope === 'window' ? this.handleRetry : this.handleReload}
            >
              {scope === 'window' ? '重试' : '重新加载'}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
