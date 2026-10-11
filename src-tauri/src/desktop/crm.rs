//! Serah terima CS -> CRM dan antrean CRM (v3.6a, PRD F-29, D-49).
//! Padanan `src/lib/validations/crm.ts`; vektor kembar, SQL dites per karakter.

use serde_json::Value;

pub const CRM_FORWARD_NOTES_MAX: usize = 500;
pub const CRM_FORWARD_INVALID: &str = "Write what the client asked for, up to 500 characters.";
pub const CRM_OPERATOR_INVALID: &str = "Choose an active CRM operator.";
pub const CRM_NOT_HANDED_OVER: &str = "This client is not handed over to CRM yet.";

/// Padanan `crmOwnerError`.
pub fn crm_owner_error(lifecycle: &str, can_crm: bool, crm_name: &str) -> Option<String> {
    if lifecycle != "EXISTING_CLIENT" || can_crm {
        return None;
    }
    let name = crm_name.trim();
    Some(format!(
        "This client is managed by CRM (PIC: {}).",
        if name.is_empty() { "not assigned yet" } else { name }
    ))
}

/// Padanan `validateCrmForward`.
pub fn validate_crm_forward(raw: &Value) -> Result<String, &'static str> {
    let notes = raw.get("notes").and_then(Value::as_str).unwrap_or_default().trim();
    if notes.is_empty() || notes.chars().count() > CRM_FORWARD_NOTES_MAX {
        return Err(CRM_FORWARD_INVALID);
    }
    Ok(notes.to_owned())
}

/// Serah terima (keputusan B/C): ?1 klien, ?2 waktu. Aman diulang; `EXISTING_CLIENT` tidak pernah kembali.
pub const CLIENT_HANDOVER_SQL: &str = "UPDATE clients SET lifecycle_status = 'EXISTING_CLIENT', assigned_crm_id = COALESCE(assigned_crm_id, (SELECT s.pic_crm_id FROM shipments h JOIN sample_requests s ON s.id = h.sample_request_id WHERE h.client_id = ?1 AND (h.status = 'RECEIVED' OR (h.status = 'COMPLAINED' AND EXISTS (SELECT 1 FROM qc_claims q WHERE q.shipment_id = h.id AND q.status = 'DECIDED'))) ORDER BY h.updated_at DESC, h.id DESC LIMIT 1)), updated_at = ?2 WHERE id = ?1 AND lifecycle_status <> 'EXISTING_CLIENT' AND EXISTS (SELECT 1 FROM shipments h WHERE h.client_id = ?1 AND (h.status = 'RECEIVED' OR (h.status = 'COMPLAINED' AND EXISTS (SELECT 1 FROM qc_claims q WHERE q.shipment_id = h.id AND q.status = 'DECIDED'))));";
/// Pemilik klien untuk gerbang CS; ?1 = id klien ATAU id lead.
pub const CRM_OWNER_SQL: &str = "SELECT c.id, c.client_code, c.lifecycle_status, COALESCE(o.nama_operator, '') AS crm_name FROM clients c LEFT JOIN master_operator o ON o.id = c.assigned_crm_id WHERE c.id = ?1 OR c.id = (SELECT l.client_id FROM leads l WHERE l.id = ?1) LIMIT 1;";
/// Kartu CRM (keputusan G): order terakhir selesai, perkiraan repeat, formula, kemasan, kontak terakhir, tiket berjalan.
pub const CRM_CLIENT_LIST_SQL: &str = "SELECT z.*, CASE WHEN z.last_completed_at = '' THEN '' ELSE date(z.last_completed_at, z.tz_shift, '+' || z.reorder_days || ' days') END AS reorder_on, date('now', z.tz_shift) AS today, (SELECT COUNT(*) FROM sample_requests r WHERE r.client_id = z.id AND r.id <> z.last_sample_id AND r.created_at >= z.last_completed_at AND r.status NOT IN ('RND_REJECTED', 'CLIENT_REJECT', 'CANCELLED')) AS open_tickets FROM (SELECT c.id, c.client_code, c.name AS client_name, c.city, c.assigned_crm_id, COALESCE(o.nama_operator, '') AS crm_name, MAX(COALESCE(CASE h.status WHEN 'RECEIVED' THEN h.received_at ELSE (SELECT MAX(q.decided_at) FROM qc_claims q WHERE q.shipment_id = h.id AND q.status = 'DECIDED') END, ''), COALESCE((SELECT MAX(i.record_date) FROM imported_records i WHERE i.client_id = c.id AND i.kind = 'SHIPMENT'), '')) AS last_completed_at, COALESCE(s.id, '') AS last_sample_id, COALESCE(s.brand_name, (SELECT i.title FROM imported_records i WHERE i.client_id = c.id AND i.kind = 'SHIPMENT' ORDER BY i.record_date DESC, i.created_at DESC LIMIT 1), '') AS brand_name, COALESCE(s.packaging, '') AS packaging, COALESCE(h.unit_count, (SELECT i.quantity FROM imported_records i WHERE i.client_id = c.id AND i.kind = 'SHIPMENT' ORDER BY i.record_date DESC, i.created_at DESC LIMIT 1), 0) AS last_units, COALESCE((SELECT f.formula_code FROM sample_formulas f WHERE f.sample_request_id = s.id ORDER BY f.iteration_number DESC, f.recorded_at DESC LIMIT 1), '') AS last_formula_code, COALESCE((SELECT MAX(MAX(l.last_followup_at, l.last_client_response_at)) FROM leads l WHERE l.client_id = c.id), '') AS last_contact_at, COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'crm_reorder_days'), 60) AS reorder_days, CASE COALESCE((SELECT t.timezone FROM company_profile t WHERE t.id = 'default_company'), '') WHEN 'Asia/Makassar' THEN '+8 hours' WHEN 'Asia/Jayapura' THEN '+9 hours' ELSE '+7 hours' END AS tz_shift FROM clients c LEFT JOIN shipments h ON h.id = (SELECT x.id FROM shipments x WHERE x.client_id = c.id AND (x.status = 'RECEIVED' OR (x.status = 'COMPLAINED' AND EXISTS (SELECT 1 FROM qc_claims q WHERE q.shipment_id = x.id AND q.status = 'DECIDED'))) ORDER BY x.updated_at DESC, x.id DESC LIMIT 1) LEFT JOIN sample_requests s ON s.id = h.sample_request_id LEFT JOIN master_operator o ON o.id = c.assigned_crm_id WHERE c.lifecycle_status = 'EXISTING_CLIENT') z";
/// ?1 klien, ?2 operator CRM, ?3 waktu.
pub const CRM_ASSIGN_SQL: &str = "UPDATE clients SET assigned_crm_id = ?2, updated_at = ?3 WHERE id = ?1 AND lifecycle_status = 'EXISTING_CLIENT';";

