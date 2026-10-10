//! Tagihan, uang masuk, dan alokasinya (PRD F-17, v2.3a; D-28 s/d D-30).
//!
//! WAJIB identik dengan `src/lib/validations/finance.ts`. Kedua sisi diuji
//! dengan vektor yang sama (`mod tests` di sini dan `finance.test.ts`), dan
//! setiap konstanta SQL dites ada per karakter dari sisi TS.

use serde_json::{json, Value};

use super::clients::{timezone_offset_hours, utc_timestamp};
use super::samples::{format_rupiah, is_calendar_date};

// ---------------------------------------------------------------------------
// Daftar pajak, diskon (D-28), dan paket cicilan (D-29, v2.3b).
// ---------------------------------------------------------------------------

pub const FINANCE_OPTION_KINDS: &[&str] = &["TAX", "DISCOUNT", "INSTALLMENT_PLAN"];
pub const FINANCE_LABEL_MAX: usize = 80;
pub const RATE_BP_MAX: i64 = 10_000;
pub const INSTALLMENT_COUNT_MAX: i64 = 24;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinanceOption {
    pub kind: &'static str,
    pub label: String,
    pub rate_bp: i64,
    /// Hanya paket cicilan: jumlah cicilan bulanan.
    pub installment_count: Option<i64>,
    pub is_active: bool,
}

fn text(raw: &Value, key: &str) -> String {
    raw.get(key)
        .and_then(Value::as_str)
        .map(|value| value.trim().to_owned())
        .unwrap_or_default()
}

/// Bilangan bulat JSON saja; teks angka dari form ditolak, bukan ditebak.
fn strict_int(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

/// Padanan `validateFinanceOption`; pesan identik.
pub fn validate_finance_option(raw: &Value) -> Result<FinanceOption, &'static str> {
    let kind = text(raw, "kind");
    let kind = FINANCE_OPTION_KINDS
        .iter()
        .copied()
        .find(|candidate| *candidate == kind)
        .ok_or("Unknown finance option type.")?;
    let label = text(raw, "label");
    if label.is_empty() || label.chars().count() > FINANCE_LABEL_MAX {
        return Err("The name must be 1-80 characters.");
    }
    let rate_bp = strict_int(raw.get("rate_bp"))
        .filter(|rate| (0..=RATE_BP_MAX).contains(rate))
        .ok_or("The rate must be from 0% to 100%.")?;
    let installment_count = if kind == "INSTALLMENT_PLAN" {
        Some(
            strict_int(raw.get("installment_count"))
                .filter(|count| (1..=INSTALLMENT_COUNT_MAX).contains(count))
                .ok_or("Choose 1-24 monthly installments.")?,
        )
    } else {
        None
    };
    let is_active = match raw.get("is_active") {
        None => true,
        Some(Value::Bool(active)) => *active,
        Some(_) => return Err("Choose whether the option is active."),
    };
    Ok(FinanceOption { kind, label, rate_bp, installment_count, is_active })
}

// ---------------------------------------------------------------------------
// Hitungan tagihan (keputusan E).
// ---------------------------------------------------------------------------

pub const INVOICE_AMOUNT_MAX: i64 = 100_000_000_000;
pub const INVOICE_TAXES_MAX: usize = 10;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvoiceTotals {
    pub subtotal_idr: i64,
    pub discount_label: String,
    pub discount_bp: i64,
    pub discount_idr: i64,
    pub taxes_json: String,
    pub tax_idr: i64,
    pub total_idr: i64,
}

/// Padanan `applyRate`: dibulatkan ke rupiah terdekat (setengah ke atas).
pub fn apply_rate(amount: i64, rate_bp: i64) -> i64 {
    (amount * rate_bp + 5000).div_euclid(10_000)
}

fn rate_line(value: &Value) -> Option<(String, i64)> {
    if !value.is_object() {
        return None;
    }
    let label = text(value, "label");
    let rate = strict_int(value.get("rate_bp"))?;
    (!label.is_empty() && label.chars().count() <= FINANCE_LABEL_MAX && (0..=RATE_BP_MAX).contains(&rate))
        .then_some((label, rate))
}

