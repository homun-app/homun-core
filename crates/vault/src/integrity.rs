use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultIntegrityReport {
    pub generated_at: String,
    pub integrity_ok: bool,
    pub foreign_key_violations: u64,
    pub total_records: u64,
    pub total_secret_rows: u64,
    pub orphan_secret_rows: u64,
    pub records_without_material: u64,
    pub duplicate_label_groups: u64,
    pub duplicate_label_extras: u64,
    pub invalid_metadata_json_rows: u64,
    pub forbidden_metadata_key_rows: u64,
    pub keyring_algorithms: BTreeMap<String, u64>,
    pub secret_algorithms: BTreeMap<String, u64>,
    pub checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultBackupReport {
    pub source: PathBuf,
    pub destination: PathBuf,
    pub bytes: u64,
}

pub(crate) fn audit_vault_integrity_on(
    connection: &Connection,
) -> Result<VaultIntegrityReport, String> {
    let integrity_ok = sqlite_integrity_ok(connection)?;
    let foreign_key_violations = pragma_row_count(connection, "pragma foreign_key_check")?;
    let total_records = count_query(connection, "select count(*) from vault_records")?;
    let total_secret_rows = count_query(connection, "select count(*) from vault_secret_material")?;
    let orphan_secret_rows = count_query(
        connection,
        "select count(*) from vault_secret_material material
         where not exists (
             select 1 from vault_records record where record.id = material.record_id
         )",
    )?;
    let records_without_material = count_query(
        connection,
        "select count(*) from vault_records record
         where not exists (
             select 1 from vault_secret_material material where material.record_id = record.id
         )",
    )?;
    let (duplicate_label_groups, duplicate_label_extras) = connection
        .query_row(
            "select count(*), coalesce(sum(duplicate_count - 1), 0)
             from (
                 select count(*) duplicate_count from vault_records
                 group by category, lower(trim(label))
                 having count(*) > 1
             )",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let (invalid_metadata_json_rows, forbidden_metadata_key_rows) =
        inspect_metadata_keys(connection)?;
    let keyring_algorithms = algorithm_counts(
        connection,
        "vault_local_keyring",
        &["xchacha20poly1305-pin-v1", "xchacha20poly1305-syskey-v1"],
    )?;
    let secret_algorithms = algorithm_counts(
        connection,
        "vault_secret_material",
        &["xchacha20poly1305-master-v1"],
    )?;

    let generated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos()
        .to_string();
    let mut report = VaultIntegrityReport {
        generated_at,
        integrity_ok,
        foreign_key_violations,
        total_records,
        total_secret_rows,
        orphan_secret_rows,
        records_without_material,
        duplicate_label_groups,
        duplicate_label_extras,
        invalid_metadata_json_rows,
        forbidden_metadata_key_rows,
        keyring_algorithms,
        secret_algorithms,
        checksum: String::new(),
    };
    report.checksum = report_checksum(&report)?;
    Ok(report)
}

fn sqlite_integrity_ok(connection: &Connection) -> Result<bool, String> {
    let mut statement = connection
        .prepare("pragma integrity_check")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|error| error.to_string())?);
    }
    Ok(results.len() == 1 && results[0] == "ok")
}

fn pragma_row_count(connection: &Connection, pragma: &str) -> Result<u64, String> {
    let mut statement = connection
        .prepare(pragma)
        .map_err(|error| error.to_string())?;
    let mut rows = statement.query([]).map_err(|error| error.to_string())?;
    let mut count = 0_u64;
    while rows.next().map_err(|error| error.to_string())?.is_some() {
        count = count.saturating_add(1);
    }
    Ok(count)
}

fn count_query(connection: &Connection, sql: &str) -> Result<u64, String> {
    connection
        .query_row(sql, [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

fn algorithm_counts(
    connection: &Connection,
    table: &str,
    allowed_algorithms: &[&str],
) -> Result<BTreeMap<String, u64>, String> {
    let mut statement = connection
        .prepare(&format!(
            "select algorithm, count(*) from {table} group by algorithm order by algorithm"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut counts = BTreeMap::new();
    for row in rows {
        let (algorithm, count) = row.map_err(|error| error.to_string())?;
        let label = if allowed_algorithms.contains(&algorithm.as_str()) {
            algorithm
        } else {
            "unknown".to_string()
        };
        *counts.entry(label).or_default() += count;
    }
    Ok(counts)
}

fn inspect_metadata_keys(connection: &Connection) -> Result<(u64, u64), String> {
    let mut statement = connection
        .prepare("select metadata_json from vault_records order by id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut invalid_json = 0_u64;
    let mut forbidden_keys = 0_u64;
    for row in rows {
        let raw = row.map_err(|error| error.to_string())?;
        match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(value) if contains_forbidden_metadata_key(&value) => {
                forbidden_keys = forbidden_keys.saturating_add(1);
            }
            Ok(_) => {}
            Err(_) => invalid_json = invalid_json.saturating_add(1),
        }
    }
    Ok((invalid_json, forbidden_keys))
}

fn contains_forbidden_metadata_key(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(key, value)| {
            let normalized = key.to_ascii_lowercase().replace(['-', ' '], "_");
            matches!(
                normalized.as_str(),
                "cvv"
                    | "cvc"
                    | "cv2"
                    | "cvv2"
                    | "security_code"
                    | "card_security_code"
                    | "pin"
                    | "password"
                    | "secret"
                    | "token"
                    | "raw_value"
            ) || contains_forbidden_metadata_key(value)
        }),
        serde_json::Value::Array(values) => values.iter().any(contains_forbidden_metadata_key),
        _ => false,
    }
}

fn report_checksum(report: &VaultIntegrityReport) -> Result<String, String> {
    let mut stable = report.clone();
    stable.generated_at.clear();
    stable.checksum.clear();
    let encoded = serde_json::to_vec(&stable).map_err(|error| error.to_string())?;
    let digest = Sha256::digest(encoded);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}