pub const REPEAT_ORDER_ACTION: &str = "REPEAT_ORDER";
pub const REPEAT_ORDER_NOTES: &str = "Repeat order from the completed order";

/// Padanan `repeatOrderError`.
pub fn repeat_order_error(status: &str, completed: bool) -> Option<&'static str> {
    if status != "CLIENT_ACC" {
        return Some("Only an approved sample can start a repeat order.");
    }
    (!completed).then_some("The order of this sample is not completed yet.")
}

/// Tiket asal repeat order: status dan apakah ordernya selesai. ?1 = id tiket.
pub const REPEAT_SOURCE_SQL: &str = "SELECT s.id, s.status, s.brand_name, s.client_id, COALESCE(c.client_code, '') AS client_code, EXISTS (SELECT 1 FROM shipments h WHERE h.sample_request_id = s.id AND (h.status = 'RECEIVED' OR (h.status = 'COMPLAINED' AND EXISTS (SELECT 1 FROM qc_claims q WHERE q.shipment_id = h.id AND q.status = 'DECIDED')))) AS completed FROM sample_requests s LEFT JOIN clients c ON c.id = s.client_id WHERE s.id = ?1;";
/// Tiket repeat langsung `CLIENT_ACC` (D-50). ?1 baru, ?2 asal, ?3 pembuat, ?4 waktu. PIC CRM = PIC CRM klien.
pub const SAMPLE_REPEAT_INSERT_SQL: &str = "INSERT INTO sample_requests (id, client_id, lead_id, sample_kind_option_id, formulation_type_option_id, registration_category_option_id, rnd_product_class, product_category_option_id, pic_crm_id, sample_qty, brand_name, bpom_product_name, claims, packaging, reference_notes, client_budget_idr, special_requests_json, deadline_at, ship_to_address, is_dummy_required, is_paid_sample, revision_index, is_billable, status, rnd_lead_time_days, sent_at, status_changed_at, created_by, created_at, updated_at, rnd_reject_reason_option_id, revision_fee_idr, is_test_requested, repeat_of_id) SELECT ?1, s.client_id, s.lead_id, s.sample_kind_option_id, s.formulation_type_option_id, s.registration_category_option_id, s.rnd_product_class, s.product_category_option_id, COALESCE((SELECT c.assigned_crm_id FROM clients c WHERE c.id = s.client_id), s.pic_crm_id), s.sample_qty, s.brand_name, s.bpom_product_name, s.claims, s.packaging, s.reference_notes, s.client_budget_idr, s.special_requests_json, s.deadline_at, s.ship_to_address, 0, s.is_paid_sample, s.revision_index, 0, 'CLIENT_ACC', s.rnd_lead_time_days, s.sent_at, ?4, ?3, ?4, ?4, '', s.revision_fee_idr, 0, s.id FROM sample_requests s WHERE s.id = ?2 AND s.status = 'CLIENT_ACC' ON CONFLICT(id) DO NOTHING;";
/// Formula terakhir tiket asal, id deterministik. ?1 baru, ?2 asal, ?3 waktu.
pub const FORMULA_REPEAT_COPY_SQL: &str = "INSERT INTO sample_formulas (id, sample_request_id, iteration_number, formula_code, product_knowledge, rnd_notes, recorded_by, recorded_at) SELECT ?1 || ':formula', ?1, f.iteration_number, f.formula_code, f.product_knowledge, f.rnd_notes, f.recorded_by, ?3 FROM sample_formulas f WHERE f.sample_request_id = ?2 ORDER BY f.iteration_number DESC, f.recorded_at DESC LIMIT 1 ON CONFLICT(id) DO NOTHING;";
/// Harga terakhir tiket asal (harga bawaan MoU), id deterministik. ?1 baru, ?2 asal, ?3 waktu.
pub const PRICE_REPEAT_COPY_SQL: &str = "INSERT INTO pricing_formulas (id, sample_request_id, iteration_number, raw_material_cost_idr, packaging_cost_idr, operational_cost_idr, regulatory_cost_idr, hpp_unit_idr, margin_bp, final_unit_price_idr, notes, recorded_by, recorded_at) SELECT ?1 || ':price', ?1, p.iteration_number, p.raw_material_cost_idr, p.packaging_cost_idr, p.operational_cost_idr, p.regulatory_cost_idr, p.hpp_unit_idr, p.margin_bp, p.final_unit_price_idr, p.notes, p.recorded_by, ?3 FROM pricing_formulas p JOIN sample_requests s ON s.id = p.sample_request_id WHERE p.sample_request_id = ?2 AND p.iteration_number = s.revision_index + 1 ORDER BY p.recorded_at DESC, p.rowid DESC LIMIT 1 ON CONFLICT(id) DO NOTHING;";
/// Dokumen legal final MoU tiket asal, disalin saat MoU tiket repeat dibuat. ?1 MoU baru, ?2 tiket repeat, ?3 waktu. Tiket biasa: tidak menyalin apa pun.
pub const LEGAL_REPEAT_COPY_SQL: &str = "INSERT INTO legal_documents (id, mou_id, sample_request_id, kind, status, reference_no, certificate_no, bpom_type, submitted_on, issued_on, expires_on, notes, updated_by, created_at, updated_at) SELECT ?1 || ':' || l.kind, ?1, ?2, l.kind, l.status, l.reference_no, l.certificate_no, l.bpom_type, l.submitted_on, l.issued_on, l.expires_on, l.notes, l.updated_by, ?3, ?3 FROM legal_documents l WHERE l.mou_id = (SELECT m.id FROM production_mou m JOIN sample_requests s ON s.repeat_of_id = m.sample_request_id WHERE s.id = ?2 AND m.status = 'ACCEPTED' ORDER BY m.status_changed_at DESC, m.id DESC LIMIT 1) AND l.status IN ('ISSUED', 'NOT_REQUIRED') ON CONFLICT(id) DO NOTHING;";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Vektor kembar dengan `src/lib/validations/crm.test.ts`.

    #[test]
    fn gerbang_cs_dan_forward() {
        assert_eq!(crm_owner_error("FIRST_ORDER_ACTIVE", false, ""), None);
        assert_eq!(crm_owner_error("EXISTING_CLIENT", true, "Rendi"), None);
        assert_eq!(
            crm_owner_error("EXISTING_CLIENT", false, " Rendi "),
            Some("This client is managed by CRM (PIC: Rendi).".into())
        );
        assert_eq!(
            crm_owner_error("EXISTING_CLIENT", false, ""),
            Some("This client is managed by CRM (PIC: not assigned yet).".into())
        );
        assert_eq!(validate_crm_forward(&json!({ "notes": " Wants 5000 pcs " })), Ok("Wants 5000 pcs".into()));
        assert_eq!(validate_crm_forward(&json!({ "notes": "" })), Err(CRM_FORWARD_INVALID));
        assert_eq!(validate_crm_forward(&json!({ "notes": "x".repeat(501) })), Err(CRM_FORWARD_INVALID));
    }

    #[test]
    fn syarat_repeat_order() {
        assert_eq!(repeat_order_error("CLIENT_ACC", true), None);
        assert_eq!(repeat_order_error("CLIENT_ACC", false), Some("The order of this sample is not completed yet."));
        assert_eq!(repeat_order_error("SAMPLE_SENT", true), Some("Only an approved sample can start a repeat order."));
    }
}
