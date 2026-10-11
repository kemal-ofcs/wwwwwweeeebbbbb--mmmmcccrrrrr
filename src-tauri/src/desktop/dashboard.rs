//! Dashboard eksekutif (PRD F-40a, D-52). Padanan
//! `src/lib/validations/dashboard.ts`; vektor kembar, SQL dites per karakter.

use super::samples::is_calendar_date;

/// Padanan `DASHBOARD_SECTION_PERMISSION`, urutan `DASHBOARD_SECTIONS`.
pub const DASHBOARD_SECTIONS: &[(&str, &str)] = &[
    ("sales", "clients.view"),
    ("samples", "samples.view"),
    ("finance", "invoices.view"),
    ("production", "production.view"),
    ("crm", "clients.view"),
];
pub const DASHBOARD_MAX_DAYS: i64 = 731;
pub const DASHBOARD_RANGE_INVALID: &str = "Choose a valid period of up to two years.";

fn day_number(date: &str) -> i64 {
    // Algoritma hari sipil (Howard Hinnant); `date` sudah tervalidasi.
    let year: i64 = date[0..4].parse().unwrap_or(0);
    let month: i64 = date[5..7].parse().unwrap_or(0);
    let day: i64 = date[8..10].parse().unwrap_or(0);
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Padanan `validateDashboardRange`.
pub fn validate_dashboard_range(from: &str, to: &str) -> Result<(String, String), &'static str> {
    if !is_calendar_date(from) || !is_calendar_date(to) || from > to || day_number(to) - day_number(from) >= DASHBOARD_MAX_DAYS {
        return Err(DASHBOARD_RANGE_INVALID);
    }
    Ok((from.to_owned(), to.to_owned()))
}

/// SQL per bagian, urutan `DASHBOARD_SECTIONS`.
pub fn dashboard_section_sql(section: &str) -> Option<&'static str> {
    match section {
        "sales" => Some(DASHBOARD_SALES_SQL),
        "samples" => Some(DASHBOARD_SAMPLES_SQL),
        "finance" => Some(DASHBOARD_FINANCE_SQL),
        "production" => Some(DASHBOARD_PRODUCTION_SQL),
        "crm" => Some(DASHBOARD_CRM_SQL),
        _ => None,
    }
}

