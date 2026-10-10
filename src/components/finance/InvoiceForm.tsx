"use client";

import { type FormEvent, useMemo, useRef, useState } from "react";
import { SAMPLE_STATUS_LABEL } from "@/components/samples/labels";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import type { ClientRecord } from "@/lib/gateways/clients";
import { createInvoice, type FinanceOverview } from "@/lib/gateways/finance";
import type { SampleRequestRecord } from "@/lib/gateways/samples";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { formatDateTime } from "@/lib/utils/format";
import {
  computeInvoice,
  INVOICE_DESCRIPTION_MAX,
  INVOICE_REF_TYPES,
} from "@/lib/validations/finance";
import {
  SHIP_NO_SETTLEMENT,
  SHIP_STORAGE_UNBILLED,
} from "@/lib/validations/production";
import { formatRupiah } from "@/lib/validations/sample";
import { INVOICE_TYPE_LABEL } from "./labels";

/**
 * Form tagihan baru (PRD F-17, keputusan B/C/E). Total di sini hanya
 * pratinjau `computeInvoice`; backend menghitung ulang dengan tarif aktif
 * dari database dan menolak pajak/diskon yang sudah dinonaktifkan.
 */

interface InvoiceFormProps {
  overview: FinanceOverview;
  clients: ClientRecord[];
  samples: SampleRequestRecord[];
  /** Tiket yang dipilih dari detail tiket (`/finance?sample=`). */
  initialSampleId: string;
  onSaved: (invoiceNumber: string) => void;
  onClose: () => void;
}

/** Jenis tagihan yang paling mungkin dibutuhkan tiket itu saat ini. */
function suggestedType(sample: SampleRequestRecord | undefined) {
  if (!sample) return "OTHER";
  if (sample.status === "WAITING_REVISION_PAYMENT") return "REVISION_FEE";
  // Sesudah Packing: pelunasan, lalu biaya titip bila ada (v3.3).
  if (sample.ship_block === SHIP_NO_SETTLEMENT) return "SETTLEMENT";
  if (sample.ship_block === SHIP_STORAGE_UNBILLED) return "STORAGE_FEE";
  if (sample.is_paid_sample === 1 && sample.status === "WAITING_SAMPLE_PAYMENT")
    return "SAMPLE_FEE";
  // MoU disetujui: tagihan DP (v2.5a).
  if (sample.mou_status === "ACCEPTED" && sample.dp_paid !== 1)
    return "DP_PRODUCTION_LEGAL";
  // Tiket desain aktif sesudah klien ACC: fase dummy (v2.4).
  if (sample.design_status && sample.status === "CLIENT_ACC")
    return "DUMMY_FEE";
  if (sample.is_test_requested === 1) return "TEST_FEE";
  return sample.is_paid_sample === 1 ? "SAMPLE_FEE" : "OTHER";
}

