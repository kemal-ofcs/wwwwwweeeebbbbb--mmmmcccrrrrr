//! Aturan tiket sampel (PRD FR-06) dan setelan bisnis (FR-11).
//!
//! WAJIB identik dengan `src/lib/validations/sample.ts`. Kedua sisi diuji
//! dengan vektor yang sama (`mod tests` di sini dan `sample.test.ts`): tiket
//! yang sama harus berpindah ke status yang sama di Web dan di perangkat,
//! termasuk saat kuota revisi habis.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

// ---------------------------------------------------------------------------
// Setelan bisnis (FR-11).
// ---------------------------------------------------------------------------

pub const SAMPLE_FEE_MODES: &[&str] = &["FREE", "PAID", "PER_REQUEST"];

pub const SETTING_DEFAULT_FREE_REVISION_LIMIT: &str = "default_free_revision_limit";
pub const SETTING_SAMPLE_FEE_MODE: &str = "sample_fee_mode";
pub const SETTING_LEAD_HOT_MAX_DAYS: &str = "lead_hot_max_days";
pub const SETTING_LEAD_WARM_MAX_DAYS: &str = "lead_warm_max_days";
pub const BUSINESS_SETTING_KEYS: &[&str] = &[
    SETTING_DEFAULT_FREE_REVISION_LIMIT,
    SETTING_SAMPLE_FEE_MODE,
    SETTING_LEAD_HOT_MAX_DAYS,
    SETTING_LEAD_WARM_MAX_DAYS,
];

pub const FREE_REVISION_LIMIT_MAX: i64 = 20;
pub const LEAD_HOT_MAX_DAYS_LIMIT: i64 = 60;
pub const LEAD_WARM_MAX_DAYS_LIMIT: i64 = 180;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BusinessSettings {
    pub default_free_revision_limit: i64,
    pub sample_fee_mode: &'static str,
    pub lead_hot_max_days: i64,
    pub lead_warm_max_days: i64,
}

impl Default for BusinessSettings {
    fn default() -> Self {
        Self {
            default_free_revision_limit: 1,
            sample_fee_mode: "PER_REQUEST",
            lead_hot_max_days: 3,
            lead_warm_max_days: 7,
        }
    }
}

impl BusinessSettings {
    pub fn to_json(&self) -> Value {
        json!({
            "default_free_revision_limit": self.default_free_revision_limit,
            "sample_fee_mode": self.sample_fee_mode,
            "lead_hot_max_days": self.lead_hot_max_days,
            "lead_warm_max_days": self.lead_warm_max_days,
        })
    }

    /// Pasangan kunci → teks untuk `setting_gex_system`.
    pub fn to_rows(&self) -> Vec<(&'static str, String)> {
        vec![
            (SETTING_DEFAULT_FREE_REVISION_LIMIT, self.default_free_revision_limit.to_string()),
            (SETTING_SAMPLE_FEE_MODE, self.sample_fee_mode.to_owned()),
            (SETTING_LEAD_HOT_MAX_DAYS, self.lead_hot_max_days.to_string()),
            (SETTING_LEAD_WARM_MAX_DAYS, self.lead_warm_max_days.to_string()),
        ]
    }
}

fn stored_int(value: Option<&String>) -> Option<i64> {
    let text = value?.trim();
    if text.is_empty() || text.len() > 9 || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn in_range(value: Option<i64>, min: i64, max: i64) -> Option<i64> {
    value.filter(|value| (min..=max).contains(value))
}

fn fee_mode(value: &str) -> Option<&'static str> {
    SAMPLE_FEE_MODES.iter().copied().find(|mode| *mode == value)
}

/// Padanan `readBusinessSettings`: nilai hilang atau rusak jatuh ke bawaan.
pub fn read_business_settings(values: &HashMap<String, String>) -> BusinessSettings {
    let defaults = BusinessSettings::default();
    let limit = in_range(
        stored_int(values.get(SETTING_DEFAULT_FREE_REVISION_LIMIT)),
        0,
        FREE_REVISION_LIMIT_MAX,
    );
    let mode = values
        .get(SETTING_SAMPLE_FEE_MODE)
        .and_then(|value| fee_mode(value.trim()));
    let hot = in_range(stored_int(values.get(SETTING_LEAD_HOT_MAX_DAYS)), 0, LEAD_HOT_MAX_DAYS_LIMIT);
    let warm = in_range(stored_int(values.get(SETTING_LEAD_WARM_MAX_DAYS)), 1, LEAD_WARM_MAX_DAYS_LIMIT);
    let (hot, warm) = match (hot, warm) {
        (Some(hot), Some(warm)) if warm > hot => (hot, warm),
        _ => (defaults.lead_hot_max_days, defaults.lead_warm_max_days),
    };
    BusinessSettings {
        default_free_revision_limit: limit.unwrap_or(defaults.default_free_revision_limit),
        sample_fee_mode: mode.unwrap_or(defaults.sample_fee_mode),
        lead_hot_max_days: hot,
        lead_warm_max_days: warm,
    }
}

