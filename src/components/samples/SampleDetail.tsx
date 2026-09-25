"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  getSampleRequest,
  recordSampleStep,
  type SampleDetail as SampleDetailData,
} from "@/lib/gateways/samples";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { formatDateTime } from "@/lib/utils/format";
import {
  applySampleAction,
  SAMPLE_ACTION_DIVISION,
  SAMPLE_ACTIONS,
  SAMPLE_NOTES_MAX,
  type SampleAction,
} from "@/lib/validations/sample";
import {
  SAMPLE_ACTION_LABEL,
  SAMPLE_ACTION_PAST,
  SAMPLE_STATUS_LABEL,
  SAMPLE_STATUS_TONE,
} from "./labels";

/**
 * Detail tiket sampel (SCR-03): ringkasan, kuota revisi, linimasa langkah,
 * dan pencatatan langkah berikutnya. Langkah yang ditawarkan dihitung dengan
 * `applySampleAction` yang sama dengan backend; backend tetap memutuskan.
 */

interface SampleDetailProps {
  id: string;
  optionLabel: (id: string) => string;
  canManage: boolean;
  onEdit: () => void;
  onChanged: () => void;
  onClose: () => void;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 text-body-md">
      <dt className="text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 break-words text-on-surface">{value}</dd>
    </div>
  );
}

