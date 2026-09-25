"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  listQuarantine,
  type QuarantineEntry,
  requestSyncNow,
  resolveQuarantine,
  SYNC_COMPLETED_EVENT,
} from "@/lib/gateways/sync-status";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Entri outbox yang dikarantina karena sesi pembuatnya tersusul login di
 * perangkat lain (PRD FR-03 butir 5). Pemilik memilih Kirim atau Buang; tidak
 * ada yang terjadi otomatis. Ditulis sekali untuk Desktop dan Mobile
 * (`filesToCopy`); Web tidak punya outbox, jadi tidak pernah tampil di sana.
 */

const DOMAIN_LABEL: Record<string, string> = {
  client: "Client",
  lead: "Lead",
  "lead-interaction": "Lead contact",
  "master-option": "Master data",
  audit: "Audit entry",
  setting: "Setting",
  "company-profile": "Company profile",
};

function describe(entry: QuarantineEntry) {
  const what = DOMAIN_LABEL[entry.domain] ?? entry.domain;
  return `${what} · ${entry.operation}`;
}

export function QuarantineBanner() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<QuarantineEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isSubmittingRef = useRef(false);
  const canDiscard = hasPermission(user, "sync.retry");

  const refresh = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    try {
      setEntries(await listQuarantine());
    } catch {
      // Tanpa `sync.view` daftar ini tidak bisa dibaca; banner cukup diam.
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void refresh();
    const onSync = () => void refresh();
    window.addEventListener(SYNC_COMPLETED_EVENT, onSync);
    return () => window.removeEventListener(SYNC_COMPLETED_EVENT, onSync);
  }, [user, refresh]);

  const resolve = async (action: "send" | "discard") => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await resolveQuarantine(
        action,
        entries.map((entry) => entry.eventId),
      );
      setConfirmDiscard(false);
      setOpen(false);
      if (action === "send") requestSyncNow();
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The entries were not changed.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  if (entries.length === 0) return null;

  return (
    <div className="px-4 pt-3">
      <FeedbackBanner tone="warning">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1">
            {entries.length === 1
              ? "1 unsent change"
              : `${entries.length} unsent changes`}{" "}
            from before your account signed in on another device{" "}
            {entries.length === 1 ? "is" : "are"} on hold.
          </span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="app-btn app-btn-secondary min-h-9"
          >
            Review
          </button>
        </div>
      </FeedbackBanner>

      {open ? (
        <Modal
          title="Changes on hold"
          titleId="quarantine-title"
          descriptionId="quarantine-body"
          onClose={() => {
            setOpen(false);
            setConfirmDiscard(false);
          }}
        >
          <p id="quarantine-body" className="text-body-md text-on-surface">
            These changes were made on this device before your account signed in
            somewhere else, so they were not sent. Send them if they are still
            right; the cloud rejects any that conflict with newer data.
          </p>
          {error ? (
            <div className="mt-3">
              <FeedbackBanner tone="error" onDismiss={() => setError("")}>
                {error}
              </FeedbackBanner>
            </div>
          ) : null}
          <ol className="mt-3 max-h-64 divide-y divide-surface-container overflow-y-auto rounded-md border border-surface-container">
            {entries.map((entry) => (
              <li
                key={entry.eventId}
                className="flex flex-col gap-0.5 p-3 sm:flex-row sm:items-baseline sm:gap-3"
              >
                <span className="min-w-0 flex-1 text-body-md text-on-surface">
                  {describe(entry)}
                </span>
                <span className="shrink-0 text-body-sm text-on-surface-variant">
                  {formatDateTime(
                    new Date(entry.createdAt * 1000).toISOString(),
                  )}
                </span>
              </li>
            ))}
          </ol>

          {confirmDiscard ? (
            <div className="mt-4 rounded-md border border-error/30 bg-error-container p-3 text-body-md text-on-error-container">
              <p>
                Discarding removes these changes from the send queue for good.
                Nothing on this device is deleted right away; the next sync
                replaces it with what the cloud has. This is recorded in the
                audit log.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve("discard")}
                  className="app-btn app-btn-danger"
                >
                  {busy ? "Discarding…" : "Discard changes"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmDiscard(false)}
                  className="app-btn app-btn-secondary"
                >
                  Keep them
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void resolve("send")}
                className="app-btn app-btn-primary"
              >
                {busy ? "Sending…" : "Send changes"}
              </button>
              {canDiscard ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmDiscard(true)}
                  className="app-btn app-btn-secondary"
                >
                  Discard…
                </button>
              ) : (
                <p className="self-center text-body-sm text-on-surface-variant">
                  Discarding needs the "Retry sync and resolve conflicts"
                  permission.
                </p>
              )}
            </div>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
