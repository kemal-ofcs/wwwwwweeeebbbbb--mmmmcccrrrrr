"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

/**
 * Gateway sesi aktif (PRD FR-10.3, FR-10.4). Tauri: `desktop_*_session*`,
 * hanya online karena sesi hidup di cloud. Web: `/api/sessions/*`.
 */

export interface ActiveSession {
  session_id: string;
  operator_id: number;
  operator_name: string | null;
  /** `web`, `desktop`, atau `mobile`. */
  client_kind: string;
  device_label: string;
  created_at: string;
  last_seen_at: string;
}

export interface ActiveSessionList {
  /** Sesi yang sedang dipakai layar ini, bila diketahui. */
  current_session_id: string | null;
  sessions: ActiveSession[];
}

export async function listActiveSessions(): Promise<ActiveSessionList> {
  if (isDesktopRuntime()) {
    return invokeDesktop<ActiveSessionList>("desktop_list_active_sessions");
  }
  const result = await requestWebApi<ActiveSessionList>(
    "/api/sessions/query",
    "POST",
  );
  return {
    current_session_id: result.current_session_id ?? null,
    sessions: result.sessions ?? [],
  };
}

export async function endSession(
  sessionId: string,
  reason: string,
): Promise<{ count: number }> {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ count: number }>("desktop_end_session", {
      sessionId,
      reason,
    });
  }
  return requestWebApi<{ count: number }>("/api/sessions/end", "POST", {
    session_id: sessionId,
    reason,
  });
}

export async function endOperatorSessions(
  operatorId: number,
  reason: string,
): Promise<{ count: number }> {
  if (isDesktopRuntime()) {
    return invokeDesktop<{ count: number }>("desktop_end_operator_sessions", {
      operatorId,
      reason,
    });
  }
  return requestWebApi<{ count: number }>("/api/sessions/end", "POST", {
    operator_id: operatorId,
    reason,
  });
}

/**
 * Web saja: alasan sesi cookie ini diakhiri dari luar, untuk layar login.
 * `null` bila sesinya masih aktif, logout biasa, atau di Desktop/Mobile (di
 * sana `AutoSyncRunner` sudah menjelaskannya lewat modal).
 */
export async function readEndedSessionReason(): Promise<string | null> {
  if (isDesktopRuntime()) return null;
  try {
    const response = await fetch("/api/auth/session", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = (await response.json()) as { ended?: string | null };
    return typeof body.ended === "string" ? body.ended : null;
  } catch {
    return null;
  }
}

/** Kalimat untuk alasan pengakhiran sesi. */
export function describeSessionEnd(reason: string) {
  return reason === "ENDED_BY_ADMIN"
    ? "An administrator ended your session."
    : "Your account signed in on another device.";
}
