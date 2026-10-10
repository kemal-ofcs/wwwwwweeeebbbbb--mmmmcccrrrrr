//! Work order produksi: cek bahan, PO, dan jadwal SPV (PRD F-23/F-24, v3.1,
//! D-44).
//!
//! WAJIB identik dengan `src/lib/validations/production.ts`. Kedua sisi diuji
//! dengan vektor yang sama (`mod tests` di sini dan `production.test.ts`), dan
//! setiap konstanta SQL dites ada per karakter dari sisi TS.

use serde_json::{json, Value};

use super::legal::LEGAL_DP_PENDING;
use super::samples::is_calendar_date;

pub const PO_STATUSES: &[&str] = &["OPEN", "ARRIVED", "CANCELLED"];
pub const PO_ACTIONS: &[&str] = &["PO_ADD", "PO_ARRIVED", "PO_LATE", "PO_CANCEL"];
pub const BATCH_CREATE_ACTION: &str = "BATCH_CREATE";
pub const MATERIALS_READY_ACTION: &str = "MATERIALS_READY";
pub const BATCH_SCHEDULE_ACTION: &str = "BATCH_SCHEDULE";
pub const DEFAULT_BATCH_CODE_PREFIX: &str = "BAT";
pub const PO_NUMBER_MAX: usize = 60;
pub const PRODUCTION_REASON_MAX: usize = 500;

/// Padanan `batchRequestError`.
pub fn batch_request_error(mou_status: &str, dp_cleared: bool, active_batches: i64) -> Option<&'static str> {
    if mou_status != "ACCEPTED" {
        return Some("The client has not accepted the MoU yet.");
    }
    if !dp_cleared {
        return Some(LEGAL_DP_PENDING);
    }
    (active_batches > 0).then_some("This MoU already has a work order.")
}

/// Padanan `applyPoAction`. `""` = PO belum ada.
pub fn apply_po_action(status: &str, action: &str) -> Result<&'static str, &'static str> {
    let from = |allowed: &str, to: &'static str| {
        if status == allowed {
            Ok(to)
        } else {
            Err("This step is not available for the purchase order's current status.")
        }
    };
    match action {
        "PO_ADD" => from("", "OPEN"),
        "PO_ARRIVED" => from("OPEN", "ARRIVED"),
        "PO_LATE" => from("OPEN", "OPEN"),
        "PO_CANCEL" => from("OPEN", "CANCELLED"),
        _ => Err("This purchase order step does not exist."),
    }
}

/// Padanan `materialsReadyError`.
pub fn materials_ready_error(material_status: &str, open_orders: i64) -> Option<&'static str> {
    if material_status == "READY" {
        return Some("The materials are already ready.");
    }
    (open_orders > 0).then_some("Mark every open purchase order as arrived or cancelled first.")
}

