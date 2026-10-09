"use client";

import { type FormEvent, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type LegalDocumentRecord,
  type MouRecord,
  recordLegalDocument,
} from "@/lib/gateways/samples";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import {
  BPOM_TYPES,
  halalScope,
  LEGAL_DP_PENDING,
  LEGAL_NOTES_MAX,
  LEGAL_NUMBER_MAX,
  type LegalKind,
  type LegalStatus,
  legalComplete,
  legalGateError,
  legalKindPermission,
  requiredLegalKinds,
} from "@/lib/validations/legal";
import { EvidencePicker } from "./EvidencePicker";
import {
  LEGAL_KIND_LABEL,
  LEGAL_STATUS_LABEL,
  LEGAL_STATUS_TONE,
  REGULATORY_PATH_LABEL,
} from "./labels";

/**
 * Bagian dokumen legal di detail tiket (v2.6, PRD F-21): daftar dokumen wajib
 * menurut jalur regulasi MoU, terkunci sampai DP lunas (E-21). SIG dicatat
 * RnD, sisanya Legal. Aturannya hanya dari `legalGateError` dan
 * `validateLegalRecord` di backend; tombol hanya menawarkan yang sah.
 */

interface Draft {
  kind: LegalKind;
  status: LegalStatus;
  reference_no: string;
  certificate_no: string;
  bpom_type: string;
  submitted_on: string;
  issued_on: string;
  expires_on: string;
  notes: string;
}

