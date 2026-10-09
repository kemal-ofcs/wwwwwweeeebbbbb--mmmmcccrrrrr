"use client";

import { useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { type ApprovalLink, createApprovalLink } from "@/lib/gateways/approval";
import { formatDateTime } from "@/lib/utils/format";
import type {
  ApprovalDecision,
  ApprovalEntityType,
} from "@/lib/validations/approval";

/**
 * Meminta jawaban klien (v2.5b, PRD F-18): tautan sekali pakai bila alamat
 * Web disetel dan perangkat online (keputusan J/K), dan pesan WhatsApp
 * berformat untuk jalur manual (keputusan N, OQ-27). Jawaban manual dicatat
 * lewat tombol langkah biasa beserta tangkapan layar balasannya.
 */

const DECISION_REPLY: Record<ApprovalDecision, string> = {
  APPROVE: "APPROVE",
  REVISE: "REVISE - tell us what to change",
  REJECT: "REJECT",
};

/** Pesan WhatsApp berformat; isian wajib bertanda `*`. */
export function approvalMessage(
  title: string,
  lines: string[],
  decisions: ApprovalDecision[],
  link: ApprovalLink | null,
) {
  return [
    title,
    ...lines,
    "",
    link
      ? `Answer here: ${link.url} (valid until ${formatDateTime(link.expires_at)})`
      : "Please reply to this message with:",
    ...(link ? ["Or reply to this message with:"] : []),
    ...decisions.map(
      (decision, index) => `${index + 1}. ${DECISION_REPLY[decision]}*`,
    ),
    "Your name*:",
    "(* required)",
  ].join("\n");
}

export function ClientApproval({
  entityType,
  entityId,
  linkEnabled,
  canCreate,
  title,
  lines,
  decisions,
}: {
  entityType: ApprovalEntityType;
  entityId: string;
  /** Alamat Web persetujuan disetel di Business settings. */
  linkEnabled: boolean;
  /** Pemegang izin mencatat jawaban klien untuk hal ini. */
  canCreate: boolean;
  title: string;
  lines: string[];
  decisions: ApprovalDecision[];
}) {
  const [link, setLink] = useState<ApprovalLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fallback, setFallback] = useState("");
  const isSubmittingRef = useRef(false);

  const copy = async (text: string, done: string) => {
    setError("");
    try {
      await navigator.clipboard.writeText(text);
      setFallback("");
      setNotice(done);
    } catch {
      // Clipboard ditolak: tampilkan teksnya untuk disalin tangan.
      setFallback(text);
      setNotice("");
    }
  };

  const create = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setLink(await createApprovalLink(entityType, entityId));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The approval link was not created.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  if (!canCreate) return null;

  return (
    <div className="grid gap-2 rounded-md border border-surface-container p-3">
      <p className="text-body-md font-semibold text-on-surface">
        Ask the client
      </p>
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
      {link ? (
        <p className="break-all text-body-sm text-on-surface">
          {link.url}
          <span className="block text-on-surface-variant">
            One use, valid until {formatDateTime(link.expires_at)}. A new link
            cancels this one.
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {linkEnabled ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void create()}
            className="app-btn app-btn-secondary"
          >
            {busy
              ? "Creating…"
              : link
                ? "New approval link"
                : "Create approval link"}
          </button>
        ) : null}
        {link ? (
          <button
            type="button"
            onClick={() => void copy(link.url, "Link copied.")}
            className="app-btn app-btn-secondary"
          >
            Copy link
          </button>
        ) : null}
        <button
          type="button"
          onClick={() =>
            void copy(
              approvalMessage(title, lines, decisions, link),
              "WhatsApp message copied.",
            )
          }
          className="app-btn app-btn-secondary"
        >
          Copy WhatsApp message
        </button>
      </div>
      {!linkEnabled ? (
        <p className="text-body-sm text-on-surface-variant">
          Approval links are off until the approval web address is set in
          Business settings. Send the WhatsApp message, then record the answer
          with a screenshot of the reply.
        </p>
      ) : null}
      {fallback ? (
        <label className="app-label grid gap-1.5">
          Copy this message
          <textarea
            readOnly
            rows={8}
            value={fallback}
            className="app-input py-2 font-normal"
          />
        </label>
      ) : null}
    </div>
  );
}
