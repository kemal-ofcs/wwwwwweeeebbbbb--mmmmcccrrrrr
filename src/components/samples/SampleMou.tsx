"use client";

import { type FormEvent, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  createMou,
  type MouRecord,
  type MouTermsInput,
  recordMouStep,
  type SampleRequestRecord,
  updateMou,
} from "@/lib/gateways/samples";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import {
  applyMouAction,
  MOU_ACTIONS,
  MOU_LEAD_TIME_MAX_DAYS,
  MOU_NOTES_MAX,
  MOU_UNITS_MAX,
  type MouAction,
  REGULATORY_PATHS,
  type RegulatoryPath,
} from "@/lib/validations/mou";
import { formatRupiah, SAMPLE_NOTES_MAX } from "@/lib/validations/sample";
import {
  MOU_ACTION_LABEL,
  MOU_STATUS_LABEL,
  MOU_STATUS_TONE,
  REGULATORY_PATH_LABEL,
} from "./labels";
import { downloadMouPdf } from "./mou-download";

/**
 * Bagian MoU di detail tiket sampel (v2.5a, PRD F-20): CS membuat draf
 * sesudah klien ACC sampel, mengirimnya, dan mencatat jawaban klien; Finance
 * menetapkan harga satuan dan persen DP. Aturan langkahnya hanya dari
 * `applyMouAction`; total dan DP dihitung ulang backend.
 */

interface SampleMouProps {
  sample: SampleRequestRecord;
  mou: MouRecord | null;
  /** Setelan persen DP bawaan untuk draf baru. */
  dpDefaultBp: number;
  onChanged: () => void;
}

interface FormState {
  total_units: string;
  unit_price_idr: string;
  production_lead_time_days: string;
  regulatory_path: RegulatoryPath;
  dp_percent: string;
  notes: string;
}

function whole(value: string) {
  return value.trim() === "" ? Number.NaN : Math.trunc(Number(value));
}