export function SampleDetail({
  id,
  optionLabel,
  canManage,
  onEdit,
  onChanged,
  onClose,
}: SampleDetailProps) {
  const [data, setData] = useState<SampleDetailData | null>(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState<SampleAction | null>(null);
  const [notes, setNotes] = useState("");
  const [leadTime, setLeadTime] = useState("");
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await getSampleRequest(id));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The request could not be loaded.",
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const request = data?.request;
  const limit = request?.free_revision_limit ?? 0;
  const available = request
    ? SAMPLE_ACTIONS.filter(
        (candidate) =>
          !(
            "error" in
            applySampleAction(
              {
                status: request.status,
                is_paid_sample: request.is_paid_sample === 1,
                revision_index: request.revision_index,
                free_revision_limit: limit,
              },
              candidate,
              1,
            )
          ),
      )
    : [];

  const submitStep = async (event: FormEvent) => {
    event.preventDefault();
    if (!action || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await recordSampleStep({
        id,
        action,
        notes,
        lead_time_days: leadTime === "" ? null : Math.trunc(Number(leadTime)),
      });
      setAction(null);
      setNotes("");
      setLeadTime("");
      await load();
      onChanged();
      requestSyncNow();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The step was not recorded.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  let special: Record<string, string> = {};
  try {
    special = JSON.parse(request?.special_requests_json ?? "{}");
  } catch {
    special = {};
  }
  const specialText = ["color", "texture", "size", "aroma"]
    .filter((key) => special[key])
    .map((key) => `${key}: ${special[key]}`)
    .join(" · ");
  const closed = [
    "RND_REJECTED",
    "CLIENT_ACC",
    "CLIENT_REJECT",
    "CANCELLED",
  ].includes(request?.status ?? "");

  return (
    <Modal
      title={request ? `${request.brand_name}` : "Sample request"}
      titleId="sample-detail-title"
      onClose={onClose}
    >
      <div className="grid gap-4">
        {error ? (
          <FeedbackBanner tone="error" onDismiss={() => setError("")}>
            {error}
          </FeedbackBanner>
        ) : null}
        {!request ? (
          <p className="text-body-md text-on-surface-variant">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                tone={SAMPLE_STATUS_TONE[request.status] ?? "neutral"}
              >
                {SAMPLE_STATUS_LABEL[request.status] ?? request.status}
              </StatusBadge>
              <span className="text-body-sm text-on-surface-variant">
                {request.client_code} · {request.client_name}
              </span>
            </div>

            <section
              aria-label="Revision quota"
              className="rounded-md border border-surface-container p-3"
            >
              <p className="text-body-md text-on-surface">
                Revision {request.revision_index} ·{" "}
                {Math.max(0, limit - request.revision_index)} of {limit} free
                revisions left
              </p>
              {request.is_billable === 1 ? (
                <p className="mt-1 text-body-sm text-on-surface-variant">
                  This revision is over the free quota and waits for Finance to
                  set the fee.
                </p>
              ) : null}
            </section>

            <dl className="grid gap-1.5">
              <DetailRow
                label="Product type"
                value={optionLabel(request.product_category_option_id)}
              />
              <DetailRow
                label="Sample kind"
                value={optionLabel(request.sample_kind_option_id)}
              />
              <DetailRow
                label="Formulation"
                value={optionLabel(request.formulation_type_option_id)}
              />
              <DetailRow
                label="Registration"
                value={optionLabel(request.registration_category_option_id)}
              />
              <DetailRow label="Samples" value={String(request.sample_qty)} />
              <DetailRow label="Packaging" value={request.packaging} />
              <DetailRow label="BPOM name" value={request.bpom_product_name} />
              <DetailRow label="Claims" value={request.claims} />
              <DetailRow label="Reference" value={request.reference_notes} />
              <DetailRow label="Special requests" value={specialText} />
              <DetailRow
                label="Budget"
                value={
                  request.client_budget_idr == null
                    ? ""
                    : `Rp ${request.client_budget_idr.toLocaleString("id-ID")}`
                }
              />
              <DetailRow label="Deadline" value={request.deadline_at} />
              <DetailRow label="Ship to" value={request.ship_to_address} />
              <DetailRow
                label="Fee"
                value={
                  request.is_paid_sample === 1 ? "Paid sample" : "Free sample"
                }
              />
              <DetailRow
                label="Packaging dummy"
                value={
                  request.is_dummy_required === 1 ? "Needed" : "Not needed"
                }
              />
              <DetailRow
                label="RnD lead time"
                value={
                  request.rnd_lead_time_days == null
                    ? ""
                    : `${request.rnd_lead_time_days} days`
                }
              />
              <DetailRow label="PIC CRM" value={request.pic_crm_name ?? ""} />
            </dl>

            {canManage && !closed ? (
              <button
                type="button"
                onClick={onEdit}
                className="app-btn app-btn-secondary justify-self-start"
              >
                Edit request
              </button>
            ) : null}

            {canManage && available.length > 0 ? (
              <section aria-label="Record the next step" className="grid gap-3">
                <h3 className="text-body-md font-semibold text-on-surface">
                  Record the next step
                </h3>
                <div className="flex flex-wrap gap-2">
                  {available.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      aria-pressed={action === candidate}
                      onClick={() => setAction(candidate)}
                      className={`app-btn ${
                        action === candidate
                          ? "app-btn-primary"
                          : candidate === "CANCEL"
                            ? "app-btn-danger"
                            : "app-btn-secondary"
                      }`}
                    >
                      {SAMPLE_ACTION_LABEL[candidate]}
                    </button>
                  ))}
                </div>
                {action ? (
                  <form onSubmit={submitStep} className="grid gap-3">
                    {SAMPLE_ACTION_DIVISION[action] ? (
                      <p className="text-body-sm text-on-surface-variant">
                        Recorded on behalf of {SAMPLE_ACTION_DIVISION[action]}.
                      </p>
                    ) : null}
                    {action === "RND_ACCEPT" ? (
                      <label className="app-label grid gap-1.5 sm:max-w-xs">
                        RnD lead time in days
                        <input
                          required
                          type="number"
                          min={1}
                          max={365}
                          step={1}
                          value={leadTime}
                          onChange={(event) => setLeadTime(event.target.value)}
                          className="app-input font-normal"
                        />
                      </label>
                    ) : null}
                    <label className="app-label grid gap-1.5">
                      Notes
                      <textarea
                        required
                        rows={3}
                        maxLength={SAMPLE_NOTES_MAX}
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                        placeholder="What was decided, and by whom"
                        className="app-input min-h-20 py-2 font-normal"
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="submit"
                        disabled={busy}
                        className="app-btn app-btn-primary"
                      >
                        {busy ? "Saving…" : "Save step"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setAction(null)}
                        className="app-btn app-btn-secondary"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </section>
            ) : null}

            <section aria-label="Timeline" className="grid gap-2">
              <h3 className="text-body-md font-semibold text-on-surface">
                Timeline
              </h3>
              {data.status_log.length === 0 ? (
                <p className="text-body-sm text-on-surface-variant">
                  Created {formatDateTime(request.created_at)}. No steps
                  recorded yet.
                </p>
              ) : (
                <ol className="grid gap-3 border-l-2 border-surface-container pl-4">
                  {data.status_log.map((entry) => (
                    <li key={entry.id} className="grid gap-1">
                      <p className="text-body-sm text-on-surface-variant">
                        {formatDateTime(entry.recorded_at)}
                      </p>
                      <p className="text-body-md text-on-surface">
                        <span className="font-semibold">
                          {entry.recorded_by_name ??
                            `Operator #${entry.recorded_by ?? "?"}`}
                        </span>{" "}
                        {SAMPLE_ACTION_PAST[entry.action] ?? entry.action}
                        {entry.on_behalf_of_division &&
                        SAMPLE_ACTION_DIVISION[entry.action as SampleAction]
                          ? ` on behalf of ${entry.on_behalf_of_division}`
                          : ""}
                      </p>
                      <p className="flex flex-wrap items-center gap-1 text-body-sm text-on-surface-variant">
                        <span className="line-through">
                          {SAMPLE_STATUS_LABEL[entry.from_status] ??
                            entry.from_status}
                        </span>
                        <span aria-hidden="true">→</span>
                        <span className="font-semibold text-on-surface">
                          {SAMPLE_STATUS_LABEL[entry.to_status] ??
                            entry.to_status}
                        </span>
                      </p>
                      <p className="rounded-md border border-surface-container bg-surface-container-low p-2 text-body-md text-on-surface">
                        {entry.notes}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
