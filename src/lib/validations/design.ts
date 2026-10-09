/**
 * Tiket desain: mockup, dummy, gerbang dummy, dan batas penolakan (PRD F-19,
 * v2.4, D-36). Satu tiket desain per tiket sampel; langkahnya ditulis ke
 * `sample_status_log` sehingga tampil di linimasa tiket sampel yang sama.
 *
 * WAJIB identik dengan `src-tauri/src/desktop/design.rs`. Kedua sisi diuji
 * dengan vektor yang sama (`design.test.ts` dan `mod tests` di sana), dan
 * setiap konstanta SQL di bawah dites ada per karakter di Rust.
 */

export const DESIGN_STATUSES = [
  "MOCKUP",
  "DUMMY_PRINTING",
  "DUMMY_SENT",
  "DUMMY_REVISION",
  "DUMMY_ACC",
  "CANCELLED",
] as const;
export type DesignStatus = (typeof DESIGN_STATUSES)[number];

export const DESIGN_ACTIONS = [
  "PRINT_DUMMY",
  "DUMMY_SENT",
  "DUMMY_ACC",
  "DUMMY_REVISE",
  "CANCEL_DESIGN",
] as const;
export type DesignAction = (typeof DESIGN_ACTIONS)[number];

/** Aksi linimasa saat CS membuat brief (bukan langkah `applyDesignAction`). */
export const DESIGN_REQUEST_ACTION = "REQUEST_DESIGN";

export const DESIGN_BRIEF_MAX = 1000;
export const TRACKING_NO_MAX = 100;
export const DUMMY_LIMIT_PERMISSION = "design.override_dummy_limit";

/** Tiket sampel yang sudah selesai tanpa produk tidak bisa meminta desain. */
const CLOSED_SAMPLE_STATUSES = ["RND_REJECTED", "CLIENT_REJECT", "CANCELLED"];

/**
 * Izin tiap langkah (keputusan F): pekerjaan desainer milik `design.manage`,
 * respons klien dan pembatalan milik CS (`samples.manage`). Padanan
 * `design_action_permission`.
 */
export function designActionPermission(action: unknown) {
  return action === "PRINT_DUMMY" || action === "DUMMY_SENT"
    ? "design.manage"
    : "samples.manage";
}

export interface DesignState {
  status: string;
  sample_status: string;
  has_mockup: boolean;
  /** Gerbang bayar putaran ini (`dummy_paid` di `DESIGN_LIST_SQL`). */
  dummy_paid: boolean;
  rejection_count: number;
  /** `max_dummy_rejections`; 0 = tanpa batas. */
  max_rejections: number;
  /** Pencatat memegang `design.override_dummy_limit`. */
  can_override: boolean;
}

export interface DesignResult {
  status: DesignStatus;
  rejection_count: number;
}

export const DUMMY_LIMIT_REACHED =
  "The dummy rejection limit is reached. Only a holder of the limit override permission can print it again.";

/** Batas tercapai: cetak berikutnya butuh izin override (keputusan E). */
export function dummyLimitReached(rejections: number, max: number) {
  return max > 0 && rejections >= max;
}

/**
 * Satu langkah tiket desain. `{ error }` = langkah tidak sah untuk keadaan
 * itu. Padanan `apply_design_action`.
 */
export function applyDesignAction(
  state: DesignState,
  action: string,
): { result: DesignResult } | { error: string } {
  const from = (allowed: DesignStatus[], to: DesignStatus, count = 0) =>
    (allowed as string[]).includes(state.status)
      ? {
          result: {
            status: to,
            rejection_count: state.rejection_count + count,
          },
        }
      : {
          error:
            "This step is not available for the design ticket's current status.",
        };
  switch (action) {
    case "PRINT_DUMMY": {
      const step = from(["MOCKUP", "DUMMY_REVISION"], "DUMMY_PRINTING");
      if ("error" in step) return step;
      if (state.sample_status !== "CLIENT_ACC") {
        return { error: "The client has not approved the sample yet." };
      }
      if (!state.has_mockup) return { error: "Upload the mockup first." };
      if (!state.dummy_paid) {
        return { error: "The dummy invoice for this round is not paid yet." };
      }
      if (
        dummyLimitReached(state.rejection_count, state.max_rejections) &&
        !state.can_override
      ) {
        return { error: DUMMY_LIMIT_REACHED };
      }
      return step;
    }
    case "DUMMY_SENT":
      return from(["DUMMY_PRINTING"], "DUMMY_SENT");
    case "DUMMY_ACC":
      return from(["DUMMY_SENT"], "DUMMY_ACC");
    case "DUMMY_REVISE":
      return from(["DUMMY_SENT"], "DUMMY_REVISION", 1);
    case "CANCEL_DESIGN":
      return from(
        ["MOCKUP", "DUMMY_PRINTING", "DUMMY_SENT", "DUMMY_REVISION"],
        "CANCELLED",
      );
    default:
      return { error: "This design step does not exist." };
  }
}

