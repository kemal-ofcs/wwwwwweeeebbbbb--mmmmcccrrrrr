//! MoU produksi, lead time, persen DP, dan jalur regulasi (PRD F-20, v2.5a,
//! D-37).
//!
//! WAJIB identik dengan `src/lib/validations/mou.ts`. Kedua sisi diuji dengan
//! vektor yang sama (`mod tests` di sini dan `mou.test.ts`), dan setiap
//! konstanta SQL dites ada per karakter dari sisi TS.

use serde_json::{json, Value};

use super::finance::{apply_rate, INVOICE_AMOUNT_MAX};
use super::samples::DP_PERCENTAGE_INVALID;

pub const MOU_STATUSES: &[&str] = &["DRAFT", "SENT", "ACCEPTED", "REJECTED", "CANCELLED"];
pub const MOU_ACTIONS: &[&str] = &["SEND_MOU", "MOU_ACCEPT", "MOU_REVISE", "MOU_REJECT", "CANCEL_MOU"];
/// Aksi linimasa saat MoU dibuat.
pub const MOU_CREATE_ACTION: &str = "CREATE_MOU";
pub const MOU_NUMBER_PREFIX: &str = "MOU";
pub const REGULATORY_PATHS: &[&str] = &["WHITE_LABEL", "WITH_BPOM"];
pub const MOU_UNITS_MAX: i64 = 10_000_000;
pub const MOU_LEAD_TIME_MAX_DAYS: i64 = 365;
pub const MOU_NOTES_MAX: usize = 1000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MouTerms {
    pub total_units: i64,
    pub unit_price_idr: i64,
    pub total_production_cost_idr: i64,
    pub production_lead_time_days: i64,
    pub regulatory_path: &'static str,
    pub dp_bp: i64,
    pub dp_amount_required_idr: i64,
    pub notes: String,
}

impl MouTerms {
    pub fn to_json(&self) -> Value {
        json!({
            "total_units": self.total_units,
            "unit_price_idr": self.unit_price_idr,
            "total_production_cost_idr": self.total_production_cost_idr,
            "production_lead_time_days": self.production_lead_time_days,
            "regulatory_path": self.regulatory_path,
            "dp_bp": self.dp_bp,
            "dp_amount_required_idr": self.dp_amount_required_idr,
            "notes": self.notes,
        })
    }
}

pub const MOU_VALUE_TOO_LARGE: &str = "The contract value is too large.";

/// Padanan `validateMouTerms`: total dan DP selalu dihitung di sini.
pub fn validate_mou_terms(raw: &Value) -> Result<MouTerms, &'static str> {
    let int = |key: &str| raw.get(key).and_then(Value::as_i64);
    let units = int("total_units")
        .filter(|units| (1..=MOU_UNITS_MAX).contains(units))
        .ok_or("Enter the number of units (1 to 10,000,000).")?;
    let price = int("unit_price_idr")
        .filter(|price| (1..=INVOICE_AMOUNT_MAX).contains(price))
        .ok_or("Enter the unit price in whole rupiah.")?;
    if price > INVOICE_AMOUNT_MAX / units {
        return Err(MOU_VALUE_TOO_LARGE);
    }
    let lead = int("production_lead_time_days")
        .filter(|days| (1..=MOU_LEAD_TIME_MAX_DAYS).contains(days))
        .ok_or("Enter the production lead time in days (1-365).")?;
    let path = raw
        .get("regulatory_path")
        .and_then(Value::as_str)
        .and_then(|path| REGULATORY_PATHS.iter().copied().find(|known| *known == path))
        .ok_or("Choose White Label or With BPOM.")?;
    let dp = int("dp_bp")
        .filter(|dp| (1..=10_000).contains(dp))
        .ok_or(DP_PERCENTAGE_INVALID)?;
    let notes = match raw.get("notes") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(_) => return Err("Notes are up to 1000 characters."),
    };
    if notes.chars().count() > MOU_NOTES_MAX {
        return Err("Notes are up to 1000 characters.");
    }
    let total = units * price;
    Ok(MouTerms {
        total_units: units,
        unit_price_idr: price,
        total_production_cost_idr: total,
        production_lead_time_days: lead,
        regulatory_path: path,
        dp_bp: dp,
        dp_amount_required_idr: apply_rate(total, dp),
        notes,
    })
}