/// Padanan `computeInvoice`. `taxes_json` dirakit tangan dengan kunci urut
/// abjad, sama dengan `JSON.stringify` di TS.
pub fn compute_invoice(raw: &Value) -> Result<InvoiceTotals, &'static str> {
    let subtotal = strict_int(raw.get("subtotal_idr"))
        .filter(|amount| (1..=INVOICE_AMOUNT_MAX).contains(amount))
        .ok_or("Enter the amount in whole rupiah.")?;
    let discount = match raw.get("discount") {
        None | Some(Value::Null) => None,
        Some(value) => Some(rate_line(value).ok_or("The discount is invalid.")?),
    };
    let taxes = match raw.get("taxes") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            if items.len() > INVOICE_TAXES_MAX {
                return Err("An invoice can carry at most 10 taxes.");
            }
            items
                .iter()
                .map(|item| rate_line(item).ok_or("A tax is invalid."))
                .collect::<Result<Vec<_>, _>>()?
        }
        Some(_) => return Err("A tax is invalid."),
    };
    let discount_idr = discount.as_ref().map_or(0, |(_, rate)| apply_rate(subtotal, *rate));
    let taxable = subtotal - discount_idr;
    let mut tax_idr = 0;
    let mut parts = Vec::with_capacity(taxes.len());
    for (label, rate) in &taxes {
        let amount = apply_rate(taxable, *rate);
        tax_idr += amount;
        parts.push(format!("{{\"amount_idr\":{amount},\"label\":{},\"rate_bp\":{rate}}}", json!(label)));
    }
    Ok(InvoiceTotals {
        subtotal_idr: subtotal,
        discount_label: discount.as_ref().map(|(label, _)| label.clone()).unwrap_or_default(),
        discount_bp: discount.as_ref().map_or(0, |(_, rate)| *rate),
        discount_idr,
        taxes_json: format!("[{}]", parts.join(",")),
        tax_idr,
        total_idr: taxable + tax_idr,
    })
}

// ---------------------------------------------------------------------------
// Jenis tagihan dan tiketnya.
// ---------------------------------------------------------------------------

pub const INVOICE_REF_TYPES: &[&str] =
    &["SAMPLE_FEE", "REVISION_FEE", "TEST_FEE", "DUMMY_FEE", "DP_PRODUCTION_LEGAL", "SETTLEMENT", "SHIPPING", "STORAGE_FEE", "OTHER"];
pub const INVOICE_DESCRIPTION_MAX: usize = 300;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvoiceTicket {
    pub is_paid_sample: bool,
    pub is_test_requested: bool,
    pub revision_fee_idr: Option<i64>,
    /// Putaran dummy tiket desain aktif; `None` = tanpa tiket desain (v2.4).
    pub dummy_round: Option<i64>,
    /// MoU aktif tiket itu sudah disetujui klien (v2.5a).
    pub mou_accepted: bool,
    /// Padanan field v3.3 di `InvoiceTicket` TS.
    pub batch_packed: bool,
    pub settlement_cleared: bool,
    pub storage_fee_idr: i64,
}

/// Padanan `invoiceTypeError`; `None` = sah.
pub fn invoice_type_error(ref_type: &str, ticket: Option<&InvoiceTicket>) -> Option<&'static str> {
    if !INVOICE_REF_TYPES.contains(&ref_type) {
        return Some("Choose what the invoice is for.");
    }
    if ref_type == "OTHER" {
        return None;
    }
    let Some(ticket) = ticket else {
        return Some("Choose the sample request this invoice is for.");
    };
    match ref_type {
        "SAMPLE_FEE" if !ticket.is_paid_sample => Some("This sample is free, so it has no sample fee."),
        "TEST_FEE" if !ticket.is_test_requested => Some("This sample was not requested with testing."),
        "REVISION_FEE" if ticket.revision_fee_idr.is_none_or(|fee| fee < 1) => {
            Some("Finance has not set a fee for this revision.")
        }
        "DUMMY_FEE" if ticket.dummy_round.is_none() => Some("Request a design for this sample first."),
        "DP_PRODUCTION_LEGAL" if !ticket.mou_accepted => Some("The client has not accepted the MoU yet."),
        "SETTLEMENT" | "SHIPPING" if !ticket.batch_packed => Some("Production is not packed yet."),
        "STORAGE_FEE" if !ticket.settlement_cleared => Some("The settlement invoice is not paid yet."),
        "STORAGE_FEE" if ticket.storage_fee_idr < 1 => Some("There is no storage fee for this order."),
        _ => None,
    }
}

/// Padanan `invoiceRevisionIndex`.
pub fn invoice_revision_index(ref_type: &str, revision_index: i64, dummy_round: Option<i64>) -> i64 {
    match ref_type {
        "REVISION_FEE" => revision_index,
        "DUMMY_FEE" => dummy_round.unwrap_or(0),
        _ => 0,
    }
}

pub const INVOICE_DUPLICATE: &str = "This sample already has an open invoice of this type.";

// ---------------------------------------------------------------------------
// Pembayaran sebagian dan cicilan (D-29, v2.3b).
// ---------------------------------------------------------------------------

pub const INSTALLMENT_REF_TYPE: &str = "INSTALLMENT";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallmentLine {
    pub installment_no: i64,
    pub amount_idr: i64,
    pub due_on: String,
}