/** `null` = brief boleh dibuat untuk tiket itu (keputusan A). Padanan `design_request_error`. */
export function designRequestError(
  sampleStatus: string,
  activeTickets: number,
): string | null {
  if (CLOSED_SAMPLE_STATUSES.includes(sampleStatus)) {
    return "A design cannot be requested for a closed sample request.";
  }
  return activeTickets > 0
    ? "This sample request already has a design ticket."
    : null;
}

export const DESIGN_BRIEF_INVALID =
  "Write the design brief, up to 1000 characters.";

/** Brief wajib, ≤ 1000 karakter. */
export function normalizeDesignBrief(value: unknown): string | null {
  const brief = typeof value === "string" ? value.trim() : "";
  return brief && [...brief].length <= DESIGN_BRIEF_MAX ? brief : null;
}

export const TRACKING_NO_INVALID =
  "The tracking number is up to 100 characters.";

/** Nomor resi boleh kosong (dummy diantar sendiri), ≤ 100 karakter. */
export function normalizeTrackingNo(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const text = value.trim();
  return [...text].length <= TRACKING_NO_MAX ? text : null;
}

export const DESIGN_CHANGED_ELSEWHERE =
  "This design ticket was changed on another device first. Open it again to see the latest status.";

// ---------------------------------------------------------------------------
// SQL. Setiap konstanta WAJIB identik dengan padanannya di `design.rs`.
// ---------------------------------------------------------------------------

/**
 * Tiket desain beserta tiket sampel, klien, dan dua gerbang (keputusan B, D):
 * `has_mockup` = tiket sampel punya foto `MOCKUP`; `dummy_paid` = putaran
 * pertama menunggu tagihan `DUMMY_FEE` lunas, putaran berikutnya hanya
 * tertahan oleh tagihan putaran itu yang belum lunas. `revision_index`
 * tagihan dummy = putaran (`dummy_rejection_count`). Pemanggil menambah
 * `WHERE` dan `ORDER BY`.
 */
export const DESIGN_LIST_SQL =
  "SELECT d.*, s.status AS sample_status, s.client_id, s.brand_name, s.is_dummy_required, c.client_code, c.name AS client_name, EXISTS (SELECT 1 FROM media_asset m WHERE m.owner_type = 'sample' AND m.owner_id = d.sample_request_id AND m.purpose = 'MOCKUP') AS has_mockup, CASE WHEN d.dummy_rejection_count = 0 THEN EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = d.sample_request_id AND i.ref_type = 'DUMMY_FEE' AND i.revision_index = 0 AND (i.status = 'RESCHEDULED' OR (i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) >= i.total_idr))) ELSE NOT EXISTS (SELECT 1 FROM invoices i WHERE i.sample_request_id = d.sample_request_id AND i.ref_type = 'DUMMY_FEE' AND i.revision_index = d.dummy_rejection_count AND i.status = 'OPEN' AND (SELECT COALESCE(SUM(a.amount_idr), 0) FROM fund_allocations a WHERE a.invoice_id = i.id) < i.total_idr) END AS dummy_paid FROM design_tickets d JOIN sample_requests s ON s.id = d.sample_request_id LEFT JOIN clients c ON c.id = s.client_id";

/** ?1 = sample id, ?2 = id yang dikecualikan ('' saat membuat). Tanpa UNIQUE: keunikan dijaga di sini. */
export const DESIGN_ACTIVE_SQL =
  "SELECT COUNT(*) AS total FROM design_tickets WHERE sample_request_id = ?1 AND status <> 'CANCELLED' AND id <> ?2;";

/** ?1 id, ?2 sample id, ?3 brief, ?4 waktu, ?5 pembuat. */
export const DESIGN_INSERT_SQL =
  "INSERT INTO design_tickets (id, sample_request_id, brief, status, dummy_rejection_count, dummy_tracking_no, revision_notes, status_changed_at, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, 'MOCKUP', 0, '', '', ?4, ?5, ?4, ?4) ON CONFLICT(id) DO NOTHING;";

/**
 * ?1 id, ?2 status baru, ?3 hitungan tolak baru, ?4 resi (NULL = tetap),
 * ?5 catatan revisi (NULL = tetap), ?6 waktu, ?7/?8 status dan hitungan yang
 * dilihat pencatat. WHERE menjadikan langkah ganda dari dua perangkat no-op.
 */
export const DESIGN_TRANSITION_SQL =
  "UPDATE design_tickets SET status = ?2, dummy_rejection_count = ?3, dummy_tracking_no = COALESCE(?4, dummy_tracking_no), revision_notes = COALESCE(?5, revision_notes), status_changed_at = ?6, updated_at = ?6 WHERE id = ?1 AND status = ?7 AND dummy_rejection_count = ?8;";
