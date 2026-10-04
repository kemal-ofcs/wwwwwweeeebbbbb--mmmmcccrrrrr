"use client";

import { requestWebApi } from "@/lib/client/api-client";
import { isDesktopRuntime } from "@/lib/runtime/app-runtime";
import { invokeDesktop } from "@/lib/runtime/desktop-commands";
import type { NotificationDivision } from "@/lib/validations/notification";

/**
 * Notifikasi divisi (PRD FR-08): lonceng dan Pengaturan › Notifikasi. Rust dan
 * Web mengembalikan bentuk yang sama (snake_case) di kedua cabang.
 */

export interface TelegramSettings {
  config: {
    is_active: boolean;
    has_bot_token: boolean;
    updated_at: string;
    updated_by: string;
  };
  pending: number;
  failed: {
    id: string;
    event_type: string;
    target_division: string;
    occurred_at: string;
    attempts: number;
    last_error: string;
  }[];
}

export interface TelegramTestResult {
  delivered: boolean;
  detail: string;
}

export interface BellNotification {
  id: string;
  event_type: string;
  target_division: string;
  text: string;
  client_id: string;
  sample_id: string;
  created_at: string;
}

export interface BellState {
  unread: number;
  items: BellNotification[];
}

export async function getTelegramSettings(): Promise<TelegramSettings> {
  if (isDesktopRuntime()) {
    return invokeDesktop<TelegramSettings>("desktop_get_telegram_config");
  }
  return requestWebApi<TelegramSettings>(
    "/api/settings/telegram/query",
    "POST",
  );
}

/** `bot_token` kosong = pertahankan token tersimpan. */
export async function saveTelegramConfig(draft: {
  bot_token: string;
  is_active: boolean;
}): Promise<TelegramSettings> {
  if (isDesktopRuntime()) {
    return invokeDesktop<TelegramSettings>("desktop_save_telegram_config", {
      draft,
    });
  }
  return requestWebApi<TelegramSettings>("/api/settings/telegram", "PUT", {
    draft,
  });
}

export async function sendTestTelegram(
  division: NotificationDivision,
): Promise<TelegramTestResult> {
  if (isDesktopRuntime()) {
    return invokeDesktop<TelegramTestResult>("desktop_send_test_telegram", {
      division,
    });
  }
  const response = await requestWebApi<{ test: TelegramTestResult }>(
    "/api/settings/telegram",
    "POST",
    { action: "test", division },
  );
  return response.test;
}

export async function retryFailedNotifications(): Promise<TelegramSettings> {
  if (isDesktopRuntime()) {
    return invokeDesktop<TelegramSettings>(
      "desktop_retry_failed_notifications",
    );
  }
  return requestWebApi<TelegramSettings>("/api/settings/telegram", "POST", {
    action: "retry",
  });
}

export async function listNotifications(): Promise<BellState> {
  if (isDesktopRuntime()) {
    return invokeDesktop<BellState>("desktop_list_notifications");
  }
  return requestWebApi<BellState>("/api/notifications/query", "POST");
}

export async function markNotificationsSeen(): Promise<void> {
  if (isDesktopRuntime()) {
    await invokeDesktop("desktop_mark_notifications_seen");
    return;
  }
  await requestWebApi("/api/notifications", "POST");
}
