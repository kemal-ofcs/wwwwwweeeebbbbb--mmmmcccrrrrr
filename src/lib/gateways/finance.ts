"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { FinanceOptionKind } from "@/lib/validations/finance";

/**
 * Gateway tagihan dan uang masuk (PRD F-17, v2.3a). Tauri:
 * `desktop_*_finance*` / `desktop_*_invoice` / `desktop_*_fund` membaca SQLite
 * lokal dan mengantre outbox. Web: `/api/finance/*`.
 */

export interface FinanceOptionRecord {
  id: string;
  kind: FinanceOptionKind;
  label: string;
  rate_bp: number;
  /** Hanya paket cicilan: jumlah cicilan bulanan. */
  installment_count: number | null;
  /** 1 = aktif. */
  is_active: number;
  sort_order: number;
  updated_at: string;
}

export interface InvoiceRecord {
  id: string;
  invoice_number: string;
  client_id: string;
  client_code: string | null;
  client_name: string | null;
  client_address: string | null;
  client_city: string | null;
  client_province: string | null;
  sample_request_id: string;
  brand_name: string | null;
  ref_type: string;
  revision_index: number;
  description: string;
  subtotal_idr: number;
  discount_label: string;
  discount_bp: number;
  discount_idr: number;
  taxes_json: string;
  tax_idr: number;
  total_idr: number;
  issued_on: string;
  due_on: string;
  /**
   * `OPEN`, `CANCELLED`, atau `RESCHEDULED` (sisanya dijadwal ulang menjadi
   * cicilan, v2.3b); lunas = `paid_idr >= total_idr`.
   */
  status: string;
  /** Tagihan cicilan: tagihan asalnya dan urutannya (v2.3b). */
  parent_invoice_id: string;
  installment_no: number;
  cancel_reason: string;
  paid_idr: number;
  created_by: number | null;
  created_at: string;
}

export interface FundRecord {
  id: string;
  client_id: string;
  client_code: string | null;
  client_name: string | null;
  received_on: string;
  amount_idr: number;
  description: string;
  proof_media_id: string;
  /** `ACTIVE` atau `VOID`. */
  status: string;
  void_reason: string;
  allocated_idr: number;
  /** '' = sisa uang masuk belum disimpan sebagai deposit klien (v2.3b). */
  deposit_confirmed_at: string;
  deposit_confirmed_by: number | null;
  recorded_by: number | null;
  created_at: string;
}

export interface AllocationRecord {
  id: string;
  fund_id: string;
  invoice_id: string;
  invoice_number: string | null;
  amount_idr: number;
  recorded_by: number | null;
  recorded_by_name: string | null;
  recorded_at: string;
}

export interface FinanceOverview {
  options: FinanceOptionRecord[];
  invoices: InvoiceRecord[];
  funds: FundRecord[];
  allocations: AllocationRecord[];
  defaults: {
    default_sample_fee_idr: number;
    default_test_fee_idr: number;
    default_dummy_fee_idr: number;
    invoice_due_days: number;
    /** Dicetak di invoice PDF (v2.3c). */
    invoice_payment_instructions: string;
  };
}

export interface FinanceOptionInput {
  /** '' = baru. */
  id: string;
  kind: FinanceOptionKind;
  label: string;
  rate_bp: number;
  /** Wajib untuk paket cicilan (1-24), null untuk pajak/diskon. */
  installment_count: number | null;
  is_active: boolean;
}

export interface InvoiceInput {
  ref_type: string;
  /** '' hanya untuk tagihan `OTHER`. */
  sample_request_id: string;
  /** Hanya dibaca untuk tagihan tanpa tiket. */
  client_id: string;
  description: string;
  subtotal_idr: number;
  /** '' = tanpa diskon. */
  discount_option_id: string;
  tax_option_ids: string[];
}

