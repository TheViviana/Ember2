use serde::Serialize;

use crate::vault::media::{MediaEntry, MediaKind, SavedMedia};

/// 媒体类型：序列化为 lowercase，与 EntryKindDto 风格一致。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKindDto {
    Image,
    Audio,
    Video,
    /// CR-20261120-26：只读附件（PDF/HTML），序列化为 "doc"。
    Doc,
}

impl From<MediaKind> for MediaKindDto {
    fn from(value: MediaKind) -> Self {
        match value {
            MediaKind::Image => MediaKindDto::Image,
            MediaKind::Audio => MediaKindDto::Audio,
            MediaKind::Video => MediaKindDto::Video,
            MediaKind::Doc => MediaKindDto::Doc,
        }
    }
}

/// `media_save` 的响应；`deduped` 表示命中已有内容、未产生新文件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSaveDto {
    pub path: String,
    pub hash: String,
    pub kind: MediaKindDto,
    pub bytes: u64,
    pub deduped: bool,
}

impl From<SavedMedia> for MediaSaveDto {
    fn from(value: SavedMedia) -> Self {
        Self {
            path: value.path,
            hash: value.hash,
            kind: value.kind.into(),
            bytes: value.bytes,
            deduped: value.deduped,
        }
    }
}

/// `media_list` 的单项（类型分目录与旧版平铺统一形态）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntryDto {
    pub path: String,
    pub hash: String,
    pub kind: MediaKindDto,
    pub bytes: u64,
    pub modified_ms: u64,
}

impl From<MediaEntry> for MediaEntryDto {
    fn from(value: MediaEntry) -> Self {
        Self {
            path: value.path,
            hash: value.hash,
            kind: value.kind.into(),
            bytes: value.bytes,
            modified_ms: value.modified_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_dtos_use_camel_case_and_lowercase_kind() {
        let dto = MediaSaveDto::from(SavedMedia {
            path: "media/image/ab/abc.png".to_string(),
            hash: "abc".to_string(),
            kind: MediaKind::Image,
            bytes: 3,
            deduped: true,
        });
        let value = serde_json::to_value(&dto).expect("json");
        assert_eq!(value["path"], "media/image/ab/abc.png");
        assert_eq!(value["kind"], "image");
        assert_eq!(value["deduped"], true);

        let entry = MediaEntryDto::from(MediaEntry {
            path: "media/legacy.webp".to_string(),
            hash: "legacy".to_string(),
            kind: MediaKind::Audio,
            bytes: 1,
            modified_ms: 2,
        });
        let value = serde_json::to_value(&entry).expect("json");
        assert_eq!(value["kind"], "audio");
        assert_eq!(value["modifiedMs"], 2);
        assert_eq!(value["path"], "media/legacy.webp");
    }
}
