"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import { useAuth } from "@/lib/context/AuthContext";
import {
  getSyncConflicts,
  resolveSyncConflicts,
  resolveSyncConflictsLocal,
  SYNC_COMPLETED_EVENT,
  type SyncConflict,
} from "@/lib/gateways/sync-status";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Perubahan yang ditolak cloud (konflik), mis. dua perangkat offline
 * melunasi tagihan yang sama (temuan uji perangkat v2). Pemiliknya memilih
 * Buang (pakai versi cloud; data lokal disamakan) atau Kirim ulang. Ditulis
 * sekali untuk Desktop dan Mobile (`filesToCopy`); Web tidak punya outbox.
 */

const DOMAIN_LABEL: Record<string, string> = {
  client: "Client",
  "lead-interaction": "Lead contact",
  "master-option": "Master data",
  sample: "Sample request",
  design: "Design",
  mou: "MoU",
  legal: "Legal document",
  invoice: "Invoice",
  fund: "Incoming payment",
  "finance-option": "Tax or discount",
  media: "Photo",
  "imported-record": "Imported record",
  setting: "Setting",
  "company-profile": "Company profile",
};

export function RejectedChangesBanner() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<SyncConflict[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const isSubmittingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    try {
      setEntries(await getSyncConflicts());
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

  const resolve = async (entry: SyncConflict, retry: boolean) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(entry.eventId);
    setError("");
    try {
      await (retry
        ? resolveSyncConflictsLocal(entry.eventId)
        : resolveSyncConflicts(entry.eventId));
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The change was not resolved.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy("");
    }
  };

  if (entries.length === 0) return null;

  return (
    <div className="px-4 pt-3">
      <FeedbackBanner tone="error">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1">
            {entries.length === 1
              ? "1 change was rejected by the cloud."
              : `${entries.length} changes were rejected by the cloud.`}
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
          title="Rejected changes"
          titleId="rejected-title"
          descriptionId="rejected-body"
          onClose={() => setOpen(false)}
        >
          <p id="rejected-body" className="text-body-md text-on-surface">
            The cloud already had newer data, so these changes from this device
            were not applied. Discard keeps the cloud version and corrects this
            device. Try again sends the change as it is.
          </p>
          {error ? (
            <div className="mt-3">
              <FeedbackBanner tone="error" onDismiss={() => setError("")}>
                {error}
              </FeedbackBanner>
            </div>
          ) : null}
          <ol className="mt-3 max-h-80 divide-y divide-surface-container overflow-y-auto rounded-md border border-surface-container">
            {entries.map((entry) => (
              <li key={entry.eventId} className="grid gap-2 p-3">
                <p className="text-body-md text-on-surface">
                  <span className="font-semibold">
                    {DOMAIN_LABEL[entry.domain] ?? entry.domain} ·{" "}
                    {entry.operation}
                  </span>
                  <span className="block text-body-sm text-on-surface-variant">
                    {formatDateTime(
                      new Date(entry.createdAt * 1000).toISOString(),
                    )}
                  </span>
                </p>
                <p className="text-body-sm text-on-surface">{entry.reason}</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => void resolve(entry, false)}
                    className="app-btn app-btn-primary"
                  >
                    {busy === entry.eventId ? "Working…" : "Discard my change"}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() => void resolve(entry, true)}
                    className="app-btn app-btn-secondary"
                  >
                    Try again
                  </button>
                </div>
              </li>
            ))}
          </ol>
        </Modal>
      ) : null}
    </div>
  );
}
