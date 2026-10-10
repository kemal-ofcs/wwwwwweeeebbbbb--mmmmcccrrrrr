//! Work order produksi: cek bahan, PO, dan jadwal SPV (PRD F-23/F-24, v3.1,
//! D-44).
//!
//! WAJIB identik dengan `src/lib/validations/production.ts`. Kedua sisi diuji
//! dengan vektor yang sama (`mod tests` di sini dan `production.test.ts`), dan
//! setiap konstanta SQL dites ada per karakter dari sisi TS.

use serde_json::{json, Value};

use super::legal::LEGAL_DP_PENDING;
use super::mou::MOU_UNITS_MAX;
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

/// Tahap lantai produksi (v3.2, PRD F-25, D-45).
pub const PRODUCTION_STAGES: &[&str] = &["WEIGHING", "MIXING", "FILLING", "PACKING"];
pub const CARTON_COUNT_MAX: i64 = 100_000;
pub const PRODUCTION_STARTED: &str =
    "Production has started, so purchase orders and materials can no longer change.";
pub const PRODUCTION_PACKED: &str = "Production is already packed.";
pub const LEGAL_PENDING_FOR_PRODUCTION: &str =
    "Waiting for every required legal document to be issued or marked not required.";

/// Padanan `STAGE_LABEL`.
pub fn stage_label(stage: &str) -> &'static str {
    match stage {
        "WEIGHING" => "Weighing",
        "MIXING" => "Mixing",
        "FILLING" => "Filling",
        _ => "Packing",
    }
}

/// Padanan `stageGateError`.
pub fn stage_gate_error(stages_done: i64, material_status: &str, has_schedule: bool, legal_open: i64) -> Option<&'static str> {
    if stages_done >= PRODUCTION_STAGES.len() as i64 {
        return Some(PRODUCTION_PACKED);
    }
    if stages_done > 0 {
        return None;
    }
    if material_status != "READY" {
        return Some("Mark the materials as ready first.");
    }
    if !has_schedule {
        return Some("Set the production schedule first.");
    }
    (legal_open > 0).then_some(LEGAL_PENDING_FOR_PRODUCTION)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackingInput {
    pub carton_count: i64,
    pub produced_units: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageRecord {
    pub notes: String,
    pub packing: Option<PackingInput>,
}

impl StageRecord {
    pub fn to_json(&self) -> Value {
        json!({
            "notes": self.notes,
            "carton_count": self.packing.as_ref().map(|packing| packing.carton_count),
            "produced_units": self.packing.as_ref().map(|packing| packing.produced_units),
        })
    }
}

/// Padanan `validateStageRecord`.
pub fn validate_stage_record(raw: &Value, stages_done: i64) -> Result<StageRecord, &'static str> {
    let notes = text(raw, "notes")
        .filter(|notes| notes.chars().count() <= PRODUCTION_REASON_MAX)
        .ok_or("Notes are up to 500 characters.")?;
    if stages_done != PRODUCTION_STAGES.len() as i64 - 1 {
        return Ok(StageRecord { notes, packing: None });
    }
    let int = |key: &str| raw.get(key).and_then(Value::as_i64);
    let cartons = int("carton_count")
        .filter(|cartons| (1..=CARTON_COUNT_MAX).contains(cartons))
        .ok_or("Enter the number of cartons (1 to 100,000).")?;
    let units = int("produced_units")
        .filter(|units| (1..=MOU_UNITS_MAX).contains(units))
        .ok_or("Enter the number of finished units (1 to 10,000,000).")?;
    Ok(StageRecord { notes, packing: Some(PackingInput { carton_count: cartons, produced_units: units }) })
}

/// Padanan `stageLogNotes`.
pub fn stage_log_notes(stage: &str, record: &StageRecord) -> String {
    let packing = record.packing.as_ref().map_or(String::new(), |packing| {
        format!(": {} cartons, {} units", packing.carton_count, packing.produced_units)
    });
    let done = format!("{} done{packing}", stage_label(stage));
    if record.notes.is_empty() {
        done
    } else {
        format!("{done} - {}", record.notes)
    }
}

