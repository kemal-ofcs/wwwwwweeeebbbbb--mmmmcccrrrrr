//! Dokumen legal: uji gizi SIG, BPOM MD/NA, Halal, dan HKI (PRD F-21, v2.6,
//! D-39). Satu baris per dokumen per MoU.
//!
//! WAJIB identik dengan `src/lib/validations/legal.ts`. Kedua sisi diuji
//! dengan vektor yang sama (`mod tests` di sini dan `legal.test.ts`), dan
//! setiap konstanta SQL dites ada per karakter dari sisi TS.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::samples::is_calendar_date;

pub const LEGAL_KINDS: &[&str] = &["SIG", "BPOM", "HALAL", "HKI"];
pub const LEGAL_STATUSES: &[&str] = &["SUBMITTED", "ISSUED", "NOT_REQUIRED"];
pub const BPOM_TYPES: &[&str] = &["MD", "NA"];
pub const LEGAL_NUMBER_MAX: usize = 100;
pub const LEGAL_NOTES_MAX: usize = 800;
const FINAL: &[&str] = &["ISSUED", "NOT_REQUIRED"];

/// Padanan `requiredLegalKinds`.
pub fn required_legal_kinds(path: &str) -> &'static [&'static str] {
    if path == "WITH_BPOM" {
        &["SIG", "BPOM", "HKI", "HALAL"]
    } else {
        &["HALAL"]
    }
}

/// Padanan `legalKindPermission`.
pub fn legal_kind_permission(kind: &str) -> &'static str {
    if kind == "SIG" {
        "rnd.manage"
    } else {
        "legal.manage"
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegalRecord {
    pub kind: &'static str,
    pub status: &'static str,
    pub reference_no: String,
    pub certificate_no: String,
    pub bpom_type: String,
    pub submitted_on: String,
    pub issued_on: String,
    pub expires_on: String,
    pub notes: String,
}

impl LegalRecord {
    pub fn to_json(&self) -> Value {
        json!({
            "kind": self.kind,
            "status": self.status,
            "reference_no": self.reference_no,
            "certificate_no": self.certificate_no,
            "bpom_type": self.bpom_type,
            "submitted_on": self.submitted_on,
            "issued_on": self.issued_on,
            "expires_on": self.expires_on,
            "notes": self.notes,
        })
    }
}

/// Teks opsional: absen/null = kosong, bukan teks = tidak sah.
fn text(raw: &Value, key: &str) -> Option<String> {
    match raw.get(key) {
        None | Some(Value::Null) => Some(String::new()),
        Some(Value::String(value)) => Some(value.trim().to_owned()),
        Some(_) => None,
    }
}

/// Padanan `validateLegalRecord`.
pub fn validate_legal_record(raw: &Value) -> Result<LegalRecord, &'static str> {
    let kind = raw
        .get("kind")
        .and_then(Value::as_str)
        .and_then(|kind| LEGAL_KINDS.iter().copied().find(|known| *known == kind))
        .ok_or("Choose the document.")?;
    let status = raw
        .get("status")
        .and_then(Value::as_str)
        .and_then(|status| LEGAL_STATUSES.iter().copied().find(|known| *known == status))
        .ok_or("Choose what happened to the document.")?;
    let notes = text(raw, "notes")
        .filter(|notes| notes.chars().count() <= LEGAL_NOTES_MAX)
        .ok_or("Notes are up to 800 characters.")?;
    let empty = LegalRecord {
        kind,
        status,
        reference_no: String::new(),
        certificate_no: String::new(),
        bpom_type: String::new(),
        submitted_on: String::new(),
        issued_on: String::new(),
        expires_on: String::new(),
        notes: notes.clone(),
    };
    if status == "NOT_REQUIRED" {
        if kind == "BPOM" {
            return Err("BPOM registration cannot be skipped.");
        }
        if notes.is_empty() {
            return Err("Write why this document is not required.");
        }
        return Ok(empty);
    }
    let reference = text(raw, "reference_no")
        .filter(|value| !value.is_empty() && value.chars().count() <= LEGAL_NUMBER_MAX)
        .ok_or("Enter the submission number, up to 100 characters.")?;
    let submitted = text(raw, "submitted_on")
        .filter(|value| is_calendar_date(value))
        .ok_or("Enter the submission date.")?;
    let bpom_type = text(raw, "bpom_type").unwrap_or_default();
    if kind == "BPOM" && !BPOM_TYPES.contains(&bpom_type.as_str()) {
        return Err("Choose MD or NA for the BPOM registration.");
    }
    let base = LegalRecord {
        reference_no: reference,
        bpom_type: if kind == "BPOM" { bpom_type } else { String::new() },
        submitted_on: submitted,
        ..empty
    };
    if status == "SUBMITTED" {
        return Ok(base);
    }
    let certificate = text(raw, "certificate_no")
        .filter(|value| !value.is_empty() && value.chars().count() <= LEGAL_NUMBER_MAX)
        .ok_or("Enter the certificate number, up to 100 characters.")?;
    let issued = text(raw, "issued_on")
        .filter(|value| is_calendar_date(value))
        .ok_or("Enter the issue date.")?;
    if issued < base.submitted_on {
        return Err("The issue date cannot be before the submission date.");
    }
    let expires = text(raw, "expires_on")
        .filter(|value| value.is_empty() || is_calendar_date(value))
        .ok_or("Enter a valid expiry date, or leave it empty.")?;
    if !expires.is_empty() && expires <= issued {
        return Err("The expiry date must be after the issue date.");
    }
    Ok(LegalRecord {
        status: "ISSUED",
        certificate_no: certificate,
        issued_on: issued,
        expires_on: expires,
        ..base
    })
}

