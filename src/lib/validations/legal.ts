/**
 * Dokumen legal: uji gizi SIG, BPOM MD/NA, Halal, dan HKI (PRD F-21, v2.6,
 * D-39). Satu baris per dokumen per MoU (`legal_documents`), supaya RnD
 * (SIG) dan Legal (BPOM/Halal/HKI) tidak menyunting baris yang sama dari
 * perangkat berbeda. Dokumen wajib diturunkan dari jalur regulasi MoU (B-10).
 *
 * WAJIB identik dengan `src-tauri/src/desktop/legal.rs`. Kedua sisi diuji
 * dengan vektor yang sama (`legal.test.ts` dan `mod tests` di sana), dan
 * setiap konstanta SQL di bawah dites ada per karakter di Rust.
 */

import { isCalendarDate } from "./sample";

export const LEGAL_KINDS = ["SIG", "BPOM", "HALAL", "HKI"] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];

export const LEGAL_STATUSES = ["SUBMITTED", "ISSUED", "NOT_REQUIRED"] as const;
export type LegalStatus = (typeof LEGAL_STATUSES)[number];

export const BPOM_TYPES = ["MD", "NA"] as const;

export const LEGAL_NUMBER_MAX = 100;
export const LEGAL_NOTES_MAX = 800;

/** Dokumen wajib per jalur regulasi (keputusan B, B-10). Padanan `required_legal_kinds`. */
export function requiredLegalKinds(path: string): LegalKind[] {
  return path === "WITH_BPOM" ? ["SIG", "BPOM", "HKI", "HALAL"] : ["HALAL"];
}

/** Cakupan Halal mengikuti jalur: White Label = bahan, Dengan BPOM = produk. */
export function halalScope(path: string) {
  return path === "WITH_BPOM" ? "PRODUCT" : "MATERIAL";
}

/** SIG dicatat RnD (B-9, US-37); sisanya Legal (keputusan G). Padanan `legal_kind_permission`. */
export function legalKindPermission(kind: unknown) {
  return kind === "SIG" ? "rnd.manage" : "legal.manage";
}

export interface LegalRecord {
  kind: LegalKind;
  status: LegalStatus;
  reference_no: string;
  certificate_no: string;
  /** Hanya BPOM: `MD` atau `NA`. */
  bpom_type: string;
  submitted_on: string;
  issued_on: string;
  expires_on: string;
  notes: string;
}

function text(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.trim() : null;
}

/**
 * Isian satu langkah dokumen (keputusan E, F). Isian yang tidak dipakai
 * status itu dikosongkan. Padanan `validate_legal_record`.
 */
export function validateLegalRecord(
  input: unknown,
): { record: LegalRecord } | { error: string } {
  const raw =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const kind = raw.kind;
  if (
    typeof kind !== "string" ||
    !(LEGAL_KINDS as readonly string[]).includes(kind)
  ) {
    return { error: "Choose the document." };
  }
  const status = raw.status;
  if (
    typeof status !== "string" ||
    !(LEGAL_STATUSES as readonly string[]).includes(status)
  ) {
    return { error: "Choose what happened to the document." };
  }
  const notes = text(raw, "notes");
  if (notes === null || [...notes].length > LEGAL_NOTES_MAX) {
    return { error: "Notes are up to 800 characters." };
  }
  const empty = {
    reference_no: "",
    certificate_no: "",
    bpom_type: "",
    submitted_on: "",
    issued_on: "",
    expires_on: "",
  };
  if (status === "NOT_REQUIRED") {
    if (kind === "BPOM")
      return { error: "BPOM registration cannot be skipped." };
    if (!notes) return { error: "Write why this document is not required." };
    return {
      record: { kind: kind as LegalKind, status, ...empty, notes },
    };
  }
  const reference = text(raw, "reference_no");
  if (!reference || [...reference].length > LEGAL_NUMBER_MAX) {
    return { error: "Enter the submission number, up to 100 characters." };
  }
  const submitted = text(raw, "submitted_on");
  if (!submitted || !isCalendarDate(submitted)) {
    return { error: "Enter the submission date." };
  }
  const bpomType = text(raw, "bpom_type") ?? "";
  if (
    kind === "BPOM" &&
    !(BPOM_TYPES as readonly string[]).includes(bpomType)
  ) {
    return { error: "Choose MD or NA for the BPOM registration." };
  }
  const base = {
    ...empty,
    reference_no: reference,
    bpom_type: kind === "BPOM" ? bpomType : "",
    submitted_on: submitted,
  };
  if (status === "SUBMITTED") {
    return {
      record: { kind: kind as LegalKind, status, ...base, notes },
    };
  }
  const certificate = text(raw, "certificate_no");
  if (!certificate || [...certificate].length > LEGAL_NUMBER_MAX) {
    return { error: "Enter the certificate number, up to 100 characters." };
  }
  const issued = text(raw, "issued_on");
  if (!issued || !isCalendarDate(issued)) {
    return { error: "Enter the issue date." };
  }
  if (issued < submitted) {
    return { error: "The issue date cannot be before the submission date." };
  }
  const expires = text(raw, "expires_on");
  if (expires === null || (expires !== "" && !isCalendarDate(expires))) {
    return { error: "Enter a valid expiry date, or leave it empty." };
  }
  if (expires !== "" && expires <= issued) {
    return { error: "The expiry date must be after the issue date." };
  }
  return {
    record: {
      kind: kind as LegalKind,
      status: "ISSUED",
      ...base,
      certificate_no: certificate,
      issued_on: issued,
      expires_on: expires,
      notes,
    },
  };
}

