"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";

export interface ActivityRecord {
  event_key: string;
  kode_item: string;
  jenis: string;
  jumlah: number;
  keterangan: string | null;
  kode_operator: string | null;
  waktu: string;
}

export interface ActivityDraft {
  kode_item: string;
  jenis: string;
  jumlah: number;
  keterangan?: string;
}

export async function listActivities(limit = 200): Promise<ActivityRecord[]> {
  if (isDesktopRuntime()) {
    return invokeDesktop<ActivityRecord[]>("desktop_list_activities", {
      limit,
    });
  }
  const result = await requestWebApi<{ activities: ActivityRecord[] }>(
    "/api/activities/query",
    "POST",
    { limit },
  );
  return result.activities ?? [];
}

export async function recordActivity(activity: ActivityDraft): Promise<void> {
  if (isDesktopRuntime()) {
    await invokeDesktop("desktop_record_activity", { activity });
    return;
  }
  await requestWebApi("/api/activities", "POST", activity);
}
