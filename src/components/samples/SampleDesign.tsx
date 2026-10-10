"use client";

import { type FormEvent, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  createDesignTicket,
  type DesignTicketRecord,
  recordDesignStep,
  type SampleRequestRecord,
} from "@/lib/gateways/samples";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import {
  isClientDecisionAction,
  stepEvidencePurpose,
} from "@/lib/validations/approval";
import {
  applyDesignAction,
  DESIGN_ACTIONS,
  DESIGN_BRIEF_MAX,
  type DesignAction,
  DUMMY_LIMIT_PERMISSION,
  designActionPermission,
  designRequestError,
  dummyLimitReached,
  TRACKING_NO_MAX,
} from "@/lib/validations/design";
import { SAMPLE_NOTES_MAX } from "@/lib/validations/sample";
import { ClientApproval } from "./ClientApproval";
import { EvidencePicker } from "./EvidencePicker";
import {
  DESIGN_ACTION_LABEL,
  DESIGN_STATUS_LABEL,
  DESIGN_STATUS_TONE,
} from "./labels";

/**
 * Bagian Desain di detail tiket sampel (v2.4, PRD F-19): CS meminta desain
 * dengan brief, desainer mengunggah mockup (galeri foto) lalu mencetak dan
 * mengirim dummy, CS mencatat respons klien. Aturan langkahnya hanya dari
 * `applyDesignAction`; tombol hanya menawarkan yang sah.
 */

interface SampleDesignProps {
  sample: SampleRequestRecord;
  design: DesignTicketRecord | null;
  maxRejections: number;
  /** `samples.manage`. */
  canManage: boolean;
  /** Alamat Web persetujuan disetel (v2.5b). */
  linkEnabled: boolean;
  onChanged: () => void;
}