export interface LegalGateState {
  mou_status: string;
  regulatory_path: string;
  dp_cleared: boolean;
  /** Status dokumen yang sudah tercatat untuk MoU ini, per jenis. */
  statuses: Partial<Record<string, string>>;
}

export const LEGAL_DP_PENDING =
  "Waiting for Finance to verify the production & legal down payment.";
const FINAL: readonly string[] = ["ISSUED", "NOT_REQUIRED"];

/**
 * Gerbang satu langkah dokumen (keputusan D, E-21). `null` = boleh.
 * Padanan `legal_gate_error`.
 */
export function legalGateError(
  state: LegalGateState,
  kind: string,
): string | null {
  if (state.mou_status !== "ACCEPTED") {
    return "The client has not accepted the MoU yet.";
  }
  if (!state.dp_cleared) return LEGAL_DP_PENDING;
  if (!(requiredLegalKinds(state.regulatory_path) as string[]).includes(kind)) {
    return "This document is not needed on this regulatory path.";
  }
  if (FINAL.includes(state.statuses[kind] ?? "")) {
    return "This document is already final.";
  }
  if (kind === "BPOM" && !FINAL.includes(state.statuses.SIG ?? "")) {
    return "Record the SIG nutrition test first.";
  }
  return null;
}

/** Semua dokumen wajib sudah terbit atau tidak diperlukan. Padanan `legal_complete`. */
export function legalComplete(
  path: string,
  statuses: Partial<Record<string, string>>,
) {
  return requiredLegalKinds(path).every((kind) =>
    FINAL.includes(statuses[kind] ?? ""),
  );
}

/** Catatan linimasa satu langkah dokumen. Padanan `legal_log_notes`. */
export function legalLogNotes(record: LegalRecord) {
  if (record.status === "NOT_REQUIRED") return `Not required: ${record.notes}`;
  const parts =
    record.status === "ISSUED"
      ? [`Issued, certificate ${record.certificate_no}`]
      : [`Submitted, number ${record.reference_no}`];
  if (record.bpom_type) parts.push(`(${record.bpom_type})`);
  if (record.notes) parts.push(`- ${record.notes}`);
  return parts.join(" ");
}

export const LEGAL_CHANGED_ELSEWHERE =
  "This document was changed on another device first. Open it again to see the latest version.";

// ---------------------------------------------------------------------------
// SQL. Setiap konstanta WAJIB identik dengan padanannya di `legal.rs`.
// ---------------------------------------------------------------------------

/** Dokumen satu MoU/tiket; pemanggil menambah `WHERE` dan `ORDER BY`. */
export const LEGAL_LIST_SQL =
  "SELECT l.*, o.nama_operator AS updated_by_name FROM legal_documents l LEFT JOIN master_operator o ON o.id = l.updated_by";

/** Baris yang sudah ada untuk (MoU, jenis); tanpa UNIQUE, yang tertua menang. */
export const LEGAL_EXISTING_SQL =
  "SELECT id, status, updated_at FROM legal_documents WHERE mou_id = ?1 AND kind = ?2 ORDER BY created_at, rowid LIMIT 1;";

/**
 * ?1 id, ?2 MoU, ?3 tiket, ?4 jenis, ?5 status, ?6-?12 isian, ?13 pencatat,
 * ?14 waktu, ?15 `updated_at` yang dilihat pencatat ('' = baris baru).
 * Suntingan basi dari perangkat lain tidak menimpa (WHERE pada DO UPDATE).
 */
export const LEGAL_UPSERT_SQL =
  "INSERT INTO legal_documents (id, mou_id, sample_request_id, kind, status, reference_no, certificate_no, bpom_type, submitted_on, issued_on, expires_on, notes, updated_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14) ON CONFLICT(id) DO UPDATE SET status = excluded.status, reference_no = excluded.reference_no, certificate_no = excluded.certificate_no, bpom_type = excluded.bpom_type, submitted_on = excluded.submitted_on, issued_on = excluded.issued_on, expires_on = excluded.expires_on, notes = excluded.notes, updated_by = excluded.updated_by, updated_at = excluded.updated_at WHERE legal_documents.updated_at = ?15 AND legal_documents.status NOT IN ('ISSUED', 'NOT_REQUIRED');";