/// Bilangan bulat JSON saja; teks angka dari form ditolak, bukan ditebak.
fn strict_int(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

/// Padanan `validateBusinessSettings`; pesan identik.
pub fn validate_business_settings(draft: &Value) -> Result<BusinessSettings, &'static str> {
    let limit = in_range(strict_int(draft.get("default_free_revision_limit")), 0, FREE_REVISION_LIMIT_MAX)
        .ok_or("Free revisions must be a whole number from 0 to 20.")?;
    let mode = draft
        .get("sample_fee_mode")
        .and_then(Value::as_str)
        .and_then(fee_mode)
        .ok_or("Choose how sample fees are charged.")?;
    let hot = in_range(strict_int(draft.get("lead_hot_max_days")), 0, LEAD_HOT_MAX_DAYS_LIMIT)
        .ok_or("The Hot limit must be a whole number of days from 0 to 60.")?;
    let warm = in_range(strict_int(draft.get("lead_warm_max_days")), 1, LEAD_WARM_MAX_DAYS_LIMIT)
        .filter(|warm| *warm > hot)
        .ok_or("The Warm limit must be more days than the Hot limit, up to 180.")?;
    Ok(BusinessSettings {
        default_free_revision_limit: limit,
        sample_fee_mode: mode,
        lead_hot_max_days: hot,
        lead_warm_max_days: warm,
    })
}

// ---------------------------------------------------------------------------
// Status dan aksi tiket (FR-06.4).
// ---------------------------------------------------------------------------

pub const SAMPLE_STATUSES: &[&str] = &[
    "DRAFT",
    "RND_REVIEW",
    "RND_REJECTED",
    "RND_ACCEPTED",
    "WAITING_SAMPLE_PAYMENT",
    "IN_RND",
    "SAMPLE_READY",
    "SAMPLE_SENT",
    "CLIENT_ACC",
    "CLIENT_REJECT",
    "PENDING_FEE_ASSESSMENT",
    "WAITING_REVISION_PAYMENT",
    "CANCELLED",
];

pub const SAMPLE_TERMINAL_STATUSES: &[&str] = &["RND_REJECTED", "CLIENT_ACC", "CLIENT_REJECT", "CANCELLED"];

pub const SAMPLE_ACTIONS: &[&str] = &[
    "SUBMIT_TO_RND",
    "RND_ACCEPT",
    "RND_REJECT",
    "PROCEED",
    "PAYMENT_RECEIVED",
    "SAMPLE_READY",
    "SAMPLE_SENT",
    "CLIENT_ACC",
    "CLIENT_REVISE",
    "CLIENT_REJECT",
    "CANCEL",
];

pub const SAMPLE_NOTES_MAX: usize = 1000;
pub const RND_LEAD_TIME_MAX_DAYS: i64 = 365;
pub const SAMPLE_STEP_NOT_ALLOWED: &str = "This step is not allowed from the current status.";

