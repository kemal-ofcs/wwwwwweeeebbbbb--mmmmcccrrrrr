"use client";

import { redirect } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  approvePasswordReset,
  deletePasswordResetHistory,
  getPasswordResetHistory,
  getPasswordResetPhoto,
  purgePasswordResetHistory,
  type ResetApprovalResult,
} from "@/lib/gateways/password-reset-history";
import { useHydrated } from "@/lib/hooks/useHydrated";
import {
  RESET_DELIVERY_AWAITING_APPROVAL,
  RESET_HISTORY_STATUS_HINT,
  RESET_HISTORY_STATUS_TONE,
  RESET_HISTORY_STATUSES,
  type ResetHistoryEntry,
  type ResetHistoryStatus,
} from "@/lib/operators/password-reset-history";
import { formatDateTime } from "@/lib/utils/format";

type StatusFilter = ResetHistoryStatus | "ALL";

const PURGE_DAYS = 90;

/**
 * Riwayat pengajuan "Lupa Password".
 *
 * Mengajukan reset terbuka untuk semua akun tanpa login — halaman ini adalah
 * sisi lainnya: siapa saja yang pernah mengajukan, kapan, dari identitas apa,
 * lolos verifikasi wajah atau tidak, dan foto wajah pemohonnya. Karena isinya
 * data pribadi, aksesnya diatur dua izin terpisah: `password_reset.view` untuk
 * melihat dan `password_reset.delete` untuk menghapus.
 */
