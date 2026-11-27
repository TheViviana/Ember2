/**
 * 空间工作区错误边界：3D 初始化或渲染异常时只替换覆盖层内容。
 *
 * 这一层不引用 three；即使渲染层加载失败，主应用仍可正常使用，
 * 用户点「返回标准视图」即可关闭覆盖层。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import styles from './spatial.module.css';

export interface SpatialErrorBoundaryProps {
  readonly onReturn: () => void;
  readonly children: ReactNode;
}

interface SpatialErrorBoundaryState {
  readonly message: string | null;
}

export class SpatialErrorBoundary extends Component<
  SpatialErrorBoundaryProps,
  SpatialErrorBoundaryState
> {
  constructor(props: SpatialErrorBoundaryProps) {
    super(props);
    this.state = { message: null };
  }

  static getDerivedStateFromError(error: unknown): SpatialErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('空间工作区渲染失败', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.message !== null) {
      return (
        <div className={styles.fallback} role="alert">
          <p className={styles.fallbackTitle}>空间工作区加载失败</p>
          <p className={styles.fallbackHint}>
            渲染层出现异常，主应用未受影响。可返回标准视图继续工作。
          </p>
          <p className={styles.fallbackDetail}>{this.state.message}</p>
          <button type="button" className={styles.returnButton} onClick={this.props.onReturn}>
            返回标准视图
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}