/// Padanan `addMonths`: tanggal yang tidak ada jatuh ke akhir bulan.
pub fn add_months(date: &str, months: i64) -> String {
    let mut parts = date.split('-').map(|part| part.parse::<i64>().unwrap_or(0));
    let year = parts.next().unwrap_or(0);
    let month = parts.next().unwrap_or(1);
    let day = parts.next().unwrap_or(1);
    let index = year * 12 + (month - 1) + months;
    let target_year = index.div_euclid(12);
    let target_month = index.rem_euclid(12) + 1;
    let leap = (target_year % 4 == 0 && target_year % 100 != 0) || target_year % 400 == 0;
    let days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let last_day = days[(target_month - 1) as usize];
    format!("{target_year:04}-{target_month:02}-{:02}", day.min(last_day))
}

/// Padanan `computeInstallments`: `(bunga, total, cicilan)`.
pub fn compute_installments(
    remaining_idr: i64,
    rate_bp: i64,
    count: i64,
    start_on: &str,
) -> (i64, i64, Vec<InstallmentLine>) {
    let interest = apply_rate(remaining_idr, rate_bp);
    let total = remaining_idr + interest;
    let share = total.div_euclid(count);
    let lines = (1..=count)
        .map(|no| InstallmentLine {
            installment_no: no,
            amount_idr: if no == count { total - share * (count - 1) } else { share },
            due_on: add_months(start_on, no),
        })
        .collect();
    (interest, total, lines)
}

/// Padanan `installmentNumber`.
pub fn installment_number(parent_number: &str, no: i64) -> String {
    format!("{parent_number}-{no}")
}

/// Padanan `installmentDescription`.
pub fn installment_description(no: i64, count: i64, parent_number: &str, plan_label: &str) -> String {
    format!("Installment {no} of {count} for {parent_number} ({plan_label})")
}

/// Padanan `partialPaymentError`; `None` = sah.
pub fn partial_payment_error(
    amount: Option<&Value>,
    ref_type: &str,
    invoice_remaining: i64,
    fund_unallocated: i64,
) -> Option<String> {
    if ref_type == INSTALLMENT_REF_TYPE {
        return Some(
            "An installment cannot be rescheduled again. Cancel it and create a new invoice instead.".to_owned(),
        );
    }
    let Some(value) = strict_int(amount).filter(|value| *value >= 1) else {
        return Some("Enter the amount in whole rupiah.".to_owned());
    };
    if value >= invoice_remaining {
        return Some(format!(
            "A partial payment must be less than the unpaid {}. Use Allocate for a full payment.",
            format_rupiah(invoice_remaining)
        ));
    }
    if value > fund_unallocated {
        return Some(format!(
            "This incoming payment only has {} left to allocate.",
            format_rupiah(fund_unallocated)
        ));
    }
    None
}

/// Padanan `depositError`; `None` = sah.
pub fn deposit_error(fund_status: &str, confirmed_at: &str, client_id: &str, unallocated: i64) -> Option<&'static str> {
    if fund_status != "ACTIVE" {
        return Some("This incoming payment is void or does not exist.");
    }
    if !confirmed_at.is_empty() {
        return Some("This payment is already kept as a deposit.");
    }
    if client_id.is_empty() {
        return Some("Choose the client this deposit belongs to.");
    }
    if unallocated < 1 {
        return Some("Nothing is left on this payment to keep as a deposit.");
    }
    None
}

// ---------------------------------------------------------------------------
// Alokasi uang masuk (keputusan G).
// ---------------------------------------------------------------------------

pub const FUND_DESCRIPTION_MAX: usize = 300;
pub const CANCEL_REASON_MAX: usize = 300;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FundDraft {
    pub received_on: String,
    pub amount_idr: i64,
    /// '' = mutasi yang belum diketahui pemiliknya.
    pub client_id: String,
    pub description: String,
}

/// Padanan `validateFundDraft`; pesan identik.
pub fn validate_fund_draft(raw: &Value) -> Result<FundDraft, &'static str> {
    let received_on = text(raw, "received_on");
    if !is_calendar_date(&received_on) {
        return Err("Enter the date the money arrived.");
    }
    let amount_idr = strict_int(raw.get("amount_idr"))
        .filter(|amount| (1..=INVOICE_AMOUNT_MAX).contains(amount))
        .ok_or("Enter the amount in whole rupiah.")?;
    let description = text(raw, "description");
    if description.chars().count() > FUND_DESCRIPTION_MAX {
        return Err("The description is up to 300 characters.");
    }
    Ok(FundDraft {
        received_on,
        amount_idr,
        client_id: text(raw, "client_id"),
        description,
    })
}

