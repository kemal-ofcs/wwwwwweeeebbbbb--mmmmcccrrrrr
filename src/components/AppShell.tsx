"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { type AppArea, canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { AutoSyncRunner } from "./AutoSyncRunner";
import { LicenseHolderLabel, LicenseNotice } from "./license/LicenseNotice";
import { NotificationBell } from "./NotificationBell";
import { QuarantineBanner } from "./QuarantineBanner";
import { SyncIndicator } from "./SyncIndicator";
import { Icon, type IconName } from "./ui/Icon";

interface NavItem {
  readonly area: AppArea;
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
}

/**
 * Menu aplikasi.
 *
 * Setiap entri dijaga oleh `area`-nya, sehingga menu, guard halaman, dan
 * pemeriksaan permission di backend Rust merujuk daftar permission yang sama.
 * Menyembunyikan menu saja tidak pernah cukup: backend tetap wajib memeriksa.
 */
const NAV_ITEMS: readonly NavItem[] = [
  { area: "clients", href: "/clients", label: "Clients", icon: "users" },
  { area: "samples", href: "/samples", label: "Samples", icon: "document" },
  { area: "finance", href: "/finance", label: "Finance", icon: "database" },
  { area: "operators", href: "/operators", label: "Operators", icon: "user" },
  { area: "audit", href: "/audit", label: "Audit", icon: "history" },
  {
    area: "password_reset",
    href: "/password-reset-history",
    label: "Password resets",
    icon: "lock",
  },
  { area: "settings", href: "/settings", label: "Settings", icon: "settings" },
];

/** Pilihan tampil/sembunyi sidebar, khusus perangkat ini (bukan data sinkron). */
const SIDEBAR_KEY = "companyos.sidebar-hidden";
const WIDE_SCREEN = "(min-width: 1024px)";

interface AppShellProps {
  children: ReactNode;
  contentClassName?: string;
}

/**
 * Kerangka layar Desktop dan Web.
 *
 * Layar lebar: sidebar tetap di kiri, bisa disembunyikan, dan pilihannya
 * diingat per perangkat. Layar sempit (Web di HP): sidebar menjadi laci yang
 * ditutup lagi begitu sebuah menu dipilih. Mobile memakai `MobileAppShell`.
 */
export function AppShell({ children, contentClassName = "" }: AppShellProps) {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const [hidden, setHidden] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Dibaca setelah mount supaya HTML server dan klien sama (tanpa hydration
  // mismatch). Penyimpanan bisa diblokir, jadi kegagalannya diabaikan.
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(SIDEBAR_KEY) === "1");
    } catch {}
  }, []);

  const toggleMenu = () => {
    if (!window.matchMedia(WIDE_SCREEN).matches) {
      setDrawerOpen((open) => !open);
      return;
    }
    const next = !hidden;
    setHidden(next);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
    } catch {}
  };

  const visible = NAV_ITEMS.filter((item) => canAccessArea(user, item.area));

  return (
    <div className="flex min-h-dvh flex-col text-on-surface">
      {/* Sinkronisasi latar wajib selalu terpasang: mutasi lokal baru sampai ke
          cloud lewat siklus ini, bukan lewat aksi pengguna. */}
      <AutoSyncRunner />
      <a
        href="#main-content"
        className="fixed left-4 top-3 z-[100] -translate-y-20 rounded-md bg-primary px-3 py-2 text-body-md font-semibold text-on-primary transition-transform focus:translate-y-0"
      >
        Skip to main content
      </a>

      <header className="sticky top-0 z-40 border-b border-surface-container bg-surface-container-lowest shadow-[0_1px_8px_rgb(0_0_0/0.04)]">
        <div className="flex h-14 items-center gap-3 px-4">
          <button
            type="button"
            onClick={toggleMenu}
            aria-controls="app-sidebar"
            aria-label="Show or hide menu"
            className="grid size-9 shrink-0 place-items-center rounded-md text-on-surface-variant transition-colors hover:bg-surface-container-low hover:text-on-surface"
          >
            <Icon name="menu" />
          </button>
          <Link
            href="/"
            className="shrink-0 text-headline-md font-bold text-on-surface"
          >
            Company OS
          </Link>
          <LicenseHolderLabel className="hidden max-w-[14rem] truncate text-body-sm text-on-surface-variant md:block" />
          <div className="flex-1" />
          <SyncIndicator />
          <NotificationBell />
          {user ? (
            <div className="flex items-center gap-2">
              <span className="hidden max-w-[12rem] truncate text-body-sm text-on-surface-variant sm:block">
                {user.nama_operator}
              </span>
              <button
                type="button"
                onClick={logout}
                className="min-h-9 rounded-md border border-outline-variant px-3 text-body-md font-semibold text-on-surface-variant transition-colors hover:border-error hover:text-error"
              >
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <LicenseNotice />
      <QuarantineBanner />

      <div className="flex flex-1">
        {drawerOpen ? (
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="fixed inset-0 z-40 bg-inverse-surface/30 lg:hidden"
          />
        ) : null}
        <aside
          id="app-sidebar"
          className={`fixed inset-y-0 left-0 z-50 w-60 shrink-0 flex-col overflow-y-auto border-r border-surface-container bg-surface-container-lowest transition-transform lg:sticky lg:top-14 lg:bottom-auto lg:z-auto lg:h-[calc(100dvh-3.5rem)] lg:translate-x-0 lg:transition-none ${
            drawerOpen
              ? "flex translate-x-0"
              : "invisible flex -translate-x-full lg:visible"
          } ${hidden ? "lg:hidden" : "lg:flex"}`}
        >
          <nav aria-label="Main" className="flex flex-col gap-1 p-3">
            {visible.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setDrawerOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-10 items-center gap-3 rounded-md px-3 text-body-md font-semibold transition-colors ${
                    active
                      ? "bg-secondary-fixed text-on-secondary-fixed-variant"
                      : "text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface"
                  }`}
                >
                  <Icon name={item.icon} className="size-5 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        <main
          id="main-content"
          className={`mx-auto flex w-full min-w-0 max-w-6xl flex-1 flex-col gap-4 px-4 py-4 ${contentClassName}`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
