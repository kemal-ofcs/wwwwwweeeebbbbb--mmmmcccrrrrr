import type { StatusTone } from "@/components/ui/StatusBadge";

/** Label tampilan tagihan dan uang masuk (PRD F-17). */

export const INVOICE_TYPE_LABEL: Record<string, string> = {
  SAMPLE_FEE: "Sample fee",
  REVISION_FEE: "Revision fee",
  TEST_FEE: "Testing fee",
  DUMMY_FEE: "Dummy fee",
  DP_PRODUCTION_LEGAL: "Down payment (production & legal)",
  OTHER: "Other",
  INSTALLMENT: "Installment",
};

interface InvoiceState {
  status: string;
  paid_idr: number;
  total_idr: number;
}

/** Lunas dihitung dari alokasi, tidak disimpan (`paid_idr`). */
export function invoiceStatusLabel(invoice: InvoiceState) {
  if (invoice.status === "CANCELLED") return "Cancelled";
  // Sisa tagihan dijadwal ulang menjadi cicilan (v2.3b).
  if (invoice.status === "RESCHEDULED") return "In installments";
  if (invoice.paid_idr >= invoice.total_idr) return "Paid";
  return invoice.paid_idr > 0 ? "Partly paid" : "Unpaid";
}

export function invoiceTone(invoice: InvoiceState): StatusTone {
  if (invoice.status === "CANCELLED") return "neutral";
  if (invoice.status === "RESCHEDULED") return "info";
  return invoice.paid_idr >= invoice.total_idr ? "success" : "warning";
}

/**
 * Belum lunas dan lewat jatuh tempo. Hanya tampilan, memakai tanggal lokal
 * perangkat; tidak ada denda (batasan v2.3b).
 */
export function isOverdue(
  invoice: InvoiceState & { due_on: string },
  today: string,
) {
  return (
    invoice.status === "OPEN" &&
    invoice.paid_idr < invoice.total_idr &&
    invoice.due_on < today
  );
}

/** `YYYY-MM-DD` lokal perangkat. */
export function localToday() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