/// Padanan `mouRequestError`.
pub fn mou_request_error(sample_status: &str, active_mous: i64) -> Option<&'static str> {
    if sample_status != "CLIENT_ACC" {
        return Some("The client has not approved the sample yet.");
    }
    (active_mous > 0).then_some("This sample request already has a MoU.")
}

pub const MOU_DUMMY_PENDING: &str = "The client has not approved the packaging dummy yet.";

/// Padanan `applyMouAction`.
pub fn apply_mou_action(status: &str, dummy_ready: bool, action: &str) -> Result<&'static str, &'static str> {
    let from = |allowed: &[&str], to: &'static str| {
        if allowed.contains(&status) {
            Ok(to)
        } else {
            Err("This step is not available for the MoU's current status.")
        }
    };
    match action {
        "SEND_MOU" => {
            let to = from(&["DRAFT"], "SENT")?;
            if dummy_ready {
                Ok(to)
            } else {
                Err(MOU_DUMMY_PENDING)
            }
        }
        "MOU_ACCEPT" => from(&["SENT"], "ACCEPTED"),
        "MOU_REVISE" => from(&["SENT"], "DRAFT"),
        "MOU_REJECT" => from(&["SENT"], "REJECTED"),
        "CANCEL_MOU" => from(&["DRAFT", "SENT"], "CANCELLED"),
        _ => Err("This MoU step does not exist."),
    }
}

pub const MOU_NOT_EDITABLE: &str = "Only a draft MoU can be changed.";
pub const MOU_CHANGED_ELSEWHERE: &str =
    "This MoU was changed on another device first. Open it again to see the latest version.";