/// Padanan `scheduleLockError`.
pub fn schedule_lock_error(stages_done: i64, current: &[&str], next: &[&str]) -> Option<&'static str> {
    if stages_done >= PRODUCTION_STAGES.len() as i64 {
        return Some(PRODUCTION_PACKED);
    }
    (0..stages_done as usize)
        .any(|index| current.get(index) != next.get(index))
        .then_some("The dates of finished stages cannot change.")
}

/// Padanan `ShipState`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ShipState {
    pub stages_done: i64,
    pub settlement_count: i64,
    pub ship_unpaid: i64,
    pub storage_count: i64,
    pub storage_days: i64,
    pub carton_count: i64,
    pub storage_rate_idr: i64,
}

impl ShipState {
    /// Dari satu baris `BATCH_LIST_SQL` (JSON).
    pub fn from_row(row: &Value) -> Self {
        let int = |key: &str| {
            row.get(key)
                .and_then(|value| value.as_i64().or_else(|| value.as_str().and_then(|text| text.parse().ok())))
                .unwrap_or(0)
        };
        Self {
            stages_done: int("stages_done"),
            settlement_count: int("settlement_count"),
            ship_unpaid: int("ship_unpaid"),
            storage_count: int("storage_count"),
            storage_days: int("storage_days"),
            carton_count: int("carton_count"),
            storage_rate_idr: int("storage_rate_idr"),
        }
    }
}

/// Padanan `storageFeeDue`.
pub fn storage_fee_due(state: &ShipState) -> i64 {
    state.storage_days * state.carton_count * state.storage_rate_idr
}

pub const PRODUCTION_NOT_PACKED: &str = "Production is not packed yet.";
pub const SHIP_NO_SETTLEMENT: &str = "Finance has not issued the settlement invoice yet.";
pub const SHIP_UNPAID: &str = "Waiting for the settlement, shipping, and storage invoices to be paid.";
pub const SHIP_STORAGE_UNBILLED: &str = "Finance must issue the storage fee invoice first.";

/// Padanan `shipGateError`.
pub fn ship_gate_error(state: &ShipState) -> Option<&'static str> {
    if state.stages_done < PRODUCTION_STAGES.len() as i64 {
        return Some(PRODUCTION_NOT_PACKED);
    }
    if state.settlement_count < 1 {
        return Some(SHIP_NO_SETTLEMENT);
    }
    if state.ship_unpaid > 0 {
        return Some(SHIP_UNPAID);
    }
    (storage_fee_due(state) > 0 && state.storage_count < 1).then_some(SHIP_STORAGE_UNBILLED)
}

/// Padanan `shipSummary`.
pub fn ship_summary(row: &Value) -> Value {
    let state = ShipState::from_row(row);
    let int = |key: &str| row.get(key).and_then(Value::as_i64).unwrap_or(0);
    json!({
        "ship_block": ship_gate_error(&state),
        "settlement_default_idr": (int("total_production_cost_idr") - int("dp_amount_required_idr")).max(0),
        "storage_fee_idr": storage_fee_due(&state),
        "settlement_cleared": i64::from(state.settlement_count > 0 && int("settlement_unpaid") == 0),
    })
}

/// Pengiriman dan Surat Jalan (v3.4, PRD F-27, D-47).
pub const SHIPMENT_STATUSES: &[&str] = &["PREPARED", "SHIPPED", "FORWARDED", "CANCELLED"];
pub const SHIPMENT_ACTIONS: &[&str] = &["SHIP_UPDATE", "SHIP_CANCEL", "SHIP_DISPATCH", "SHIP_TRACKING", "SHIP_FORWARD"];
pub const SHIPMENT_CREATE_ACTION: &str = "SHIP_PREPARE";
pub const DELIVERY_METHODS: &[&str] = &["CARRIER", "FLEET"];
pub const DEFAULT_DELIVERY_NOTE_PREFIX: &str = "SJ";
pub const TRACKING_NO_MAX: usize = 60;
pub const SHIP_ADDRESS_MAX: usize = 500;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShipmentInput {
    pub method: &'static str,
    pub carrier_option_id: String,
    pub driver_name: String,
    pub driver_phone: String,
    pub vehicle_plate: String,
    pub carton_count: i64,
    pub unit_count: i64,
    pub ship_on: String,
    pub ship_to_address: String,
    pub notes: String,
}

