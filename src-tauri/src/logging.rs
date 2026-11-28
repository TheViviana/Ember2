//! P1-6 最小结构化日志：`tracing` 门面 + 非阻塞落盘到 `app_log_dir()/ember.log`。
//!
//! 只负责初始化与守卫持有；轮转、级别配置与导出 UI 不在本里程碑。
//! 日志目录不可用时降级到 stderr，任何初始化失败都不阻断启动。

use std::path::PathBuf;

use tauri::Manager;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// 日志写入线程的守卫：必须随进程存活，drop 时把缓冲区刷盘。
pub struct LogGuard {
    _worker: Option<WorkerGuard>,
}

/// 初始化日志。返回的守卫交给 Tauri 托管（`app.manage`），进程退出时刷盘。
pub fn init(app: &tauri::AppHandle) -> LogGuard {
    match log_dir(app) {
        Ok(dir) => {
            let file = tracing_appender::rolling::never(&dir, "ember.log");
            let (writer, guard) = tracing_appender::non_blocking(file);
            let installed = tracing_subscriber::registry()
                .with(tracing_subscriber::filter::LevelFilter::INFO)
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(writer)
                        .with_ansi(false),
                )
                .try_init()
                .is_ok();
            if installed {
                tracing::info!(
                    target: "ember",
                    version = env!("CARGO_PKG_VERSION"),
                    dir = %dir.display(),
                    "日志已启用"
                );
            }
            LogGuard {
                _worker: Some(guard),
            }
        }
        Err(error) => init_stderr(error),
    }
}

/// macOS `~/Library/Logs/<bundle-id>`、Windows `%LOCALAPPDATA%\<bundle-id>\logs`。
fn log_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

/// 目录不可写时的兜底：日志写 stderr。
/// 注意：stderr 回退只对开发环境（终端启动）有效；打包后的 `.app` 通常
/// 收不到 stderr，这条路径在用户机器上等于没有日志。
fn init_stderr(error: String) -> LogGuard {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .try_init();
    tracing::warn!(target: "ember", error = %error, "日志目录不可用，回退 stderr");
    LogGuard { _worker: None }
}