export function InvoiceForm({
  overview,
  clients,
  samples,
  initialSampleId,
  onSaved,
  onClose,
}: InvoiceFormProps) {
  const initialSample = samples.find((row) => row.id === initialSampleId);
  const taxes = overview.options.filter(
    (option) => option.kind === "TAX" && option.is_active === 1,
  );
  const discounts = overview.options.filter(
    (option) => option.kind === "DISCOUNT" && option.is_active === 1,
  );
  const prefill = (refType: string, sample?: SampleRequestRecord) => {
    if (refType === "SAMPLE_FEE")
      return overview.defaults.default_sample_fee_idr || "";
    if (refType === "TEST_FEE")
      return overview.defaults.default_test_fee_idr || "";
    if (refType === "REVISION_FEE") return sample?.revision_fee_idr ?? "";
    if (refType === "DUMMY_FEE")
      return overview.defaults.default_dummy_fee_idr || "";
    if (refType === "DP_PRODUCTION_LEGAL") return sample?.mou_dp_idr ?? "";
    // Total MoU − DP sebelum pajak (keputusan B v3.3); biaya titip berjalan.
    if (refType === "SETTLEMENT") return sample?.settlement_default_idr ?? "";
    if (refType === "STORAGE_FEE") return sample?.storage_fee_idr ?? "";
    return "";
  };

  const [clientId, setClientId] = useState(initialSample?.client_id ?? "");
  const [sampleId, setSampleId] = useState(initialSample?.id ?? "");
  const [refType, setRefType] = useState(suggestedType(initialSample));
  const [subtotal, setSubtotal] = useState(
    String(prefill(suggestedType(initialSample), initialSample)),
  );
  const [description, setDescription] = useState("");
  const [discountId, setDiscountId] = useState("");
  // Keputusan E: semua pajak aktif tercentang; Finance boleh melepasnya.
  const [taxIds, setTaxIds] = useState<string[]>(() =>
    taxes.map((tax) => tax.id),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const clientSamples = useMemo(
    () => samples.filter((row) => row.client_id === clientId),
    [samples, clientId],
  );
  const sample = samples.find((row) => row.id === sampleId);
  const discount = discounts.find((option) => option.id === discountId);
  const preview = computeInvoice({
    subtotal_idr: subtotal.trim() === "" ? 0 : Number(subtotal),
    discount: discount
      ? { label: discount.label, rate_bp: discount.rate_bp }
      : null,
    taxes: taxes
      .filter((tax) => taxIds.includes(tax.id))
      .map((tax) => ({ label: tax.label, rate_bp: tax.rate_bp })),
  });

  const chooseSample = (id: string) => {
    setSampleId(id);
    const next = samples.find((row) => row.id === id);
    const type = suggestedType(next);
    setRefType(type);
    setSubtotal(String(prefill(type, next)));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await createInvoice({
        ref_type: refType,
        sample_request_id: sampleId,
        client_id: clientId,
        description,
        subtotal_idr: subtotal.trim() === "" ? 0 : Number(subtotal),
        discount_option_id: discountId,
        tax_option_ids: taxIds,
      });
      requestSyncNow();
      onSaved(saved.invoice_number);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The invoice was not saved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal title="New invoice" titleId="invoice-form-title" onClose={onClose}>
      <form onSubmit={save} className="grid gap-4">
        {error ? (
          <FeedbackBanner tone="error" onDismiss={() => setError("")}>
            {error}
          </FeedbackBanner>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="app-label grid gap-1.5">
            Client
            <select
              required
              value={clientId}
              onChange={(event) => {
                setClientId(event.target.value);
                setSampleId("");
                setRefType("OTHER");
                setSubtotal("");
              }}
              className="app-input font-normal"
            >
              <option value="">Choose…</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.client_code} · {client.name}
                </option>
              ))}
            </select>
          </label>
          <label className="app-label grid gap-1.5">
            Sample request
            <select
              value={sampleId}
              onChange={(event) => chooseSample(event.target.value)}
              className="app-input font-normal"
            >
              <option value="">None (other charge)</option>
              {clientSamples.map((row) => (
                // Brand bisa sama di beberapa tiket: status dan waktu
                // dibuat membedakannya (temuan uji perangkat v2).
                <option key={row.id} value={row.id}>
                  {`${row.brand_name} · ${SAMPLE_STATUS_LABEL[row.status] ?? row.status} · ${formatDateTime(row.created_at)}`}
                </option>
              ))}
            </select>
          </label>
          <label className="app-label grid gap-1.5">
            For
            <select
              required
              value={refType}
              onChange={(event) => {
                setRefType(event.target.value);
                setSubtotal(String(prefill(event.target.value, sample)));
              }}
              className="app-input font-normal"
            >
              {INVOICE_REF_TYPES.map((type) => (
                <option key={type} value={type}>
                  {INVOICE_TYPE_LABEL[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="app-label grid gap-1.5">
            Amount before discount and tax (Rp)
            <input
              required
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={subtotal}
              onChange={(event) => setSubtotal(event.target.value)}
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            Discount
            <select
              value={discountId}
              onChange={(event) => setDiscountId(event.target.value)}
              className="app-input font-normal"
            >
              <option value="">No discount</option>
              {discounts.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} ({option.rate_bp / 100}%)
                </option>
              ))}
            </select>
          </label>
          <label className="app-label grid gap-1.5">
            Description (optional)
            <input
              maxLength={INVOICE_DESCRIPTION_MAX}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="app-input font-normal"
            />
          </label>
        </div>
        {taxes.length > 0 ? (
          <fieldset className="flex flex-wrap gap-x-6 gap-y-2">
            <legend className="mb-1 text-body-md text-on-surface-variant">
              Taxes
            </legend>
            {taxes.map((tax) => (
              <label
                key={tax.id}
                className="flex min-h-11 items-center gap-2 text-body-md text-on-surface"
              >
                <input
                  type="checkbox"
                  checked={taxIds.includes(tax.id)}
                  onChange={(event) =>
                    setTaxIds((current) =>
                      event.target.checked
                        ? [...current, tax.id]
                        : current.filter((id) => id !== tax.id),
                    )
                  }
                  className="size-4"
                />
                {tax.label} ({tax.rate_bp / 100}%)
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="text-body-sm text-on-surface-variant">
            No taxes are set up. Add them under Settings › Taxes and discounts.
          </p>
        )}
        <p className="text-body-md text-on-surface" aria-live="polite">
          {"error" in preview
            ? preview.error
            : `Discount ${formatRupiah(preview.totals.discount_idr)} · tax ${formatRupiah(preview.totals.tax_idr)} · total ${formatRupiah(preview.totals.total_idr)}`}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy || "error" in preview}
            className="app-btn app-btn-primary"
          >
            {busy ? "Saving…" : "Create invoice"}
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
