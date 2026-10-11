"use client";

import { type FormEvent, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { forwardToCrm } from "@/lib/gateways/crm";
import { requestSyncNow } from "@/lib/gateways/sync-status";
import { CRM_FORWARD_NOTES_MAX } from "@/lib/validations/crm";

/**
 * Klien yang sudah diserahkan ke CRM (v3.6a, E-33): CS hanya membaca, dan
 * permintaan klien diteruskan ke grup CRM lewat tombol ini.
 */
export function CrmForward({ clientId }: { clientId: string }) {
  const { user } = useAuth();
  const canForward = hasPermission(user, "clients.manage");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isSubmittingRef = useRef(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await forwardToCrm(clientId, notes);
      setNotes("");
      setNotice("Forwarded to the CRM group.");
      requestSyncNow();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The request was not sent.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-md border border-surface-container p-3">
      <p className="text-body-sm text-on-surface">
        This client is managed by CRM after their first order. CS can read the
        history but cannot start new requests.
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
      {canForward ? (
        <form onSubmit={(event) => void submit(event)} className="space-y-2">
          <label className="app-label grid gap-1.5">
            What did the client ask for?
            <textarea
              required
              rows={2}
              maxLength={CRM_FORWARD_NOTES_MAX}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="app-input min-h-16 py-2 font-normal"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="app-btn app-btn-secondary"
          >
            {busy ? "Sending…" : "Forward to CRM"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