impl ShipmentInput {
    pub fn to_json(&self) -> Value {
        json!({
            "method": self.method,
            "carrier_option_id": self.carrier_option_id,
            "driver_name": self.driver_name,
            "driver_phone": self.driver_phone,
            "vehicle_plate": self.vehicle_plate,
            "carton_count": self.carton_count,
            "unit_count": self.unit_count,
            "ship_on": self.ship_on,
            "ship_to_address": self.ship_to_address,
            "notes": self.notes,
        })
    }
}

/// Padanan `validateShipment`.
pub fn validate_shipment(raw: &Value) -> Result<ShipmentInput, &'static str> {
    let method = raw
        .get("method")
        .and_then(Value::as_str)
        .and_then(|method| DELIVERY_METHODS.iter().copied().find(|known| *known == method))
        .ok_or("Choose how the goods are shipped.")?;
    let carrier = text(raw, "carrier_option_id").unwrap_or_default();
    let driver = text(raw, "driver_name");
    let phone = text(raw, "driver_phone");
    let plate = text(raw, "vehicle_plate");
    if method == "CARRIER" && carrier.is_empty() {
        return Err("Choose the shipping company.");
    }
    let fleet = method == "FLEET";
    if fleet {
        if !driver.as_ref().is_some_and(|name| !name.is_empty() && name.chars().count() <= 100) {
            return Err("Enter the driver's name, up to 100 characters.");
        }
        if !plate.as_ref().is_some_and(|plate| !plate.is_empty() && plate.chars().count() <= 20) {
            return Err("Enter the vehicle plate number, up to 20 characters.");
        }
        if !phone.as_ref().is_some_and(|phone| phone.chars().count() <= 30) {
            return Err("The driver's phone is up to 30 characters.");
        }
    }
    let int = |key: &str| raw.get(key).and_then(Value::as_i64);
    let cartons = int("carton_count")
        .filter(|cartons| (1..=CARTON_COUNT_MAX).contains(cartons))
        .ok_or("Enter the number of cartons (1 to 100,000).")?;
    let units = int("unit_count")
        .filter(|units| (1..=MOU_UNITS_MAX).contains(units))
        .ok_or("Enter the number of units (1 to 10,000,000).")?;
    let ship_on = text(raw, "ship_on")
        .filter(|date| is_calendar_date(date))
        .ok_or("Enter the shipping date.")?;
    let address = text(raw, "ship_to_address")
        .filter(|address| !address.is_empty() && address.chars().count() <= SHIP_ADDRESS_MAX)
        .ok_or("Enter the delivery address, up to 500 characters.")?;
    let notes = text(raw, "notes")
        .filter(|notes| notes.chars().count() <= PRODUCTION_REASON_MAX)
        .ok_or("Notes are up to 500 characters.")?;
    Ok(ShipmentInput {
        method,
        carrier_option_id: if fleet { String::new() } else { carrier },
        driver_name: if fleet { driver.unwrap_or_default() } else { String::new() },
        driver_phone: if fleet { phone.unwrap_or_default() } else { String::new() },
        vehicle_plate: if fleet { plate.unwrap_or_default() } else { String::new() },
        carton_count: cartons,
        unit_count: units,
        ship_on,
        ship_to_address: address,
        notes,
    })
}

/// Padanan `shipmentRequestError`.
pub fn shipment_request_error(ship_block: Option<&'static str>, active_shipments: i64) -> Option<&'static str> {
    ship_block.or((active_shipments > 0).then_some("This work order already has a shipment."))
}

/// Padanan `applyShipmentAction`.
pub fn apply_shipment_action(status: &str, method: &str, tracking_no: &str, action: &str) -> Result<&'static str, &'static str> {
    let wrong = Err("This step is not available for the shipment's current status.");
    match action {
        "SHIP_UPDATE" if status == "PREPARED" => Ok("PREPARED"),
        "SHIP_CANCEL" if status == "PREPARED" => Ok("CANCELLED"),
        "SHIP_DISPATCH" if status == "PREPARED" => Ok("SHIPPED"),
        "SHIP_TRACKING" if status == "SHIPPED" || status == "FORWARDED" => {
            if tracking_no.is_empty() {
                Ok(if status == "SHIPPED" { "SHIPPED" } else { "FORWARDED" })
            } else {
                Err("The tracking number is already recorded.")
            }
        }
        "SHIP_FORWARD" if status == "SHIPPED" => {
            if method == "CARRIER" && tracking_no.is_empty() {
                Err("Record the tracking number before forwarding it.")
            } else {
                Ok("FORWARDED")
            }
        }
        "SHIP_UPDATE" | "SHIP_CANCEL" | "SHIP_DISPATCH" | "SHIP_TRACKING" | "SHIP_FORWARD" => wrong,
        _ => Err("This shipment step does not exist."),
    }
}

/// Padanan `shipmentActionPermission`.
pub fn shipment_action_permission(action: &str) -> &'static str {
    if action == "SHIP_FORWARD" {
        "samples.manage"
    } else {
        "shipping.manage"
    }
}