pub const MOU_LIST_SQL: &str = "SELECT m.*, s.brand_name, s.is_dummy_required, c.client_code, c.name AS client_name, c.address AS client_address, c.city AS client_city, c.province AS client_province, (s.is_dummy_required = 0 OR EXISTS (SELECT 1 FROM design_tickets d WHERE d.sample_request_id = m.sample_request_id AND d.status = 'DUMMY_ACC')) AS dummy_ready, EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = m.sample_request_id AND i.ref_type = 'DP_PRODUCTION_LEGAL' AND i.status IN ('OPEN', 'RESCHEDULED')) AS dp_invoiced, EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = m.sample_request_id AND i.ref_type = 'DP_PRODUCTION_LEGAL' AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) AS dp_cleared FROM production_mou m JOIN sample_requests s ON s.id = m.sample_request_id LEFT JOIN clients c ON c.id = m.client_id";
pub const MOU_ACTIVE_SQL: &str = "SELECT COUNT(*) AS total FROM production_mou WHERE sample_request_id = ?1 AND status NOT IN ('CANCELLED', 'REJECTED') AND id <> ?2;";
pub const MOU_INSERT_SQL: &str = "INSERT INTO production_mou (id, mou_number, sample_request_id, client_id, total_units, unit_price_idr, total_production_cost_idr, production_lead_time_days, regulatory_path, dp_bp, dp_amount_required_idr, notes, status, revision_notes, status_changed_at, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'DRAFT', '', ?13, ?14, ?13, ?13) ON CONFLICT(id) DO NOTHING;";
pub const MOU_UPDATE_SQL: &str = "UPDATE production_mou SET total_units = ?2, unit_price_idr = ?3, total_production_cost_idr = ?4, production_lead_time_days = ?5, regulatory_path = ?6, dp_bp = ?7, dp_amount_required_idr = ?8, notes = ?9, updated_at = ?10 WHERE id = ?1 AND status = 'DRAFT' AND updated_at = ?11;";
pub const MOU_TRANSITION_SQL: &str = "UPDATE production_mou SET status = ?2, revision_notes = COALESCE(?3, revision_notes), status_changed_at = ?4, updated_at = ?4 WHERE id = ?1 AND status = ?5;";

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar dengan `src/lib/validations/mou.test.ts`.

    fn terms() -> Value {
        json!({
            "total_units": 10_000,
            "unit_price_idr": 32_500,
            "production_lead_time_days": 45,
            "regulatory_path": "WITH_BPOM",
            "dp_bp": 5000,
            "notes": " Box 30 ml ",
        })
    }

    #[test]
    fn isi_mou_dihitung_dan_divalidasi() {
        assert_eq!(
            validate_mou_terms(&terms()),
            Ok(MouTerms {
                total_units: 10_000,
                unit_price_idr: 32_500,
                total_production_cost_idr: 325_000_000,
                production_lead_time_days: 45,
                regulatory_path: "WITH_BPOM",
                dp_bp: 5000,
                dp_amount_required_idr: 162_500_000,
                notes: "Box 30 ml".into(),
            })
        );
        let mut odd = terms();
        odd["total_units"] = json!(3);
        odd["unit_price_idr"] = json!(333);
        odd["dp_bp"] = json!(3333);
        let odd = validate_mou_terms(&odd).unwrap();
        assert_eq!((odd.total_production_cost_idr, odd.dp_amount_required_idr), (999, 333));
        let with = |key: &str, value: Value| {
            let mut draft = terms();
            draft[key] = value;
            validate_mou_terms(&draft).unwrap_err()
        };
        assert_eq!(with("total_units", json!(0)), "Enter the number of units (1 to 10,000,000).");
        assert_eq!(with("total_units", json!("10")), "Enter the number of units (1 to 10,000,000).");
        assert_eq!(with("unit_price_idr", json!(0)), "Enter the unit price in whole rupiah.");
        assert_eq!(with("unit_price_idr", json!(10_000_001)), MOU_VALUE_TOO_LARGE);
        assert_eq!(with("production_lead_time_days", json!(366)), "Enter the production lead time in days (1-365).");
        assert_eq!(with("regulatory_path", json!("BPOM")), "Choose White Label or With BPOM.");
        assert_eq!(with("dp_bp", json!(0)), DP_PERCENTAGE_INVALID);
        assert_eq!(with("notes", json!("x".repeat(1001))), "Notes are up to 1000 characters.");
        assert_eq!(with("notes", json!(5)), "Notes are up to 1000 characters.");
        let mut bare = terms();
        bare.as_object_mut().unwrap().remove("notes");
        assert_eq!(validate_mou_terms(&bare).unwrap().notes, "");
    }

    #[test]
    fn langkah_mou_mengikuti_diagram() {
        assert_eq!(apply_mou_action("DRAFT", true, "SEND_MOU"), Ok("SENT"));
        assert_eq!(apply_mou_action("DRAFT", false, "SEND_MOU"), Err(MOU_DUMMY_PENDING));
        assert_eq!(apply_mou_action("SENT", false, "MOU_ACCEPT"), Ok("ACCEPTED"));
        assert_eq!(apply_mou_action("SENT", true, "MOU_REVISE"), Ok("DRAFT"));
        assert_eq!(apply_mou_action("SENT", true, "MOU_REJECT"), Ok("REJECTED"));
        assert_eq!(apply_mou_action("DRAFT", true, "CANCEL_MOU"), Ok("CANCELLED"));
        let wrong = Err("This step is not available for the MoU's current status.");
        assert_eq!(apply_mou_action("ACCEPTED", true, "CANCEL_MOU"), wrong);
        assert_eq!(apply_mou_action("DRAFT", true, "MOU_ACCEPT"), wrong);
        assert_eq!(apply_mou_action("SENT", true, "SEND_MOU"), wrong);
        assert_eq!(apply_mou_action("DRAFT", true, "SIGN"), Err("This MoU step does not exist."));
        assert_eq!(mou_request_error("CLIENT_ACC", 0), None);
        assert_eq!(mou_request_error("SAMPLE_SENT", 0), Some("The client has not approved the sample yet."));
        assert_eq!(mou_request_error("CLIENT_ACC", 1), Some("This sample request already has a MoU."));
    }
}
