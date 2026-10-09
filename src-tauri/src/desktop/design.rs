//! Tiket desain: mockup, dummy, gerbang dummy, dan batas penolakan (PRD F-19,
//! v2.4, D-36).
//!
//! WAJIB identik dengan `src/lib/validations/design.ts`. Kedua sisi diuji
//! dengan vektor yang sama (`mod tests` di sini dan `design.test.ts`), dan
//! setiap konstanta SQL dites ada per karakter dari sisi TS.

use serde_json::Value;

pub const DESIGN_STATUSES: &[&str] = &[
    "MOCKUP",
    "DUMMY_PRINTING",
    "DUMMY_SENT",
    "DUMMY_REVISION",
    "DUMMY_ACC",
    "CANCELLED",
];
pub const DESIGN_ACTIONS: &[&str] = &["PRINT_DUMMY", "DUMMY_SENT", "DUMMY_ACC", "DUMMY_REVISE", "CANCEL_DESIGN"];
/// Aksi linimasa saat CS membuat brief.
pub const DESIGN_REQUEST_ACTION: &str = "REQUEST_DESIGN";
pub const DESIGN_BRIEF_MAX: usize = 1000;
pub const TRACKING_NO_MAX: usize = 100;
pub const DUMMY_LIMIT_PERMISSION: &str = "design.override_dummy_limit";

const CLOSED_SAMPLE_STATUSES: &[&str] = &["RND_REJECTED", "CLIENT_REJECT", "CANCELLED"];

/// Padanan `designActionPermission`.
pub fn design_action_permission(action: &str) -> &'static str {
    if matches!(action, "PRINT_DUMMY" | "DUMMY_SENT") {
        "design.manage"
    } else {
        "samples.manage"
    }
}

#[derive(Clone, Debug)]
pub struct DesignState<'a> {
    pub status: &'a str,
    pub sample_status: &'a str,
    pub has_mockup: bool,
    pub dummy_paid: bool,
    pub rejection_count: i64,
    pub max_rejections: i64,
    pub can_override: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesignResult {
    pub status: &'static str,
    pub rejection_count: i64,
}

pub const DUMMY_LIMIT_REACHED: &str =
    "The dummy rejection limit is reached. Only a holder of the limit override permission can print it again.";

/// Padanan `dummyLimitReached`.
pub fn dummy_limit_reached(rejections: i64, max: i64) -> bool {
    max > 0 && rejections >= max
}

/// Padanan `applyDesignAction`.
pub fn apply_design_action(state: &DesignState, action: &str) -> Result<DesignResult, &'static str> {
    let from = |allowed: &[&str], to: &'static str, count: i64| {
        if allowed.contains(&state.status) {
            Ok(DesignResult { status: to, rejection_count: state.rejection_count + count })
        } else {
            Err("This step is not available for the design ticket's current status.")
        }
    };
    match action {
        "PRINT_DUMMY" => {
            let step = from(&["MOCKUP", "DUMMY_REVISION"], "DUMMY_PRINTING", 0)?;
            if state.sample_status != "CLIENT_ACC" {
                return Err("The client has not approved the sample yet.");
            }
            if !state.has_mockup {
                return Err("Upload the mockup first.");
            }
            if !state.dummy_paid {
                return Err("The dummy invoice for this round is not paid yet.");
            }
            if dummy_limit_reached(state.rejection_count, state.max_rejections) && !state.can_override {
                return Err(DUMMY_LIMIT_REACHED);
            }
            Ok(step)
        }
        "DUMMY_SENT" => from(&["DUMMY_PRINTING"], "DUMMY_SENT", 0),
        "DUMMY_ACC" => from(&["DUMMY_SENT"], "DUMMY_ACC", 0),
        "DUMMY_REVISE" => from(&["DUMMY_SENT"], "DUMMY_REVISION", 1),
        "CANCEL_DESIGN" => from(&["MOCKUP", "DUMMY_PRINTING", "DUMMY_SENT", "DUMMY_REVISION"], "CANCELLED", 0),
        _ => Err("This design step does not exist."),
    }
}

/// Padanan `designRequestError`.
pub fn design_request_error(sample_status: &str, active_tickets: i64) -> Option<&'static str> {
    if CLOSED_SAMPLE_STATUSES.contains(&sample_status) {
        return Some("A design cannot be requested for a closed sample request.");
    }
    (active_tickets > 0).then_some("This sample request already has a design ticket.")
}

