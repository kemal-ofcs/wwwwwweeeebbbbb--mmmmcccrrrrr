"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type {
  ApprovalDecision,
  ApprovalEntityType,
} from "@/lib/validations/approval";

/**
 * Gateway tautan persetujuan klien (v2.5b, PRD F-18). Membuat tautan ada di
 * ketiga target (`desktop_create_approval_link` / `/api/approval/link`);
 * membaca dan menjawabnya hanya di Web, karena halaman klien hanya ada di sana.
 */

export interface ApprovalLink {
  url: string;
  /** `YYYY-MM-DD HH:MM:SS` UTC, dihitung database. */
  expires_at: string;
}

export interface ApprovalCompany {
  name: string;
  phone: string;
}

export type ApprovalView =
  | { valid: false; company: ApprovalCompany }
  | {
      valid: true;
      company: ApprovalCompany;
      entity_type: ApprovalEntityType;
      decisions: ApprovalDecision[];
      expires_at: string;
      client_name: string;
      brand_name: string;
      details: { label: string; value: string }[];
    };

export async function createApprovalLink(
  entityType: ApprovalEntityType,
  entityId: string,
): Promise<ApprovalLink> {
  if (isDesktopRuntime()) {
    return invokeDesktop("desktop_create_approval_link", {
      entityType,
      entityId,
    });
  }
  return requestWebApi("/api/approval/link", "POST", {
    entity_type: entityType,
    entity_id: entityId,
  });
}

function webOnly() {
  if (isDesktopRuntime()) {
    throw new Error("The approval page is only available on the Web.");
  }
}

export async function readApproval(token: string): Promise<ApprovalView> {
  webOnly();
  const result = await requestWebApi<{ approval: ApprovalView }>(
    "/api/approval/query",
    "POST",
    { token },
  );
  return result.approval;
}

export async function respondApproval(
  token: string,
  response: {
    decision: ApprovalDecision;
    responder_name: string;
    notes: string;
  },
): Promise<{ decision: ApprovalDecision }> {
  webOnly();
  return requestWebApi("/api/approval/respond", "POST", {
    token,
    ...response,
  });
}