pub struct LegalGateState<'a> {
    pub mou_status: &'a str,
    pub regulatory_path: &'a str,
    pub dp_cleared: bool,
    pub statuses: &'a HashMap<String, String>,
}

pub const LEGAL_DP_PENDING: &str = "Waiting for Finance to verify the production & legal down payment.";

fn is_final(statuses: &HashMap<String, String>, kind: &str) -> bool {
    statuses.get(kind).is_some_and(|status| FINAL.contains(&status.as_str()))
}

/// Padanan `legalGateError`.
pub fn legal_gate_error(state: &LegalGateState, kind: &str) -> Option<&'static str> {
    if state.mou_status != "ACCEPTED" {
        return Some("The client has not accepted the MoU yet.");
    }
    if !state.dp_cleared {
        return Some(LEGAL_DP_PENDING);
    }
    if !required_legal_kinds(state.regulatory_path).contains(&kind) {
        return Some("This document is not needed on this regulatory path.");
    }
    if is_final(state.statuses, kind) {
        return Some("This document is already final.");
    }
    if kind == "BPOM" && !is_final(state.statuses, "SIG") {
        return Some("Record the SIG nutrition test first.");
    }
    None
}

/// Padanan `legalComplete`. Belum dipakai perangkat: gerbang PPIC v3
/// (OQ-22) yang akan memakainya; vektornya sudah dites sekarang.
#[allow(dead_code)]
pub fn legal_complete(path: &str, statuses: &HashMap<String, String>) -> bool {
    required_legal_kinds(path).iter().all(|kind| is_final(statuses, kind))
}

/// Padanan `legalLogNotes`.
pub fn legal_log_notes(record: &LegalRecord) -> String {
    if record.status == "NOT_REQUIRED" {
        return format!("Not required: {}", record.notes);
    }
    let mut parts = vec![if record.status == "ISSUED" {
        format!("Issued, certificate {}", record.certificate_no)
    } else {
        format!("Submitted, number {}", record.reference_no)
    }];
    if !record.bpom_type.is_empty() {
        parts.push(format!("({})", record.bpom_type));
    }
    if !record.notes.is_empty() {
        parts.push(format!("- {}", record.notes));
    }
    parts.join(" ")
}

pub const LEGAL_CHANGED_ELSEWHERE: &str =
    "This document was changed on another device first. Open it again to see the latest version.";

