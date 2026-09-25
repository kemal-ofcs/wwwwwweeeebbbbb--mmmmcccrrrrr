"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Modal } from "@/components/ui/Modal";
import {
  type ActiveSession,
  endOperatorSessions,
  endSession,
  listActiveSessions,
} from "@/lib/gateways/sessions";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Sesi aktif per operator (PRD FR-10.3, FR-10.4; bagian sesi dari SCR-07).
 * Mengakhiri sesi butuh alasan tertulis yang masuk log audit. Perangkat
 * targetnya keluar dalam satu siklus sync; sesi Web di permintaan berikutnya.
 * Ditulis sekali untuk Web-Desktop dan Mobile (`filesToCopy`).
 */

const KIND_LABEL: Record<string, string> = {
  web: "Web",
  desktop: "Desktop",
  mobile: "Mobile",
};

/** Apa yang terjadi pada target, dengan kalimat yang sesuai jenis kliennya. */
function describeEnd(target: Target) {
  const kept =
    "Unsent data on the device is kept and waits for their decision.";
  if (target.kind === "operator") {
    return `${target.name} is signed out everywhere: browsers on their next page load, desktop and mobile apps at their next sync. ${kept}`;
  }
  const { session } = target;
  const name = session.operator_name ?? "This operator";
  const where = `${KIND_LABEL[session.client_kind] ?? session.client_kind}${
    session.device_label ? ` (${session.device_label})` : ""
  }`;
  return session.client_kind === "web"
    ? `${name} is signed out of ${where} on their next page load.`
    : `${name} is signed out of ${where} at its next sync. ${kept}`;
}

type Target =
  | { kind: "session"; session: ActiveSession }
  | { kind: "operator"; operatorId: number; name: string; count: number };

export function ActiveSessions() {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const isSubmittingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listActiveSessions();
      setSessions(list.sessions);
      setCurrentId(list.current_session_id);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Active sessions could not be loaded. They are read from the cloud, so this device must be online.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byOperator = useMemo(() => {
    const groups = new Map<number, ActiveSession[]>();
    for (const session of sessions) {
      const list = groups.get(session.operator_id) ?? [];
      list.push(session);
      groups.set(session.operator_id, list);
    }
    return [...groups].sort((a, b) =>
      (a[1][0]?.operator_name ?? "").localeCompare(
        b[1][0]?.operator_name ?? "",
      ),
    );
  }, [sessions]);

  const close = () => {
    if (busy) return;
    setTarget(null);
    setReason("");
  };

  const confirm = async () => {
    if (!target || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result =
        target.kind === "session"
          ? await endSession(target.session.session_id, reason)
          : await endOperatorSessions(target.operatorId, reason);
      setTarget(null);
      setReason("");
      await load();
      setNotice(
        result.count === 1
          ? "1 session ended."
          : `${result.count} sessions ended.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The session was not ended.",
      );
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const reasonLength = [...reason.trim()].length;

  return (
    <div className="space-y-4">
      {notice ? (
        <FeedbackBanner tone="success" onDismiss={() => setNotice("")}>
          {notice}
        </FeedbackBanner>
      ) : null}
      {error && !target ? (
        <FeedbackBanner tone="error" onDismiss={() => setError("")}>
          {error}
        </FeedbackBanner>
      ) : null}

      <section className="app-panel overflow-hidden">
        {loading ? (
          <p className="p-4 text-body-md text-on-surface-variant">Loading…</p>
        ) : byOperator.length === 0 ? (
          <p className="p-4 text-body-md text-on-surface-variant">
            No one is signed in.
          </p>
        ) : (
          <ul className="divide-y divide-surface-container">
            {byOperator.map(([operatorId, list]) => {
              const name = list[0]?.operator_name ?? `Operator #${operatorId}`;
              return (
                <li key={operatorId} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-body-md font-semibold text-on-surface">
                      {name}
                    </h3>
                    {list.length > 1 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setTarget({
                            kind: "operator",
                            operatorId,
                            name,
                            count: list.length,
                          })
                        }
                        className="app-btn app-btn-secondary min-h-9"
                      >
                        End all {list.length}
                      </button>
                    ) : null}
                  </div>
                  <ul className="mt-2 space-y-2">
                    {list.map((session) => (
                      <li
                        key={session.session_id}
                        className="flex flex-col gap-2 rounded-md border border-surface-container p-3 sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-body-md text-on-surface">
                            {KIND_LABEL[session.client_kind] ??
                              session.client_kind}
                            {session.device_label
                              ? ` · ${session.device_label}`
                              : ""}
                            {session.session_id === currentId ? (
                              <span className="ml-2 text-body-sm font-semibold text-primary">
                                This session
                              </span>
                            ) : null}
                          </p>
                          <p className="text-body-sm text-on-surface-variant">
                            Signed in {formatDateTime(session.created_at)} ·
                            last seen {formatDateTime(session.last_seen_at)}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setTarget({ kind: "session", session })
                          }
                          className="app-btn app-btn-secondary min-h-9 self-start sm:self-center"
                        >
                          End
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <p className="text-body-sm text-on-surface-variant">
        Desktop and mobile sessions update their last-seen time about every 5
        minutes while syncing.
      </p>

      {target ? (
        <Modal
          title={
            target.kind === "session"
              ? "End this session?"
              : `End all of ${target.name}'s sessions?`
          }
          titleId="end-session-title"
          descriptionId="end-session-body"
          onClose={close}
        >
          <p id="end-session-body" className="text-body-md text-on-surface">
            {describeEnd(target)}
          </p>
          {error ? (
            <div className="mt-3">
              <FeedbackBanner tone="error" onDismiss={() => setError("")}>
                {error}
              </FeedbackBanner>
            </div>
          ) : null}
          <label className="app-label mt-3 grid gap-1.5">
            Reason (recorded in the audit log)
            <textarea
              required
              rows={3}
              maxLength={300}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why this session is being ended"
              className="app-input min-h-20 py-2 font-normal"
            />
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || reasonLength < 3}
              onClick={() => void confirm()}
              className="app-btn app-btn-danger"
            >
              {busy
                ? "Ending…"
                : target.kind === "session"
                  ? "End session"
                  : "End sessions"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={close}
              className="app-btn app-btn-secondary"
            >
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
