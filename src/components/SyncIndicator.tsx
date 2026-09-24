"use client";

import { useEffect, useState } from "react";
import {
  getSyncStatus,
  isDesktopSyncAvailable,
  SYNC_COMPLETED_EVENT,
  SYNC_FAILED_EVENT,
  type SyncStatus,
} from "@/lib/gateways/sync-status";

type IndicatorState =
  | { kind: "idle" }
  | { kind: "queued"; count: number }
  | { kind: "failed" };

function fromStatus(status: SyncStatus): IndicatorState {
  const count = status.pending + status.failed + status.conflict;
  return count > 0 ? { kind: "queued", count } : { kind: "idle" };
}

/**
 * Status antrean sinkronisasi di header Desktop/Mobile. Satu-satunya tempat
 * `animate-pulse` boleh dipakai (DESIGN.md): titiknya berkedip hanya selama
 * masih ada perubahan yang belum terkirim. Web tidak punya outbox, jadi
 * komponen ini tidak merender apa pun di sana.
 */
export function SyncIndicator() {
  const [state, setState] = useState<IndicatorState | null>(null);

  useEffect(() => {
    if (!isDesktopSyncAvailable()) return;
    let active = true;
    getSyncStatus()
      .then((status) => {
        if (active && status) setState(fromStatus(status));
      })
      .catch(() => undefined);

    const onCompleted = (event: Event) => {
      const status = (event as CustomEvent<SyncStatus>).detail;
      if (status) setState(fromStatus(status));
    };
    const onFailed = () => setState({ kind: "failed" });
    window.addEventListener(SYNC_COMPLETED_EVENT, onCompleted);
    window.addEventListener(SYNC_FAILED_EVENT, onFailed);
    return () => {
      active = false;
      window.removeEventListener(SYNC_COMPLETED_EVENT, onCompleted);
      window.removeEventListener(SYNC_FAILED_EVENT, onFailed);
    };
  }, []);

  if (!state) return null;

  const label =
    state.kind === "idle"
      ? "Synced"
      : state.kind === "queued"
        ? `${state.count} pending`
        : "Sync failed";
  const dot =
    state.kind === "idle"
      ? "bg-success"
      : state.kind === "queued"
        ? "animate-pulse bg-secondary"
        : "bg-error";

  return (
    <output className="inline-flex items-center gap-1.5 rounded-md border border-surface-container bg-surface-container-lowest px-2 py-0.5 font-mono text-code-sm text-on-surface-variant">
      <span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
      {label}
    </output>
  );
}