export function SampleLegal({
  mou,
  documents,
  onChanged,
}: {
  mou: MouRecord | null;
  documents: LegalDocumentRecord[];
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isSubmittingRef = useRef(false);

  if (!mou || mou.status !== "ACCEPTED") return null;

  // Satu dokumen per jenis; baris ganda dari dua perangkat: yang tertua menang.
  const byKind: Partial<Record<string, LegalDocumentRecord>> = {};
  for (const document of [...documents].reverse()) {
    if (document.mou_id === mou.id) byKind[document.kind] = document;
  }
  const statuses = Object.fromEntries(
    Object.entries(byKind).map(([kind, document]) => [kind, document?.status]),
  ) as Partial<Record<string, string>>;
  const gate = {
    mou_status: mou.status,
    regulatory_path: mou.regulatory_path,
    dp_cleared: mou.dp_cleared === 1,
    statuses,
  };
  const complete = legalComplete(mou.regulatory_path, statuses);

  const open = (kind: LegalKind, status: LegalStatus) => {
    const current = byKind[kind];
    setError("");
    setEvidence("");
    setDraft({
      kind,
      status,
      reference_no: current?.reference_no ?? "",
      certificate_no: current?.certificate_no ?? "",
      bpom_type: current?.bpom_type ?? "",
      submitted_on: current?.submitted_on ?? "",
      issued_on: current?.issued_on ?? "",
      expires_on: current?.expires_on ?? "",
      notes: "",
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await recordLegalDocument(mou.id, draft, evidence);
      setDraft(null);
      setEvidence("");
      onChanged();
      requestSyncNow();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The document was not saved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const field = (key: keyof Draft, label: string, type = "text") =>
    draft ? (
      <label className="app-label grid gap-1.5">
        {label}
        <input
          required={key !== "expires_on"}
          type={type}
          maxLength={type === "text" ? LEGAL_NUMBER_MAX : undefined}
          value={draft[key]}
          onChange={(event) =>
            setDraft({ ...draft, [key]: event.target.value })
          }
          className="app-input font-normal"
        />
      </label>
    ) : null;

  return (
    <section aria-label="Legal documents" className="grid gap-3">
      <h3 className="text-body-md font-semibold text-on-surface">
        Legal documents
      </h3>
      <p className="text-body-sm text-on-surface-variant">
        {REGULATORY_PATH_LABEL[mou.regulatory_path] ?? mou.regulatory_path}{" "}
        path.{" "}
        {complete
          ? "All required documents are done."
          : mou.dp_cleared !== 1
            ? LEGAL_DP_PENDING
            : "Record each document as it is submitted and issued."}
      </p>
      {error ? (
        <FeedbackBanner tone="error" onDismiss={() => setError("")}>
          {error}
        </FeedbackBanner>
      ) : null}

      <ul className="grid gap-2">
        {requiredLegalKinds(mou.regulatory_path).map((kind) => {
          const current = byKind[kind];
          const status = current?.status ?? "";
          const canRecord = hasPermission(user, legalKindPermission(kind));
          const blocked = legalGateError(gate, kind);
          const label =
            kind === "HALAL"
              ? `${LEGAL_KIND_LABEL.HALAL} (${halalScope(mou.regulatory_path) === "PRODUCT" ? "product" : "materials"})`
              : LEGAL_KIND_LABEL[kind];
          return (
            <li
              key={kind}
              className="grid gap-1 rounded-md border border-surface-container p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-body-md font-semibold text-on-surface">
                  {label}
                </span>
                <StatusBadge tone={LEGAL_STATUS_TONE[status] ?? "neutral"}>
                  {LEGAL_STATUS_LABEL[status] ?? "Not started"}
                </StatusBadge>
              </div>
              {current?.reference_no ? (
                <p className="text-body-sm text-on-surface-variant">
                  Submitted {current.submitted_on}, number{" "}
                  {current.reference_no}
                  {current.bpom_type ? ` (${current.bpom_type})` : ""}
                </p>
              ) : null}
              {current?.certificate_no ? (
                <p className="text-body-sm text-on-surface-variant">
                  Issued {current.issued_on}, certificate{" "}
                  {current.certificate_no}
                  {current.expires_on
                    ? `, valid until ${current.expires_on}`
                    : ""}
                </p>
              ) : null}
              {current?.notes ? (
                <p className="text-body-sm text-on-surface-variant">
                  {current.notes}
                </p>
              ) : null}
              {canRecord && blocked && mou.dp_cleared === 1 && !current ? (
                <p className="text-body-sm text-on-surface-variant">
                  {blocked}
                </p>
              ) : null}
              {canRecord && !blocked && draft?.kind !== kind ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => open(kind, "SUBMITTED")}
                    className="app-btn app-btn-secondary"
                  >
                    {status === "SUBMITTED"
                      ? "Correct submission"
                      : "Record submission"}
                  </button>
                  <button
                    type="button"
                    onClick={() => open(kind, "ISSUED")}
                    className="app-btn app-btn-secondary"
                  >
                    Record issue
                  </button>
                  {kind !== "BPOM" ? (
                    <button
                      type="button"
                      onClick={() => open(kind, "NOT_REQUIRED")}
                      className="app-btn app-btn-secondary"
                    >
                      Not required
                    </button>
                  ) : null}
                </div>
              ) : null}
              {draft?.kind === kind ? (
                <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
                  {draft.status !== "NOT_REQUIRED" ? (
                    <>
                      {field("reference_no", "Submission number")}
                      {field("submitted_on", "Submitted on", "date")}
                      {kind === "BPOM" ? (
                        <label className="app-label grid gap-1.5">
                          BPOM type
                          <select
                            required
                            value={draft.bpom_type}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                bpom_type: event.target.value,
                              })
                            }
                            className="app-input font-normal"
                          >
                            <option value="">Choose</option>
                            {BPOM_TYPES.map((type) => (
                              <option key={type} value={type}>
                                {type}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                    </>
                  ) : null}
                  {draft.status === "ISSUED" ? (
                    <>
                      {field("certificate_no", "Certificate number")}
                      {field("issued_on", "Issued on", "date")}
                      {field("expires_on", "Valid until (optional)", "date")}
                    </>
                  ) : null}
                  <label className="app-label grid gap-1.5 sm:col-span-2">
                    {draft.status === "NOT_REQUIRED"
                      ? "Why is it not required?"
                      : "Notes (optional)"}
                    <textarea
                      required={draft.status === "NOT_REQUIRED"}
                      rows={2}
                      maxLength={LEGAL_NOTES_MAX}
                      value={draft.notes}
                      onChange={(event) =>
                        setDraft({ ...draft, notes: event.target.value })
                      }
                      className="app-input min-h-16 py-2 font-normal"
                    />
                  </label>
                  {draft.status !== "NOT_REQUIRED" ? (
                    <div className="sm:col-span-2">
                      <EvidencePicker
                        value={evidence}
                        onChange={setEvidence}
                        label="Photo of the document (optional)"
                        hint="A photo or scan of the receipt or certificate."
                      />
                    </div>
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
                      onClick={() => setDraft(null)}
                      className="app-btn app-btn-secondary"
                    >
                      Back
                    </button>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
