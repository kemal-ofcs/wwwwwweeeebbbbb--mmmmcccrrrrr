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
  SET_REVISION_FEE: "Set revision fee",
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
  SET_REVISION_FEE: "set the revision fee",
  // Langkah tiket desain (v2.4) di linimasa yang sama.
  REQUEST_DESIGN: "requested a design",
  PRINT_DUMMY: "started printing the dummy",
  DUMMY_SENT: "sent the dummy to the client",
  DUMMY_ACC: "recorded the client's dummy approval",
  DUMMY_REVISE: "recorded a dummy revision request from the client",
  CANCEL_DESIGN: "cancelled the design",
  // Langkah MoU (v2.5a) di linimasa yang sama.
  CREATE_MOU: "drafted the MoU",
  SEND_MOU: "sent the MoU to the client",
  MOU_ACCEPT: "recorded the client's MoU acceptance",
  MOU_REVISE: "recorded MoU changes requested by the client",
  MOU_REJECT: "recorded the client's MoU rejection",
  CANCEL_MOU: "cancelled the MoU",
};

/** Status MoU (v2.5a, PRD F-20). */
export const MOU_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SENT: "Sent to client",
  ACCEPTED: "Accepted by client",
  REJECTED: "Rejected by client",
  CANCELLED: "Cancelled",
};

export const MOU_STATUS_TONE: Record<string, StatusTone> = {
  DRAFT: "neutral",
  SENT: "info",
  ACCEPTED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
};

export const MOU_ACTION_LABEL: Record<string, string> = {
  SEND_MOU: "Send to client",
  MOU_ACCEPT: "Client accepted",
  MOU_REVISE: "Client wants changes",
  MOU_REJECT: "Client rejected",
  CANCEL_MOU: "Cancel MoU",
};

export const REGULATORY_PATH_LABEL: Record<string, string> = {
  WHITE_LABEL: "White Label",
  WITH_BPOM: "With BPOM",
};

/** Status tiket desain (v2.4, PRD F-19). */
export const DESIGN_STATUS_LABEL: Record<string, string> = {
  MOCKUP: "Mockup",
  DUMMY_PRINTING: "Printing dummy",
  DUMMY_SENT: "Dummy sent to client",
  DUMMY_REVISION: "Dummy revision requested",
  DUMMY_ACC: "Dummy approved",
  CANCELLED: "Cancelled",
};

export const DESIGN_STATUS_TONE: Record<string, StatusTone> = {
  MOCKUP: "info",
  DUMMY_PRINTING: "info",
  DUMMY_SENT: "info",
  DUMMY_REVISION: "warning",
  DUMMY_ACC: "success",
  CANCELLED: "neutral",
};

export const DESIGN_ACTION_LABEL: Record<string, string> = {
  PRINT_DUMMY: "Start printing dummy",
  DUMMY_SENT: "Dummy sent",
  DUMMY_ACC: "Client approved dummy",
  DUMMY_REVISE: "Client wants a dummy revision",
  CANCEL_DESIGN: "Cancel design",
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
