"use client";

import { type FormEvent, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import {
  acceptPartialPayment,
  type FinanceOptionRecord,
  type FundRecord,
  type InvoiceRecord,
} from "@/lib/gateways/finance";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import {
  computeInstallments,
  partialPaymentError,
} from "@/lib/validations/finance";
import { formatRupiah } from "@/lib/validations/sample";
import { localToday } from "./labels";

/**
 * Terima pembayaran sebagian (PRD F-17, v2.3b, D-29): nominal itu
 * dialokasikan, sisanya dijadwal ulang dengan satu paket cicilan. Pratinjau di
 * sini memakai fungsi yang sama dengan backend; tanggal mulainya diputuskan
 * backend (tanggal perusahaan saat disimpan).
 */

interface PartialPaymentFormProps {
  fund: FundRecord;
  /** Tagihan terbuka yang belum lunas. */
  invoices: InvoiceRecord[];
  plans: FinanceOptionRecord[];
  onSaved: (message: string) => void;
  onClose: () => void;
}

export function PartialPaymentForm({
  fund,
  invoices,
  plans,
  onSaved,
  onClose,
}: PartialPaymentFormProps) {
  const left = fund.amount_idr - fund.allocated_idr;
  const candidates = invoices.filter(
    (invoice) =>
      invoice.ref_type !== "INSTALLMENT" &&
      (!fund.client_id || invoice.client_id === fund.client_id),
  );
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState(String(left));
  const [planId, setPlanId] = useState(plans[0]?.id ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const invoice = candidates.find((row) => row.id === invoiceId);
  const plan = plans.find((row) => row.id === planId);
  const remaining = invoice ? invoice.total_idr - invoice.paid_idr : 0;
  const value = amount.trim() === "" ? 0 : Number(amount);
  const problem = !invoice
    ? "Choose the invoice this payment partly settles."
    : !plan
      ? "Choose an installment plan."
      : partialPaymentError(value, invoice.ref_type, remaining, left);
  const schedule =
    !problem && plan
      ? computeInstallments(
          remaining - value,
          plan.rate_bp,
          plan.installment_count ?? 1,
          localToday(),
        )
      : null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!invoice || !plan || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await acceptPartialPayment(
        fund.id,
        invoice.id,
        value,
        plan.id,
      );
      requestSyncNow();
      onSaved(
        `${invoice.invoice_number}: ${saved.installments} installments totalling ${formatRupiah(saved.total_idr)} created.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nothing was saved.");
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Accept partial payment"
      titleId="partial-payment-title"
      onClose={onClose}
    >
      <form onSubmit={save} className="grid gap-4">
        {error ? (
          <FeedbackBanner tone="error" onDismiss={() => setError("")}>
            {error}
          </FeedbackBanner>
        ) : null}
        <p className="text-body-sm text-on-surface-variant">
          The amount below is allocated now. The rest of the invoice becomes
          monthly installment invoices, with interest charged once on it.
        </p>
        {plans.length === 0 ? (
          <p className="text-body-md text-on-surface-variant">
            No installment plans yet. Add one under Settings › Taxes, discounts,
            and installments.
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="app-label grid gap-1.5 sm:col-span-2">
            Invoice
            <select
              required
              value={invoiceId}
              onChange={(event) => setInvoiceId(event.target.value)}
              className="app-input font-normal"
            >
              <option value="">Choose…</option>
              {candidates.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.invoice_number} · {row.client_code} ·{" "}
                  {formatRupiah(row.total_idr - row.paid_idr)} unpaid
                </option>
              ))}
            </select>
          </label>
          <label className="app-label grid gap-1.5">
            Paid now (Rp)
            <input
              required
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            Installment plan
            <select
              required
              value={planId}
              onChange={(event) => setPlanId(event.target.value)}
              className="app-input font-normal"
            >
              {plans.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label} ({row.installment_count} months,{" "}
                  {row.rate_bp / 100}%)
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="text-body-md text-on-surface" aria-live="polite">
          {problem ??
            (schedule ? (
              <div className="grid gap-1">
                <p>
                  Unpaid {formatRupiah(remaining - value)} + interest{" "}
                  {formatRupiah(schedule.interest_idr)} ={" "}
                  {formatRupiah(schedule.total_idr)}
                </p>
                <ul className="text-body-sm text-on-surface-variant">
                  {schedule.lines.map((line) => (
                    <li key={line.installment_no}>
                      {line.installment_no}. {formatRupiah(line.amount_idr)} due
                      about {line.due_on}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null)}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy || problem !== null}
            className="app-btn app-btn-primary"
          >
            {busy ? "Saving…" : "Accept and create installments"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="app-btn app-btn-secondary"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
