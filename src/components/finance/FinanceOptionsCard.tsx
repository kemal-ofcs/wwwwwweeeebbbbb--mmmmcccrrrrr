"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import {
  type FinanceOptionInput,
  type FinanceOptionRecord,
  getFinanceOverview,
  saveFinanceOption,
} from "@/lib/gateways/finance";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import {
  FINANCE_LABEL_MAX,
  FINANCE_OPTION_KINDS,
  type FinanceOptionKind,
  INSTALLMENT_COUNT_MAX,
} from "@/lib/validations/finance";

/**
 * Pengaturan › Taxes and discounts (PRD F-17, D-28). Tarifnya disalin ke
 * setiap tagihan saat dibuat, jadi mengubahnya tidak mengubah tagihan lama.
 * Pilihan tidak pernah dihapus, hanya dinonaktifkan.
 */

const KIND_TITLE: Record<FinanceOptionKind, string> = {
  TAX: "Taxes",
  DISCOUNT: "Discounts",
  INSTALLMENT_PLAN: "Installment plans",
};

const KIND_HINT: Record<FinanceOptionKind, string> = {
  TAX: "Added on top of the invoice, e.g. PPN 11%. Every active tax is ticked on a new invoice.",
  DISCOUNT:
    "Taken off before tax, at most one per invoice, e.g. Lebaran 20% or Full payment 3%.",
  INSTALLMENT_PLAN:
    "Offered when a client pays only part of an invoice. Interest is charged once on the unpaid amount, then split into monthly installments, e.g. 3 months 10% or 7 months 0%.",
};

function emptyDraft(kind: FinanceOptionKind): FinanceOptionInput {
  return {
    id: "",
    kind,
    label: "",
    rate_bp: 0,
    installment_count: kind === "INSTALLMENT_PLAN" ? 3 : null,
    is_active: true,
  };
}

export function FinanceOptionsCard() {
  const [options, setOptions] = useState<FinanceOptionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<FinanceOptionInput | null>(null);
  const [rate, setRate] = useState("");
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setOptions((await getFinanceOverview()).options);
    } catch (cause) {
      setFeedback({
        tone: "error",
        text:
          cause instanceof Error
            ? cause.message
            : "Taxes and discounts could not be loaded.",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = (next: FinanceOptionInput) => {
    setDraft(next);
    setRate(next.id ? String(next.rate_bp / 100) : "");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      await saveFinanceOption({
        ...draft,
        rate_bp: rate.trim() === "" ? -1 : Math.round(Number(rate) * 100),
      });
      setDraft(null);
      setFeedback({ tone: "success", text: "Saved." });
      requestSyncNow();
      await load();
    } catch (cause) {
      setFeedback({
        tone: "error",
        text: cause instanceof Error ? cause.message : "Nothing was saved.",
      });
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="app-panel space-y-4 p-4 sm:p-5">
      <div>
        <h2 className="text-headline-md text-on-surface">
          Taxes, discounts, and installments
        </h2>
        <p className="mt-1 text-body-md text-on-surface-variant">
          Rates are copied onto each invoice when it is created, so changing
          them never changes an invoice that already exists.
        </p>
      </div>
      {feedback ? (
        <FeedbackBanner
          tone={feedback.tone}
          onDismiss={() => setFeedback(null)}
        >
          {feedback.text}
        </FeedbackBanner>
      ) : null}
      {loading ? (
        <p className="text-body-md text-on-surface-variant">Loading…</p>
      ) : (
        FINANCE_OPTION_KINDS.map((kind) => {
          const rows = options.filter((option) => option.kind === kind);
          return (
            <div key={kind} className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-body-md font-semibold text-on-surface">
                  {KIND_TITLE[kind]}
                </h3>
                <button
                  type="button"
                  onClick={() => edit(emptyDraft(kind))}
                  className="app-btn app-btn-secondary"
                >
                  Add
                </button>
              </div>
              <p className="text-body-sm text-on-surface-variant">
                {KIND_HINT[kind]}
              </p>
              {rows.length === 0 ? (
                <p className="text-body-sm text-on-surface-variant">
                  None yet.
                </p>
              ) : (
                <ul className="divide-y divide-surface-container rounded-md border border-surface-container">
                  {rows.map((option) => (
                    <li
                      key={option.id}
                      className="flex flex-wrap items-center justify-between gap-2 p-3"
                    >
                      <span className="text-body-md text-on-surface">
                        {option.label} ·{" "}
                        {option.installment_count
                          ? `${option.installment_count} months, interest `
                          : ""}
                        {option.rate_bp / 100}%
                        {option.is_active === 1 ? "" : " (inactive)"}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          edit({
                            id: option.id,
                            kind: option.kind,
                            label: option.label,
                            rate_bp: option.rate_bp,
                            installment_count: option.installment_count,
                            is_active: option.is_active === 1,
                          })
                        }
                        className="app-btn app-btn-secondary"
                      >
                        Edit
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}
      {draft ? (
        <form
          onSubmit={save}
          className="grid gap-3 rounded-md border border-surface-container p-3 sm:grid-cols-4"
        >
          <label className="app-label grid gap-1.5">
            {draft.kind === "TAX"
              ? "Tax name"
              : draft.kind === "DISCOUNT"
                ? "Discount name"
                : "Plan name"}
            <input
              required
              maxLength={FINANCE_LABEL_MAX}
              value={draft.label}
              onChange={(event) =>
                setDraft({ ...draft, label: event.target.value })
              }
              className="app-input font-normal"
            />
          </label>
          {draft.kind === "INSTALLMENT_PLAN" ? (
            <label className="app-label grid gap-1.5">
              Monthly installments
              <input
                required
                type="number"
                min={1}
                max={INSTALLMENT_COUNT_MAX}
                step={1}
                value={draft.installment_count ?? ""}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    installment_count:
                      event.target.value === ""
                        ? null
                        : Math.trunc(Number(event.target.value)),
                  })
                }
                className="app-input font-normal"
              />
            </label>
          ) : null}
          <label className="app-label grid gap-1.5">
            {draft.kind === "INSTALLMENT_PLAN" ? "Interest (%)" : "Rate (%)"}
            <input
              required
              type="number"
              inputMode="decimal"
              min={0}
              max={100}
              step={0.01}
              value={rate}
              onChange={(event) => setRate(event.target.value)}
              className="app-input font-normal"
            />
          </label>
          <label className="flex min-h-11 items-center gap-2 self-end text-body-md text-on-surface">
            <input
              type="checkbox"
              checked={draft.is_active}
              onChange={(event) =>
                setDraft({ ...draft, is_active: event.target.checked })
              }
              className="size-4"
            />
            Active
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-4">
            <button
              type="submit"
              disabled={busy}
              className="app-btn app-btn-primary"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDraft(null)}
              className="app-btn app-btn-secondary"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
