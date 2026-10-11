"use client";

import { type FormEvent, useRef, useState } from "react";
import { EvidencePicker } from "@/components/samples/EvidencePicker";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { decideQcClaim, type QcClaimRecord } from "@/lib/gateways/production";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { formatDateTime } from "@/lib/utils/format";
import {
  PRODUCTION_REASON_MAX,
  QC_FINDINGS_MAX,
  QC_REMEDIES,
  QC_REMEDY_LABEL,
  type QcFaultType,
  type QcRemedy,
} from "@/lib/validations/production";
import { downloadClaimReport } from "./shipment-download";

/**
 * Komplain penerimaan dan keputusan QC (v3.5, PRD F-28). QC memutuskan
 * sekali: salah pabrik = retur disetujui dengan tindak lanjut, salah
 * penerima/ekspedisi = retur ditolak. Aturannya di `validateClaimDecision`
 * ↔ `validate_claim_decision`.
 */

interface Draft {
  claimId: string;
  fault_type: QcFaultType;
  findings: string;
  remedy: string;
  remedy_notes: string;
  evidence_base64: string;
}

export function QcClaimSection({
  claims,
  onChanged,
}: {
  claims: QcClaimRecord[];
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const canDecide = hasPermission(user, "qc.manage");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const isSubmittingRef = useRef(false);

  if (claims.length === 0) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const { claimId, ...decision } = draft;
      await decideQcClaim(claimId, decision);
      setDraft(null);
      onChanged();
      requestSyncNow();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The decision was not saved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const download = async (claim: QcClaimRecord) => {
    setError("");
    try {
      setNotice(await downloadClaimReport(claim));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The PDF could not be saved.",
      );
    }
  };

  return (
    <div className="grid gap-2">
      <h4 className="text-body-sm font-semibold text-on-surface">
        Client complaint
      </h4>
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
      {claims.map((claim) => (
        <div
          key={claim.id}
          className="grid gap-2 rounded-md border border-surface-container p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-body-sm text-on-surface-variant">
              Delivery note{" "}
              <span className="font-mono">{claim.delivery_note_no}</span> ·
              reported {formatDateTime(claim.created_at)}
            </span>
            <StatusBadge
              tone={
                claim.status === "OPEN"
                  ? "warning"
                  : claim.decision === "RETURN_APPROVED"
                    ? "success"
                    : "neutral"
              }
            >
              {claim.status === "OPEN"
                ? "QC investigating"
                : claim.decision === "RETURN_APPROVED"
                  ? "Return approved"
                  : "Return rejected"}
            </StatusBadge>
          </div>
          <p className="whitespace-pre-line text-body-sm text-on-surface">
            {claim.complaint_notes}
          </p>
          {claim.affected_units > 0 ? (
            <p className="text-body-sm text-on-surface-variant">
              {claim.affected_units.toLocaleString("en-US")} of{" "}
              {claim.unit_count.toLocaleString("en-US")} units affected
            </p>
          ) : null}

          {claim.status === "DECIDED" ? (
            <>
              <p className="text-body-sm text-on-surface">
                {claim.fault_type === "INTERNAL"
                  ? `Our fault: ${QC_REMEDY_LABEL[claim.remedy as QcRemedy] ?? claim.remedy}${claim.remedy_notes ? ` (${claim.remedy_notes})` : ""}.`
                  : "Not our fault: the recipient or the courier."}
              </p>
              <p className="whitespace-pre-line text-body-sm text-on-surface-variant">
                QC findings: {claim.findings}
              </p>
              <p className="text-body-sm text-on-surface-variant">
                Decided by {claim.decided_by_name || "QC"},{" "}
                {formatDateTime(claim.decided_at)}
              </p>
              <div>
                <button
                  type="button"
                  onClick={() => void download(claim)}
                  className="app-btn app-btn-secondary"
                >
                  Claim report PDF
                </button>
              </div>
            </>
          ) : null}

          {claim.status === "OPEN" &&
          canDecide &&
          draft?.claimId !== claim.id ? (
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  setDraft({
                    claimId: claim.id,
                    fault_type: "INTERNAL",
                    findings: "",
                    remedy: "",
                    remedy_notes: "",
                    evidence_base64: "",
                  })
                }
                className="app-btn app-btn-primary min-h-12"
              >
                Record QC decision
              </button>
            </div>
          ) : null}
          {claim.status === "OPEN" && !canDecide ? (
            <p className="text-body-sm text-on-surface-variant">
              Waiting for QC to investigate.
            </p>
          ) : null}

          {draft?.claimId === claim.id ? (
            <form
              onSubmit={(event) => void submit(event)}
              className="grid gap-3 sm:grid-cols-2"
            >
              <label className="app-label grid gap-1.5 sm:col-span-2">
                Whose fault is it?
                <select
                  value={draft.fault_type}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      fault_type: event.target.value as QcFaultType,
                    })
                  }
                  className="app-input font-normal"
                >
                  <option value="INTERNAL">
                    Ours (production or packing): approve the return
                  </option>
                  <option value="RECIPIENT">
                    Recipient or courier: reject the return
                  </option>
                </select>
              </label>
              <label className="app-label grid gap-1.5 sm:col-span-2">
                What QC found
                <textarea
                  required
                  rows={3}
                  maxLength={QC_FINDINGS_MAX}
                  value={draft.findings}
                  onChange={(event) =>
                    setDraft({ ...draft, findings: event.target.value })
                  }
                  className="app-input min-h-20 py-2 font-normal"
                />
              </label>
              {draft.fault_type === "INTERNAL" ? (
                <>
                  <label className="app-label grid gap-1.5">
                    How the client is put right
                    <select
                      required
                      value={draft.remedy}
                      onChange={(event) =>
                        setDraft({ ...draft, remedy: event.target.value })
                      }
                      className="app-input font-normal"
                    >
                      <option value="">Choose</option>
                      {QC_REMEDIES.map((remedy) => (
                        <option key={remedy} value={remedy}>
                          {QC_REMEDY_LABEL[remedy]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="app-label grid gap-1.5">
                    Notes (optional)
                    <input
                      maxLength={PRODUCTION_REASON_MAX}
                      value={draft.remedy_notes}
                      onChange={(event) =>
                        setDraft({ ...draft, remedy_notes: event.target.value })
                      }
                      className="app-input font-normal"
                    />
                  </label>
                </>
              ) : null}
              <div className="sm:col-span-2">
                <EvidencePicker
                  value={draft.evidence_base64}
                  onChange={(value) =>
                    setDraft({ ...draft, evidence_base64: value })
                  }
                  label="QC evidence photo (optional)"
                  hint="A photo of the returned goods or the retained sample."
                />
              </div>
              <div className="flex flex-wrap gap-2 sm:col-span-2">
                <button
                  type="submit"
                  disabled={busy}
                  className="app-btn app-btn-primary min-h-12"
                >
                  {busy ? "Saving…" : "Save decision"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                  className="app-btn app-btn-secondary min-h-12"
                >
                  Back
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ))}
    </div>
  );
}
