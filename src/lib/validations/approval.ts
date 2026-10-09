/**
 * Persetujuan klien: tautan sekali pakai dan jalur manual (PRD F-18, v2.5b,
 * D-38). Satu mesin untuk tiga hal yang menunggu jawaban klien: sampel yang
 * dikirim (`SAMPLE_SENT`), dummy yang dikirim (`DUMMY_SENT`), dan MoU yang
 * dikirim (`SENT`).
 *
 * Tabel `approval_tokens` cloud-only dan hanya memegang hash token. Tautan
 * dibuat perangkat atau Web langsung di cloud (keputusan J); jawabannya
 * diterapkan Web dengan aturan langkah yang sama seperti pencatatan manual.
 *
 * Konstanta yang dipakai Rust WAJIB identik dengan
 * `src-tauri/src/desktop/approval.rs` (dites per karakter).
 */

export const APPROVAL_ENTITY_TYPES = ["SAMPLE", "DUMMY", "MOU"] as const;
export type ApprovalEntityType = (typeof APPROVAL_ENTITY_TYPES)[number];

export const APPROVAL_DECISIONS = ["APPROVE", "REVISE", "REJECT"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export function isApprovalEntityType(
  value: unknown,
): value is ApprovalEntityType {
  return (
    typeof value === "string" &&
    (APPROVAL_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

/** Izin membuat tautan: sama dengan izin mencatat jawabannya manual. Padanan `approval_permission`. */
export function approvalPermission(type: unknown) {
  return type === "MOU" ? "mou.manage" : "samples.manage";
}

/**
 * Langkah yang dicatat untuk jawaban klien; `null` = pilihan itu tidak ada
 * untuk jenis ini (dummy tidak bisa ditolak, hanya direvisi).
 */
export function approvalStepAction(
  type: ApprovalEntityType,
  decision: ApprovalDecision,
): string | null {
  const actions: Record<
    ApprovalEntityType,
    Record<ApprovalDecision, string | null>
  > = {
    SAMPLE: {
      APPROVE: "CLIENT_ACC",
      REVISE: "CLIENT_REVISE",
      REJECT: "CLIENT_REJECT",
    },
    DUMMY: { APPROVE: "DUMMY_ACC", REVISE: "DUMMY_REVISE", REJECT: null },
    MOU: { APPROVE: "MOU_ACCEPT", REVISE: "MOU_REVISE", REJECT: "MOU_REJECT" },
  };
  return actions[type][decision];
}

/**
 * Langkah yang mencatat jawaban klien. Dicatat manual oleh staf, langkah ini
 * WAJIB membawa tangkapan layar balasan klien (keputusan N, foto
 * `CLIENT_RESPONSE`). Padanan `is_client_decision_action`.
 */
export const CLIENT_DECISION_ACTIONS = [
  "CLIENT_ACC",
  "CLIENT_REVISE",
  "CLIENT_REJECT",
  "DUMMY_ACC",
  "DUMMY_REVISE",
  "MOU_ACCEPT",
  "MOU_REVISE",
  "MOU_REJECT",
] as const;

export function isClientDecisionAction(action: unknown) {
  return (
    typeof action === "string" &&
    (CLIENT_DECISION_ACTIONS as readonly string[]).includes(action)
  );
}

export const CLIENT_EVIDENCE_REQUIRED =
  "Attach a screenshot of the client's reply.";
export const APPROVAL_LINK_UNAVAILABLE =
  "The client cannot answer this yet. Sync first, and check that it was sent to the client.";
export const APPROVAL_LINK_DISABLED =
  "Set the approval web address in Business settings first.";
/** Halaman E-24: tautan kedaluwarsa, sudah dipakai, dicabut, atau dimanipulasi. */
export const APPROVAL_INVALID =
  "This approval link is not valid or has expired.";

export const APPROVAL_RESPONDER_MAX = 100;
export const APPROVAL_NOTES_MAX = 800;

export interface ApprovalResponse {
  decision: ApprovalDecision;
  responder_name: string;
  notes: string;
}

/** Jawaban dari halaman klien. Revisi wajib menyebut apa yang diubah. */
export function validateApprovalResponse(
  input: unknown,
): { response: ApprovalResponse } | { error: string } {
  const raw =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const decision = raw.decision;
  if (
    typeof decision !== "string" ||
    !(APPROVAL_DECISIONS as readonly string[]).includes(decision)
  ) {
    return { error: "Choose your answer." };
  }
  const name =
    typeof raw.responder_name === "string" ? raw.responder_name.trim() : "";
  if (!name || [...name].length > APPROVAL_RESPONDER_MAX) {
    return { error: "Enter your name, up to 100 characters." };
  }
  const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";
  if ([...notes].length > APPROVAL_NOTES_MAX) {
    return { error: "Notes are up to 800 characters." };
  }
  if (decision === "REVISE" && !notes) {
    return { error: "Tell us what to change." };
  }
  return {
    response: {
      decision: decision as ApprovalDecision,
      responder_name: name,
      notes,
    },
  };
}

/** Tautan yang dikirim ke klien. Padanan `approval_url`. */
export function approvalUrl(baseUrl: string, token: string) {
  return `${baseUrl}/approve?t=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// SQL. Tabel cloud-only; yang dipakai Rust WAJIB identik dengan `approval.rs`.
// ---------------------------------------------------------------------------

/** Keadaan terkini hal yang disetujui: ?1 jenis, ?2 id. */
export const APPROVAL_TARGET_SQL =
  "SELECT 'SAMPLE' AS entity_type, s.id AS entity_id, s.id AS sample_request_id, s.status, s.revision_index AS revision FROM sample_requests s WHERE ?1 = 'SAMPLE' AND s.id = ?2 UNION ALL SELECT 'DUMMY', d.id, d.sample_request_id, d.status, d.dummy_rejection_count FROM design_tickets d WHERE ?1 = 'DUMMY' AND d.id = ?2 UNION ALL SELECT 'MOU', m.id, m.sample_request_id, m.status, 0 FROM production_mou m WHERE ?1 = 'MOU' AND m.id = ?2";

/**
 * ?1 jenis, ?2 id hal itu, ?3 id token, ?4 hash token, ?5 masa berlaku
 * (hari), ?6 pembuat. Hanya menulis bila hal itu di cloud sedang menunggu
 * jawaban klien; kedaluwarsa dihitung database (keputusan L).
 */
export const APPROVAL_INSERT_SQL = `INSERT INTO approval_tokens (id, token_hash, entity_type, entity_id, sample_request_id, base_status, base_revision, expires_at, created_by, created_at) SELECT ?3, ?4, t.entity_type, t.entity_id, t.sample_request_id, t.status, t.revision, datetime('now', '+' || ?5 || ' days'), ?6, datetime('now') FROM (${APPROVAL_TARGET_SQL}) t WHERE t.status = CASE t.entity_type WHEN 'SAMPLE' THEN 'SAMPLE_SENT' WHEN 'DUMMY' THEN 'DUMMY_SENT' ELSE 'SENT' END;`;

/** Tautan baru membatalkan tautan lama untuk hal yang sama. ?3 = token baru. */
export const APPROVAL_REVOKE_OTHERS_SQL =
  "UPDATE approval_tokens SET revoked_at = datetime('now') WHERE entity_type = ?1 AND entity_id = ?2 AND id <> ?3 AND used_at IS NULL AND revoked_at IS NULL;";

/** Token yang masih bisa dipakai (Web saja). ?1 = hash token. */
export const APPROVAL_LOOKUP_SQL =
  "SELECT * FROM approval_tokens WHERE token_hash = ?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now');";

/** Tandai dipakai, sekali saja (Web saja). ?1 id, ?2 jawaban. */
export const APPROVAL_USE_SQL =
  "UPDATE approval_tokens SET used_at = datetime('now'), response_json = ?2 WHERE id = ?1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now');";