/// Padanan `allocationError`; `None` = sah.
pub fn allocation_error(amount: Option<&Value>, invoice_remaining: i64, fund_unallocated: i64) -> Option<String> {
    let Some(value) = strict_int(amount).filter(|value| *value >= 1) else {
        return Some("Enter the amount in whole rupiah.".to_owned());
    };
    if invoice_remaining < 1 {
        return Some("This invoice is already paid.".to_owned());
    }
    if value != invoice_remaining {
        return Some(format!(
            "The amount must equal the unpaid {} of this invoice (difference {}).",
            format_rupiah(invoice_remaining),
            format_rupiah(value - invoice_remaining)
        ));
    }
    if value > fund_unallocated {
        return Some(format!(
            "This incoming payment only has {} left to allocate.",
            format_rupiah(fund_unallocated)
        ));
    }
    None
}

/// Padanan `allocationCheck`: baris `ALLOCATION_STATE_SQL` + nominal → pesan,
/// atau `None` bila sah. Dipakai command perangkat dan guard cloud.
pub fn allocation_check(state_row: &Value, amount: &Value) -> Option<String> {
    if state_row.get("invoice_status").and_then(Value::as_str) != Some("OPEN") {
        return Some("This invoice is cancelled or does not exist.".into());
    }
    if state_row.get("fund_status").and_then(Value::as_str) != Some("ACTIVE") {
        return Some("This incoming payment is void or does not exist.".into());
    }
    let number = |key: &str| {
        state_row
            .get(key)
            .and_then(|value| value.as_i64().or_else(|| value.as_str().and_then(|text| text.parse().ok())))
            .unwrap_or(0)
    };
    allocation_error(Some(amount), number("invoice_remaining"), number("fund_unallocated"))
}

/// Padanan `normalizeCancelReason`.
pub fn normalize_cancel_reason(value: &str) -> Option<String> {
    let reason = value.trim();
    (!reason.is_empty() && reason.chars().count() <= CANCEL_REASON_MAX).then(|| reason.to_owned())
}

pub const CANCEL_REASON_INVALID: &str = "Give a reason, up to 300 characters.";

// ---------------------------------------------------------------------------
// Tanggal dan nomor tagihan.
// ---------------------------------------------------------------------------

pub const INVOICE_NUMBER_PREFIX: &str = "INV";

/// Padanan `invoiceDates`: `(terbit, jatuh tempo)` dalam `YYYY-MM-DD`.
pub fn invoice_dates(epoch_seconds: i64, timezone: &str, due_days: i64) -> (String, String) {
    let local = epoch_seconds + timezone_offset_hours(timezone) * 3600;
    (
        utc_timestamp(local)[..10].to_owned(),
        utc_timestamp(local + due_days * 86_400)[..10].to_owned(),
    )
}

// ---------------------------------------------------------------------------
// SQL — WAJIB identik dengan `finance.ts`.
// ---------------------------------------------------------------------------

pub const FINANCE_OPTION_UPSERT_SQL: &str = "INSERT INTO finance_options (id, kind, label, rate_bp, is_active, sort_order, updated_at, installment_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(id) DO UPDATE SET label = excluded.label, rate_bp = excluded.rate_bp, is_active = excluded.is_active, sort_order = excluded.sort_order, updated_at = excluded.updated_at, installment_count = excluded.installment_count;";

pub const FINANCE_OPTIONS_SQL: &str = "SELECT id, kind, label, rate_bp, installment_count, is_active, sort_order, updated_at FROM finance_options ORDER BY kind, sort_order, label;";

pub const INVOICE_INSERT_SQL: &str = "INSERT INTO invoices (id, invoice_number, client_id, sample_request_id, ref_type, revision_index, description, subtotal_idr, discount_label, discount_bp, discount_idr, taxes_json, tax_idr, total_idr, issued_on, due_on, status, cancel_reason, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'OPEN', '', ?17, ?18, ?18) ON CONFLICT(id) DO NOTHING;";

pub const INVOICE_CANCEL_SQL: &str = "UPDATE invoices SET status = 'CANCELLED', cancel_reason = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'OPEN' AND NOT EXISTS (SELECT 1 FROM fund_allocations a WHERE a.invoice_id = ?1);";

pub const INVOICE_DUPLICATE_SQL: &str = "SELECT COUNT(*) AS total FROM invoices WHERE sample_request_id = ?1 AND ref_type = ?2 AND revision_index = ?3 AND status IN ('OPEN', 'RESCHEDULED') AND id <> ?4;";

pub const INSTALLMENT_INSERT_SQL: &str = "INSERT INTO invoices (id, invoice_number, client_id, sample_request_id, ref_type, revision_index, description, subtotal_idr, discount_label, discount_bp, discount_idr, taxes_json, tax_idr, total_idr, issued_on, due_on, status, cancel_reason, created_by, created_at, updated_at, parent_invoice_id, installment_no) VALUES (?1, ?2, ?3, ?4, 'INSTALLMENT', ?5, ?6, ?7, '', 0, 0, '[]', 0, ?7, ?8, ?9, 'OPEN', '', ?12, ?13, ?13, ?10, ?11) ON CONFLICT(id) DO NOTHING;";