export interface FundInput {
  received_on: string;
  amount_idr: number;
  /** '' = pemilik mutasi belum diketahui. */
  client_id: string;
  description: string;
  /** Foto bukti yang SUDAH dikompresi (`compressImageToWebp`), '' = tanpa. */
  proof_base64: string;
}

export async function getFinanceOverview(): Promise<FinanceOverview> {
  if (isDesktopRuntime()) {
    return invokeDesktop<FinanceOverview>("desktop_get_finance_overview");
  }
  return requestWebApi<FinanceOverview>("/api/finance/query", "POST");
}

export async function saveFinanceOption(
  option: FinanceOptionInput,
): Promise<{ id: string }> {
  const body = {
    id: option.id,
    kind: option.kind,
    label: option.label,
    rate_bp: option.rate_bp,
    installment_count: option.installment_count,
    is_active: option.is_active,
  };
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_save_finance_option", { option: body });
  }
  return requestWebApi("/api/finance/options", "POST", { option: body });
}

export async function createInvoice(
  invoice: InvoiceInput,
): Promise<{ id: string; invoice_number: string; total_idr: number }> {
  const body = {
    ref_type: invoice.ref_type,
    sample_request_id: invoice.sample_request_id,
    client_id: invoice.client_id,
    description: invoice.description,
    subtotal_idr: invoice.subtotal_idr,
    discount_option_id: invoice.discount_option_id,
    tax_option_ids: invoice.tax_option_ids,
  };
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_create_invoice", { invoice: body });
  }
  return requestWebApi("/api/finance/invoices", "POST", { invoice: body });
}

export async function cancelInvoice(
  id: string,
  reason: string,
): Promise<{ id: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_cancel_invoice", { id, reason });
  }
  return requestWebApi("/api/finance/invoices/cancel", "POST", { id, reason });
}

export async function recordIncomingFund(
  fund: FundInput,
): Promise<{ id: string }> {
  const body = {
    received_on: fund.received_on,
    amount_idr: fund.amount_idr,
    client_id: fund.client_id,
    description: fund.description,
    proof_base64: fund.proof_base64,
  };
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_record_incoming_fund", { fund: body });
  }
  return requestWebApi("/api/finance/funds", "POST", { fund: body });
}

export async function voidIncomingFund(
  id: string,
  reason: string,
): Promise<{ id: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_void_incoming_fund", { id, reason });
  }
  return requestWebApi("/api/finance/funds/void", "POST", { id, reason });
}

export async function allocateFund(
  fundId: string,
  invoiceId: string,
  amountIdr: number,
): Promise<{ id: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_allocate_fund", {
      fundId,
      invoiceId,
      amountIdr,
    });
  }
  return requestWebApi("/api/finance/funds/allocate", "POST", {
    fund_id: fundId,
    invoice_id: invoiceId,
    amount_idr: amountIdr,
  });
}

/**
 * Terima pembayaran sebagian dan jadwalkan ulang sisanya dengan satu paket
 * cicilan (v2.3b). Hanya untuk `payments.approve_exception`.
 */
export async function acceptPartialPayment(
  fundId: string,
  invoiceId: string,
  amountIdr: number,
  planOptionId: string,
): Promise<{ id: string; installments: number; total_idr: number }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_accept_partial_payment", {
      fundId,
      invoiceId,
      amountIdr,
      planOptionId,
    });
  }
  return requestWebApi("/api/finance/invoices/reschedule", "POST", {
    fund_id: fundId,
    invoice_id: invoiceId,
    amount_idr: amountIdr,
    plan_option_id: planOptionId,
  });
}

/** Simpan sisa uang masuk sebagai deposit klien (v2.3b). */
export async function confirmDeposit(
  fundId: string,
  clientId: string,
): Promise<{ id: string }> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_confirm_deposit", { fundId, clientId });
  }
  return requestWebApi("/api/finance/funds/deposit", "POST", {
    fund_id: fundId,
    client_id: clientId,
  });
}