/// Padanan `SAMPLE_ACTION_DIVISION`: divisi yang sebenarnya memutuskan.
pub fn sample_action_division(action: &str) -> Option<&'static str> {
    match action {
        "RND_ACCEPT" | "RND_REJECT" | "SAMPLE_READY" => Some("RnD"),
        "PAYMENT_RECEIVED" => Some("Finance"),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SampleActionState<'a> {
    pub status: &'a str,
    pub is_paid_sample: bool,
    pub revision_index: i64,
    pub free_revision_limit: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SampleActionResult {
    pub status: &'static str,
    pub revision_index: i64,
    pub is_billable: Option<bool>,
    pub client_decision: Option<&'static str>,
}

/// Padanan `applySampleAction`: seluruh diagram FR-06.4 ada di sini.
pub fn apply_sample_action(
    state: &SampleActionState<'_>,
    action: &str,
    lead_time_days: Option<i64>,
) -> Result<SampleActionResult, &'static str> {
    let step = |from: &[&str], status: &'static str| -> Result<SampleActionResult, &'static str> {
        if from.contains(&state.status) {
            Ok(SampleActionResult {
                status,
                revision_index: state.revision_index,
                is_billable: None,
                client_decision: None,
            })
        } else {
            Err(SAMPLE_STEP_NOT_ALLOWED)
        }
    };
    match action {
        "SUBMIT_TO_RND" => step(&["DRAFT"], "RND_REVIEW"),
        "RND_ACCEPT" => {
            if state.status != "RND_REVIEW" {
                return Err(SAMPLE_STEP_NOT_ALLOWED);
            }
            if !lead_time_days.is_some_and(|days| (1..=RND_LEAD_TIME_MAX_DAYS).contains(&days)) {
                return Err("Enter the RnD lead time in days (1-365).");
            }
            step(&["RND_REVIEW"], "RND_ACCEPTED")
        }
        "RND_REJECT" => step(&["RND_REVIEW"], "RND_REJECTED"),
        "PROCEED" => step(
            &["RND_ACCEPTED"],
            if state.is_paid_sample { "WAITING_SAMPLE_PAYMENT" } else { "IN_RND" },
        ),
        "PAYMENT_RECEIVED" => step(&["WAITING_SAMPLE_PAYMENT", "WAITING_REVISION_PAYMENT"], "IN_RND"),
        "SAMPLE_READY" => step(&["IN_RND"], "SAMPLE_READY"),
        "SAMPLE_SENT" => step(&["SAMPLE_READY"], "SAMPLE_SENT"),
        "CLIENT_ACC" => step(&["SAMPLE_SENT"], "CLIENT_ACC").map(|result| SampleActionResult {
            client_decision: Some("ACC"),
            ..result
        }),
        "CLIENT_REJECT" => step(&["SAMPLE_SENT"], "CLIENT_REJECT").map(|result| SampleActionResult {
            client_decision: Some("REJECT"),
            ..result
        }),
        "CLIENT_REVISE" => {
            if state.status != "SAMPLE_SENT" {
                return Err(SAMPLE_STEP_NOT_ALLOWED);
            }
            let index = state.revision_index + 1;
            let free = index <= state.free_revision_limit;
            Ok(SampleActionResult {
                status: if free { "IN_RND" } else { "PENDING_FEE_ASSESSMENT" },
                revision_index: index,
                is_billable: Some(!free),
                client_decision: Some("REVISE"),
            })
        }
        "CANCEL" => {
            if SAMPLE_TERMINAL_STATUSES.contains(&state.status) || !SAMPLE_STATUSES.contains(&state.status) {
                Err(SAMPLE_STEP_NOT_ALLOWED)
            } else {
                Ok(SampleActionResult {
                    status: "CANCELLED",
                    revision_index: state.revision_index,
                    is_billable: None,
                    client_decision: None,
                })
            }
        }
        _ => Err(SAMPLE_STEP_NOT_ALLOWED),
    }
}

/// Padanan `normalizeSampleNotes`: catatan wajib di setiap langkah (FR-06.6).
pub fn normalize_sample_notes(value: &str) -> Option<String> {
    let notes = value.trim();
    (!notes.is_empty() && notes.chars().count() <= SAMPLE_NOTES_MAX).then(|| notes.to_owned())
}

// ---------------------------------------------------------------------------
// Draft tiket (FR-06.1).
// ---------------------------------------------------------------------------

/// Padanan `SAMPLE_FIELDS_EDITABLE_AFTER_SUBMIT` (keputusan G).
pub const SAMPLE_FIELDS_EDITABLE_AFTER_SUBMIT: &[&str] =
    &["deadline_at", "ship_to_address", "pic_crm_id", "client_budget_idr"];

pub const SAMPLE_QTY_MAX: i64 = 10_000;
pub const SAMPLE_TEXT_MAX: usize = 300;
pub const SAMPLE_BRAND_MAX: usize = 120;
pub const SAMPLE_LONG_TEXT_MAX: usize = 2000;
pub const SAMPLE_BUDGET_MAX: i64 = 1_000_000_000_000;
pub const SPECIAL_REQUEST_KEYS: &[&str] = &["color", "texture", "size", "aroma"];