/// Padanan `normalizeTracking`.
pub fn normalize_tracking(value: Option<&Value>, required: bool) -> Option<String> {
    let tracking = match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(_) => return None,
    };
    if tracking.chars().count() > TRACKING_NO_MAX || (required && tracking.is_empty()) {
        return None;
    }
    Some(tracking)
}

pub const TRACKING_INVALID: &str = "Enter the tracking number, up to 60 characters.";
pub const SHIPMENT_CANCEL_REASON_INVALID: &str = "Write why the shipment is cancelled, up to 500 characters.";

/// Padanan `ShipmentLogInput`.
pub struct ShipmentLogInput<'a> {
    pub delivery_note_no: &'a str,
    pub method: &'a str,
    pub carrier_label: &'a str,
    pub tracking_no: &'a str,
    pub driver_name: &'a str,
    pub vehicle_plate: &'a str,
    pub reason: &'a str,
}

/// Padanan `shipmentLogNotes`.
pub fn shipment_log_notes(action: &str, input: &ShipmentLogInput<'_>) -> String {
    match action {
        "SHIP_PREPARE" => format!("Delivery note {}", input.delivery_note_no),
        "SHIP_UPDATE" => format!("Delivery note {} corrected", input.delivery_note_no),
        "SHIP_CANCEL" => format!("Delivery note {} cancelled: {}", input.delivery_note_no, input.reason),
        "SHIP_DISPATCH" if input.method == "FLEET" => {
            format!("Shipped by {} ({})", input.driver_name, input.vehicle_plate)
        }
        "SHIP_DISPATCH" => {
            let tracking = if input.tracking_no.is_empty() {
                String::new()
            } else {
                format!(", tracking {}", input.tracking_no)
            };
            format!("Shipped by {}{tracking}", input.carrier_label)
        }
        "SHIP_TRACKING" => format!("Tracking number {}", input.tracking_no),
        _ => "Tracking number and delivery note sent to the client".to_owned(),
    }
}

pub const SHIPMENT_CHANGED_ELSEWHERE: &str =
    "This shipment was changed on another device first. Open it again to see the latest version.";

pub const BATCH_CHANGED_ELSEWHERE: &str =
    "This work order was changed on another device first. Open it again to see the latest version.";