export function SampleMou({
  sample,
  mou,
  dpDefaultBp,
  onChanged,
}: SampleMouProps) {
  const { user } = useAuth();
  const canMou = hasPermission(user, "mou.manage");
  const canPrice = hasPermission(user, "finance.manage");
  const canPdf = hasPermission(user, "invoices.view");
  const [form, setForm] = useState<FormState | null>(null);
  const [action, setAction] = useState<MouAction | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isSubmittingRef = useRef(false);

  const active =
    mou && !["CANCELLED", "REJECTED"].includes(mou.status) ? mou : null;
  const available =
    active && canMou
      ? MOU_ACTIONS.filter(
          (candidate) =>
            !(
              "error" in
              applyMouAction(
                {
                  status: active.status,
                  dummy_ready: active.dummy_ready === 1,
                },
                candidate,
              )
            ),
        )
      : [];
  const canCreate = canMou && !active && sample.status === "CLIENT_ACC";
  const canEdit = active?.status === "DRAFT" && (canMou || canPrice);

  const openForm = (source: MouRecord | null) => {
    setError("");
    setNotice("");
    setForm({
      total_units: source ? String(source.total_units) : "",
      unit_price_idr: String(
        source?.unit_price_idr ?? sample.unit_price_idr ?? "",
      ),
      production_lead_time_days: source
        ? String(source.production_lead_time_days)
        : "",
      regulatory_path: source?.regulatory_path ?? "WITH_BPOM",
      dp_percent: String((source?.dp_bp ?? dpDefaultBp) / 100),
      notes: source?.notes ?? "",
    });
  };

  const run = async (work: () => Promise<unknown>, done: string) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      setForm(null);
      setAction(null);
      setNotes("");
      setNotice(done);
      onChanged();
      requestSyncNow();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nothing was saved.");
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const submitForm = (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    // Backend yang memutuskan sah atau tidak; harga dan DP dari form hanya
    // dipakai untuk pemegang `finance.manage`.
    const terms: MouTermsInput = {
      total_units: whole(form.total_units),
      unit_price_idr: whole(form.unit_price_idr),
      production_lead_time_days: whole(form.production_lead_time_days),
      regulatory_path: form.regulatory_path,
      dp_bp: Math.round(Number(form.dp_percent) * 100),
      notes: form.notes,
    };
    void run(
      () => (active ? updateMou(active.id, terms) : createMou(sample.id, terms)),
      active ? "MoU saved." : "MoU drafted.",
    );
  };

  const submitStep = (event: FormEvent) => {
    event.preventDefault();
    if (!active || !action) return;
    void run(
      () => recordMouStep({ id: active.id, action, notes }),
      "MoU updated.",
    );
  };

  // Hanya membuat dan menyimpan berkas: tanpa sync dan tanpa muat ulang.
  const exportPdf = async () => {
    if (!active || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      setNotice(await downloadMouPdf(active));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The PDF was not created.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  if (!mou && sample.status !== "CLIENT_ACC") return null;

  return (
    <section aria-label="MoU" className="grid gap-3">
      <h3 className="text-body-md font-semibold text-on-surface">MoU</h3>
      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError("")}>
          {error}
        </FeedbackBanner>
      ) : null}
      {notice ? (
        <FeedbackBanner tone="success" onDismiss={() => setNotice("")}>
          {notice}
        </FeedbackBanner>
      ) : null}

      {active && !form ? (
        <div className="grid gap-2 rounded-md border border-surface-container p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-body-md font-semibold text-on-surface">
              {active.mou_number}
            </span>
            <StatusBadge tone={MOU_STATUS_TONE[active.status] ?? "neutral"}>
              {MOU_STATUS_LABEL[active.status] ?? active.status}
            </StatusBadge>
          </div>
          <p className="text-body-md text-on-surface">
            {active.total_units.toLocaleString("id-ID")} units ×{" "}
            {formatRupiah(active.unit_price_idr)} ={" "}
            <span className="font-semibold">
              {formatRupiah(active.total_production_cost_idr)}
            </span>{" "}
            before tax
          </p>
          <p className="text-body-sm text-on-surface-variant">
            Down payment {active.dp_bp / 100}% ={" "}
            {formatRupiah(active.dp_amount_required_idr)} · Production lead
            time {active.production_lead_time_days} days ·{" "}
            {REGULATORY_PATH_LABEL[active.regulatory_path] ??
              active.regulatory_path}
          </p>
          {active.notes ? (
            <p className="whitespace-pre-wrap text-body-sm text-on-surface-variant">
              {active.notes}
            </p>
          ) : null}
          {active.revision_notes ? (
            <p className="text-body-sm text-on-surface-variant">
              Last changes requested: {active.revision_notes}
            </p>
          ) : null}
          {active.status === "DRAFT" && active.dummy_ready !== 1 ? (
            <p className="text-body-sm text-on-surface-variant">
              The MoU can be sent after the client approves the packaging
              dummy.
            </p>
          ) : null}
          {active.status === "ACCEPTED" ? (
            <p className="text-body-sm text-on-surface-variant">
              {active.dp_cleared === 1
                ? "Down payment paid."
                : active.dp_invoiced === 1
                  ? "Down payment invoice issued, not paid yet."
                  : "Waiting for Finance to issue the down payment invoice."}
            </p>
          ) : null}
        </div>
      ) : null}
      {!active && !form ? (
        <p className="text-body-sm text-on-surface-variant">
          {mou
            ? `The last MoU (${mou.mou_number}) was ${MOU_STATUS_LABEL[mou.status]?.toLowerCase() ?? mou.status}.`
            : "No MoU yet."}
        </p>
      ) : null}

      {!form && !action ? (
        <div className="flex flex-wrap gap-2">
          {canCreate ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => openForm(null)}
              className="app-btn app-btn-secondary"
            >
              Draft MoU
            </button>
          ) : null}
          {canEdit && active ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => openForm(active)}
              className="app-btn app-btn-secondary"
            >
              Edit MoU
            </button>
          ) : null}
          {available.map((candidate) => (
            <button
              key={candidate}
              type="button"
              disabled={busy}
              onClick={() => setAction(candidate)}
              className="app-btn app-btn-secondary"
            >
              {MOU_ACTION_LABEL[candidate] ?? candidate}
            </button>
          ))}
          {active && canPdf ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void exportPdf()}
              className="app-btn app-btn-secondary"
            >
              PDF
            </button>
          ) : null}
        </div>
      ) : null}

      {form ? (
        <form onSubmit={submitForm} className="grid gap-3 sm:grid-cols-2">
          <label className="app-label grid gap-1.5">
            Units
            <input
              required
              type="number"
              min={1}
              max={MOU_UNITS_MAX}
              step={1}
              disabled={!canMou}
              value={form.total_units}
              onChange={(event) =>
                setForm({ ...form, total_units: event.target.value })
              }
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            Unit price before tax (Rp)
            <input
              required
              type="number"
              min={1}
              step={1}
              disabled={!canPrice}
              value={form.unit_price_idr}
              onChange={(event) =>
                setForm({ ...form, unit_price_idr: event.target.value })
              }
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            Production lead time (days)
            <input
              required
              type="number"
              min={1}
              max={MOU_LEAD_TIME_MAX_DAYS}
              step={1}
              disabled={!canMou}
              value={form.production_lead_time_days}
              onChange={(event) =>
                setForm({
                  ...form,
                  production_lead_time_days: event.target.value,
                })
              }
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            Down payment (%)
            <input
              required
              type="number"
              min={0.01}
              max={100}
              step={0.01}
              disabled={!canPrice}
              value={form.dp_percent}
              onChange={(event) =>
                setForm({ ...form, dp_percent: event.target.value })
              }
              className="app-input font-normal"
            />
          </label>
          <label className="app-label grid gap-1.5">
            Regulatory path
            <select
              disabled={!canMou}
              value={form.regulatory_path}
              onChange={(event) =>
                setForm({
                  ...form,
                  regulatory_path: event.target.value as RegulatoryPath,
                })
              }
              className="app-input font-normal"
            >
              {REGULATORY_PATHS.map((path) => (
                <option key={path} value={path}>
                  {REGULATORY_PATH_LABEL[path]}
                </option>
              ))}
            </select>
          </label>
          <label className="app-label grid gap-1.5 sm:col-span-2">
            Notes
            <textarea
              rows={3}
              maxLength={MOU_NOTES_MAX}
              disabled={!canMou}
              value={form.notes}
              onChange={(event) =>
                setForm({ ...form, notes: event.target.value })
              }
              className="app-input min-h-24 py-2 font-normal"
            />
          </label>
          {!canPrice ? (
            <p className="text-body-sm text-on-surface-variant sm:col-span-2">
              The unit price comes from the sample price and the down payment
              from Business settings. Finance can change both while the MoU is
              a draft.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
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
              onClick={() => setForm(null)}
              className="app-btn app-btn-secondary"
            >
              Back
            </button>
          </div>
        </form>
      ) : null}

      {action ? (
        <form onSubmit={submitStep} className="grid gap-2">
          <p className="text-body-md font-semibold text-on-surface">
            {MOU_ACTION_LABEL[action] ?? action}
          </p>
          <label htmlFor="mou-notes" className="app-label">
            {action === "MOU_REVISE" ? "What the client wants changed" : "Notes"}
          </label>
          <textarea
            id="mou-notes"
            required
            rows={3}
            maxLength={SAMPLE_NOTES_MAX}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className="app-input min-h-24 py-2 font-normal"
          />
          <div className="flex flex-wrap gap-2">
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
              onClick={() => {
                setAction(null);
                setNotes("");
              }}
              className="app-btn app-btn-secondary"
            >
              Back
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