pub const INVOICE_RESCHEDULE_SQL: &str = "UPDATE invoices SET status = 'RESCHEDULED', updated_at = ?2 WHERE id = ?1 AND status = 'OPEN';";

pub const RESCHEDULE_STATE_SQL: &str = "SELECT i.invoice_number, i.client_id, i.sample_request_id, i.revision_index, i.ref_type, i.status, i.total_idr - (SELECT COALESCE(SUM(amount_idr), 0) FROM fund_allocations WHERE invoice_id = i.id) AS invoice_remaining, (SELECT status FROM incoming_funds WHERE id = ?2) AS fund_status, (SELECT amount_idr - (SELECT COALESCE(SUM(amount_idr), 0) FROM fund_allocations WHERE fund_id = ?2) FROM incoming_funds WHERE id = ?2) AS fund_unallocated FROM invoices i WHERE i.id = ?1;";

pub const INVOICE_LIST_SQL: &str = "SELECT i.*, c.client_code, c.name AS client_name, c.address AS client_address, c.city AS client_city, c.province AS client_province, s.brand_name, (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) AS paid_idr FROM invoices i LEFT JOIN clients c ON c.id = i.client_id LEFT JOIN sample_requests s ON s.id = i.sample_request_id";

pub const FUND_INSERT_SQL: &str = "INSERT INTO incoming_funds (id, client_id, received_on, amount_idr, description, proof_media_id, status, void_reason, recorded_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ACTIVE', '', ?7, ?8, ?8) ON CONFLICT(id) DO NOTHING;";

pub const FUND_VOID_SQL: &str = "UPDATE incoming_funds SET status = 'VOID', void_reason = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM fund_allocations a WHERE a.fund_id = ?1);";

pub const FUND_DEPOSIT_SQL: &str = "UPDATE incoming_funds SET client_id = ?2, deposit_confirmed_by = ?3, deposit_confirmed_at = ?4, updated_at = ?4 WHERE id = ?1 AND status = 'ACTIVE' AND deposit_confirmed_at = '' AND (client_id = '' OR client_id = ?2);";

pub const FUND_DEPOSIT_STATE_SQL: &str = "SELECT status, client_id, deposit_confirmed_at, amount_idr - (SELECT COALESCE(SUM(amount_idr), 0) FROM fund_allocations WHERE fund_id = ?1) AS unallocated FROM incoming_funds WHERE id = ?1;";

pub const FUND_LIST_SQL: &str = "SELECT f.*, c.client_code, c.name AS client_name, (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.fund_id = f.id) AS allocated_idr FROM incoming_funds f LEFT JOIN clients c ON c.id = f.client_id";

pub const FUND_MEDIA_INSERT_SQL: &str = "INSERT INTO media_asset (id, owner_type, owner_id, purpose, mime, byte_size, data_base64, created_by, created_at) VALUES (?1, 'fund', ?2, 'PAYMENT_PROOF', 'image/webp', ?3, ?4, ?5, ?6) ON CONFLICT(id) DO NOTHING;";

pub const ALLOCATION_INSERT_SQL: &str = "INSERT INTO fund_allocations (id, fund_id, invoice_id, amount_idr, recorded_by, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO NOTHING;";

pub const ALLOCATION_LIST_SQL: &str = "SELECT a.*, i.invoice_number, o.nama_operator AS recorded_by_name FROM fund_allocations a LEFT JOIN invoices i ON i.id = a.invoice_id LEFT JOIN master_operator o ON o.id = a.recorded_by ORDER BY a.recorded_at DESC, a.id;";