pub const BATCH_LIST_SQL: &str = "SELECT b.*, CASE WHEN b.stages_done < 4 OR b.packed_at = '' THEN 0 ELSE MAX(0, CAST(julianday(CASE WHEN b.settlement_count > 0 AND b.settlement_unpaid = 0 AND b.settlement_paid_on <> '' THEN b.settlement_paid_on ELSE date('now', b.tz_shift) END) - julianday(date(b.packed_at, b.tz_shift)) AS INTEGER) - b.storage_grace_days) END AS storage_days FROM (SELECT b.*, m.mou_number, m.total_units, m.regulatory_path, m.production_lead_time_days, s.brand_name, c.client_code, c.name AS client_name, (SELECT COUNT(*) FROM batch_purchase_orders p WHERE p.batch_id = b.id AND p.status = 'OPEN') AS open_orders, (SELECT MIN(p.eta_on) FROM batch_purchase_orders p WHERE p.batch_id = b.id AND p.status = 'OPEN') AS next_eta_on, CASE m.regulatory_path WHEN 'WITH_BPOM' THEN 4 ELSE 1 END - (SELECT COUNT(DISTINCT l.kind) FROM legal_documents l WHERE l.mou_id = b.mou_id AND l.status IN ('ISSUED', 'NOT_REQUIRED') AND (m.regulatory_path = 'WITH_BPOM' OR l.kind = 'HALAL')) AS legal_open, s.ship_to_address, m.total_production_cost_idr, m.dp_amount_required_idr, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.ref_type = 'SETTLEMENT' AND i.status <> 'CANCELLED') AS settlement_count, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.ref_type = 'STORAGE_FEE' AND i.status <> 'CANCELLED') AS storage_count, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.status = 'OPEN' AND COALESCE((SELECT p.ref_type FROM invoices p WHERE p.id = i.parent_invoice_id), i.ref_type) = 'SETTLEMENT' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr) AS settlement_unpaid, (SELECT COUNT(*) FROM invoices i WHERE i.sample_request_id = b.sample_request_id AND i.status = 'OPEN' AND COALESCE((SELECT p.ref_type FROM invoices p WHERE p.id = i.parent_invoice_id), i.ref_type) IN ('SETTLEMENT', 'SHIPPING', 'STORAGE_FEE') AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr) AS ship_unpaid, COALESCE((SELECT MAX(f.received_on) FROM invoices i JOIN fund_allocations a ON a.invoice_id = i.id JOIN incoming_funds f ON f.id = a.fund_id WHERE i.sample_request_id = b.sample_request_id AND COALESCE((SELECT p.ref_type FROM invoices p WHERE p.id = i.parent_invoice_id), i.ref_type) = 'SETTLEMENT'), '') AS settlement_paid_on, COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'storage_grace_days'), 14) AS storage_grace_days, COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'storage_fee_idr'), 0) AS storage_rate_idr, CASE COALESCE((SELECT z.timezone FROM company_profile z WHERE z.id = 'default_company'), '') WHEN 'Asia/Makassar' THEN '+8 hours' WHEN 'Asia/Jayapura' THEN '+9 hours' ELSE '+7 hours' END AS tz_shift FROM production_batches b JOIN production_mou m ON m.id = b.mou_id JOIN sample_requests s ON s.id = b.sample_request_id LEFT JOIN clients c ON c.id = b.client_id) b";
pub const PO_LIST_SQL: &str = "SELECT p.*, COALESCE(o.label, '') AS supplier_label FROM batch_purchase_orders p LEFT JOIN master_option o ON o.id = p.supplier_option_id";
pub const SUPPLIER_LIST_SQL: &str = "SELECT id, code, label, is_active FROM master_option WHERE kind = 'SUPPLIER' ORDER BY sort_order, label;";
pub const CARRIER_LIST_SQL: &str = "SELECT id, code, label, is_active FROM master_option WHERE kind = 'CARRIER' ORDER BY sort_order, label;";
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

pub const BATCH_STAGE_SQL: &str = "UPDATE production_batches SET stages_done = ?2, packed_at = CASE WHEN ?2 = 4 THEN ?3 ELSE packed_at END, carton_count = CASE WHEN ?2 = 4 THEN ?4 ELSE carton_count END, produced_units = CASE WHEN ?2 = 4 THEN ?5 ELSE produced_units END, updated_at = ?3 WHERE id = ?1 AND stages_done = ?2 - 1;";
pub const STAGE_LOG_SQL: &str = "SELECT l.sample_request_id, l.action, l.notes, l.recorded_at, o.nama_operator AS recorded_by_name FROM sample_status_log l LEFT JOIN master_operator o ON o.id = l.recorded_by WHERE l.action LIKE 'STAGE_%' AND l.sample_request_id IN (SELECT sample_request_id FROM production_batches) ORDER BY l.recorded_at, l.rowid;";

