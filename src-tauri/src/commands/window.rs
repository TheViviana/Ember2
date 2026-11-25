//! 窗口几何命令。
//! macOS 上 tao 0.37 的 `startResizeDragging` 返回 NotSupported 且被运行时吞掉（不可用），
//! 自绘窗口的「移动 + 缩放」合并为一条 IPC：前端每动画帧只发最新一帧（节流在发送方），
//! 这里先定位再定尺寸（非真原子；set_size 失败会回滚位置后再报错，见下方实现）。权限模型：Rust 侧直接调用窗口 API，
//! 不经 JS 窗口 ACL（capabilities 无需 allow-set-size / allow-set-position）。

use serde::Deserialize;
use tauri::{LogicalPosition, LogicalSize, Window};

/// 与 tauri.conf.json minWidth/minHeight 一致的最小窗口尺寸（逻辑像素）。
const MIN_WIDTH: f64 = 960.0;
const MIN_HEIGHT: f64 = 640.0;

#[derive(Deserialize)]
pub struct FramePayload {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl FramePayload {
    /// 入参校验（五/六轮审查修复）：拒绝 NaN/无限值与荒谬量级，宽高钳制到最小尺寸。
    /// 屏幕级边界约束在 P3 chrome 接线时实现（主窗口 OS 几何不归 WindowManager 浮窗层管）。
    fn validated(self) -> Result<(f64, f64, f64, f64), String> {
        // x/y 允许负值（多显示器左/上侧扩展屏合法），但拒绝荒谬量级（1e9 会把窗口移出全部屏幕）
        for (name, v) in [
            ("x", self.x),
            ("y", self.y),
            ("width", self.width),
            ("height", self.height),
        ] {
            if !v.is_finite() {
                return Err(format!("{name} 不是有限数值"));
            }
            if v.abs() > 100_000.0 {
                return Err(format!("{name} 超出合理范围（|{name}| ≤ 100000）"));
            }
        }
        if self.width <= 0.0 || self.height <= 0.0 {
            return Err("width/height 必须为正数".to_string());
        }
        Ok((
            self.x,
            self.y,
            self.width.max(MIN_WIDTH),
            self.height.max(MIN_HEIGHT),
        ))
    }
}

#[tauri::command]
pub fn window_resize_frame(window: Window, frame: FramePayload) -> Result<(), String> {
    let (x, y, width, height) = frame.validated()?;
    // 注释更正（七轮审查）：此操作并非真原子——先定位后定尺寸，set_size 失败时窗口已移动。
    // 补偿策略：记录原位置，set_size 失败即回滚位置后再报错，避免「移了尺寸没变」的半成功状态。
    let original = window
        .outer_position()
        .map_err(|e| format!("outer_position failed: {e}"))?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("set_position failed: {e}"))?;
    if let Err(e) = window.set_size(LogicalSize::new(width, height)) {
        // 回滚失败必须如实上报（八轮审查：此前吞掉回滚结果并固定谎报「位置已回滚」）
        return Err(match window.set_position(original) {
            Ok(_) => format!("set_size failed（位置已回滚）: {e}"),
            Err(rb) => {
                format!("set_size failed（且位置回滚失败，窗口停留在新位置）: {e}；回滚错误: {rb}")
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod config_sync {
    /// 七轮审查修复：MIN_WIDTH/HEIGHT 与 tauri.conf.json 双写，必须由测试钉死同步。
    #[test]
    fn 最小尺寸与_tauri_conf_一致() {
        const CONF: &str = include_str!("../../tauri.conf.json");
        let v: serde_json::Value = serde_json::from_str(CONF).expect("tauri.conf.json 解析失败");
        let win = &v["app"]["windows"][0];
        assert_eq!(win["minWidth"].as_f64(), Some(super::MIN_WIDTH));
        assert_eq!(win["minHeight"].as_f64(), Some(super::MIN_HEIGHT));
    }
}

#[cfg(test)]
mod tests {
    use super::FramePayload;

    fn payload(x: f64, y: f64, w: f64, h: f64) -> FramePayload {
        FramePayload {
            x,
            y,
            width: w,
            height: h,
        }
    }

    #[test]
    fn 拒绝非有限数值() {
        assert!(payload(f64::NAN, 0.0, 100.0, 100.0).validated().is_err());
        assert!(payload(0.0, f64::INFINITY, 100.0, 100.0)
            .validated()
            .is_err());
    }

    #[test]
    fn 拒绝非正宽高() {
        assert!(payload(0.0, 0.0, 0.0, 100.0).validated().is_err());
        assert!(payload(0.0, 0.0, 100.0, -5.0).validated().is_err());
    }

    #[test]
    fn 宽高钳制到最小尺寸() {
        let (x, y, w, h) = payload(10.0, 20.0, 100.0, 50.0).validated().unwrap();
        assert_eq!((x, y), (10.0, 20.0));
        assert_eq!((w, h), (super::MIN_WIDTH, super::MIN_HEIGHT));
    }

    #[test]
    fn 合法输入原样通过() {
        let (x, y, w, h) = payload(-3.0, 400.0, 1280.0, 820.0).validated().unwrap();
        assert_eq!((x, y, w, h), (-3.0, 400.0, 1280.0, 820.0));
    }

    #[test]
    fn 拒绝荒谬坐标量级() {
        assert!(payload(1.0e9, 0.0, 1280.0, 820.0).validated().is_err());
        assert!(payload(0.0, -1.0e9, 1280.0, 820.0).validated().is_err());
    }
}
