//! Impor CSV Data Uang Masuk, Database Formulasi, dan Database Desain (PRD
//! F-22, v2.7, D-40).
//!
//! WAJIB identik dengan bagian "Kembar" di `src/lib/validations/sheet-import.ts`.
//! Kedua sisi diuji dengan vektor yang sama (`mod tests` di sini dan
//! `sheet-import.test.ts`), dan setiap konstanta SQL dites ada per karakter
//! dari sisi TS.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use super::clients::{parse_sheet_date, parse_stored_timestamp, utc_timestamp, SheetDate};
use super::finance::{FUND_DESCRIPTION_MAX, INVOICE_AMOUNT_MAX};
use super::samples::is_calendar_date;

pub const ARCHIVE_KINDS: &[&str] = &["FORMULA", "DESIGN"];
pub const ARCHIVE_CODE_MAX: usize = 100;
pub const ARCHIVE_TITLE_MAX: usize = 200;
pub const ARCHIVE_NOTES_MAX: usize = 1000;

/// Padanan `sheetImportPermission`.
pub fn sheet_import_permission(kind: &str) -> Option<&'static str> {
    match kind {
        "FUNDS" => Some("finance.manage"),
        "FORMULA" => Some("rnd.manage"),
        "DESIGN" => Some("design.manage"),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SheetValue<T> {
    Value(T),
    Empty,
    Error(String),
}

/// Padanan `parseSheetAmount`.
pub fn parse_sheet_amount(raw: &str) -> SheetValue<i64> {
    let text = raw.trim();
    if text.is_empty() {
        return SheetValue::Empty;
    }
    let mut digits = text;
    if digits.get(..2).is_some_and(|prefix| prefix.eq_ignore_ascii_case("rp")) {
        digits = &digits[2..];
        digits = digits.strip_prefix('.').unwrap_or(digits);
    }
    let mut digits: String = digits.chars().filter(|c| !c.is_whitespace()).collect();
    if digits.ends_with(",-") || digits.ends_with(".-") {
        digits.truncate(digits.len() - 2);
    }
    let bytes = digits.as_bytes();
    let n = bytes.len();
    if n >= 3 && matches!(bytes[n - 3], b'.' | b',') && bytes[n - 2].is_ascii_digit() && bytes[n - 1].is_ascii_digit() {
        if &digits[n - 2..] != "00" {
            return SheetValue::Error(format!("The amount \"{text}\" has cents. Use whole rupiah."));
        }
        digits.truncate(n - 3);
    }
    let plain = !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit());
    let grouped = {
        let groups: Vec<&str> = digits.split(['.', ',']).collect();
        groups.len() > 1
            && (1..=3).contains(&groups[0].len())
            && groups.iter().all(|group| group.bytes().all(|byte| byte.is_ascii_digit()))
            && groups[1..].iter().all(|group| group.len() == 3)
    };
    if !plain && !grouped {
        return SheetValue::Error(format!("The amount \"{text}\" could not be read."));
    }
    let digits: String = digits.chars().filter(char::is_ascii_digit).collect();
    let trimmed = digits.trim_start_matches('0');
    let value = if trimmed.len() > 12 { i64::MAX } else { trimmed.parse::<i64>().unwrap_or(0) };
    if !(1..=INVOICE_AMOUNT_MAX).contains(&value) {
        return SheetValue::Error(format!("The amount \"{text}\" is out of range."));
    }
    SheetValue::Value(value)
}