pub const LEGAL_LIST_SQL: &str = "SELECT l.*, o.nama_operator AS updated_by_name FROM legal_documents l LEFT JOIN master_operator o ON o.id = l.updated_by";
pub const LEGAL_EXISTING_SQL: &str = "SELECT id, status, updated_at FROM legal_documents WHERE mou_id = ?1 AND kind = ?2 ORDER BY created_at, rowid LIMIT 1;";
pub const LEGAL_UPSERT_SQL: &str = "INSERT INTO legal_documents (id, mou_id, sample_request_id, kind, status, reference_no, certificate_no, bpom_type, submitted_on, issued_on, expires_on, notes, updated_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14) ON CONFLICT(id) DO UPDATE SET status = excluded.status, reference_no = excluded.reference_no, certificate_no = excluded.certificate_no, bpom_type = excluded.bpom_type, submitted_on = excluded.submitted_on, issued_on = excluded.issued_on, expires_on = excluded.expires_on, notes = excluded.notes, updated_by = excluded.updated_by, updated_at = excluded.updated_at WHERE legal_documents.updated_at = ?15 AND legal_documents.status NOT IN ('ISSUED', 'NOT_REQUIRED');";

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar dengan `src/lib/validations/legal.test.ts`.

    fn issued() -> Value {
        json!({
            "kind": "BPOM",
            "status": "ISSUED",
            "reference_no": " REG-1 ",
            "certificate_no": "NA18260100001",
            "bpom_type": "NA",
            "submitted_on": "2026-10-01",
            "issued_on": "2026-11-01",
            "expires_on": "2029-11-01",
            "notes": "",
        })
    }

    #[test]
    fn isian_dokumen_divalidasi() {
        let record = validate_legal_record(&issued()).unwrap();
        assert_eq!(
            (record.status, record.reference_no.as_str(), record.bpom_type.as_str(), record.expires_on.as_str()),
            ("ISSUED", "REG-1", "NA", "2029-11-01")
        );
        let mut submitted = issued();
        submitted["status"] = json!("SUBMITTED");
        let record = validate_legal_record(&submitted).unwrap();
        assert_eq!((record.certificate_no.as_str(), record.issued_on.as_str()), ("", ""));
        let mut skip = json!({ "kind": "HKI", "status": "NOT_REQUIRED", "notes": " Client owns the brand ", "reference_no": "X" });
        let record = validate_legal_record(&skip).unwrap();
        assert_eq!((record.notes.as_str(), record.reference_no.as_str()), ("Client owns the brand", ""));
        assert_eq!(
            legal_log_notes(&record),
            "Not required: Client owns the brand"
        );
        skip["notes"] = json!("");
        assert_eq!(validate_legal_record(&skip), Err("Write why this document is not required."));
        let with = |key: &str, value: Value| {
            let mut draft = issued();
            draft[key] = value;
            validate_legal_record(&draft).unwrap_err()
        };
        assert_eq!(with("kind", json!("PIRT")), "Choose the document.");
        assert_eq!(with("status", json!("DONE")), "Choose what happened to the document.");
        assert_eq!(with("status", json!("NOT_REQUIRED")), "BPOM registration cannot be skipped.");
        assert_eq!(with("reference_no", json!("")), "Enter the submission number, up to 100 characters.");
        assert_eq!(with("submitted_on", json!("2026-02-30")), "Enter the submission date.");
        assert_eq!(with("bpom_type", json!("ML")), "Choose MD or NA for the BPOM registration.");
        assert_eq!(with("certificate_no", json!("x".repeat(101))), "Enter the certificate number, up to 100 characters.");
        assert_eq!(with("issued_on", json!("2026-09-30")), "The issue date cannot be before the submission date.");
        assert_eq!(with("expires_on", json!("2026-11-01")), "The expiry date must be after the issue date.");
        assert_eq!(with("expires_on", json!("soon")), "Enter a valid expiry date, or leave it empty.");
        assert_eq!(with("notes", json!("x".repeat(801))), "Notes are up to 800 characters.");
        let mut halal = issued();
        halal["kind"] = json!("HALAL");
        halal["bpom_type"] = json!("MD");
        assert_eq!(validate_legal_record(&halal).unwrap().bpom_type, "");
        assert_eq!(
            legal_log_notes(&validate_legal_record(&issued()).unwrap()),
            "Issued, certificate NA18260100001 (NA)"
        );
    }

    #[test]
    fn gerbang_dokumen_legal() {
        let mut statuses = HashMap::new();
        let state = |statuses: &HashMap<String, String>, mou: &'static str, dp: bool| {
            let state = LegalGateState { mou_status: mou, regulatory_path: "WITH_BPOM", dp_cleared: dp, statuses };
            [
                legal_gate_error(&state, "SIG"),
                legal_gate_error(&state, "BPOM"),
                legal_gate_error(&state, "HALAL"),
            ]
        };
        assert_eq!(state(&statuses, "SENT", true)[0], Some("The client has not accepted the MoU yet."));
        assert_eq!(state(&statuses, "ACCEPTED", false)[0], Some(LEGAL_DP_PENDING));
        assert_eq!(
            state(&statuses, "ACCEPTED", true),
            [None, Some("Record the SIG nutrition test first."), None]
        );
        statuses.insert("SIG".to_owned(), "SUBMITTED".to_owned());
        assert_eq!(state(&statuses, "ACCEPTED", true)[1], Some("Record the SIG nutrition test first."));
        statuses.insert("SIG".to_owned(), "NOT_REQUIRED".to_owned());
        assert_eq!(
            state(&statuses, "ACCEPTED", true),
            [Some("This document is already final."), None, None]
        );
        let white = LegalGateState { mou_status: "ACCEPTED", regulatory_path: "WHITE_LABEL", dp_cleared: true, statuses: &statuses };
        assert_eq!(legal_gate_error(&white, "BPOM"), Some("This document is not needed on this regulatory path."));
        assert!(!legal_complete("WHITE_LABEL", &statuses));
        statuses.insert("HALAL".to_owned(), "ISSUED".to_owned());
        assert!(legal_complete("WHITE_LABEL", &statuses));
        assert!(!legal_complete("WITH_BPOM", &statuses));
        statuses.insert("BPOM".to_owned(), "ISSUED".to_owned());
        statuses.insert("HKI".to_owned(), "NOT_REQUIRED".to_owned());
        assert!(legal_complete("WITH_BPOM", &statuses));
        assert_eq!(legal_kind_permission("SIG"), "rnd.manage");
        assert_eq!(legal_kind_permission("HKI"), "legal.manage");
    }
}
