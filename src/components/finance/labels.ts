import type { StatusTone } from "@/components/ui/StatusBadge";

/** Label tampilan tagihan dan uang masuk (PRD F-17). */

export const INVOICE_TYPE_LABEL: Record<string, string> = {
  SAMPLE_FEE: "Sample fee",
  REVISION_FEE: "Revision fee",
  TEST_FEE: "Testing fee",
  DUMMY_FEE: "Dummy fee",
  DP_PRODUCTION_LEGAL: "Down payment (production & legal)",
  SETTLEMENT: "Settlement",
  SHIPPING: "Shipping",
  STORAGE_FEE: "Storage fee",
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

/**
 * Tab penyaring halaman Finance (temuan uji perangkat v2). Bawaan = yang
 * sedang dikerjakan: tagihan belum lunas dan uang masuk belum dialokasikan.
 * Disaring di layar: datanya sudah ada di perangkat (offline-first).
 */
export const INVOICE_FILTERS = [
  ["UNPAID", "Unpaid"],
  ["OVERDUE", "Overdue"],
  ["PAID", "Paid"],
  ["RESCHEDULED", "In installments"],
  ["CANCELLED", "Cancelled"],
  ["ALL", "All"],
] as const;
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number][0];

export function matchesInvoiceFilter(
  filter: InvoiceFilter,
  invoice: InvoiceState & { due_on: string },
  today: string,
) {
  const open = invoice.status === "OPEN";
  switch (filter) {
    case "UNPAID":
      return open && invoice.paid_idr < invoice.total_idr;
    case "OVERDUE":
      return isOverdue(invoice, today);
    case "PAID":
      return open && invoice.paid_idr >= invoice.total_idr;
    case "RESCHEDULED":
    case "CANCELLED":
      return invoice.status === filter;
    default:
      return true;
  }
}

export const FUND_FILTERS = [
  ["UNALLOCATED", "Unallocated"],
  ["DEPOSIT", "Deposits"],
  ["ALLOCATED", "Allocated"],
  ["VOID", "Void"],
  ["ALL", "All"],
] as const;
export type FundFilter = (typeof FUND_FILTERS)[number][0];

export function matchesFundFilter(
  filter: FundFilter,
  fund: {
    status: string;
    amount_idr: number;
    allocated_idr: number;
    deposit_confirmed_at: string;
  },
) {
  const left = fund.status === "ACTIVE" && fund.amount_idr > fund.allocated_idr;
  switch (filter) {
    case "UNALLOCATED":
      return left && !fund.deposit_confirmed_at;
    case "DEPOSIT":
      return left && Boolean(fund.deposit_confirmed_at);
    case "ALLOCATED":
      return fund.status === "ACTIVE" && !left;
    case "VOID":
      return fund.status === "VOID";
    default:
      return true;
  }
}

/** Pencarian bebas: setiap kata harus ada di salah satu teks (huruf kecil). */
export function matchesSearch(
  term: string,
  texts: readonly (string | null | undefined)[],
) {
  const haystack = texts.join(" ").toLowerCase();
  return term
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}