/// Padanan `parseSheetDay`: tanggal sheet → `YYYY-MM-DD`.
pub fn parse_sheet_day(raw: &str, order: &str) -> SheetValue<String> {
    match parse_sheet_date(raw, order, "Asia/Jakarta") {
        SheetDate::Empty => SheetValue::Empty,
        SheetDate::Error(message) => SheetValue::Error(message),
        SheetDate::Value(value) => match parse_stored_timestamp(&value) {
            Some(epoch) => SheetValue::Value(utc_timestamp(epoch + 7 * 3600)[..10].to_owned()),
            None => SheetValue::Error(format!("The date \"{}\" could not be read.", raw.trim())),
        },
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SheetRow {
    pub line: i64,
    pub date: String,
    pub client_code: String,
    pub code: String,
    pub title: String,
    pub amount_idr: Option<i64>,
    pub notes: String,
}

fn field(input: &Value, key: &str) -> String {
    input.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// Padanan `validateSheetRow` (masukan mentah, seperti `sheetRowInput`).
pub fn validate_sheet_row(kind: &str, input: &Value, order: &str) -> Result<SheetRow, String> {
    let funds = kind == "FUNDS";
    let date = match parse_sheet_day(&field(input, "date"), order) {
        SheetValue::Error(message) => return Err(message),
        SheetValue::Empty if funds => return Err("Tanggal is empty.".to_owned()),
        SheetValue::Empty => String::new(),
        SheetValue::Value(value) => value,
    };
    let client_code = field(input, "client_code").trim().to_owned();
    if !funds && client_code.is_empty() {
        return Err("Kode Klien is empty.".to_owned());
    }
    let code = if funds { String::new() } else { field(input, "code").trim().to_owned() };
    if code.chars().count() > ARCHIVE_CODE_MAX {
        return Err(format!("The code is longer than {ARCHIVE_CODE_MAX} characters."));
    }
    let title = if funds { String::new() } else { field(input, "title").trim().to_owned() };
    if !funds && title.is_empty() {
        return Err(if kind == "FORMULA" { "Nama Produk is empty." } else { "Brand is empty." }.to_owned());
    }
    if title.chars().count() > ARCHIVE_TITLE_MAX {
        return Err(format!("The name is longer than {ARCHIVE_TITLE_MAX} characters."));
    }
    let amount = if kind == "DESIGN" { SheetValue::Empty } else { parse_sheet_amount(&field(input, "amount")) };
    let amount_idr = match amount {
        SheetValue::Error(message) => return Err(message),
        SheetValue::Empty if funds => return Err("Nominal is empty.".to_owned()),
        SheetValue::Empty => None,
        SheetValue::Value(value) => Some(value),
    };
    let notes = field(input, "notes").trim().to_owned();
    let notes_max = if funds { FUND_DESCRIPTION_MAX } else { ARCHIVE_NOTES_MAX };
    if notes.chars().count() > notes_max {
        return Err(format!("The notes are longer than {notes_max} characters."));
    }
    Ok(SheetRow {
        line: input.get("line").and_then(Value::as_i64).unwrap_or_default(),
        date,
        client_code,
        code,
        title,
        amount_idr,
        notes,
    })
}

/// Padanan `sheetRowKey`.
pub fn sheet_row_key(
    kind: &str,
    client_id: &str,
    date: &str,
    code: &str,
    title: &str,
    amount_idr: Option<i64>,
    notes: &str,
) -> String {
    let fold = |value: &str| value.trim().to_lowercase();
    if kind == "FUNDS" {
        let amount = amount_idr.map(|value| value.to_string()).unwrap_or_default();
        format!("FUNDS|{date}|{amount}|{}", fold(notes))
    } else {
        format!("{kind}|{client_id}|{}|{}|{date}", fold(code), fold(title))
    }
}

pub struct SheetPlan {
    pub valid: Vec<(SheetRow, String)>,
    pub results: Vec<Value>,
}

/// Padanan `planSheetImport`. `clients` = kode huruf kecil → id.
pub fn plan_sheet_import(
    kind: &str,
    rows: &[Value],
    order: &str,
    clients: &HashMap<String, String>,
    existing: &HashSet<String>,
) -> SheetPlan {
    let mut plan = SheetPlan { valid: Vec::new(), results: Vec::new() };
    for input in rows {
        let row = match validate_sheet_row(kind, input, order) {
            Ok(row) => row,
            Err(message) => {
                let line = input.get("line").and_then(Value::as_i64).unwrap_or_default();
                plan.results.push(json!({ "line": line, "status": "invalid", "message": message }));
                continue;
            }
        };
        let mut client_id = String::new();
        if !row.client_code.is_empty() {
            match clients.get(&row.client_code.to_lowercase()) {
                Some(found) => client_id = found.clone(),
                None => {
                    plan.results.push(json!({
                        "line": row.line,
                        "status": "invalid",
                        "message": format!("Kode Klien {} is not registered.", row.client_code),
                    }));
                    continue;
                }
            }
        }
        let key = sheet_row_key(kind, &client_id, &row.date, &row.code, &row.title, row.amount_idr, &row.notes);
        if existing.contains(&key) {
            plan.results.push(json!({ "line": row.line, "status": "skipped", "message": "Already in the app." }));
            continue;
        }
        plan.valid.push((row, client_id));
    }
    plan
}

/// Pemeriksaan ulang payload `imported-record/record` di cloud (khusus Rust:
/// Web menulis langsung setelah `validateSheetRow`). `None` = sah.
pub fn archive_payload_error(payload: &Value) -> Option<&'static str> {
    let text = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or_default();
    let date = text("record_date");
    let amount_ok = match payload.get("amount_idr") {
        None | Some(Value::Null) => true,
        Some(value) => value.as_i64().is_some_and(|amount| (1..=INVOICE_AMOUNT_MAX).contains(&amount)),
    };
    let valid = ARCHIVE_KINDS.contains(&text("kind"))
        && !text("client_id").is_empty()
        && !text("title").trim().is_empty()
        && text("title").chars().count() <= ARCHIVE_TITLE_MAX
        && text("code").chars().count() <= ARCHIVE_CODE_MAX
        && text("notes").chars().count() <= ARCHIVE_NOTES_MAX
        && (date.is_empty() || is_calendar_date(date))
        && amount_ok
        && parse_stored_timestamp(text("created_at")).is_some();
    (!valid).then_some("The imported record is incomplete or invalid.")
}

pub const SHEET_CLIENTS_SQL: &str = "SELECT client_code, id FROM clients;";

pub const SHEET_FUND_KEYS_SQL: &str = "SELECT received_on, amount_idr, description FROM incoming_funds;";

pub const SHEET_ARCHIVE_KEYS_SQL: &str = "SELECT kind, client_id, code, title, record_date FROM imported_records;";

pub const IMPORTED_RECORD_INSERT_SQL: &str = "INSERT INTO imported_records (id, kind, client_id, record_date, code, title, amount_idr, notes, source_file, imported_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(id) DO NOTHING;";

pub const IMPORTED_RECORD_LIST_SQL: &str = "SELECT id, kind, client_id, record_date, code, title, amount_idr, notes, source_file, created_at FROM imported_records WHERE client_id = ?1 ORDER BY record_date DESC, created_at DESC, rowid DESC;";

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar: `sheet-import.test.ts` memakai masukan dan keluaran yang sama.

    #[test]
    fn nominal_rupiah_dibaca() {
        let cases: &[(&str, SheetValue<i64>)] = &[
            ("Rp 1.500.000", SheetValue::Value(1_500_000)),
            ("rp.1,500,000", SheetValue::Value(1_500_000)),
            ("1500000,00", SheetValue::Value(1_500_000)),
            ("Rp 15.000,-", SheetValue::Value(15_000)),
            ("1.500", SheetValue::Value(1500)),
            ("007", SheetValue::Value(7)),
            ("  ", SheetValue::Empty),
            ("1,50", SheetValue::Error("The amount \"1,50\" has cents. Use whole rupiah.".to_owned())),
            ("12.34.567", SheetValue::Error("The amount \"12.34.567\" could not be read.".to_owned())),
            ("-500", SheetValue::Error("The amount \"-500\" could not be read.".to_owned())),
            ("0", SheetValue::Error("The amount \"0\" is out of range.".to_owned())),
            ("100.000.000.001", SheetValue::Error("The amount \"100.000.000.001\" is out of range.".to_owned())),
            ("9999999999999999", SheetValue::Error("The amount \"9999999999999999\" is out of range.".to_owned())),
        ];
        for (raw, expected) in cases {
            assert_eq!(&parse_sheet_amount(raw), expected, "{raw}");
        }
    }

    #[test]
    fn tanggal_sheet_menjadi_hari() {
        assert_eq!(parse_sheet_day("5/10/2026 23:30", "DMY"), SheetValue::Value("2026-10-05".to_owned()));
        assert_eq!(parse_sheet_day("10/5/2026", "MDY"), SheetValue::Value("2026-10-05".to_owned()));
        assert_eq!(parse_sheet_day("2026-01-01 00:15:00", "DMY"), SheetValue::Value("2026-01-01".to_owned()));
        assert_eq!(parse_sheet_day("", "DMY"), SheetValue::Empty);
        assert_eq!(
            parse_sheet_day("31/2/2026", "DMY"),
            SheetValue::Error("The date \"31/2/2026\" could not be read.".to_owned())
        );
    }

    fn input(date: &str, client: &str, code: &str, title: &str, amount: &str, notes: &str) -> Value {
        json!({ "line": 2, "date": date, "client_code": client, "code": code, "title": title, "amount": amount, "notes": notes })
    }

    #[test]
    fn baris_sheet_divalidasi() {
        let row = validate_sheet_row("FUNDS", &input("5/10/2026", " KP-1 ", "X", "Y", "Rp 2.000.000", " Transfer BCA "), "DMY")
            .expect("uang masuk sah");
        assert_eq!(
            (row.date.as_str(), row.client_code.as_str(), row.code.as_str(), row.title.as_str(), row.amount_idr, row.notes.as_str()),
            ("2026-10-05", "KP-1", "", "", Some(2_000_000), "Transfer BCA")
        );
        let row = validate_sheet_row("DESIGN", &input("", "KP-1", "D-01", "Aura", "abc", ""), "DMY").expect("desain sah");
        assert_eq!((row.date.as_str(), row.amount_idr), ("", None));
        let errors: &[(&str, Value, &str)] = &[
            ("FUNDS", input("", "", "", "", "1000", ""), "Tanggal is empty."),
            ("FUNDS", input("1/1/2026", "", "", "", "", ""), "Nominal is empty."),
            ("FUNDS", input("1/1/2026", "", "", "", "1000", &"a".repeat(301)), "The notes are longer than 300 characters."),
            ("FORMULA", input("", "", "F-1", "Serum", "", ""), "Kode Klien is empty."),
            ("FORMULA", input("", "KP-1", "F-1", " ", "", ""), "Nama Produk is empty."),
            ("DESIGN", input("", "KP-1", "", "", "", ""), "Brand is empty."),
            ("FORMULA", input("", "KP-1", &"c".repeat(101), "Serum", "", ""), "The code is longer than 100 characters."),
            ("FORMULA", input("", "KP-1", "", &"t".repeat(201), "", ""), "The name is longer than 200 characters."),
            ("FORMULA", input("", "KP-1", "", "Serum", "", &"n".repeat(1001)), "The notes are longer than 1000 characters."),
            ("FORMULA", input("", "KP-1", "", "Serum", "1,5", ""), "The amount \"1,5\" could not be read."),
        ];
        for (kind, raw, message) in errors {
            assert_eq!(validate_sheet_row(kind, raw, "DMY"), Err((*message).to_owned()), "{message}");
        }
    }

    #[test]
    fn rencana_impor_melewati_yang_sudah_ada() {
        let clients = HashMap::from([("kp-1".to_owned(), "c1".to_owned())]);
        let existing = HashSet::from([
            sheet_row_key("FUNDS", "", "2026-10-05", "", "", Some(2_000_000), "transfer bca"),
            sheet_row_key("FORMULA", "c1", "", "f-1", "serum", None, ""),
        ]);
        let rows = vec![
            input("5/10/2026", "", "", "", "2.000.000", "Transfer BCA"),
            input("6/10/2026", "kp-1", "", "", "500.000", ""),
            input("6/10/2026", "KP-9", "", "", "500.000", ""),
            input("6/10/2026", "", "", "", "500.000", ""),
            input("6/10/2026", "", "", "", "500.000", ""),
        ];
        let plan = plan_sheet_import("FUNDS", &rows, "DMY", &clients, &existing);
        assert_eq!(
            plan.valid.iter().map(|(row, client)| (row.amount_idr, client.as_str())).collect::<Vec<_>>(),
            vec![(Some(500_000), "c1"), (Some(500_000), ""), (Some(500_000), "")]
        );
        assert_eq!(
            plan.results,
            vec![
                json!({ "line": 2, "status": "skipped", "message": "Already in the app." }),
                json!({ "line": 2, "status": "invalid", "message": "Kode Klien KP-9 is not registered." }),
            ]
        );
        let plan = plan_sheet_import(
            "FORMULA",
            &[input("", "KP-1", "F-1", "SERUM", "", ""), input("", "KP-1", "F-2", "Serum", "", "")],
            "DMY",
            &clients,
            &existing,
        );
        assert_eq!(plan.valid.len(), 1);
        assert_eq!(plan.results[0]["status"], "skipped");
        assert_eq!(sheet_import_permission("DESIGN"), Some("design.manage"));
        assert_eq!(sheet_import_permission("CLIENTS"), None);
    }
}