/// Padanan `isCalendarDate`: `YYYY-MM-DD` yang benar-benar ada.
pub fn is_calendar_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !value
            .bytes()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (
        value[0..4].parse::<i64>(),
        value[5..7].parse::<i64>(),
        value[8..10].parse::<i64>(),
    ) else {
        return false;
    };
    if year < 2000 || !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    day <= days[(month - 1) as usize]
}

fn draft_text(draft: &Value, key: &str) -> String {
    draft
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_owned())
        .unwrap_or_default()
}

fn is_blank(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.is_empty(),
        _ => false,
    }
}

/// Padanan `validateSampleDraft`. Mengembalikan objek JSON dengan kunci yang
/// sama persis dengan `SampleDraft` di TS.
pub fn validate_sample_draft(draft: &Value, fee_mode: &str) -> Result<Value, &'static str> {
    let product_category = draft_text(draft, "product_category_option_id");
    if product_category.is_empty() {
        return Err("Choose the product type.");
    }
    let qty = strict_int(draft.get("sample_qty"))
        .filter(|qty| (1..=SAMPLE_QTY_MAX).contains(qty))
        .ok_or("Enter the sample quantity (1-10000).")?;
    let brand = draft_text(draft, "brand_name");
    if brand.is_empty() || brand.chars().count() > SAMPLE_BRAND_MAX {
        return Err("The brand name is required, up to 120 characters.");
    }
    let packaging = draft_text(draft, "packaging");
    if packaging.is_empty() || packaging.chars().count() > SAMPLE_TEXT_MAX {
        return Err("The packaging is required, up to 300 characters.");
    }
    let deadline = draft_text(draft, "deadline_at");
    if !is_calendar_date(&deadline) {
        return Err("Enter the date the sample must reach the client.");
    }
    let address = draft_text(draft, "ship_to_address");
    if address.is_empty() || address.chars().count() > SAMPLE_TEXT_MAX {
        return Err("The shipping address is required, up to 300 characters.");
    }
    let Some(dummy) = draft.get("is_dummy_required").and_then(Value::as_bool) else {
        return Err("Choose whether a packaging dummy is needed.");
    };

    let bpom = draft_text(draft, "bpom_product_name");
    let claims = draft_text(draft, "claims");
    let reference = draft_text(draft, "reference_notes");
    if bpom.chars().count() > SAMPLE_BRAND_MAX
        || claims.chars().count() > SAMPLE_LONG_TEXT_MAX
        || reference.chars().count() > SAMPLE_LONG_TEXT_MAX
    {
        return Err("One of the text fields is too long.");
    }

    // `serde_json` dengan `preserve_order` tidak dijamin aktif, jadi JSON-nya
    // dirakit tangan dengan urutan tetap, sama dengan `JSON.stringify` di TS.
    let empty = Value::Object(Map::new());
    let raw_special = draft.get("special_requests").filter(|value| value.is_object()).unwrap_or(&empty);
    let mut parts = Vec::with_capacity(SPECIAL_REQUEST_KEYS.len());
    for key in SPECIAL_REQUEST_KEYS {
        let value = draft_text(raw_special, key);
        if value.chars().count() > SAMPLE_TEXT_MAX {
            return Err("Each special request is up to 300 characters.");
        }
        parts.push(format!("{}:{}", json!(key), json!(value)));
    }
    let special_json = format!("{{{}}}", parts.join(","));

    let budget = if is_blank(draft.get("client_budget_idr")) {
        None
    } else {
        Some(
            strict_int(draft.get("client_budget_idr"))
                .filter(|budget| (0..=SAMPLE_BUDGET_MAX).contains(budget))
                .ok_or("The client budget must be a whole rupiah amount.")?,
        )
    };
    let pic = match draft.get("pic_crm_id") {
        None | Some(Value::Null) => None,
        Some(value) if value.as_i64() == Some(0) => None,
        Some(value) => Some(
            value
                .as_i64()
                .filter(|id| *id >= 1)
                .ok_or("Choose an active CRM operator.")?,
        ),
    };

    let requested = draft.get("is_paid_sample").and_then(Value::as_bool);
    let paid = if fee_mode == "PER_REQUEST" {
        requested.ok_or("Choose whether this sample is paid.")?
    } else {
        let paid = fee_mode == "PAID";
        if requested.is_some_and(|requested| requested != paid) {
            return Err(if paid {
                "Company settings make every sample paid."
            } else {
                "Company settings make every sample free."
            });
        }
        paid
    };

    Ok(json!({
        "product_category_option_id": product_category,
        "sample_kind_option_id": draft_text(draft, "sample_kind_option_id"),
        "formulation_type_option_id": draft_text(draft, "formulation_type_option_id"),
        "registration_category_option_id": draft_text(draft, "registration_category_option_id"),
        "pic_crm_id": pic,
        "sample_qty": qty,
        "brand_name": brand,
        "bpom_product_name": bpom,
        "claims": claims,
        "packaging": packaging,
        "reference_notes": reference,
        "client_budget_idr": budget,
        "special_requests_json": special_json,
        "deadline_at": deadline,
        "ship_to_address": address,
        "is_dummy_required": dummy,
        "is_paid_sample": paid,
    }))
}