export function SampleDesign({
  sample,
  design,
  maxRejections,
  canManage,
  linkEnabled,
  onChanged,
}: SampleDesignProps) {
  const { user } = useAuth();
  const canDesign = hasPermission(user, "design.manage");
  const canOverride = hasPermission(user, DUMMY_LIMIT_PERMISSION);
  const [brief, setBrief] = useState("");
  const [action, setAction] = useState<DesignAction | null>(null);
  const [notes, setNotes] = useState("");
  const [evidence, setEvidence] = useState("");
  const [tracking, setTracking] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isSubmittingRef = useRef(false);

  const active = design && design.status !== "CANCELLED" ? design : null;
  const allowed = {
    "design.manage": canDesign,
    "samples.manage": canManage,
  };
  const state = active && {
    status: active.status,
    sample_status: active.sample_status,
    has_mockup: active.has_mockup === 1,
    dummy_paid: active.dummy_paid === 1,
    rejection_count: active.dummy_rejection_count,
    max_rejections: maxRejections,
    can_override: canOverride,
  };
  const available = state
    ? DESIGN_ACTIONS.filter(
        (candidate) =>
          allowed[designActionPermission(candidate)] &&
          !("error" in applyDesignAction(state, candidate)),
      )
    : [];
  // Alasan cetak dummy belum bisa, untuk desainer yang menunggu.
  const printBlocked =
    state && canDesign && !available.includes("PRINT_DUMMY")
      ? applyDesignAction(state, "PRINT_DUMMY")
      : null;
  const canRequest =
    canManage && !active && designRequestError(sample.status, 0) === null;

  const run = async (work: () => Promise<unknown>) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      setBrief("");
      setAction(null);
      setNotes("");
      setTracking("");
      setEvidence("");
      onChanged();
      requestSyncNow();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Nothing was saved.");
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const submitRequest = (event: FormEvent) => {
    event.preventDefault();
    void run(() => createDesignTicket(sample.id, brief));
  };

  const submitStep = (event: FormEvent) => {
    event.preventDefault();
    if (!active || !action) return;
    void run(() =>
      recordDesignStep({
        id: active.id,
        action,
        notes,
        tracking_no: action === "DUMMY_SENT" ? tracking : "",
        evidence_base64: stepEvidencePurpose(action) ? evidence : "",
      }),
    );
  };

  return (
    <section aria-label="Design" className="grid gap-3">
      <h3 className="text-body-md font-semibold text-on-surface">Design</h3>
      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError("")}>
          {error}
        </FeedbackBanner>
      ) : null}

      {sample.status === "SAMPLE_READY" && sample.mockup_ready !== 1 ? (
        <p className="text-body-sm text-on-surface-variant">
          {active
            ? "The sample cannot be sent until the designer uploads a mockup."
            : "This request needs a packaging dummy, so request a design and upload a mockup before the sample is sent."}
        </p>
      ) : null}

      {active ? (
        <div className="grid gap-2 rounded-md border border-surface-container p-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={DESIGN_STATUS_TONE[active.status] ?? "neutral"}>
              {DESIGN_STATUS_LABEL[active.status] ?? active.status}
            </StatusBadge>
            <span className="text-body-sm text-on-surface-variant">
              Dummy rejections {active.dummy_rejection_count}
              {maxRejections > 0 ? ` of ${maxRejections}` : ", no limit"}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-body-md text-on-surface">
            {active.brief}
          </p>
          {active.dummy_tracking_no ? (
            <p className="text-body-sm text-on-surface-variant">
              Tracking number: {active.dummy_tracking_no}
            </p>
          ) : null}
          {active.revision_notes ? (
            <p className="text-body-sm text-on-surface-variant">
              Last revision notes: {active.revision_notes}
            </p>
          ) : null}
          {active.has_mockup !== 1 ? (
            <p className="text-body-sm text-on-surface-variant">
              Waiting for the mockup.
            </p>
          ) : null}
          {printBlocked &&
          "error" in printBlocked &&
          ["MOCKUP", "DUMMY_REVISION"].includes(active.status) &&
          active.sample_status === "CLIENT_ACC" ? (
            <p className="text-body-sm text-on-surface-variant">
              {printBlocked.error}
            </p>
          ) : null}
          {dummyLimitReached(active.dummy_rejection_count, maxRejections) &&
          canOverride &&
          active.status === "DUMMY_REVISION" ? (
            <p className="text-body-sm text-on-surface-variant">
              The rejection limit is reached. Printing again is recorded as your
              override.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-body-sm text-on-surface-variant">
          {design?.status === "CANCELLED"
            ? "The last design was cancelled."
            : "No design requested."}
        </p>
      )}

      {canRequest ? (
        <form onSubmit={submitRequest} className="grid gap-2">
          <label htmlFor="design-brief" className="app-label">
            Design brief
          </label>
          <textarea
            id="design-brief"
            required
            rows={3}
            maxLength={DESIGN_BRIEF_MAX}
            value={brief}
            placeholder="Packaging, size, colors, logo, text on the label"
            onChange={(event) => setBrief(event.target.value)}
            className="app-input min-h-24 py-2 font-normal"
          />
          <button
            type="submit"
            disabled={busy}
            className="app-btn app-btn-secondary justify-self-start"
          >
            {busy ? "Saving…" : "Request design"}
          </button>
        </form>
      ) : null}

      {active?.status === "DUMMY_SENT" ? (
        <ClientApproval
          entityType="DUMMY"
          entityId={active.id}
          linkEnabled={linkEnabled}
          canCreate={canManage}
          title={`Packaging dummy for ${sample.brand_name}, round ${active.dummy_rejection_count + 1}`}
          lines={[
            `For ${sample.client_name ?? ""} (${sample.client_code ?? ""})`,
            `Brief: ${active.brief}`,
            ...(active.dummy_tracking_no
              ? [`Tracking number: ${active.dummy_tracking_no}`]
              : []),
          ]}
          decisions={["APPROVE", "REVISE"]}
        />
      ) : null}

      {available.length > 0 && !action ? (
        <div className="flex flex-wrap gap-2">
          {available.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setAction(candidate)}
              className="app-btn app-btn-secondary"
            >
              {DESIGN_ACTION_LABEL[candidate] ?? candidate}
            </button>
          ))}
        </div>
      ) : null}

      {action ? (
        <form onSubmit={submitStep} className="grid gap-2">
          <p className="text-body-md font-semibold text-on-surface">
            {DESIGN_ACTION_LABEL[action] ?? action}
          </p>
          {action === "DUMMY_SENT" ? (
            <>
              <label htmlFor="design-tracking" className="app-label">
                Tracking number (optional)
              </label>
              <input
                id="design-tracking"
                maxLength={TRACKING_NO_MAX}
                value={tracking}
                onChange={(event) => setTracking(event.target.value)}
                className="app-input font-normal"
              />
            </>
          ) : null}
          {isClientDecisionAction(action) ? (
            <EvidencePicker value={evidence} onChange={setEvidence} />
          ) : action === "PRINT_DUMMY" ? (
            <EvidencePicker
              value={evidence}
              onChange={setEvidence}
              label="Print-ready design (optional)"
              hint="The artwork this dummy is printed from."
            />
          ) : null}
          <label htmlFor="design-notes" className="app-label">
            {action === "DUMMY_REVISE"
              ? "What the client wants changed"
              : "Notes"}
          </label>
          <textarea
            id="design-notes"
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
                setTracking("");
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