/// Penjualan: lead baru, lead terbuka per segmen, tanpa PIC, rata-rata hari lead ke tiket pertama.
pub const DASHBOARD_SALES_SQL: &str = "WITH p AS (SELECT ?1 AS d1, ?2 AS d2, CASE COALESCE((SELECT t.timezone FROM company_profile t WHERE t.id = 'default_company'), '') WHEN 'Asia/Makassar' THEN '+8 hours' WHEN 'Asia/Jayapura' THEN '+9 hours' ELSE '+7 hours' END AS tz) SELECT (SELECT COUNT(*) FROM leads l WHERE date(l.created_at, p.tz) BETWEEN p.d1 AND p.d2) AS leads_new, (SELECT COUNT(*) FROM leads l JOIN clients c ON c.id = l.client_id WHERE c.lifecycle_status = 'LEAD') AS leads_open, (SELECT COUNT(*) FROM leads l JOIN clients c ON c.id = l.client_id WHERE c.lifecycle_status = 'LEAD' AND l.pic_cs_id IS NULL) AS leads_without_pic, (SELECT COUNT(*) FROM leads l JOIN clients c ON c.id = l.client_id WHERE c.lifecycle_status = 'LEAD' AND l.last_client_response_at <> '' AND MAX(0, CAST(julianday(date('now', p.tz)) - julianday(date(l.last_client_response_at, p.tz)) AS INTEGER)) <= COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'lead_hot_max_days'), 3)) AS leads_hot, (SELECT COUNT(*) FROM leads l JOIN clients c ON c.id = l.client_id WHERE c.lifecycle_status = 'LEAD' AND l.last_client_response_at <> '' AND MAX(0, CAST(julianday(date('now', p.tz)) - julianday(date(l.last_client_response_at, p.tz)) AS INTEGER)) > COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'lead_hot_max_days'), 3) AND MAX(0, CAST(julianday(date('now', p.tz)) - julianday(date(l.last_client_response_at, p.tz)) AS INTEGER)) <= COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'lead_warm_max_days'), 7)) AS leads_warm, (SELECT COUNT(*) FROM leads l JOIN clients c ON c.id = l.client_id WHERE c.lifecycle_status = 'LEAD' AND l.last_client_response_at <> '' AND MAX(0, CAST(julianday(date('now', p.tz)) - julianday(date(l.last_client_response_at, p.tz)) AS INTEGER)) > COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'lead_warm_max_days'), 7)) AS leads_cold, (SELECT ROUND(AVG(julianday(f.first_at) - julianday(f.lead_at)), 1) FROM (SELECT MIN(s.created_at) AS first_at, MIN(l.created_at) AS lead_at FROM sample_requests s JOIN leads l ON l.client_id = s.client_id GROUP BY s.client_id) f WHERE date(f.first_at, p.tz) BETWEEN p.d1 AND p.d2) AS avg_lead_to_sample_days FROM p;";
/// Sampel: tiket baru (bukan repeat), dikirim, disetujui, MoU diterima, berjalan, rata-rata hari RnD.
pub const DASHBOARD_SAMPLES_SQL: &str = "WITH p AS (SELECT ?1 AS d1, ?2 AS d2, CASE COALESCE((SELECT t.timezone FROM company_profile t WHERE t.id = 'default_company'), '') WHEN 'Asia/Makassar' THEN '+8 hours' WHEN 'Asia/Jayapura' THEN '+9 hours' ELSE '+7 hours' END AS tz) SELECT (SELECT COUNT(*) FROM sample_requests s WHERE s.repeat_of_id = '' AND date(s.created_at, p.tz) BETWEEN p.d1 AND p.d2) AS samples_new, (SELECT COUNT(*) FROM sample_status_log r WHERE r.action = 'SAMPLE_SENT' AND date(r.recorded_at, p.tz) BETWEEN p.d1 AND p.d2) AS samples_sent, (SELECT COUNT(*) FROM sample_status_log r WHERE r.action = 'CLIENT_ACC' AND date(r.recorded_at, p.tz) BETWEEN p.d1 AND p.d2) AS samples_approved, (SELECT COUNT(*) FROM sample_status_log r WHERE r.action = 'MOU_ACCEPT' AND date(r.recorded_at, p.tz) BETWEEN p.d1 AND p.d2) AS mou_accepted, (SELECT COUNT(*) FROM sample_requests s WHERE s.status NOT IN ('CLIENT_ACC', 'CLIENT_REJECT', 'RND_REJECTED', 'CANCELLED')) AS samples_in_progress, (SELECT ROUND(AVG(julianday(r.recorded_at) - julianday((SELECT MAX(x.recorded_at) FROM sample_status_log x WHERE x.sample_request_id = r.sample_request_id AND x.to_status = 'IN_RND' AND x.recorded_at <= r.recorded_at))), 1) FROM sample_status_log r WHERE r.action = 'SAMPLE_READY' AND date(r.recorded_at, p.tz) BETWEEN p.d1 AND p.d2) AS avg_rnd_days FROM p;";
/// Keuangan: tagihan terbit (tanpa cicilan), uang masuk, piutang, lewat jatuh tempo, uang belum dialokasikan.
pub const DASHBOARD_FINANCE_SQL: &str = "WITH p AS (SELECT ?1 AS d1, ?2 AS d2, CASE COALESCE((SELECT t.timezone FROM company_profile t WHERE t.id = 'default_company'), '') WHEN 'Asia/Makassar' THEN '+8 hours' WHEN 'Asia/Jayapura' THEN '+9 hours' ELSE '+7 hours' END AS tz) SELECT (SELECT COUNT(*) FROM invoices i WHERE i.status <> 'CANCELLED' AND i.ref_type <> 'INSTALLMENT' AND i.issued_on BETWEEN p.d1 AND p.d2) AS invoices_issued, (SELECT COALESCE(SUM(i.total_idr), 0) FROM invoices i WHERE i.status <> 'CANCELLED' AND i.ref_type <> 'INSTALLMENT' AND i.issued_on BETWEEN p.d1 AND p.d2) AS invoiced_idr, (SELECT COALESCE(SUM(f.amount_idr), 0) FROM incoming_funds f WHERE f.status = 'ACTIVE' AND f.received_on BETWEEN p.d1 AND p.d2) AS received_idr, (SELECT COALESCE(SUM(i.total_idr - (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id)), 0) FROM invoices i WHERE i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr) AS outstanding_idr, (SELECT COALESCE(SUM(i.total_idr - (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id)), 0) FROM invoices i WHERE i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr AND i.due_on < date('now', p.tz)) AS overdue_idr, (SELECT COUNT(*) FROM invoices i WHERE i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr AND i.due_on < date('now', p.tz)) AS overdue_count, (SELECT COALESCE(SUM(f.amount_idr - (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.fund_id = f.id)), 0) FROM incoming_funds f WHERE f.status = 'ACTIVE' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.fund_id = f.id) < f.amount_idr) AS unallocated_idr FROM p;";
/// Produksi, pengiriman, dan QC: work order per tahap, packing tepat jadwal, terlambat, kirim, komplain.
pub const DASHBOARD_PRODUCTION_SQL: &str = "WITH p AS (SELECT ?1 AS d1, ?2 AS d2, CASE COALESCE((SELECT t.timezone FROM company_profile t WHERE t.id = 'default_company'), '') WHEN 'Asia/Makassar' THEN '+8 hours' WHEN 'Asia/Jayapura' THEN '+9 hours' ELSE '+7 hours' END AS tz) SELECT (SELECT COUNT(*) FROM production_batches b WHERE b.stages_done = 0) AS wo_waiting, (SELECT COUNT(*) FROM production_batches b WHERE b.stages_done BETWEEN 1 AND 3) AS wo_floor, (SELECT COUNT(*) FROM production_batches b WHERE b.stages_done = 4 AND NOT EXISTS (SELECT 1 FROM shipments h WHERE h.batch_id = b.id AND h.status IN ('SHIPPED', 'FORWARDED', 'RECEIVED', 'COMPLAINED'))) AS wo_packed, (SELECT COUNT(*) FROM production_batches b WHERE b.stages_done = 4 AND date(b.packed_at, p.tz) BETWEEN p.d1 AND p.d2) AS packed, (SELECT COUNT(*) FROM production_batches b WHERE b.stages_done = 4 AND date(b.packed_at, p.tz) BETWEEN p.d1 AND p.d2 AND date(b.packed_at, p.tz) <= b.sched_packing_on) AS packed_on_time, (SELECT COUNT(*) FROM production_batches b WHERE b.stages_done < 4 AND b.sched_packing_on <> '' AND b.sched_packing_on < date('now', p.tz)) AS behind_schedule, (SELECT COUNT(*) FROM batch_purchase_orders o WHERE o.status = 'OPEN' AND o.eta_on < date('now', p.tz)) AS late_purchase_orders, (SELECT COUNT(*) FROM shipments h WHERE h.shipped_at <> '' AND date(h.shipped_at, p.tz) BETWEEN p.d1 AND p.d2) AS shipped, (SELECT COUNT(*) FROM shipments h WHERE h.status = 'RECEIVED' AND date(h.received_at, p.tz) BETWEEN p.d1 AND p.d2) AS received_ok, (SELECT COUNT(*) FROM qc_claims q WHERE date(q.created_at, p.tz) BETWEEN p.d1 AND p.d2) AS complaints, (SELECT COUNT(*) FROM qc_claims q WHERE q.status = 'OPEN') AS claims_open, (SELECT COUNT(*) FROM qc_claims q WHERE q.status = 'DECIDED' AND date(q.decided_at, p.tz) BETWEEN p.d1 AND p.d2) AS claims_decided, (SELECT COUNT(*) FROM qc_claims q WHERE q.status = 'DECIDED' AND q.fault_type = 'INTERNAL' AND date(q.decided_at, p.tz) BETWEEN p.d1 AND p.d2) AS claims_internal, (SELECT ROUND(AVG((julianday(q.decided_at) - julianday(q.created_at)) * 24), 1) FROM qc_claims q WHERE q.status = 'DECIDED' AND date(q.decided_at, p.tz) BETWEEN p.d1 AND p.d2) AS avg_qc_hours FROM p;";
/// CRM: klien, tanpa PIC, jatuh tempo repeat (aturan `CRM_CLIENT_LIST_SQL`), order selesai, repeat dimulai.
pub const DASHBOARD_CRM_SQL: &str = "WITH p AS (SELECT ?1 AS d1, ?2 AS d2, CASE COALESCE((SELECT t.timezone FROM company_profile t WHERE t.id = 'default_company'), '') WHEN 'Asia/Makassar' THEN '+8 hours' WHEN 'Asia/Jayapura' THEN '+9 hours' ELSE '+7 hours' END AS tz) SELECT (SELECT COUNT(*) FROM clients c WHERE c.lifecycle_status = 'EXISTING_CLIENT') AS crm_clients, (SELECT COUNT(*) FROM clients c WHERE c.lifecycle_status = 'EXISTING_CLIENT' AND c.assigned_crm_id IS NULL) AS crm_unassigned, (SELECT COUNT(*) FROM (SELECT z.*, CASE WHEN z.last_completed_at = '' THEN '' ELSE date(z.last_completed_at, z.tz_shift, '+' || z.reorder_days || ' days') END AS reorder_on, date('now', z.tz_shift) AS today, (SELECT COUNT(*) FROM sample_requests r WHERE r.client_id = z.id AND r.id <> z.last_sample_id AND r.created_at >= z.last_completed_at AND r.status NOT IN ('RND_REJECTED', 'CLIENT_REJECT', 'CANCELLED')) AS open_tickets FROM (SELECT c.id, c.client_code, c.name AS client_name, c.city, c.assigned_crm_id, COALESCE(o.nama_operator, '') AS crm_name, MAX(COALESCE(CASE h.status WHEN 'RECEIVED' THEN h.received_at ELSE (SELECT MAX(q.decided_at) FROM qc_claims q WHERE q.shipment_id = h.id AND q.status = 'DECIDED') END, ''), COALESCE((SELECT MAX(i.record_date) FROM imported_records i WHERE i.client_id = c.id AND i.kind = 'SHIPMENT'), '')) AS last_completed_at, COALESCE(s.id, '') AS last_sample_id, COALESCE(s.brand_name, (SELECT i.title FROM imported_records i WHERE i.client_id = c.id AND i.kind = 'SHIPMENT' ORDER BY i.record_date DESC, i.created_at DESC LIMIT 1), '') AS brand_name, COALESCE(s.packaging, '') AS packaging, COALESCE(h.unit_count, (SELECT i.quantity FROM imported_records i WHERE i.client_id = c.id AND i.kind = 'SHIPMENT' ORDER BY i.record_date DESC, i.created_at DESC LIMIT 1), 0) AS last_units, COALESCE((SELECT f.formula_code FROM sample_formulas f WHERE f.sample_request_id = s.id ORDER BY f.iteration_number DESC, f.recorded_at DESC LIMIT 1), '') AS last_formula_code, COALESCE((SELECT MAX(MAX(l.last_followup_at, l.last_client_response_at)) FROM leads l WHERE l.client_id = c.id), '') AS last_contact_at, COALESCE((SELECT CAST(g.value AS INTEGER) FROM setting_gex_system g WHERE g.key = 'crm_reorder_days'), 60) AS reorder_days, CASE COALESCE((SELECT t.timezone FROM company_profile t WHERE t.id = 'default_company'), '') WHEN 'Asia/Makassar' THEN '+8 hours' WHEN 'Asia/Jayapura' THEN '+9 hours' ELSE '+7 hours' END AS tz_shift FROM clients c LEFT JOIN shipments h ON h.id = (SELECT x.id FROM shipments x WHERE x.client_id = c.id AND (x.status = 'RECEIVED' OR (x.status = 'COMPLAINED' AND EXISTS (SELECT 1 FROM qc_claims q WHERE q.shipment_id = x.id AND q.status = 'DECIDED'))) ORDER BY x.updated_at DESC, x.id DESC LIMIT 1) LEFT JOIN sample_requests s ON s.id = h.sample_request_id LEFT JOIN master_operator o ON o.id = c.assigned_crm_id WHERE c.lifecycle_status = 'EXISTING_CLIENT') z) z WHERE z.reorder_on <> '' AND z.reorder_on <= z.today AND z.open_tickets = 0) AS crm_due, (SELECT COUNT(*) FROM shipments h WHERE (h.status = 'RECEIVED' AND date(h.received_at, p.tz) BETWEEN p.d1 AND p.d2) OR (h.status = 'COMPLAINED' AND EXISTS (SELECT 1 FROM qc_claims q WHERE q.shipment_id = h.id AND q.status = 'DECIDED' AND date(q.decided_at, p.tz) BETWEEN p.d1 AND p.d2))) AS orders_completed, (SELECT COUNT(*) FROM sample_requests s WHERE s.repeat_of_id <> '' AND date(s.created_at, p.tz) BETWEEN p.d1 AND p.d2) AS repeat_started FROM p;";

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar dengan `src/lib/validations/dashboard.test.ts`.

    #[test]
    fn periode_dashboard() {
        assert_eq!(validate_dashboard_range("2026-10-01", "2026-10-31"), Ok(("2026-10-01".into(), "2026-10-31".into())));
        assert_eq!(validate_dashboard_range("2026-10-01", "2026-10-01"), Ok(("2026-10-01".into(), "2026-10-01".into())));
        assert_eq!(validate_dashboard_range("2025-01-01", "2026-12-31"), Ok(("2025-01-01".into(), "2026-12-31".into())));
        for (from, to) in [
            ("2026-10-31", "2026-10-01"),
            ("2026-02-30", "2026-03-01"),
            ("2024-12-30", "2026-12-31"),
            ("", "2026-10-01"),
        ] {
            assert_eq!(validate_dashboard_range(from, to), Err(DASHBOARD_RANGE_INVALID), "{from}..{to}");
        }
        assert!(DASHBOARD_SECTIONS.iter().all(|(section, _)| dashboard_section_sql(section).is_some()));
    }

    #[test]
    fn sql_berjalan_di_database_perangkat() {
        let directory = tempfile::tempdir().expect("direktori sementara");
        super::super::storage::initialize(directory.path()).expect("skema lokal");
        let connection = super::super::storage::database(directory.path()).expect("koneksi");
        for (section, _) in DASHBOARD_SECTIONS {
            let sql = dashboard_section_sql(section).expect("SQL bagian");
            connection
                .query_row(sql, ["2026-01-01", "2026-12-31"], |_| Ok(()))
                .unwrap_or_else(|error| panic!("{section}: {error}"));
        }
    }
}
