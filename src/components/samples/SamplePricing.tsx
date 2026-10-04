"use client";

import { type FormEvent, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import {
  recordSamplePrice,
  type SamplePriceEntry,
} from "@/lib/gateways/samples";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { formatDateTime } from "@/lib/utils/format";
import {
  computeUnitPrice,
  formatRupiah,
  SAMPLE_NOTES_MAX,
} from "@/lib/validations/sample";

/**
 * Harga Finance per iterasi tiket (v2.2, PRD F-16, D-27). Harga jual dihitung
 * `computeUnitPrice` yang sama dengan backend; tampilan di sini hanya
 * pratinjau. Rincian biaya hanya datang dari backend untuk `pricing.view`.
 */

const COMPONENTS = [
  ["raw_material_cost_idr", "Raw materials"],
  ["packaging_cost_idr", "Packaging"],
  ["operational_cost_idr", "Operations"],
  ["regulatory_cost_idr", "Regulatory and testing (optional)"],
] as const;
type CostKey = (typeof COMPONENTS)[number][0];

interface SamplePricingProps {
  sampleId: string;
  status: string;
  /** Iterasi yang sedang berjalan (revisi + 1). */
  iteration: number;
  prices: SamplePriceEntry[];
  canPrice: boolean;
  onSaved: () => void;
}

function wholeNumber(value: string) {
  return value.trim() === "" ? 0 : Number(value);
}

export function SamplePricing({
  sampleId,
  status,
  iteration,
  prices,
  canPrice,
  onSaved,
}: SamplePricingProps) {
  // Revisi biasanya berangkat dari harga sebelumnya, jadi form diisi darinya.
  const last = prices[prices.length - 1];
  const [costs, setCosts] = useState<Record<CostKey, string>>(() => ({
    raw_material_cost_idr: String(last?.raw_material_cost_idr ?? ""),
    packaging_cost_idr: String(last?.packaging_cost_idr ?? ""),
    operational_cost_idr: String(last?.operational_cost_idr ?? ""),
    regulatory_cost_idr: String(last?.regulatory_cost_idr ?? ""),
  }));
  const [margin, setMargin] = useState(
    last?.margin_bp === undefined ? "" : String(last.margin_bp / 100),
  );
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const forIteration = prices.filter(
    (price) => price.iteration_number === iteration,
  );
  const current = forIteration[forIteration.length - 1];
  const draft = {
    raw_material_cost_idr: wholeNumber(costs.raw_material_cost_idr),
    packaging_cost_idr: wholeNumber(costs.packaging_cost_idr),
    operational_cost_idr: wholeNumber(costs.operational_cost_idr),
    regulatory_cost_idr: wholeNumber(costs.regulatory_cost_idr),
    margin_bp: margin.trim() === "" ? -1 : Math.round(Number(margin) * 100),
    notes,
  };
  const preview = computeUnitPrice(draft);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await recordSamplePrice(sampleId, draft);
      setNotes("");
      onSaved();
      requestSyncNow();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The price was not saved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  if (prices.length === 0 && status !== "SAMPLE_READY") return null;

  return (
    <section aria-label="Price" className="grid gap-3">
      <h3 className="text-body-md font-semibold text-on-surface">Price</h3>
      {current ? (
        <p className="text-body-md text-on-surface">
          Unit price for sample {iteration}:{" "}
          <span className="font-semibold">
            {formatRupiah(current.final_unit_price_idr)}
          </span>{" "}
          <span className="text-body-sm text-on-surface-variant">
            before tax
          </span>
        </p>
      ) : status === "SAMPLE_READY" ? (
        <p className="text-body-md text-on-surface-variant">
          Waiting for Finance to price sample {iteration}. It cannot be sent to
          the client before then.
        </p>
      ) : null}

      {prices.length > 0 ? (
        <ol className="grid gap-2">
          {prices.map((price) => (
            <li
              key={price.id}
              className="grid gap-0.5 rounded-md border border-surface-container p-3"
            >
              <p className="text-body-md text-on-surface">
                Sample {price.iteration_number} ·{" "}
                {formatRupiah(price.final_unit_price_idr)}
              </p>
              {price.hpp_unit_idr !== undefined &&
              price.margin_bp !== undefined ? (
                <p className="text-body-sm text-on-surface-variant">
                  Cost {formatRupiah(price.hpp_unit_idr)} per unit · margin{" "}
                  {price.margin_bp / 100}%
                </p>
              ) : null}
              {price.notes ? (
                <p className="text-body-sm text-on-surface">{price.notes}</p>
              ) : null}
              <p className="text-body-sm text-on-surface-variant">
                {price.recorded_by_name ??
                  `Operator #${price.recorded_by ?? "?"}`}{" "}
                · {formatDateTime(price.recorded_at)}
              </p>
            </li>
          ))}
        </ol>
      ) : null}

      {canPrice && status === "SAMPLE_READY" ? (
        <form onSubmit={save} className="grid gap-3">
          {error ? (
            <FeedbackBanner tone="error" onDismiss={() => setError("")}>
              {error}
            </FeedbackBanner>
          ) : null}
          <p className="text-body-sm text-on-surface-variant">
            Costs per unit in whole rupiah. The margin is taken from the selling
            price, and the price is rounded up to the next rupiah.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {COMPONENTS.map(([key, label]) => (
              <label key={key} className="app-label grid gap-1.5">
                {label}
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  required={key !== "regulatory_cost_idr"}
                  value={costs[key]}
                  onChange={(event) =>
                    setCosts((previous) => ({
                      ...previous,
                      [key]: event.target.value,
                    }))
                  }
                  className="app-input font-normal"
                />
              </label>
            ))}
            <label className="app-label grid gap-1.5">
              Margin (%)
              <input
                type="number"
                inputMode="decimal"
                min={0}
                max={95}
                step={0.01}
                required
                value={margin}
                onChange={(event) => setMargin(event.target.value)}
                className="app-input font-normal"
              />
            </label>
          </div>
          <label className="app-label grid gap-1.5">
            Notes (optional)
            <textarea
              rows={2}
              maxLength={SAMPLE_NOTES_MAX}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="For example the order quantity this price assumes"
              className="app-input min-h-16 py-2 font-normal"
            />
          </label>
          <p className="text-body-md text-on-surface" aria-live="polite">
            {"error" in preview
              ? preview.error
              : `Cost ${formatRupiah(preview.price.hpp_unit_idr)} per unit · unit price ${formatRupiah(preview.price.final_unit_price_idr)}`}
          </p>
          <button
            type="submit"
            disabled={busy || "error" in preview}
            className="app-btn app-btn-primary justify-self-start"
          >
            {busy ? "Saving…" : "Save price"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