/// Teks yang sudah dirapikan; `None` = bukan teks (angka, objek).
fn text(raw: &Value, key: &str) -> Option<String> {
    match raw.get(key) {
        None | Some(Value::Null) => Some(String::new()),
        Some(Value::String(value)) => Some(value.trim().to_owned()),
        Some(_) => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PurchaseOrderInput {
    pub po_number: String,
    pub supplier_option_id: String,
    pub eta_on: String,
}

impl PurchaseOrderInput {
    pub fn to_json(&self) -> Value {
        json!({
            "po_number": self.po_number,
            "supplier_option_id": self.supplier_option_id,
            "eta_on": self.eta_on,
        })
    }
}

/// Padanan `validatePurchaseOrder`.
pub fn validate_purchase_order(raw: &Value) -> Result<PurchaseOrderInput, &'static str> {
    let number = text(raw, "po_number")
        .filter(|number| !number.is_empty() && number.chars().count() <= PO_NUMBER_MAX)
        .ok_or("Enter the purchase order number, up to 60 characters.")?;
    let supplier = text(raw, "supplier_option_id")
        .filter(|supplier| !supplier.is_empty())
        .ok_or("Choose the supplier.")?;
    let eta = text(raw, "eta_on")
        .filter(|eta| is_calendar_date(eta))
        .ok_or("Enter the expected arrival date.")?;
    Ok(PurchaseOrderInput { po_number: number, supplier_option_id: supplier, eta_on: eta })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoDelayInput {
    pub eta_on: String,
    pub reason: String,
}

impl PoDelayInput {
    pub fn to_json(&self) -> Value {
        json!({ "eta_on": self.eta_on, "reason": self.reason })
    }
}

/// Padanan `validatePoDelay`.
pub fn validate_po_delay(raw: &Value, current_eta: &str) -> Result<PoDelayInput, &'static str> {
    let eta = text(raw, "eta_on")
        .filter(|eta| is_calendar_date(eta))
        .ok_or("Enter the new expected arrival date.")?;
    if eta.as_str() <= current_eta {
        return Err("The new arrival date must be after the current one.");
    }
    let reason = text(raw, "reason")
        .filter(|reason| !reason.is_empty() && reason.chars().count() <= PRODUCTION_REASON_MAX)
        .ok_or("Write why the order is late, up to 500 characters.")?;
    Ok(PoDelayInput { eta_on: eta, reason })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatchScheduleInput {
    pub weighing_on: String,
    pub mixing_on: String,
    pub filling_on: String,
    pub packing_on: String,
    pub reason: String,
}

impl BatchScheduleInput {
    pub fn to_json(&self) -> Value {
        json!({
            "weighing_on": self.weighing_on,
            "mixing_on": self.mixing_on,
            "filling_on": self.filling_on,
            "packing_on": self.packing_on,
            "reason": self.reason,
        })
    }
}

pub const SCHEDULE_STAGES: &[(&str, &str)] = &[
    ("weighing_on", "weighing"),
    ("mixing_on", "mixing"),
    ("filling_on", "filling"),
    ("packing_on", "packing"),
];

/// Padanan `validateBatchSchedule`.
pub fn validate_batch_schedule(raw: &Value, has_schedule: bool) -> Result<BatchScheduleInput, String> {
    let mut dates: Vec<String> = Vec::new();
    for (key, label) in SCHEDULE_STAGES {
        let value = text(raw, key)
            .filter(|value| is_calendar_date(value))
            .ok_or_else(|| format!("Enter the {label} date."))?;
        if dates.last().is_some_and(|previous| value < *previous) {
            return Err(format!("The {label} date cannot be before the stage before it."));
        }
        dates.push(value);
    }
    let reason = text(raw, "reason")
        .filter(|reason| reason.chars().count() <= PRODUCTION_REASON_MAX)
        .ok_or("The reason is up to 500 characters.")?;
    if has_schedule && reason.is_empty() {
        return Err("Write why the schedule changes.".into());
    }
    let mut dates = dates.into_iter();
    let mut next = || dates.next().unwrap_or_default();
    Ok(BatchScheduleInput {
        weighing_on: next(),
        mixing_on: next(),
        filling_on: next(),
        packing_on: next(),
        reason,
    })
}

/// Padanan `poLogNotes`.
pub fn po_log_notes(action: &str, po_number: &str, supplier: &str, eta_on: &str, reason: &str) -> String {
    match action {
        "PO_ADD" => format!("PO {po_number} from {supplier}, arriving {eta_on}"),
        "PO_ARRIVED" => format!("PO {po_number} arrived"),
        "PO_LATE" => format!("PO {po_number} is late, now arriving {eta_on}: {reason}"),
        _ => format!("PO {po_number} cancelled"),
    }
}

/// Padanan `scheduleLogNotes`.
pub fn schedule_log_notes(schedule: &BatchScheduleInput) -> String {
    let dates = format!(
        "Weighing {}, mixing {}, filling {}, packing {}",
        schedule.weighing_on, schedule.mixing_on, schedule.filling_on, schedule.packing_on
    );
    if schedule.reason.is_empty() {
        dates
    } else {
        format!("{dates} - {}", schedule.reason)
    }
}

pub const BATCH_CHANGED_ELSEWHERE: &str =
    "This work order was changed on another device first. Open it again to see the latest version.";

pub const BATCH_LIST_SQL: &str = "SELECT b.*, m.mou_number, m.total_units, m.regulatory_path, m.production_lead_time_days, s.brand_name, c.client_code, c.name AS client_name, (SELECT COUNT(*) FROM batch_purchase_orders p WHERE p.batch_id = b.id AND p.status = 'OPEN') AS open_orders, (SELECT MIN(p.eta_on) FROM batch_purchase_orders p WHERE p.batch_id = b.id AND p.status = 'OPEN') AS next_eta_on FROM production_batches b JOIN production_mou m ON m.id = b.mou_id JOIN sample_requests s ON s.id = b.sample_request_id LEFT JOIN clients c ON c.id = b.client_id";
pub const PO_LIST_SQL: &str = "SELECT p.*, COALESCE(o.label, '') AS supplier_label FROM batch_purchase_orders p LEFT JOIN master_option o ON o.id = p.supplier_option_id";
pub const SUPPLIER_LIST_SQL: &str = "SELECT id, code, label, is_active FROM master_option WHERE kind = 'SUPPLIER' ORDER BY sort_order, label;";
pub const MOU_WITHOUT_BATCH_WHERE: &str = " WHERE m.status = 'ACCEPTED' AND NOT EXISTS (SELECT 1 FROM production_batches b WHERE b.mou_id = m.id)";
pub const BATCH_ACTIVE_SQL: &str = "SELECT COUNT(*) AS total FROM production_batches WHERE mou_id = ?1 AND id <> ?2;";
pub const BATCH_INSERT_SQL: &str = "INSERT INTO production_batches (id, batch_code, mou_id, sample_request_id, client_id, material_status, sched_weighing_on, sched_mixing_on, sched_filling_on, sched_packing_on, needs_reschedule, schedule_updated_at, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'UNCHECKED', '', '', '', '', 0, '', ?6, ?7, ?7) ON CONFLICT(id) DO NOTHING;";
pub const PO_INSERT_SQL: &str = "INSERT INTO batch_purchase_orders (id, batch_id, po_number, supplier_option_id, eta_on, status, late_reason, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'OPEN', '', ?6, ?7, ?7) ON CONFLICT(id) DO NOTHING;";
pub const PO_STATUS_SQL: &str = "UPDATE batch_purchase_orders SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'OPEN';";
pub const PO_DELAY_SQL: &str = "UPDATE batch_purchase_orders SET eta_on = ?2, late_reason = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'OPEN' AND eta_on = ?5;";
pub const BATCH_WAITING_PO_SQL: &str = "UPDATE production_batches SET material_status = 'WAITING_PO', updated_at = ?2 WHERE id = ?1;";
pub const BATCH_NEEDS_RESCHEDULE_SQL: &str = "UPDATE production_batches SET needs_reschedule = CASE WHEN sched_packing_on <> '' THEN 1 ELSE needs_reschedule END, updated_at = ?2 WHERE id = ?1;";
pub const BATCH_READY_SQL: &str = "UPDATE production_batches SET material_status = 'READY', updated_at = ?2 WHERE id = ?1 AND material_status <> 'READY' AND NOT EXISTS (SELECT 1 FROM batch_purchase_orders p WHERE p.batch_id = ?1 AND p.status = 'OPEN');";
pub const BATCH_SCHEDULE_SQL: &str = "UPDATE production_batches SET sched_weighing_on = ?2, sched_mixing_on = ?3, sched_filling_on = ?4, sched_packing_on = ?5, needs_reschedule = 0, schedule_updated_at = ?6, updated_at = ?6 WHERE id = ?1 AND schedule_updated_at = ?7;";

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar dengan `src/lib/validations/production.test.ts`.

    #[test]
    fn work_order_dan_langkah_po_mengikuti_aturan() {
        assert_eq!(batch_request_error("ACCEPTED", true, 0), None);
        assert_eq!(batch_request_error("SENT", true, 0), Some("The client has not accepted the MoU yet."));
        assert_eq!(batch_request_error("ACCEPTED", false, 0), Some(LEGAL_DP_PENDING));
        assert_eq!(batch_request_error("ACCEPTED", true, 1), Some("This MoU already has a work order."));
        assert_eq!(apply_po_action("", "PO_ADD"), Ok("OPEN"));
        assert_eq!(apply_po_action("OPEN", "PO_ARRIVED"), Ok("ARRIVED"));
        assert_eq!(apply_po_action("OPEN", "PO_LATE"), Ok("OPEN"));
        assert_eq!(apply_po_action("OPEN", "PO_CANCEL"), Ok("CANCELLED"));
        let wrong = Err("This step is not available for the purchase order's current status.");
        assert_eq!(apply_po_action("ARRIVED", "PO_LATE"), wrong);
        assert_eq!(apply_po_action("OPEN", "PO_ADD"), wrong);
        assert_eq!(apply_po_action("CANCELLED", "PO_ARRIVED"), wrong);
        assert_eq!(apply_po_action("OPEN", "PO_SPLIT"), Err("This purchase order step does not exist."));
        assert_eq!(materials_ready_error("UNCHECKED", 0), None);
        assert_eq!(materials_ready_error("WAITING_PO", 0), None);
        assert_eq!(
            materials_ready_error("WAITING_PO", 2),
            Some("Mark every open purchase order as arrived or cancelled first.")
        );
        assert_eq!(materials_ready_error("READY", 0), Some("The materials are already ready."));
    }

    #[test]
    fn isian_po_dan_keterlambatan_divalidasi() {
        let order = json!({ "po_number": " PO-778 ", "supplier_option_id": "sup-1", "eta_on": "2026-10-20" });
        assert_eq!(
            validate_purchase_order(&order),
            Ok(PurchaseOrderInput {
                po_number: "PO-778".into(),
                supplier_option_id: "sup-1".into(),
                eta_on: "2026-10-20".into(),
            })
        );
        let with = |key: &str, value: Value| {
            let mut draft = order.clone();
            draft[key] = value;
            validate_purchase_order(&draft).unwrap_err()
        };
        assert_eq!(with("po_number", json!("")), "Enter the purchase order number, up to 60 characters.");
        assert_eq!(with("po_number", json!("x".repeat(61))), "Enter the purchase order number, up to 60 characters.");
        assert_eq!(with("po_number", json!(778)), "Enter the purchase order number, up to 60 characters.");
        assert_eq!(with("supplier_option_id", json!("")), "Choose the supplier.");
        assert_eq!(with("eta_on", json!("2026-02-30")), "Enter the expected arrival date.");

        let delay = json!({ "eta_on": "2026-10-27", "reason": " Supplier stock out " });
        assert_eq!(
            validate_po_delay(&delay, "2026-10-20"),
            Ok(PoDelayInput { eta_on: "2026-10-27".into(), reason: "Supplier stock out".into() })
        );
        assert_eq!(
            validate_po_delay(&delay, "2026-10-27").unwrap_err(),
            "The new arrival date must be after the current one."
        );
        assert_eq!(
            validate_po_delay(&json!({ "eta_on": "27-10-2026", "reason": "x" }), "2026-10-20").unwrap_err(),
            "Enter the new expected arrival date."
        );
        assert_eq!(
            validate_po_delay(&json!({ "eta_on": "2026-10-27", "reason": "" }), "2026-10-20").unwrap_err(),
            "Write why the order is late, up to 500 characters."
        );
    }

    #[test]
    fn jadwal_berurutan_dan_alasan_saat_diubah() {
        let draft = json!({
            "weighing_on": "2026-11-02",
            "mixing_on": "2026-11-03",
            "filling_on": "2026-11-03",
            "packing_on": "2026-11-05",
            "reason": "",
        });
        let schedule = validate_batch_schedule(&draft, false).unwrap();
        assert_eq!(
            schedule,
            BatchScheduleInput {
                weighing_on: "2026-11-02".into(),
                mixing_on: "2026-11-03".into(),
                filling_on: "2026-11-03".into(),
                packing_on: "2026-11-05".into(),
                reason: String::new(),
            }
        );
        assert_eq!(
            schedule_log_notes(&schedule),
            "Weighing 2026-11-02, mixing 2026-11-03, filling 2026-11-03, packing 2026-11-05"
        );
        assert_eq!(validate_batch_schedule(&draft, true).unwrap_err(), "Write why the schedule changes.");
        let mut moved = draft.clone();
        moved["reason"] = json!(" PO late ");
        let moved = validate_batch_schedule(&moved, true).unwrap();
        assert_eq!(
            schedule_log_notes(&moved),
            "Weighing 2026-11-02, mixing 2026-11-03, filling 2026-11-03, packing 2026-11-05 - PO late"
        );
        let mut backwards = draft.clone();
        backwards["filling_on"] = json!("2026-11-01");
        assert_eq!(
            validate_batch_schedule(&backwards, false).unwrap_err(),
            "The filling date cannot be before the stage before it."
        );
        let mut missing = draft.clone();
        missing["packing_on"] = json!("");
        assert_eq!(validate_batch_schedule(&missing, false).unwrap_err(), "Enter the packing date.");
        let mut long = draft.clone();
        long["reason"] = json!("x".repeat(501));
        assert_eq!(validate_batch_schedule(&long, true).unwrap_err(), "The reason is up to 500 characters.");
        assert_eq!(
            po_log_notes("PO_ADD", "PO-778", "PT Kimia", "2026-10-20", ""),
            "PO PO-778 from PT Kimia, arriving 2026-10-20"
        );
        assert_eq!(
            po_log_notes("PO_LATE", "PO-778", "PT Kimia", "2026-10-27", "Stock out"),
            "PO PO-778 is late, now arriving 2026-10-27: Stock out"
        );
        assert_eq!(po_log_notes("PO_ARRIVED", "PO-778", "", "", ""), "PO PO-778 arrived");
        assert_eq!(po_log_notes("PO_CANCEL", "PO-778", "", "", ""), "PO PO-778 cancelled");
    }
}
