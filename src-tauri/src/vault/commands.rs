//! vault 命令聚合层：命令实现按域拆到子模块，对外仍以 `vault::commands::<命令名>` 暴露。

use std::path::Path;

use crate::ipc::ErrorPayload;
use crate::vault::Session;

mod backup;
mod canvas;
mod conflict;
mod doc;
mod history;
mod media;
mod trash;

pub use backup::*;
pub use canvas::*;
pub use conflict::*;
pub use doc::*;
pub use history::*;
pub use media::*;
pub use trash::*;

/// 当前会话不可用时（身份/锁初始化失败）先于一切命令返回同一份失败。
pub(crate) fn root_of(session: &Session) -> Result<&Path, ErrorPayload> {
    if let Some(failure) = &session.failure {
        return Err(failure.clone());
    }
    Ok(session.root.as_path())
}