pub const DESIGN_BRIEF_INVALID: &str = "Write the design brief, up to 1000 characters.";

/// Padanan `normalizeDesignBrief`.
pub fn normalize_design_brief(value: Option<&Value>) -> Option<String> {
    let brief = value.and_then(Value::as_str).unwrap_or_default().trim();
    (!brief.is_empty() && brief.chars().count() <= DESIGN_BRIEF_MAX).then(|| brief.to_owned())
}

pub const TRACKING_NO_INVALID: &str = "The tracking number is up to 100 characters.";

/// Padanan `normalizeTrackingNo`: absen/null = kosong.
pub fn normalize_tracking_no(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => Some(String::new()),
        Some(Value::String(text)) => {
            let text = text.trim();
            (text.chars().count() <= TRACKING_NO_MAX).then(|| text.to_owned())
        }
        Some(_) => None,
    }
}

pub const DESIGN_CHANGED_ELSEWHERE: &str =
    "This design ticket was changed on another device first. Open it again to see the latest status.";

pub const DESIGN_LIST_SQL: &str = "SELECT d.*, s.status AS sample_status, s.client_id, s.brand_name, s.is_dummy_required, c.client_code, c.name AS client_name, EXISTS (SELECT 1 FROM media_asset m WHERE m.owner_type = 'sample' AND m.owner_id = d.sample_request_id AND m.purpose = 'MOCKUP') AS has_mockup, CASE WHEN d.dummy_rejection_count = 0 THEN EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = d.sample_request_id AND i.ref_type = 'DUMMY_FEE' AND i.revision_index = 0 AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) ELSE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = d.sample_request_id AND i.ref_type = 'DUMMY_FEE' AND i.revision_index = d.dummy_rejection_count AND i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr) END AS dummy_paid FROM design_tickets d JOIN sample_requests s ON s.id = d.sample_request_id LEFT JOIN clients c ON c.id = s.client_id";
pub const DESIGN_ACTIVE_SQL: &str = "SELECT COUNT(*) AS total FROM design_tickets WHERE sample_request_id = ?1 AND status <> 'CANCELLED' AND id <> ?2;";
pub const DESIGN_INSERT_SQL: &str = "INSERT INTO design_tickets (id, sample_request_id, brief, status, dummy_rejection_count, dummy_tracking_no, revision_notes, status_changed_at, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, 'MOCKUP', 0, '', '', ?4, ?5, ?4, ?4) ON CONFLICT(id) DO NOTHING;";
pub const DESIGN_TRANSITION_SQL: &str = "UPDATE design_tickets SET status = ?2, dummy_rejection_count = ?3, dummy_tracking_no = COALESCE(?4, dummy_tracking_no), revision_notes = COALESCE(?5, revision_notes), status_changed_at = ?6, updated_at = ?6 WHERE id = ?1 AND status = ?7 AND dummy_rejection_count = ?8;";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Vektor kembar dengan `src/lib/validations/design.test.ts`.

    fn state(status: &str) -> DesignState<'_> {
        DesignState {
            status,
            sample_status: "CLIENT_ACC",
            has_mockup: true,
            dummy_paid: true,
            rejection_count: 0,
            max_rejections: 0,
            can_override: false,
        }
    }

    fn ok(status: &'static str, rejection_count: i64) -> Result<DesignResult, &'static str> {
        Ok(DesignResult { status, rejection_count })
    }

    #[test]
    fn langkah_desain_mengikuti_diagram() {
        assert_eq!(apply_design_action(&state("MOCKUP"), "PRINT_DUMMY"), ok("DUMMY_PRINTING", 0));
        assert_eq!(apply_design_action(&state("DUMMY_PRINTING"), "DUMMY_SENT"), ok("DUMMY_SENT", 0));
        assert_eq!(apply_design_action(&state("DUMMY_SENT"), "DUMMY_ACC"), ok("DUMMY_ACC", 0));
        assert_eq!(apply_design_action(&state("DUMMY_SENT"), "DUMMY_REVISE"), ok("DUMMY_REVISION", 1));
        let revised = DesignState { rejection_count: 1, ..state("DUMMY_REVISION") };
        assert_eq!(apply_design_action(&revised, "PRINT_DUMMY"), ok("DUMMY_PRINTING", 1));
        assert_eq!(apply_design_action(&state("DUMMY_SENT"), "CANCEL_DESIGN"), ok("CANCELLED", 0));
        let wrong = Err("This step is not available for the design ticket's current status.");
        assert_eq!(apply_design_action(&state("DUMMY_ACC"), "CANCEL_DESIGN"), wrong);
        assert_eq!(apply_design_action(&state("CANCELLED"), "PRINT_DUMMY"), wrong);
        assert_eq!(apply_design_action(&state("MOCKUP"), "DUMMY_ACC"), wrong);
        assert_eq!(apply_design_action(&state("DUMMY_PRINTING"), "DUMMY_REVISE"), wrong);
        assert_eq!(apply_design_action(&state("MOCKUP"), "CANCEL"), Err("This design step does not exist."));
    }

    #[test]
    fn gerbang_cetak_dummy() {
        let mockup = state("MOCKUP");
        assert_eq!(
            apply_design_action(&DesignState { sample_status: "SAMPLE_SENT", ..mockup.clone() }, "PRINT_DUMMY"),
            Err("The client has not approved the sample yet.")
        );
        assert_eq!(
            apply_design_action(&DesignState { has_mockup: false, ..mockup.clone() }, "PRINT_DUMMY"),
            Err("Upload the mockup first.")
        );
        assert_eq!(
            apply_design_action(&DesignState { dummy_paid: false, ..mockup.clone() }, "PRINT_DUMMY"),
            Err("The dummy invoice for this round is not paid yet.")
        );
        let limit = DesignState { rejection_count: 2, max_rejections: 2, ..state("DUMMY_REVISION") };
        assert_eq!(apply_design_action(&limit, "PRINT_DUMMY"), Err(DUMMY_LIMIT_REACHED));
        assert_eq!(
            apply_design_action(&DesignState { can_override: true, ..limit.clone() }, "PRINT_DUMMY"),
            ok("DUMMY_PRINTING", 2)
        );
        let below = DesignState { rejection_count: 1, ..limit.clone() };
        assert_eq!(apply_design_action(&below, "PRINT_DUMMY"), ok("DUMMY_PRINTING", 1));
        let unlimited = DesignState { max_rejections: 0, rejection_count: 9, ..limit };
        assert_eq!(apply_design_action(&unlimited, "PRINT_DUMMY"), ok("DUMMY_PRINTING", 9));
        assert!(!dummy_limit_reached(5, 0));
        assert!(dummy_limit_reached(3, 3));
        assert!(!dummy_limit_reached(2, 3));
    }

    #[test]
    fn izin_dan_isian_desain() {
        assert_eq!(design_action_permission("PRINT_DUMMY"), "design.manage");
        assert_eq!(design_action_permission("DUMMY_SENT"), "design.manage");
        for action in ["DUMMY_ACC", "DUMMY_REVISE", "CANCEL_DESIGN"] {
            assert_eq!(design_action_permission(action), "samples.manage");
        }
        assert_eq!(design_request_error("IN_RND", 0), None);
        assert_eq!(design_request_error("CLIENT_ACC", 0), None);
        assert_eq!(
            design_request_error("CANCELLED", 0),
            Some("A design cannot be requested for a closed sample request.")
        );
        assert_eq!(design_request_error("SAMPLE_SENT", 1), Some("This sample request already has a design ticket."));
        assert_eq!(normalize_design_brief(Some(&json!(" Box 50 ml, pastel "))).as_deref(), Some("Box 50 ml, pastel"));
        assert_eq!(normalize_design_brief(Some(&json!("  "))), None);
        assert_eq!(normalize_design_brief(Some(&json!("é".repeat(1001)))), None);
        assert_eq!(normalize_design_brief(None), None);
        assert_eq!(normalize_tracking_no(None).as_deref(), Some(""));
        assert_eq!(normalize_tracking_no(Some(&Value::Null)).as_deref(), Some(""));
        assert_eq!(normalize_tracking_no(Some(&json!(" JNE123 "))).as_deref(), Some("JNE123"));
        assert_eq!(normalize_tracking_no(Some(&json!("x".repeat(101)))), None);
        assert_eq!(normalize_tracking_no(Some(&json!(12))), None);
    }
}
