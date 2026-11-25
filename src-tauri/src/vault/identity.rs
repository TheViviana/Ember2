use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use ulid::Ulid;

use crate::ipc::{VaultError, VaultResult};
use crate::vault::{atomic, paths};

/// 当前设置文件 schema 版本（与旧库一致，只认 v1）。
pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultIdentity {
    pub vault_id: String,
    pub schema_version: u32,
}

/// 读取库身份；缺失时才创建。既有 `settings.json` **一字节都不改写**。
pub fn ensure_identity(root: &Path) -> VaultResult<VaultIdentity> {
    let file = paths::settings_file(root);
    match fs::read_to_string(&file) {
        Ok(text) => parse_identity(&text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_identity(root, &file),
        // 存在但读不出来时不能重建身份，否则会静默换掉库 ID。
        Err(error) => Err(error.into()),
    }
}

/// 只读探测：不创建任何文件。
pub fn read_identity(root: &Path) -> VaultResult<Option<VaultIdentity>> {
    match fs::read_to_string(paths::settings_file(root)) {
        Ok(text) => parse_identity(&text).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn parse_identity(text: &str) -> VaultResult<VaultIdentity> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|error| VaultError::InvalidArg(format!("settings.json 解析失败：{error}")))?;
    let schema_version = value
        .get("schemaVersion")
        .and_then(|item| item.as_u64())
        .ok_or_else(|| VaultError::InvalidArg("settings.json 缺少 schemaVersion".to_string()))?;
    if schema_version != u64::from(SETTINGS_SCHEMA_VERSION) {
        return Err(VaultError::InvalidArg(format!(
            "settings.json schemaVersion={schema_version}，当前只支持 {SETTINGS_SCHEMA_VERSION}"
        )));
    }
    let vault_id = value
        .get("vault")
        .and_then(|item| item.get("id"))
        .and_then(|item| item.as_str())
        .filter(|item| !item.is_empty())
        .ok_or_else(|| VaultError::InvalidArg("settings.json 缺少 vault.id".to_string()))?;
    Ok(VaultIdentity {
        vault_id: vault_id.to_string(),
        schema_version: SETTINGS_SCHEMA_VERSION,
    })
}

fn create_identity(root: &Path, file: &Path) -> VaultResult<VaultIdentity> {
    let vault_id = Ulid::generate().to_string();
    let name = root
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Ember Vault".to_string());
    let settings = serde_json::json!({
        "schemaVersion": SETTINGS_SCHEMA_VERSION,
        "vault": {
            "id": vault_id,
            "name": name,
            "createdAt": now_iso8601(),
        },
        "ui": {},
        "linkOverrides": {},
    });
    let bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|error| VaultError::InvalidArg(format!("settings.json 序列化失败：{error}")))?;
    fs::create_dir_all(paths::workbench(root))?;
    atomic::write_atomic(file, &bytes)?;
    Ok(VaultIdentity {
        vault_id,
        schema_version: SETTINGS_SCHEMA_VERSION,
    })
}

pub(crate) fn now_iso8601() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    iso8601_from_unix(seconds)
}

fn iso8601_from_unix(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        (rest % 3_600) / 60,
        rest % 60
    )
}

/// Howard Hinnant 的 civil_from_days：1970-01-01 起的天数 → 公历年月日。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn creates_identity_once_and_is_idempotent() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let first = ensure_identity(root).expect("首次创建");
        assert_eq!(first.vault_id.len(), 26, "ULID 应为 26 位");
        assert_eq!(first.schema_version, 1);
        assert!(paths::settings_file(root).is_file());

        let second = ensure_identity(root).expect("二次读取");
        assert_eq!(first, second);
    }

    #[test]
    fn existing_settings_bytes_untouched() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir_all(paths::workbench(root)).expect("workbench");
        let original = br#"{"schemaVersion":1,"vault":{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","name":"old","extra":true},"ui":{"theme":"dark"},"linkOverrides":{}}"#;
        fs::write(paths::settings_file(root), original).expect("write");

        let identity = ensure_identity(root).expect("读取旧库");
        assert_eq!(identity.vault_id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        let after = fs::read(paths::settings_file(root)).expect("read back");
        assert_eq!(after, original, "既有 settings.json 不得被改写");
    }

    #[test]
    fn malformed_settings_are_reported_not_overwritten() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir_all(paths::workbench(root)).expect("workbench");
        fs::write(paths::settings_file(root), b"{\"vault\":{}}").expect("write");
        let error = ensure_identity(root).expect_err("缺少 schemaVersion 应报错");
        assert_eq!(error.code(), "E_INVALID_ARG");
    }

    #[test]
    fn iso8601_epoch_and_known_instant() {
        assert_eq!(iso8601_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_from_unix(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn iso8601_covers_2000_to_2100() {
        for (seconds, expected) in [
            (946_684_800_u64, "2000-01-01T00:00:00Z"),
            (978_220_800, "2000-12-31T00:00:00Z"),
            (1_709_164_800, "2024-02-29T00:00:00Z"),
            (1_709_251_200, "2024-03-01T00:00:00Z"),
            (4_107_456_000, "2100-02-28T00:00:00Z"),
            (4_107_542_400, "2100-03-01T00:00:00Z"),
            (4_133_980_799, "2100-12-31T23:59:59Z"),
        ] {
            assert_eq!(
                iso8601_from_unix(seconds),
                expected,
                "时间戳 {seconds} 换算漂移"
            );
        }
    }

    #[test]
    fn leap_day_rules_hold_at_century_boundaries() {
        // 2000 是闰年（能被 400 整除）；2100 不是（能被 100 整除但不能被 400 整除），
        // 闰年写死 29 天或按 4 年一闰都会在这两个年份出错。
        for (seconds, expected) in [
            (951_696_000_u64, "2000-02-28T00:00:00Z"),
            (951_782_400, "2000-02-29T00:00:00Z"),
            (951_868_800, "2000-03-01T00:00:00Z"),
            (4_107_456_000, "2100-02-28T00:00:00Z"),
            (4_107_542_400, "2100-03-01T00:00:00Z"),
        ] {
            assert_eq!(
                iso8601_from_unix(seconds),
                expected,
                "闰年边界 {seconds} 换算漂移"
            );
        }
    }

    #[test]
    fn iso8601_handles_32_bit_time_boundary() {
        assert_eq!(iso8601_from_unix(2_147_483_647), "2038-01-19T03:14:07Z");
        assert_eq!(iso8601_from_unix(2_147_483_648), "2038-01-19T03:14:08Z");
    }
}