/// WAJIB identik dengan `CLIENT_LIFECYCLE_FROM_SAMPLES_SQL` di `sample.ts`.
/// Parameter: ?1 id klien, ?2 waktu perubahan.
pub const CLIENT_LIFECYCLE_FROM_SAMPLES_SQL: &str = "UPDATE clients SET lifecycle_status = CASE WHEN EXISTS (SELECT 1 FROM sample_requests WHERE client_id = ?1 AND status NOT IN ('RND_REJECTED', 'CLIENT_REJECT', 'CANCELLED')) THEN 'FIRST_ORDER_ACTIVE' ELSE 'LEAD' END, updated_at = ?2 WHERE id = ?1 AND lifecycle_status IN ('LEAD', 'FIRST_ORDER_ACTIVE') AND lifecycle_status <> CASE WHEN EXISTS (SELECT 1 FROM sample_requests WHERE client_id = ?1 AND status NOT IN ('RND_REJECTED', 'CLIENT_REJECT', 'CANCELLED')) THEN 'FIRST_ORDER_ACTIVE' ELSE 'LEAD' END;";

/// SQL tiket bersama untuk cloud, SQLite lokal, dan Web (`sample.ts`),
/// WAJIB identik. Parameter tercantum di komentar masing-masing.
///
/// ?1 id, ?2 client_id, ?3 lead_id, ?4 sample_kind, ?5 formulation_type,
/// ?6 registration_category, ?7 product_category, ?8 pic_crm_id, ?9 qty,
/// ?10 brand, ?11 bpom, ?12 claims, ?13 packaging, ?14 reference,
/// ?15 budget, ?16 special_requests_json, ?17 deadline, ?18 address,
/// ?19 dummy, ?20 paid, ?21 waktu, ?22 created_by.
pub const SAMPLE_INSERT_SQL: &str = "INSERT INTO sample_requests (id, client_id, lead_id, sample_kind_option_id, formulation_type_option_id, registration_category_option_id, rnd_product_class, product_category_option_id, pic_crm_id, sample_qty, brand_name, bpom_product_name, claims, packaging, reference_notes, client_budget_idr, special_requests_json, deadline_at, ship_to_address, is_dummy_required, is_paid_sample, revision_index, is_billable, status, rnd_lead_time_days, sent_at, status_changed_at, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, 0, 0, 'DRAFT', NULL, '', ?21, ?22, ?21, ?21) ON CONFLICT(id) DO NOTHING;";

