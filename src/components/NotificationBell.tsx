"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  type BellNotification,
  listNotifications,
  markNotificationsSeen,
} from "@/lib/gateways/notifications";
import { SYNC_COMPLETED_EVENT } from "@/lib/gateways/sync-status";
import { formatDateTime } from "@/lib/utils/format";
import { OPEN_DETAIL_EVENT } from "@/lib/utils/open-detail";
import {
  NOTIFICATION_DIVISIONS,
  NOTIFICATION_PERMISSIONS,
} from "@/lib/validations/notification";

/**
 * Lonceng notifikasi (PRD FR-08). Membaca kejadian yang sama dengan Telegram
 * dari database (cloud-only), jadi saat offline hanya daftar terakhir yang
 * tampil. Dimuat ulang tiap 60 detik selama jendela terlihat dan setiap siklus
 * sync selesai; membuka panel menandai semuanya dibaca di semua perangkat.
 */

const REFRESH_MS = 60_000;

function target(
  item: BellNotification,
): { path: string; query: string } | null {
  if (item.event_type === "COLD_DIGEST")
    return { path: "/clients", query: "tab=cold" };
  if (item.event_type === "LEAD_NEW" && item.client_id) {
    return {
      path: "/clients",
      query: `id=${encodeURIComponent(item.client_id)}`,
    };
  }
  if (item.event_type.startsWith("SAMPLE_") && item.sample_id) {
    return {
      path: "/samples",
      query: `id=${encodeURIComponent(item.sample_id)}`,
    };
  }
  return null;
}

export function NotificationBell() {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const allowed = NOTIFICATION_DIVISIONS.some((division) =>
    hasPermission(user, NOTIFICATION_PERMISSIONS[division]),
  );
  const [items, setItems] = useState<BellNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState(false);
  const isSubmittingRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await listNotifications();
      setItems(state.items);
      setUnread(state.unread);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void refresh();
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener(SYNC_COMPLETED_EVENT, tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener(SYNC_COMPLETED_EVENT, tick);
    };
  }, [allowed, refresh]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(false);
        return;
      }
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!allowed) return null;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || unread === 0 || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    try {
      await markNotificationsSeen();
      setUnread(0);
    } catch {
      // Tetap belum dibaca; dicoba lagi saat panel dibuka berikutnya.
    } finally {
      isSubmittingRef.current = false;
    }
  };

  const go = (destination: { path: string; query: string }) => {
    setOpen(false);
    router.push(`${destination.path}?${destination.query}`);
    if (pathname === destination.path) {
      const params = new URLSearchParams(destination.query);
      window.dispatchEvent(
        new CustomEvent(OPEN_DETAIL_EVENT, {
          detail: {
            id: params.get("id") ?? undefined,
            tab: params.get("tab") ?? undefined,
          },
        }),
      );
    }
  };

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={
          unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
        }
        className="relative grid size-9 place-items-center rounded-md text-on-surface-variant transition-colors hover:bg-surface-container-low hover:text-on-surface"
      >
        <Icon name="bell" className="size-5" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-error px-1 font-mono text-[10px] font-bold leading-4 text-on-error">
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="fixed inset-x-4 top-14 z-50 max-h-[70dvh] overflow-y-auto rounded-md border border-surface-container bg-surface-container-lowest shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-96">
          <div className="flex items-center justify-between border-b border-surface-container px-4 py-3">
            <h2 className="text-body-md font-semibold text-on-surface">
              Notifications
            </h2>
            {offline ? (
              <span className="text-body-sm text-on-surface-variant">
                Offline
              </span>
            ) : null}
          </div>
          {offline ? (
            <p className="border-b border-surface-container px-4 py-2 text-body-sm text-on-surface-variant">
              New notifications appear once this device is connected.
            </p>
          ) : null}
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-body-md text-on-surface-variant">
              No notifications yet.
            </p>
          ) : (
            <ul>
              {items.map((item) => {
                const destination = target(item);
                const reachable =
                  destination !== null &&
                  canAccessArea(
                    user,
                    destination.path === "/samples" ? "samples" : "clients",
                  )
                    ? destination
                    : null;
                const [headline, ...rest] = item.text.split("\n");
                const body = (
                  <>
                    <span className="block font-semibold text-on-surface">
                      {headline}
                    </span>
                    {rest.length > 0 ? (
                      <span className="mt-0.5 block whitespace-pre-line text-on-surface-variant">
                        {rest.join("\n")}
                      </span>
                    ) : null}
                    <span className="mt-1 block text-body-sm text-on-surface-variant">
                      {formatDateTime(item.created_at)}
                    </span>
                  </>
                );
                return (
                  <li
                    key={item.id}
                    className="border-b border-surface-container text-body-sm last:border-b-0"
                  >
                    {reachable ? (
                      <button
                        type="button"
                        onClick={() => go(reachable)}
                        className="block w-full px-4 py-3 text-left transition-colors hover:bg-surface-container-low"
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="px-4 py-3">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
