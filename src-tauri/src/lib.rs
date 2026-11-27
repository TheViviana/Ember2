//! Ember 2.0 宿主进程入口。
//! 当前：窗口几何命令（commands::window）+ P1/T1 存储核（vault、library、ipc）
//! + T5a AI 传输层（ai）。

mod commands;
mod logging;
// T1 已落地、T2~T3 才接线的内核 API（paths/atomic/identity 等）需要公开可达，
// 否则 `-D warnings` 会把它们判成 dead_code；门禁禁止 allow 豁免，故此处公开模块。
pub mod ai;
pub mod ipc;
pub mod translate;
pub mod vault;

use std::sync::Arc;

use tauri::Manager;

pub fn run() {
    // 命令注册表先取出，才能在外层包一层 IPC 入口/出口日志；逐条命令不改。
    // 标成函数指针是为了在不创建 Builder 的情况下定住运行时类型（Wry）。
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        commands::window::window_resize_frame,
        vault::commands::vault_identity,
        vault::commands::vault_constants,
        vault::commands::vault_read,
        vault::commands::vault_reveal,
        vault::commands::vault_write,
        vault::commands::vault_replace,
        vault::commands::vault_import,
        vault::commands::vault_rename,
        vault::commands::vault_list,
        vault::commands::vault_scan,
        vault::commands::vault_stat,
        vault::commands::list_canvases,
        vault::commands::canvas_read,
        vault::commands::canvas_write,
        vault::commands::canvas_rename,
        vault::commands::media_save,
        vault::commands::media_save_bytes,
        vault::commands::media_list,
        vault::commands::vault_remove,
        vault::commands::vault_mkdir,
        vault::commands::trash_list,
        vault::commands::trash_cleanup,
        vault::commands::media_delete,
        vault::commands::backup_destination,
        vault::commands::backup_export,
        vault::commands::backup_inspect,
        vault::commands::history_list,
        vault::commands::history_read,
        vault::commands::history_restore,
        vault::commands::history_delete,
        vault::commands::history_purge,
        ai::commands::ai_key_save,
        ai::commands::ai_key_status,
        ai::commands::ai_key_delete,
        ai::commands::ai_test_connection,
        ai::commands::ai_list_models,
        ai::commands::ai_chat_stream,
        ai::commands::ai_chat_cancel,
        translate::translate_online,
        vault::library::library_list,
        vault::library::library_add,
        vault::library::library_remove,
        vault::library::library_current,
    ];

    tauri::Builder::default()
        // T13 CR-A 补充：系统文件夹选择器插件
        .plugin(tauri_plugin_dialog::init())
        // P7：自动更新插件（endpoint/pubkey 在 tauri.conf.json 的 plugins.updater）
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // 日志先于其余初始化：后续模块的 tracing 事件才能落盘。
            // 守卫交给 Tauri 托管，进程退出时由 drop 刷盘。
            app.manage(logging::init(app.handle()));
            let state = vault::bootstrap(app.handle());
            app.manage(state);
            // T5b：AI 门面与在途流取消表，随进程常驻。
            app.manage(ai::client::AiTransport::new());
            app.manage(Arc::new(ai::commands::ChatRegistry::new()));
            // 启动后一次回收站清扫，脱离主线程；失败只上报不阻塞启动。
            vault::spawn_trash_sweep(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 窗口销毁：取消该窗口全部在途流；任何错误都吞掉，销毁路径不得 panic。
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(registry) = window
                    .app_handle()
                    .try_state::<Arc<ai::commands::ChatRegistry>>()
                {
                    let _ = registry.cancel_window(window.label());
                }
            }
        })
        .register_uri_scheme_protocol("media", |ctx, request| {
            let state = ctx.app_handle().state::<vault::VaultState>();
            // 每次请求读当前库根：切库后无需重启，媒体立即指向新库。
            let root = state.current_root();
            vault::protocol::respond(&root, &request)
        })
        .invoke_handler(move |invoke| {
            // P1-6：IPC 入口/出口落盘。参数体不记录，只记命令名与分发耗时；
            // 逐条命令的失败码由各自的错误载荷构造点记录。
            // `dispatch_ms` 是分发耗时：`async fn` 命令只计到 spawn 返回，
            // `ipc.exit` 不代表命令执行完成（长命令需看各自的错误/事件日志）。
            let command = invoke.message.command().to_owned();
            let started = std::time::Instant::now();
            tracing::info!(target: "ipc", command = %command, "ipc.enter");
            let handled = handler(invoke);
            let dispatch_ms = started.elapsed().as_millis() as u64;
            if handled {
                tracing::info!(target: "ipc", command = %command, dispatch_ms, "ipc.exit");
            } else {
                tracing::warn!(target: "ipc", command = %command, dispatch_ms, "ipc.unknown");
            }
            handled
        })
        // 启动级 Fail-fast：这里没有返回值可交给调用方，窗口也尚未创建，
        // 事件循环起不来时没有任何可恢复路径。保留 panic 以便系统崩溃日志
        // 与「意外退出」弹窗能定位问题；不要改成 `let _ = ...` 静默吞掉。
        .run(tauri::generate_context!())
        .expect("Ember 启动失败");
}