/// Keputusan G ditegakkan di SQL: spesifikasi produk hanya berubah selama
/// `DRAFT`; deadline, alamat, PIC CRM, dan budget boleh berubah sampai tiket
/// ditutup. ?1 id, ?2-?14 spesifikasi (urutan sama dengan kolom di bawah),
/// ?15 pic_crm_id, ?16 budget, ?17 deadline, ?18 address, ?19 waktu.
pub const SAMPLE_UPDATE_SQL: &str = "UPDATE sample_requests SET sample_kind_option_id = CASE WHEN status = 'DRAFT' THEN ?2 ELSE sample_kind_option_id END, formulation_type_option_id = CASE WHEN status = 'DRAFT' THEN ?3 ELSE formulation_type_option_id END, registration_category_option_id = CASE WHEN status = 'DRAFT' THEN ?4 ELSE registration_category_option_id END, product_category_option_id = CASE WHEN status = 'DRAFT' THEN ?5 ELSE product_category_option_id END, sample_qty = CASE WHEN status = 'DRAFT' THEN ?6 ELSE sample_qty END, brand_name = CASE WHEN status = 'DRAFT' THEN ?7 ELSE brand_name END, bpom_product_name = CASE WHEN status = 'DRAFT' THEN ?8 ELSE bpom_product_name END, claims = CASE WHEN status = 'DRAFT' THEN ?9 ELSE claims END, packaging = CASE WHEN status = 'DRAFT' THEN ?10 ELSE packaging END, reference_notes = CASE WHEN status = 'DRAFT' THEN ?11 ELSE reference_notes END, special_requests_json = CASE WHEN status = 'DRAFT' THEN ?12 ELSE special_requests_json END, is_dummy_required = CASE WHEN status = 'DRAFT' THEN ?13 ELSE is_dummy_required END, is_paid_sample = CASE WHEN status = 'DRAFT' THEN ?14 ELSE is_paid_sample END, pic_crm_id = ?15, client_budget_idr = ?16, deadline_at = ?17, ship_to_address = ?18, updated_at = ?19 WHERE id = ?1 AND status NOT IN ('RND_REJECTED', 'CLIENT_ACC', 'CLIENT_REJECT', 'CANCELLED');";

/// Satu langkah tiket, hanya bila status dan revisinya masih seperti yang
/// dilihat pencatat. ?1 id, ?2 status baru, ?3 revisi baru, ?4 billable
/// (NULL = tetap), ?5 lead time RnD (NULL = tetap), ?6 waktu, ?7 status lama,
/// ?8 revisi lama.
pub const SAMPLE_TRANSITION_SQL: &str = "UPDATE sample_requests SET status = ?2, revision_index = ?3, is_billable = COALESCE(?4, is_billable), rnd_lead_time_days = COALESCE(?5, rnd_lead_time_days), sent_at = CASE WHEN ?2 = 'SAMPLE_SENT' THEN ?6 ELSE sent_at END, status_changed_at = ?6, updated_at = ?6 WHERE id = ?1 AND status = ?7 AND revision_index = ?8;";

pub const SAMPLE_STATUS_LOG_INSERT_SQL: &str = "INSERT INTO sample_status_log (id, sample_request_id, from_status, to_status, action, notes, on_behalf_of_division, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

pub const SAMPLE_FEEDBACK_INSERT_SQL: &str = "INSERT INTO sample_feedbacks (id, sample_request_id, iteration_number, client_decision, client_notes, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING;";

