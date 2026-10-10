//! Persetujuan klien: tautan sekali pakai dan jalur manual (PRD F-18, v2.5b,
//! D-38). Perangkat hanya MEMBUAT tautan (langsung di cloud, keputusan J) dan
//! menuntut tangkapan layar saat jawaban klien dicatat manual; jawaban lewat
//! tautan diterapkan Web.
//!
//! Konstanta di sini WAJIB identik dengan `src/lib/validations/approval.ts`
//! (dites per karakter dari sisi TS).

pub const APPROVAL_ENTITY_TYPES: &[&str] = &["SAMPLE", "DUMMY", "MOU"];

/// Padanan `approvalPermission`.
pub fn approval_permission(entity_type: &str) -> &'static str {
    if entity_type == "MOU" {
        "mou.manage"
    } else {
        "samples.manage"
    }
}

pub const CLIENT_DECISION_ACTIONS: &[&str] = &[
    "CLIENT_ACC",
    "CLIENT_REVISE",
    "CLIENT_REJECT",
    "DUMMY_ACC",
    "DUMMY_REVISE",
    "MOU_ACCEPT",
    "MOU_REVISE",
    "MOU_REJECT",
];

/// Padanan `isClientDecisionAction`.
pub fn is_client_decision_action(action: &str) -> bool {
    CLIENT_DECISION_ACTIONS.contains(&action)
}

/// Padanan `stepEvidencePurpose`.
pub fn step_evidence_purpose(action: &str) -> Option<&'static str> {
    if is_client_decision_action(action) {
        Some("CLIENT_RESPONSE")
    } else if action == "PRINT_DUMMY" {
        Some("DUMMY_ARTWORK")
    } else {
        None
    }
}

pub const CLIENT_EVIDENCE_REQUIRED: &str = "Attach a screenshot of the client's reply.";
pub const APPROVAL_LINK_UNAVAILABLE: &str =
    "The client cannot answer this yet. Sync first, and check that it was sent to the client.";
pub const APPROVAL_LINK_DISABLED: &str = "Set the approval web address in Business settings first.";

/// Padanan `approvalUrl`. Token base64url tidak perlu di-escape.
pub fn approval_url(base_url: &str, token: &str) -> String {
    format!("{base_url}/approve?t={token}")
}

pub const APPROVAL_INSERT_SQL: &str = "INSERT INTO approval_tokens (id, token_hash, entity_type, entity_id, sample_request_id, base_status, base_revision, expires_at, created_by, created_at) SELECT ?3, ?4, t.entity_type, t.entity_id, t.sample_request_id, t.status, t.revision, datetime('now', '+' || ?5 || ' days'), ?6, datetime('now') FROM (SELECT 'SAMPLE' AS entity_type, s.id AS entity_id, s.id AS sample_request_id, s.status, s.revision_index AS revision FROM sample_requests s WHERE ?1 = 'SAMPLE' AND s.id = ?2 UNION ALL SELECT 'DUMMY', d.id, d.sample_request_id, d.status, d.dummy_rejection_count FROM design_tickets d WHERE ?1 = 'DUMMY' AND d.id = ?2 UNION ALL SELECT 'MOU', m.id, m.sample_request_id, m.status, 0 FROM production_mou m WHERE ?1 = 'MOU' AND m.id = ?2) t WHERE t.status = CASE t.entity_type WHEN 'SAMPLE' THEN 'SAMPLE_SENT' WHEN 'DUMMY' THEN 'DUMMY_SENT' ELSE 'SENT' END;";
pub const APPROVAL_REVOKE_OTHERS_SQL: &str = "UPDATE approval_tokens SET revoked_at = datetime('now') WHERE entity_type = ?1 AND entity_id = ?2 AND id <> ?3 AND used_at IS NULL AND revoked_at IS NULL;";

#[cfg(test)]
mod tests {
    use super::*;

    // Vektor kembar dengan `src/lib/validations/approval.test.ts`.

    #[test]
    fn izin_dan_jawaban_klien() {
        assert_eq!(approval_permission("SAMPLE"), "samples.manage");
        assert_eq!(approval_permission("DUMMY"), "samples.manage");
        assert_eq!(approval_permission("MOU"), "mou.manage");
        for action in ["CLIENT_ACC", "DUMMY_REVISE", "MOU_REJECT"] {
            assert!(is_client_decision_action(action), "{action}");
        }
        for action in ["SAMPLE_SENT", "PRINT_DUMMY", "SEND_MOU", "CANCEL"] {
            assert!(!is_client_decision_action(action), "{action}");
        }
        assert_eq!(
            ["CLIENT_ACC", "DUMMY_REVISE", "PRINT_DUMMY", "DUMMY_SENT"].map(step_evidence_purpose),
            [Some("CLIENT_RESPONSE"), Some("CLIENT_RESPONSE"), Some("DUMMY_ARTWORK"), None]
        );
        assert_eq!(
            approval_url("https://crm.company.id", "abc_DEF-123"),
            "https://crm.company.id/approve?t=abc_DEF-123"
        );
    }
}
