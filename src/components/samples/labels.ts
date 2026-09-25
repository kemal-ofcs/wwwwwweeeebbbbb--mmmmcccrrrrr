import type { StatusTone } from "@/components/ui/StatusBadge";
import type { SampleAction } from "@/lib/validations/sample";

/** Label tampilan status dan langkah tiket sampel (PRD FR-06.4). */

export const SAMPLE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  RND_REVIEW: "RnD review",
  RND_REJECTED: "Rejected by RnD",
  RND_ACCEPTED: "Accepted by RnD",
  WAITING_SAMPLE_PAYMENT: "Waiting for sample payment",
  IN_RND: "In RnD",
  SAMPLE_READY: "Sample ready",
  SAMPLE_SENT: "Sent to client",
  CLIENT_ACC: "Client approved",
  CLIENT_REJECT: "Client rejected",
  PENDING_FEE_ASSESSMENT: "Waiting for revision fee",
  WAITING_REVISION_PAYMENT: "Waiting for revision payment",
  CANCELLED: "Cancelled",
};

export const SAMPLE_STATUS_TONE: Record<string, StatusTone> = {
  DRAFT: "neutral",
  RND_REVIEW: "info",
  RND_REJECTED: "danger",
  RND_ACCEPTED: "info",
  WAITING_SAMPLE_PAYMENT: "warning",
  IN_RND: "info",
  SAMPLE_READY: "info",
  SAMPLE_SENT: "info",
  CLIENT_ACC: "success",
  CLIENT_REJECT: "danger",
  PENDING_FEE_ASSESSMENT: "warning",
  WAITING_REVISION_PAYMENT: "warning",
  CANCELLED: "neutral",
};

export const SAMPLE_ACTION_LABEL: Record<SampleAction, string> = {
  SUBMIT_TO_RND: "Send to RnD",
  RND_ACCEPT: "RnD accepted",
  RND_REJECT: "RnD rejected",
  PROCEED: "Proceed",
  PAYMENT_RECEIVED: "Payment received",
  SAMPLE_READY: "Sample ready",
  SAMPLE_SENT: "Sample sent to client",
  CLIENT_ACC: "Client approved",
  CLIENT_REVISE: "Client wants a revision",
  CLIENT_REJECT: "Client rejected",
  CANCEL: "Cancel request",
};

/** Kalimat linimasa: apa yang dicatat pada satu langkah. */
export const SAMPLE_ACTION_PAST: Record<string, string> = {
  SUBMIT_TO_RND: "sent the request to RnD",
  RND_ACCEPT: "recorded that RnD accepted the request",
  RND_REJECT: "recorded that RnD rejected the request",
  PROCEED: "moved the request on",
  PAYMENT_RECEIVED: "recorded the payment as received",
  SAMPLE_READY: "recorded the sample as ready",
  SAMPLE_SENT: "sent the sample to the client",
  CLIENT_ACC: "recorded the client's approval",
  CLIENT_REVISE: "recorded a revision request from the client",
  CLIENT_REJECT: "recorded the client's rejection",
  CANCEL: "cancelled the request",
};

/** Lama tiket di status sekarang, untuk lencana waktu. Hanya tampilan. */
export function timeInStatus(changedAt: string, nowMs = Date.now()) {
  const value = changedAt.trim();
  if (!value) return "";
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const start = new Date(iso).getTime();
  if (Number.isNaN(start)) return "";
  const hours = Math.max(0, Math.floor((nowMs - start) / 3_600_000));
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} d`;
  return `${Math.floor(days / 7)} wk`;
}