pub const ALLOCATION_STATE_SQL: &str = "SELECT (SELECT status FROM invoices WHERE id = ?1) AS invoice_status, (SELECT total_idr - (SELECT COALESCE(SUM(amount_idr), 0) FROM fund_allocations WHERE invoice_id = ?1) FROM invoices WHERE id = ?1) AS invoice_remaining, (SELECT status FROM incoming_funds WHERE id = ?2) AS fund_status, (SELECT amount_idr - (SELECT COALESCE(SUM(amount_idr), 0) FROM fund_allocations WHERE fund_id = ?2) FROM incoming_funds WHERE id = ?2) AS fund_unallocated;";

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar dengan `src/lib/validations/finance.test.ts`.

    #[test]
    fn opsi_keuangan_divalidasi() {
        assert_eq!(
            validate_finance_option(&json!({ "kind": "TAX", "label": " PPN ", "rate_bp": 1100 })),
            Ok(FinanceOption { kind: "TAX", label: "PPN".into(), rate_bp: 1100, installment_count: None, is_active: true })
        );
        assert_eq!(
            validate_finance_option(&json!({ "kind": "DISCOUNT", "label": "Lebaran", "rate_bp": 2000, "is_active": false })),
            Ok(FinanceOption { kind: "DISCOUNT", label: "Lebaran".into(), rate_bp: 2000, installment_count: None, is_active: false })
        );
        assert_eq!(
            validate_finance_option(&json!({ "kind": "INSTALLMENT_PLAN", "label": "3x", "rate_bp": 1000, "installment_count": 3 })),
            Ok(FinanceOption { kind: "INSTALLMENT_PLAN", label: "3x".into(), rate_bp: 1000, installment_count: Some(3), is_active: true })
        );
        let cases: &[(Value, &str)] = &[
            (json!({ "kind": "BONUS", "label": "3x", "rate_bp": 1000 }), "Unknown finance option type."),
            (json!({ "kind": "INSTALLMENT_PLAN", "label": "3x", "rate_bp": 1000 }), "Choose 1-24 monthly installments."),
            (json!({ "kind": "INSTALLMENT_PLAN", "label": "x", "rate_bp": 0, "installment_count": 25 }), "Choose 1-24 monthly installments."),
            (json!({ "kind": "TAX", "label": "", "rate_bp": 1100 }), "The name must be 1-80 characters."),
            (json!({ "kind": "TAX", "label": "PPN", "rate_bp": 10001 }), "The rate must be from 0% to 100%."),
            (json!({ "kind": "TAX", "label": "PPN", "rate_bp": "1100" }), "The rate must be from 0% to 100%."),
            (json!({ "kind": "TAX", "label": "PPN", "rate_bp": 1100, "is_active": "yes" }), "Choose whether the option is active."),
        ];
        for (input, message) in cases {
            assert_eq!(validate_finance_option(input), Err(*message), "{input}");
        }
    }

    #[test]
    fn hitungan_tagihan() {
        let totals = compute_invoice(&json!({
            "subtotal_idr": 1_000_000,
            "discount": { "label": "Lebaran", "rate_bp": 2000 },
            "taxes": [{ "label": "PPN", "rate_bp": 1100 }, { "label": "Local", "rate_bp": 150 }],
        }))
        .unwrap();
        assert_eq!(
            totals,
            InvoiceTotals {
                subtotal_idr: 1_000_000,
                discount_label: "Lebaran".into(),
                discount_bp: 2000,
                discount_idr: 200_000,
                taxes_json: "[{\"amount_idr\":88000,\"label\":\"PPN\",\"rate_bp\":1100},{\"amount_idr\":12000,\"label\":\"Local\",\"rate_bp\":150}]".into(),
                tax_idr: 100_000,
                total_idr: 900_000,
            }
        );
        // Pembulatan setengah ke atas: 333 × 11% = 36,63 → 37; 5 × 10% = 0,5 → 1.
        let rounded = compute_invoice(&json!({ "subtotal_idr": 333, "taxes": [{ "label": "PPN", "rate_bp": 1100 }] })).unwrap();
        assert_eq!((rounded.tax_idr, rounded.total_idr, rounded.taxes_json.as_str()), (37, 370, "[{\"amount_idr\":37,\"label\":\"PPN\",\"rate_bp\":1100}]"));
        assert_eq!(apply_rate(5, 1000), 1);
        assert_eq!(apply_rate(4, 1000), 0);
        let plain = compute_invoice(&json!({ "subtotal_idr": 500_000 })).unwrap();
        assert_eq!((plain.discount_idr, plain.tax_idr, plain.total_idr, plain.taxes_json.as_str()), (0, 0, 500_000, "[]"));

        let cases: &[(Value, &str)] = &[
            (json!({ "subtotal_idr": 0 }), "Enter the amount in whole rupiah."),
            (json!({ "subtotal_idr": 1.5 }), "Enter the amount in whole rupiah."),
            (json!({ "subtotal_idr": 100_000_000_001_i64 }), "Enter the amount in whole rupiah."),
            (json!({ "subtotal_idr": 100, "discount": { "label": "", "rate_bp": 10 } }), "The discount is invalid."),
            (json!({ "subtotal_idr": 100, "taxes": [{ "label": "PPN", "rate_bp": -1 }] }), "A tax is invalid."),
            (json!({ "subtotal_idr": 100, "taxes": "PPN" }), "A tax is invalid."),
        ];
        for (input, message) in cases {
            assert_eq!(compute_invoice(input), Err(*message), "{input}");
        }
        let many: Vec<Value> = (0..11).map(|_| json!({ "label": "T", "rate_bp": 1 })).collect();
        assert_eq!(
            compute_invoice(&json!({ "subtotal_idr": 100, "taxes": many })),
            Err("An invoice can carry at most 10 taxes.")
        );
    }

    #[test]
    fn jenis_tagihan_per_tiket() {
        let ticket = |paid: bool, test: bool, fee: Option<i64>, round: Option<i64>| InvoiceTicket {
            is_paid_sample: paid,
            is_test_requested: test,
            revision_fee_idr: fee,
            dummy_round: round,
            mou_accepted: paid,
            batch_packed: paid,
            settlement_cleared: paid,
            storage_fee_idr: if paid { 60_000 } else { 0 },
        };
        let paid = ticket(true, true, Some(750_000), Some(0));
        let free = ticket(false, false, None, None);
        let waived = InvoiceTicket { storage_fee_idr: 0, ..paid };
        let cases: &[(&str, Option<&InvoiceTicket>, Option<&str>)] = &[
            ("SAMPLE_FEE", Some(&paid), None),
            ("TEST_FEE", Some(&paid), None),
            ("REVISION_FEE", Some(&paid), None),
            ("OTHER", None, None),
            ("SAMPLE_FEE", Some(&free), Some("This sample is free, so it has no sample fee.")),
            ("TEST_FEE", Some(&free), Some("This sample was not requested with testing.")),
            ("REVISION_FEE", Some(&free), Some("Finance has not set a fee for this revision.")),
            ("SAMPLE_FEE", None, Some("Choose the sample request this invoice is for.")),
            ("DUMMY_FEE", Some(&paid), None),
            ("DUMMY_FEE", Some(&free), Some("Request a design for this sample first.")),
            ("DP_PRODUCTION_LEGAL", Some(&paid), None),
            ("DP_PRODUCTION_LEGAL", Some(&free), Some("The client has not accepted the MoU yet.")),
            ("PRINT_FEE", Some(&paid), Some("Choose what the invoice is for.")),
            ("SETTLEMENT", Some(&paid), None),
            ("SETTLEMENT", Some(&free), Some("Production is not packed yet.")),
            ("SHIPPING", Some(&free), Some("Production is not packed yet.")),
            ("STORAGE_FEE", Some(&paid), None),
            ("STORAGE_FEE", Some(&free), Some("The settlement invoice is not paid yet.")),
            ("STORAGE_FEE", Some(&waived), Some("There is no storage fee for this order.")),
        ];
        for (ref_type, ticket, expected) in cases {
            assert_eq!(invoice_type_error(ref_type, *ticket), *expected, "{ref_type}");
        }
        assert_eq!(invoice_revision_index("REVISION_FEE", 2, Some(1)), 2);
        assert_eq!(invoice_revision_index("DUMMY_FEE", 2, Some(1)), 1);
        assert_eq!(invoice_revision_index("DUMMY_FEE", 2, None), 0);
        assert_eq!(invoice_revision_index("SAMPLE_FEE", 2, Some(1)), 0);
    }

    #[test]
    fn alokasi_lunas_penuh() {
        assert_eq!(allocation_error(Some(&json!(500_000)), 500_000, 600_000), None);
        assert_eq!(allocation_error(Some(&json!(0)), 500_000, 600_000).as_deref(), Some("Enter the amount in whole rupiah."));
        assert_eq!(allocation_error(None, 500_000, 600_000).as_deref(), Some("Enter the amount in whole rupiah."));
        assert_eq!(allocation_error(Some(&json!(10)), 0, 600_000).as_deref(), Some("This invoice is already paid."));
        assert_eq!(
            allocation_error(Some(&json!(450_000)), 500_000, 600_000).as_deref(),
            Some("The amount must equal the unpaid Rp 500.000 of this invoice (difference -Rp 50.000).")
        );
        assert_eq!(
            allocation_error(Some(&json!(500_000)), 500_000, 300_000).as_deref(),
            Some("This incoming payment only has Rp 300.000 left to allocate.")
        );
        let row = |invoice: &str, remaining: Value, fund: &str, unallocated: Value| {
            json!({ "invoice_status": invoice, "invoice_remaining": remaining, "fund_status": fund, "fund_unallocated": unallocated })
        };
        assert_eq!(allocation_check(&row("OPEN", json!(500_000), "ACTIVE", json!("600000")), &json!(500_000)), None);
        assert_eq!(
            allocation_check(&row("CANCELLED", json!(500_000), "ACTIVE", json!(600_000)), &json!(500_000)).as_deref(),
            Some("This invoice is cancelled or does not exist.")
        );
        assert_eq!(
            allocation_check(&row("OPEN", json!(500_000), "VOID", json!(600_000)), &json!(500_000)).as_deref(),
            Some("This incoming payment is void or does not exist.")
        );
        assert_eq!(allocation_check(&Value::Null, &json!(1)).as_deref(), Some("This invoice is cancelled or does not exist."));
        assert_eq!(normalize_cancel_reason("  Wrong amount "), Some("Wrong amount".into()));
        assert_eq!(normalize_cancel_reason("   "), None);
        assert_eq!(normalize_cancel_reason(&"x".repeat(301)), None);
    }

    #[test]
    fn isian_uang_masuk() {
        assert_eq!(
            validate_fund_draft(&json!({ "received_on": "2026-10-08", "amount_idr": 500_000, "client_id": " c1 ", "description": " BCA transfer " })),
            Ok(FundDraft {
                received_on: "2026-10-08".into(),
                amount_idr: 500_000,
                client_id: "c1".into(),
                description: "BCA transfer".into(),
            })
        );
        let cases: &[(Value, &str)] = &[
            (json!({ "received_on": "2026-02-30", "amount_idr": 1 }), "Enter the date the money arrived."),
            (json!({ "received_on": "2026-10-08", "amount_idr": 0 }), "Enter the amount in whole rupiah."),
            (json!({ "received_on": "2026-10-08", "amount_idr": "500000" }), "Enter the amount in whole rupiah."),
            (json!({ "received_on": "2026-10-08", "amount_idr": 1, "description": "d".repeat(301) }), "The description is up to 300 characters."),
        ];
        for (input, message) in cases {
            assert_eq!(validate_fund_draft(input), Err(*message), "{input}");
        }
    }

    #[test]
    fn cicilan_dan_pembayaran_sebagian() {
        assert_eq!(add_months("2026-01-31", 1), "2026-02-28");
        assert_eq!(add_months("2028-01-31", 1), "2028-02-29");
        assert_eq!(add_months("2026-10-08", 3), "2027-01-08");
        assert_eq!(add_months("2026-12-15", 12), "2027-12-15");
        let line = |no: i64, amount: i64, due: &str| InstallmentLine { installment_no: no, amount_idr: amount, due_on: due.into() };
        // Contoh user: sisa 5.000.000, 3x bunga 10% = 5.500.000.
        assert_eq!(
            compute_installments(5_000_000, 1000, 3, "2026-10-08"),
            (
                500_000,
                5_500_000,
                vec![
                    line(1, 1_833_333, "2026-11-08"),
                    line(2, 1_833_333, "2026-12-08"),
                    line(3, 1_833_334, "2027-01-08"),
                ]
            )
        );
        assert_eq!(compute_installments(1_000_000, 500, 1, "2026-01-31"), (50_000, 1_050_000, vec![line(1, 1_050_000, "2026-02-28")]));
        assert_eq!(compute_installments(700_000, 0, 7, "2026-10-08").2[6], line(7, 100_000, "2027-05-08"));

        assert_eq!(partial_payment_error(Some(&json!(300_000)), "SAMPLE_FEE", 500_000, 300_000), None);
        assert_eq!(
            partial_payment_error(Some(&json!(500_000)), "SAMPLE_FEE", 500_000, 600_000).as_deref(),
            Some("A partial payment must be less than the unpaid Rp 500.000. Use Allocate for a full payment.")
        );
        assert_eq!(
            partial_payment_error(Some(&json!(300_000)), "SAMPLE_FEE", 500_000, 200_000).as_deref(),
            Some("This incoming payment only has Rp 200.000 left to allocate.")
        );
        assert_eq!(partial_payment_error(Some(&json!(0)), "OTHER", 500_000, 200_000).as_deref(), Some("Enter the amount in whole rupiah."));
        assert_eq!(
            partial_payment_error(Some(&json!(1)), "INSTALLMENT", 500_000, 200_000).as_deref(),
            Some("An installment cannot be rescheduled again. Cancel it and create a new invoice instead.")
        );

        assert_eq!(installment_number("INV-20261008-A101", 2), "INV-20261008-A101-2");
        assert_eq!(
            installment_description(2, 3, "INV-20261008-A101", "3x 10%"),
            "Installment 2 of 3 for INV-20261008-A101 (3x 10%)"
        );
        assert_eq!(deposit_error("ACTIVE", "", "c1", 1), None);
        assert_eq!(deposit_error("VOID", "", "c1", 1), Some("This incoming payment is void or does not exist."));
        assert_eq!(deposit_error("ACTIVE", "2026-10-08 01:00:00", "c1", 1), Some("This payment is already kept as a deposit."));
        assert_eq!(deposit_error("ACTIVE", "", "", 1), Some("Choose the client this deposit belongs to."));
        assert_eq!(deposit_error("ACTIVE", "", "c1", 0), Some("Nothing is left on this payment to keep as a deposit."));
    }

    #[test]
    fn tanggal_tagihan() {
        // 2026-10-08 20:00 UTC = 2026-10-09 03:00 WIB.
        let epoch = 1_791_489_600;
        assert_eq!(utc_timestamp(epoch), "2026-10-08 20:00:00");
        assert_eq!(invoice_dates(epoch, "Asia/Jakarta", 7), ("2026-10-09".into(), "2026-10-16".into()));
        assert_eq!(invoice_dates(epoch, "Asia/Jayapura", 0), ("2026-10-09".into(), "2026-10-09".into()));
    }
}