export default function PasswordResetHistoryPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [entries, setEntries] = useState<ResetHistoryEntry[]>([]);
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error" | "warning";
    message: string;
  } | null>(null);
  const [photo, setPhoto] = useState<{
    entry: ResetHistoryEntry;
    src: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ResetHistoryEntry | null>(
    null,
  );
  const [purgeOpen, setPurgeOpen] = useState(false);

  const canDelete = hasPermission(user, "password_reset.delete");
  const canApprove = hasPermission(user, "password_reset.approve");
  const [approval, setApproval] = useState<ResetApprovalResult | null>(null);
  // Ref, bukan state `busy`: dua klik dalam satu tick sama-sama membaca state
  // lama. Menyetujui dua kali menerbitkan dua kode untuk satu permintaan.
  const isSubmittingRef = useRef(false);

  /**
   * Setujui permintaan, lalu tampilkan kodenya.
   *
   * Kode ini tidak disimpan dalam bentuk asli di mana pun — database hanya
   * memegang hash-nya — sehingga layar ini satu-satunya kesempatan membacanya.
   * Karena itu ia ditampilkan sebagai dialog yang harus ditutup peninjau
   * sendiri, bukan notifikasi yang hilang otomatis.
   */
  const approve = async (entry: ResetHistoryEntry) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    try {
      setApproval(await approvePasswordReset(entry.id));
      await load();
    } catch (caught) {
      setFeedback({
        tone: "error",
        message:
          caught instanceof Error
            ? caught.message
            : "The request could not be approved.",
      });
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await getPasswordResetHistory({ status, search }));
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "History could not be loaded.",
      });
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => {
    if (!isAuthenticated) return;
    void load();
  }, [isAuthenticated, load]);

  const openPhoto = async (entry: ResetHistoryEntry) => {
    setBusy(true);
    setFeedback(null);
    try {
      const result = await getPasswordResetPhoto(entry.id);
      setPhoto({
        entry,
        src: `data:${result.mime};base64,${result.base64}`,
      });
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The photo could not be opened.",
      });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    try {
      await deletePasswordResetHistory(deleteTarget.id);
      setDeleteTarget(null);
      setFeedback({
        tone: "success",
        message: `Request history of ${deleteTarget.operatorName} deleted.`,
      });
      await load();
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "History could not be deleted.",
      });
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  const confirmPurge = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBusy(true);
    try {
      const result = await purgePasswordResetHistory(PURGE_DAYS);
      setPurgeOpen(false);
      setFeedback({
        tone: result.deleted > 0 ? "success" : "warning",
        message:
          result.deleted > 0
            ? `${result.deleted} old requests cleared.`
            : `No finished requests are older than ${PURGE_DAYS} days.`,
      });
      await load();
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Clearing history failed.",
      });
    } finally {
      isSubmittingRef.current = false;
      setBusy(false);
    }
  };

  if (!isHydrated || authLoading)
    return <div className="min-h-dvh bg-background" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "password_reset")) redirect("/forbidden");

  const withPhoto = entries.filter((entry) => entry.hasPhoto).length;

  return (
    <AppShell>
      <PageHeader
        title="Password resets"
        description="Every Forgot password request is recorded here with the requester's face verification photo, liveness result, and link delivery status."
        actions={
          <StatusBadge tone={canDelete ? "warning" : "info"}>
            <Icon name={canDelete ? "tools" : "lock"} className="size-3" />
            {canDelete ? "Can delete history" : "Read only"}
          </StatusBadge>
        }
      />

      {feedback ? (
        <FeedbackBanner
          tone={feedback.tone}
          onDismiss={() => setFeedback(null)}
        >
          {feedback.message}
        </FeedbackBanner>
      ) : null}

      <dl className="grid gap-3 sm:grid-cols-3">
        <SummaryTile
          label="Requests shown"
          value={String(entries.length)}
          hint="Matching the current filter"
        />
        <SummaryTile
          label="With photo"
          value={String(withPhoto)}
          hint="Face evidence available"
        />
        <SummaryTile
          label="Password changed"
          value={String(
            entries.filter((entry) => entry.status === "Used").length,
          )}
          hint="Status Used"
        />
      </dl>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row">
          <label className="flex-1">
            <span className="sr-only">Search accounts</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, username, operator code, or typed identity"
              className="app-input w-full"
            />
          </label>
          <label>
            <span className="sr-only">Filter by status</span>
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as StatusFilter)
              }
              className="app-input"
            >
              <option value="ALL">All statuses</option>
              {RESET_HISTORY_STATUSES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>
        {canDelete ? (
          <button
            type="button"
            onClick={() => setPurgeOpen(true)}
            disabled={busy}
            className="app-btn app-btn-secondary text-error"
          >
            Clear history older than {PURGE_DAYS} days
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="app-panel grid min-h-60 place-items-center text-body-md text-on-surface-variant">
          Loading password reset history...
        </div>
      ) : entries.length === 0 ? (
        <div className="app-panel grid min-h-60 place-items-center p-6 text-center">
          <div className="space-y-1">
            <p className="text-headline-md text-on-surface">No requests yet</p>
            <p className="mx-auto max-w-md text-body-md text-on-surface-variant">
              History fills in as soon as an operator uses Forgot password on
              the sign-in page.
            </p>
          </div>
        </div>
      ) : (
        <ul className="grid gap-3">
          {entries.map((entry) => (
            <HistoryCard
              key={entry.id}
              entry={entry}
              busy={busy}
              canDelete={canDelete}
              canApprove={canApprove}
              onOpenPhoto={() => void openPhoto(entry)}
              onDelete={() => setDeleteTarget(entry)}
              onApprove={() => void approve(entry)}
            />
          ))}
        </ul>
      )}

      {approval ? (
        <Modal
          title="Recovery code"
          titleId="reset-approval-title"
          onClose={() => setApproval(null)}
        >
          <div className="space-y-3 text-body-md">
            <p className="text-on-surface">
              Hand this code to <strong>{approval.namaOperator}</strong> in
              person. It is valid for {approval.berlakuMenit} minutes and can be
              used once.
            </p>
            <p className="select-all break-all rounded-md border border-outline-variant bg-surface-container-low p-3 text-center font-mono text-headline-md tracking-wider text-on-surface">
              {approval.token}
            </p>
            <p className="rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed p-3 text-on-tertiary-fixed">
              This code is not stored and cannot be shown again. If this window
              is closed before the code is handed over, the requester must
              submit a new request.
            </p>
            <button
              type="button"
              onClick={() => setApproval(null)}
              className="app-btn app-btn-primary w-full"
            >
              I have handed over the code
            </button>
          </div>
        </Modal>
      ) : null}

      {photo ? (
        <Modal
          title={`Verification photo: ${photo.entry.operatorName}`}
          titleId="reset-photo-title"
          onClose={() => setPhoto(null)}
        >
          <div className="space-y-3">
            {/* Foto bukti disimpan sebagai base64 di database cloud, jadi
                ditampilkan lewat data URI — tidak ada permintaan jaringan
                keluar, sesuai batasan CSP Desktop. */}
            {/** biome-ignore lint/performance/noImgElement: sumbernya data URI dari database, bukan aset yang bisa dioptimalkan next/image */}
            <img
              src={photo.src}
              alt={`Face of the password reset requester ${photo.entry.operatorName}`}
              className="w-full rounded-md border border-surface-container"
            />
            <dl className="grid gap-2 rounded-md border border-surface-container bg-surface-container-low p-3 sm:grid-cols-2">
              <DetailRow
                label="Requested"
                value={formatDateTime(photo.entry.requestedAt)}
              />
              <DetailRow
                label="Liveness score"
                value={formatScore(photo.entry.livenessScore)}
              />
              <DetailRow
                label="Challenges"
                value={
                  photo.entry.livenessChallenges.join(", ") || "Not recorded"
                }
              />
              <DetailRow label="Status" value={photo.entry.status} />
            </dl>
            <p className="text-body-sm text-on-surface-variant">
              This photo is not legal proof of identity. Liveness verification
              stops printed photos and still screens, not a video recording of
              someone else, so also check that the timing and typed identity
              make sense.
            </p>
          </div>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <Modal
          title="Delete this request?"
          titleId="reset-delete-title"
          onClose={() => setDeleteTarget(null)}
        >
          <div className="space-y-4">
            <p className="text-body-md text-on-surface">
              The request history of{" "}
              <strong>{deleteTarget.operatorName}</strong> and its verification
              photo will be deleted permanently.
            </p>
            {deleteTarget.status === "Sent" ? (
              <p className="rounded-md border border-tertiary-fixed-dim bg-tertiary-fixed p-3 text-body-md text-on-tertiary-fixed">
                This request is still live: its reset link has not been used.
                Deleting it also disables that link, and the owner will need to
                request Forgot password again.
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="app-btn app-btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={busy}
                className="app-btn app-btn-danger"
              >
                {busy ? "Deleting..." : "Delete permanently"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {purgeOpen ? (
        <Modal
          title="Clear old history?"
          titleId="reset-purge-title"
          onClose={() => setPurgeOpen(false)}
        >
          <div className="space-y-4">
            <p className="text-body-md text-on-surface">
              All requests with status Used, Expired, or Cancelled that are
              older than {PURGE_DAYS} days will be deleted with their photos.
              Requests still in progress are kept.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setPurgeOpen(false)}
                className="app-btn app-btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmPurge()}
                disabled={busy}
                className="app-btn app-btn-danger"
              >
                {busy ? "Clearing..." : "Clear now"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </AppShell>
  );
}

function SummaryTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="app-panel p-3">
      <dt className="font-mono text-label-caps uppercase text-on-surface-variant">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-headline-xl tabular-nums text-on-surface">
        {value}
      </dd>
      <dd className="text-body-sm text-on-surface-variant">{hint}</dd>
    </div>
  );
}

function HistoryCard({
  entry,
  busy,
  canDelete,
  canApprove,
  onOpenPhoto,
  onDelete,
  onApprove,
}: {
  entry: ResetHistoryEntry;
  busy: boolean;
  canDelete: boolean;
  canApprove: boolean;
  onOpenPhoto: () => void;
  onDelete: () => void;
  onApprove: () => void;
}) {
  // Hanya permintaan yang benar-benar menunggu peninjauan manusia yang boleh
  // disetujui. Menampilkan tombolnya pada baris lain akan mengundang klik yang
  // pasti ditolak backend.
  const awaitingApproval =
    entry.deliveryStatus === RESET_DELIVERY_AWAITING_APPROVAL &&
    entry.status === "Pending Verification";
  return (
    <li className="app-panel p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-headline-md text-on-surface">
              {entry.operatorName}
            </p>
            <StatusBadge tone={RESET_HISTORY_STATUS_TONE[entry.status]}>
              {entry.status}
            </StatusBadge>
          </div>
          <p className="text-body-sm text-on-surface-variant">
            <span className="font-mono">{entry.kodeOperator}</span> · @
            {entry.username} · {entry.maskedEmail}
          </p>
          <p className="text-body-md text-on-surface-variant">
            {RESET_HISTORY_STATUS_HINT[entry.status]}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {entry.hasPhoto ? (
            <button
              type="button"
              onClick={onOpenPhoto}
              disabled={busy}
              className="app-btn app-btn-secondary"
            >
              View photo
            </button>
          ) : (
            <span className="inline-flex min-h-11 items-center px-2 text-body-md text-on-surface-variant">
              No photo
            </span>
          )}
          {canApprove && awaitingApproval ? (
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="app-btn app-btn-primary"
            >
              Approve
            </button>
          ) : null}
          {canDelete ? (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="app-btn app-btn-secondary text-error"
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>

      <dl className="mt-3 grid gap-2 border-t border-surface-container pt-3 sm:grid-cols-2 lg:grid-cols-4">
        <DetailRow
          label="Requested"
          value={formatDateTime(entry.requestedAt)}
        />
        <DetailRow label="Typed" value={entry.identifierUsed || "-"} />
        <DetailRow
          label="Liveness score"
          value={formatScore(entry.livenessScore)}
        />
        <DetailRow
          label="Delivery"
          value={entry.deliveryStatus || "Not sent yet"}
        />
      </dl>

      {entry.deliveryError ? (
        <p className="mt-2 rounded-md border border-error/30 bg-error-container p-2.5 text-body-md text-on-error-container">
          {entry.deliveryError}
        </p>
      ) : null}
      {entry.livenessReason && entry.status !== "Used" ? (
        <p className="mt-2 text-body-sm text-on-surface-variant">
          Verification note: {entry.livenessReason}
        </p>
      ) : null}
    </li>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-label-caps uppercase text-on-surface-variant">
        {label}
      </dt>
      <dd className="truncate text-body-md font-semibold text-on-surface">
        {value}
      </dd>
    </div>
  );
}

function formatScore(score: number | null) {
  return score == null ? "Not scored" : `${Math.round(score * 100)}%`;
}
