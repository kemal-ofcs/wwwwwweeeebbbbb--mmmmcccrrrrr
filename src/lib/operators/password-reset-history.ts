/**
 * Bentuk data riwayat pengajuan "Lupa Password".
 *
 * Dipisah dari layanan servernya supaya komponen klien dan gateway bisa
 * mengimpor tipe ini tanpa ikut menarik `@libsql/client` atau `server-only`.
 */

export const RESET_HISTORY_STATUSES = [
  "Pending Verification",
  "Sent",
  "Used",
  "Expired",
  "Cancelled",
] as const;

export type ResetHistoryStatus = (typeof RESET_HISTORY_STATUSES)[number];

/**
 * `delivery_status` jalur `in_app` sebelum peninjau menyetujui. Nilai yang sama
 * ditulis `password-reset.ts` dan `turso.rs`; UI memakainya untuk menentukan
 * kapan tombol Approve boleh tampil.
 */
export const RESET_DELIVERY_AWAITING_APPROVAL = "Awaiting Approval";

export function isResetHistoryStatus(
  value: unknown,
): value is ResetHistoryStatus {
  return (
    typeof value === "string" &&
    (RESET_HISTORY_STATUSES as readonly string[]).includes(value)
  );
}

export interface ResetHistoryEntry {
  id: string;
  operatorId: number;
  operatorName: string;
  username: string;
  kodeOperator: string;
  /** Apa yang diketik pemohon pada langkah pencarian akun. */
  identifierUsed: string;
  maskedEmail: string;
  status: ResetHistoryStatus;
  /** 0..1, atau null bila verifikasi wajah belum sempat dinilai. */
  livenessScore: number | null;
  livenessReason: string;
  livenessChallenges: string[];
  deliveryStatus: string;
  deliveryError: string;
  hasPhoto: boolean;
  requestedAt: string;
  verifiedAt: string;
  sentAt: string;
  usedAt: string;
  expiresAt: string;
}

export interface ResetHistoryFilter {
  status?: ResetHistoryStatus | "ALL";
  /** Cocokkan nama, username, kode operator, atau identitas yang diketik. */
  search?: string;
  limit?: number;
}

export interface ResetHistoryPhoto {
  mime: string;
  base64: string;
}

export const RESET_HISTORY_DEFAULT_LIMIT = 100;
export const RESET_HISTORY_MAX_LIMIT = 500;

/** Nada badge status untuk UI. Satu peta supaya Web dan Mobile tidak drift. */
export const RESET_HISTORY_STATUS_TONE: Record<
  ResetHistoryStatus,
  "info" | "success" | "warning" | "danger" | "neutral"
> = {
  "Pending Verification": "warning",
  Sent: "info",
  Used: "success",
  Expired: "neutral",
  Cancelled: "danger",
};

export const RESET_HISTORY_STATUS_HINT: Record<ResetHistoryStatus, string> = {
  "Pending Verification":
    "The requester stopped before face verification finished. No link was sent.",
  Sent: "A reset link was sent to the account owner's email and is still valid.",
  Used: "The password was changed with this link.",
  Expired: "The link was not used before it expired.",
  Cancelled:
    "Stopped by the system: face verification failed, the email could not be sent, or the requester made a new request.",
};