pub const SHIPMENT_LIST_SQL: &str = "SELECT h.*, COALESCE(o.label, '') AS carrier_label, b.batch_code, m.mou_number, s.brand_name, c.client_code, c.name AS client_name FROM shipments h JOIN production_batches b ON b.id = h.batch_id JOIN production_mou m ON m.id = b.mou_id JOIN sample_requests s ON s.id = h.sample_request_id LEFT JOIN clients c ON c.id = h.client_id LEFT JOIN master_option o ON o.id = h.carrier_option_id";
pub const SHIPMENT_ACTIVE_SQL: &str = "SELECT COUNT(*) AS total FROM shipments WHERE batch_id = ?1 AND status <> 'CANCELLED' AND id <> ?2;";
pub const SHIPMENT_INSERT_SQL: &str = "INSERT INTO shipments (id, batch_id, sample_request_id, client_id, delivery_note_no, method, carrier_option_id, tracking_no, driver_name, driver_phone, vehicle_plate, carton_count, unit_count, ship_on, ship_to_address, notes, status, cancel_reason, shipped_at, forwarded_at, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'PREPARED', '', '', '', ?16, ?17, ?17) ON CONFLICT(id) DO NOTHING;";
pub const SHIPMENT_UPDATE_SQL: &str = "UPDATE shipments SET method = ?2, carrier_option_id = ?3, driver_name = ?4, driver_phone = ?5, vehicle_plate = ?6, carton_count = ?7, unit_count = ?8, ship_on = ?9, ship_to_address = ?10, notes = ?11, updated_at = ?12 WHERE id = ?1 AND status = 'PREPARED' AND updated_at = ?13;";
pub const SHIPMENT_STEP_SQL: &str = "UPDATE shipments SET status = ?2, tracking_no = CASE WHEN ?3 <> '' THEN ?3 ELSE tracking_no END, cancel_reason = CASE WHEN ?2 = 'CANCELLED' THEN ?4 ELSE cancel_reason END, shipped_at = CASE WHEN ?2 = 'SHIPPED' AND shipped_at = '' THEN ?5 ELSE shipped_at END, forwarded_at = CASE WHEN ?2 = 'FORWARDED' AND forwarded_at = '' THEN ?5 ELSE forwarded_at END, updated_at = ?5 WHERE id = ?1 AND status = ?6 AND updated_at = ?7;";

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar dengan `src/lib/validations/production.test.ts`.

    #[test]
    fn pengiriman_mengikuti_aturan() {
        // Vektor kembar dengan "pengiriman" di `production.test.ts`.
        let carrier = json!({
            "method": "CARRIER",
            "carrier_option_id": "jne",
            "driver_name": "ignored",
            "carton_count": 40,
            "unit_count": 990,
            "ship_on": "2026-11-20",
            "ship_to_address": " Jl. Merdeka 1, Bandung ",
            "notes": "",
        });
        assert_eq!(
            validate_shipment(&carrier),
            Ok(ShipmentInput {
                method: "CARRIER",
                carrier_option_id: "jne".into(),
                driver_name: String::new(),
                driver_phone: String::new(),
                vehicle_plate: String::new(),
                carton_count: 40,
                unit_count: 990,
                ship_on: "2026-11-20".into(),
                ship_to_address: "Jl. Merdeka 1, Bandung".into(),
                notes: String::new(),
            })
        );
        let with = |key: &str, value: Value| {
            let mut draft = carrier.clone();
            draft[key] = value;
            validate_shipment(&draft).unwrap_err()
        };
        assert_eq!(with("method", json!("PLANE")), "Choose how the goods are shipped.");
        assert_eq!(with("carrier_option_id", json!("")), "Choose the shipping company.");
        assert_eq!(with("carton_count", json!(0)), "Enter the number of cartons (1 to 100,000).");
        assert_eq!(with("unit_count", json!("990")), "Enter the number of units (1 to 10,000,000).");
        assert_eq!(with("ship_on", json!("2026-13-01")), "Enter the shipping date.");
        assert_eq!(with("ship_to_address", json!("")), "Enter the delivery address, up to 500 characters.");
        let mut fleet = carrier.clone();
        fleet["method"] = json!("FLEET");
        fleet["driver_name"] = json!("");
        assert_eq!(validate_shipment(&fleet).unwrap_err(), "Enter the driver's name, up to 100 characters.");
        fleet["driver_name"] = json!("Budi");
        assert_eq!(validate_shipment(&fleet).unwrap_err(), "Enter the vehicle plate number, up to 20 characters.");
        fleet["vehicle_plate"] = json!("D 1234 AB");
        let fleet = validate_shipment(&fleet).unwrap();
        assert_eq!(
            (fleet.carrier_option_id.as_str(), fleet.driver_name.as_str(), fleet.vehicle_plate.as_str()),
            ("", "Budi", "D 1234 AB")
        );

        assert_eq!(shipment_request_error(None, 0), None);
        assert_eq!(shipment_request_error(Some(SHIP_UNPAID), 0), Some(SHIP_UNPAID));
        assert_eq!(shipment_request_error(None, 1), Some("This work order already has a shipment."));
        let step = |status: &str, method: &str, tracking: &str, action: &str| {
            apply_shipment_action(status, method, tracking, action).unwrap_or_else(|message| message)
        };
        let wrong = "This step is not available for the shipment's current status.";
        assert_eq!(step("PREPARED", "CARRIER", "", "SHIP_UPDATE"), "PREPARED");
        assert_eq!(step("PREPARED", "CARRIER", "", "SHIP_CANCEL"), "CANCELLED");
        assert_eq!(step("PREPARED", "CARRIER", "", "SHIP_DISPATCH"), "SHIPPED");
        assert_eq!(step("SHIPPED", "CARRIER", "", "SHIP_CANCEL"), wrong);
        assert_eq!(step("SHIPPED", "CARRIER", "", "SHIP_TRACKING"), "SHIPPED");
        assert_eq!(step("SHIPPED", "CARRIER", "JNE123", "SHIP_TRACKING"), "The tracking number is already recorded.");
        assert_eq!(step("PREPARED", "CARRIER", "", "SHIP_TRACKING"), wrong);
        assert_eq!(step("SHIPPED", "CARRIER", "", "SHIP_FORWARD"), "Record the tracking number before forwarding it.");
        assert_eq!(step("SHIPPED", "CARRIER", "JNE123", "SHIP_FORWARD"), "FORWARDED");
        assert_eq!(step("SHIPPED", "FLEET", "", "SHIP_FORWARD"), "FORWARDED");
        assert_eq!(step("FORWARDED", "FLEET", "", "SHIP_TRACKING"), "FORWARDED");
        assert_eq!(step("PREPARED", "FLEET", "", "SHIP_FLY"), "This shipment step does not exist.");
        assert_eq!(shipment_action_permission("SHIP_FORWARD"), "samples.manage");
        assert_eq!(shipment_action_permission("SHIP_DISPATCH"), "shipping.manage");
        assert_eq!(normalize_tracking(Some(&json!(" JNE123 ")), true), Some("JNE123".into()));
        assert_eq!(normalize_tracking(None, false), Some(String::new()));
        assert_eq!(normalize_tracking(None, true), None);
        assert_eq!(normalize_tracking(Some(&json!("x".repeat(61))), false), None);
        let log = ShipmentLogInput {
            delivery_note_no: "SJ-20261120-A101",
            method: "CARRIER",
            carrier_label: "JNE",
            tracking_no: "JNE123",
            driver_name: "",
            vehicle_plate: "",
            reason: "Wrong address",
        };
        assert_eq!(shipment_log_notes("SHIP_PREPARE", &log), "Delivery note SJ-20261120-A101");
        assert_eq!(shipment_log_notes("SHIP_CANCEL", &log), "Delivery note SJ-20261120-A101 cancelled: Wrong address");
        assert_eq!(shipment_log_notes("SHIP_DISPATCH", &log), "Shipped by JNE, tracking JNE123");
        let fleet_log = ShipmentLogInput { method: "FLEET", driver_name: "Budi", vehicle_plate: "D 1234 AB", ..log };
        assert_eq!(shipment_log_notes("SHIP_DISPATCH", &fleet_log), "Shipped by Budi (D 1234 AB)");
        assert_eq!(shipment_log_notes("SHIP_FORWARD", &fleet_log), "Tracking number and delivery note sent to the client");
    }

    #[test]
    fn siap_kirim_dan_biaya_titip() {
        // Vektor kembar dengan "siap kirim" di `production.test.ts`.
        let packed = ShipState {
            stages_done: 4,
            settlement_count: 1,
            ship_unpaid: 0,
            storage_count: 0,
            storage_days: 0,
            carton_count: 40,
            storage_rate_idr: 500,
        };
        assert_eq!(ship_gate_error(&packed), None);
        assert_eq!(ship_gate_error(&ShipState { stages_done: 3, ..packed }), Some(PRODUCTION_NOT_PACKED));
        assert_eq!(
            ship_gate_error(&ShipState { settlement_count: 0, ..packed }),
            Some("Finance has not issued the settlement invoice yet.")
        );
        assert_eq!(
            ship_gate_error(&ShipState { ship_unpaid: 2, ..packed }),
            Some("Waiting for the settlement, shipping, and storage invoices to be paid.")
        );
        let late = ShipState { storage_days: 3, ..packed };
        assert_eq!(storage_fee_due(&late), 60_000);
        assert_eq!(ship_gate_error(&late), Some("Finance must issue the storage fee invoice first."));
        assert_eq!(ship_gate_error(&ShipState { storage_count: 1, ..late }), None);
        assert_eq!(ship_gate_error(&ShipState { storage_rate_idr: 0, ..late }), None);
        assert_eq!(
            ship_summary(&json!({
                "stages_done": 4,
                "settlement_count": 1,
                "settlement_unpaid": 0,
                "storage_days": 3,
                "carton_count": 40,
                "storage_rate_idr": 500,
                "total_production_cost_idr": 325_000,
                "dp_amount_required_idr": 162_500,
            })),
            json!({
                "ship_block": "Finance must issue the storage fee invoice first.",
                "settlement_default_idr": 162_500,
                "storage_fee_idr": 60_000,
                "settlement_cleared": 1,
            })
        );
        assert_eq!(
            ShipState::from_row(&json!({ "stages_done": 4, "settlement_count": "1", "carton_count": 40 })),
            ShipState { stages_done: 4, settlement_count: 1, carton_count: 40, ..ShipState::default() }
        );
    }

    #[test]
    fn tahap_produksi_berurutan_dan_terkunci() {
        // Vektor kembar dengan "tahap produksi" di `production.test.ts`.
        assert_eq!(stage_gate_error(0, "READY", true, 0), None);
        assert_eq!(stage_gate_error(0, "WAITING_PO", true, 0), Some("Mark the materials as ready first."));
        assert_eq!(stage_gate_error(0, "READY", false, 0), Some("Set the production schedule first."));
        assert_eq!(stage_gate_error(0, "READY", true, 2), Some(LEGAL_PENDING_FOR_PRODUCTION));
        assert_eq!(stage_gate_error(2, "READY", true, 2), None);
        assert_eq!(stage_gate_error(4, "READY", true, 0), Some(PRODUCTION_PACKED));

        let mixing = validate_stage_record(&json!({ "notes": " Crew A " }), 1).unwrap();
        assert_eq!(mixing, StageRecord { notes: "Crew A".into(), packing: None });
        assert_eq!(stage_log_notes("MIXING", &mixing), "Mixing done - Crew A");
        let packing = validate_stage_record(&json!({ "carton_count": 120, "produced_units": 9_950 }), 3).unwrap();
        assert_eq!(
            packing,
            StageRecord {
                notes: String::new(),
                packing: Some(PackingInput { carton_count: 120, produced_units: 9_950 }),
            }
        );
        assert_eq!(stage_log_notes("PACKING", &packing), "Packing done: 120 cartons, 9950 units");
        let wrong = |raw: Value| validate_stage_record(&raw, 3).unwrap_err();
        assert_eq!(wrong(json!({ "produced_units": 10 })), "Enter the number of cartons (1 to 100,000).");
        assert_eq!(
            wrong(json!({ "carton_count": "12", "produced_units": 10 })),
            "Enter the number of cartons (1 to 100,000)."
        );
        assert_eq!(
            wrong(json!({ "carton_count": 12, "produced_units": 0 })),
            "Enter the number of finished units (1 to 10,000,000)."
        );
        assert_eq!(
            validate_stage_record(&json!({ "notes": "x".repeat(501) }), 0).unwrap_err(),
            "Notes are up to 500 characters."
        );

        let current = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
        let moved = ["2026-11-02", "2026-11-03", "2026-11-06", "2026-11-07"];
        assert_eq!(schedule_lock_error(2, &current, &moved), None);
        assert_eq!(schedule_lock_error(3, &current, &moved), Some("The dates of finished stages cannot change."));
        assert_eq!(schedule_lock_error(4, &current, &current), Some(PRODUCTION_PACKED));
    }

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