/// Pesan konflik saat perangkat lain sudah mengubah tiket lebih dulu.
pub const SAMPLE_CHANGED_ELSEWHERE: &str =
    "This sample request was changed on another device first. Sync, check its current status, then record the step again.";

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar dengan `src/lib/validations/sample.test.ts`.

    fn settings(values: &[(&str, &str)]) -> BusinessSettings {
        read_business_settings(
            &values
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
        )
    }

    #[test]
    fn setelan_bisnis_dibaca_dengan_bawaan() {
        assert_eq!(settings(&[]), BusinessSettings::default());
        assert_eq!(
            settings(&[
                ("default_free_revision_limit", "2"),
                ("sample_fee_mode", "PAID"),
                ("lead_hot_max_days", "5"),
                ("lead_warm_max_days", "14"),
            ]),
            BusinessSettings {
                default_free_revision_limit: 2,
                sample_fee_mode: "PAID",
                lead_hot_max_days: 5,
                lead_warm_max_days: 14,
            }
        );
        assert_eq!(
            settings(&[
                ("default_free_revision_limit", "99"),
                ("sample_fee_mode", "paid"),
                ("lead_hot_max_days", "9"),
                ("lead_warm_max_days", "9"),
            ]),
            BusinessSettings::default()
        );
    }

    #[test]
    fn setelan_bisnis_divalidasi() {
        let valid = json!({
            "default_free_revision_limit": 0,
            "sample_fee_mode": "FREE",
            "lead_hot_max_days": 0,
            "lead_warm_max_days": 1,
        });
        assert_eq!(
            validate_business_settings(&valid),
            Ok(BusinessSettings {
                default_free_revision_limit: 0,
                sample_fee_mode: "FREE",
                lead_hot_max_days: 0,
                lead_warm_max_days: 1,
            })
        );
        let with = |key: &str, value: Value| {
            let mut draft = valid.clone();
            draft[key] = value;
            validate_business_settings(&draft).unwrap_err()
        };
        assert_eq!(with("default_free_revision_limit", json!(21)), "Free revisions must be a whole number from 0 to 20.");
        assert_eq!(with("default_free_revision_limit", json!(1.5)), "Free revisions must be a whole number from 0 to 20.");
        assert_eq!(with("sample_fee_mode", json!("SOMETIMES")), "Choose how sample fees are charged.");
        assert_eq!(with("lead_hot_max_days", json!(61)), "The Hot limit must be a whole number of days from 0 to 60.");
        assert_eq!(
            with("lead_warm_max_days", json!(181)),
            "The Warm limit must be more days than the Hot limit, up to 180."
        );
        let mut same = valid.clone();
        same["lead_hot_max_days"] = json!(5);
        same["lead_warm_max_days"] = json!(5);
        assert_eq!(
            validate_business_settings(&same).unwrap_err(),
            "The Warm limit must be more days than the Hot limit, up to 180."
        );
    }

    #[test]
    fn aksi_tiket_mengikuti_diagram_dan_gerbang_kuota() {
        type Expected = Result<(&'static str, i64, Option<bool>, Option<&'static str>), &'static str>;
        let not_allowed: Expected = Err(SAMPLE_STEP_NOT_ALLOWED);
        let cases: &[(&str, bool, i64, i64, &str, Option<i64>, Expected)] = &[
            ("DRAFT", false, 0, 1, "SUBMIT_TO_RND", None, Ok(("RND_REVIEW", 0, None, None))),
            ("RND_REVIEW", false, 0, 1, "RND_ACCEPT", Some(14), Ok(("RND_ACCEPTED", 0, None, None))),
            ("RND_REVIEW", false, 0, 1, "RND_ACCEPT", None, Err("Enter the RnD lead time in days (1-365).")),
            ("RND_REVIEW", false, 0, 1, "RND_ACCEPT", Some(366), Err("Enter the RnD lead time in days (1-365).")),
            ("RND_REVIEW", false, 0, 1, "RND_REJECT", None, Ok(("RND_REJECTED", 0, None, None))),
            ("RND_ACCEPTED", true, 0, 1, "PROCEED", None, Ok(("WAITING_SAMPLE_PAYMENT", 0, None, None))),
            ("RND_ACCEPTED", false, 0, 1, "PROCEED", None, Ok(("IN_RND", 0, None, None))),
            ("WAITING_SAMPLE_PAYMENT", true, 0, 1, "PAYMENT_RECEIVED", None, Ok(("IN_RND", 0, None, None))),
            ("WAITING_REVISION_PAYMENT", true, 2, 1, "PAYMENT_RECEIVED", None, Ok(("IN_RND", 2, None, None))),
            ("IN_RND", false, 0, 1, "SAMPLE_READY", None, Ok(("SAMPLE_READY", 0, None, None))),
            ("SAMPLE_READY", false, 0, 1, "SAMPLE_SENT", None, Ok(("SAMPLE_SENT", 0, None, None))),
            ("SAMPLE_SENT", false, 0, 1, "CLIENT_ACC", None, Ok(("CLIENT_ACC", 0, None, Some("ACC")))),
            ("SAMPLE_SENT", false, 0, 1, "CLIENT_REJECT", None, Ok(("CLIENT_REJECT", 0, None, Some("REJECT")))),
            ("SAMPLE_SENT", false, 0, 1, "CLIENT_REVISE", None, Ok(("IN_RND", 1, Some(false), Some("REVISE")))),
            ("SAMPLE_SENT", false, 1, 1, "CLIENT_REVISE", None, Ok(("PENDING_FEE_ASSESSMENT", 2, Some(true), Some("REVISE")))),
            ("SAMPLE_SENT", false, 0, 0, "CLIENT_REVISE", None, Ok(("PENDING_FEE_ASSESSMENT", 1, Some(true), Some("REVISE")))),
            ("PENDING_FEE_ASSESSMENT", false, 2, 1, "CANCEL", None, Ok(("CANCELLED", 2, None, None))),
            ("DRAFT", false, 0, 1, "CANCEL", None, Ok(("CANCELLED", 0, None, None))),
            ("DRAFT", false, 0, 1, "SAMPLE_SENT", None, not_allowed),
            ("IN_RND", false, 0, 1, "CLIENT_REVISE", None, not_allowed),
            ("PENDING_FEE_ASSESSMENT", false, 2, 1, "PAYMENT_RECEIVED", None, not_allowed),
            ("CLIENT_ACC", false, 0, 1, "CANCEL", None, not_allowed),
            ("CANCELLED", false, 0, 1, "CANCEL", None, not_allowed),
            ("UNKNOWN", false, 0, 1, "CANCEL", None, not_allowed),
        ];
        for (status, paid, index, limit, action, lead, expected) in cases {
            let state = SampleActionState {
                status,
                is_paid_sample: *paid,
                revision_index: *index,
                free_revision_limit: *limit,
            };
            let actual = apply_sample_action(&state, action, *lead)
                .map(|result| (result.status, result.revision_index, result.is_billable, result.client_decision));
            assert_eq!(actual, *expected, "{status} + {action}");
        }
    }

    #[test]
    fn draft_tiket_dirapikan_dan_divalidasi() {
        let draft = json!({
            "product_category_option_id": "cat-1",
            "sample_qty": 3,
            "brand_name": " Aura Glow ",
            "packaging": "Amber dropper 30 ml",
            "deadline_at": "2026-10-31",
            "ship_to_address": "Jl. Merdeka 1, Bandung",
            "is_dummy_required": false,
            "is_paid_sample": true,
            "special_requests": { "color": "Clear", "aroma": "Rose", "extra": "ignored" },
            "client_budget_idr": 2500000,
        });
        assert_eq!(
            validate_sample_draft(&draft, "PER_REQUEST").unwrap(),
            json!({
                "product_category_option_id": "cat-1",
                "sample_kind_option_id": "",
                "formulation_type_option_id": "",
                "registration_category_option_id": "",
                "pic_crm_id": null,
                "sample_qty": 3,
                "brand_name": "Aura Glow",
                "bpom_product_name": "",
                "claims": "",
                "packaging": "Amber dropper 30 ml",
                "reference_notes": "",
                "client_budget_idr": 2500000,
                "special_requests_json": "{\"color\":\"Clear\",\"texture\":\"\",\"size\":\"\",\"aroma\":\"Rose\"}",
                "deadline_at": "2026-10-31",
                "ship_to_address": "Jl. Merdeka 1, Bandung",
                "is_dummy_required": false,
                "is_paid_sample": true,
            })
        );

        let mut unset = draft.clone();
        unset.as_object_mut().unwrap().remove("is_paid_sample");
        assert_eq!(validate_sample_draft(&unset, "FREE").unwrap()["is_paid_sample"], json!(false));
        assert_eq!(validate_sample_draft(&unset, "PAID").unwrap()["is_paid_sample"], json!(true));
        assert_eq!(
            validate_sample_draft(&draft, "FREE").unwrap_err(),
            "Company settings make every sample free."
        );

        let cases: &[(&str, Value, &str)] = &[
            ("product_category_option_id", json!(""), "Choose the product type."),
            ("sample_qty", json!(0), "Enter the sample quantity (1-10000)."),
            ("sample_qty", json!("3"), "Enter the sample quantity (1-10000)."),
            ("brand_name", json!("  "), "The brand name is required, up to 120 characters."),
            ("packaging", json!(""), "The packaging is required, up to 300 characters."),
            ("deadline_at", json!("2026-02-30"), "Enter the date the sample must reach the client."),
            ("ship_to_address", json!(""), "The shipping address is required, up to 300 characters."),
            ("is_dummy_required", json!("no"), "Choose whether a packaging dummy is needed."),
            ("client_budget_idr", json!(10.5), "The client budget must be a whole rupiah amount."),
            ("client_budget_idr", json!(-1), "The client budget must be a whole rupiah amount."),
            ("pic_crm_id", json!(-4), "Choose an active CRM operator."),
            ("is_paid_sample", Value::Null, "Choose whether this sample is paid."),
        ];
        for (key, value, message) in cases {
            let mut changed = draft.clone();
            changed[*key] = value.clone();
            assert_eq!(validate_sample_draft(&changed, "PER_REQUEST").unwrap_err(), *message, "{key}");
        }
    }

    #[test]
    fn tanggal_kalender() {
        assert!(is_calendar_date("2028-02-29"));
        assert!(!is_calendar_date("2026-02-29"));
        assert!(!is_calendar_date("2026-13-01"));
        assert!(!is_calendar_date("26-01-01"));
    }
}
