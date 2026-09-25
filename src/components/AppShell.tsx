"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { type AppArea, canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { AutoSyncRunner } from "./AutoSyncRunner";
import { LicenseHolderLabel, LicenseNotice } from "./license/LicenseNotice";
import { QuarantineBanner } from "./QuarantineBanner";
import { SyncIndicator } from "./SyncIndicator";

interface NavItem {
  readonly area: AppArea;
  readonly href: string;
  readonly label: string;
}

/**
 * Menu aplikasi.
 *
 * Setiap entri dijaga oleh `area`-nya, sehingga menu, guard halaman, dan
 * pemeriksaan permission di backend Rust merujuk daftar permission yang sama.
 * Menyembunyikan menu saja tidak pernah cukup: backend tetap wajib memeriksa.
 */
const NAV_ITEMS: readonly NavItem[] = [
  { area: "clients", href: "/clients", label: "Clients" },
  { area: "operators", href: "/operators", label: "Operators" },
  { area: "audit", href: "/audit", label: "Audit" },
  {
    area: "password_reset",
    href: "/password-reset-history",
    label: "Password resets",
  },
  { area: "settings", href: "/settings", label: "Settings" },
];

interface AppShellProps {
  children: ReactNode;
  contentClassName?: string;
}

export function AppShell({ children, contentClassName = "" }: AppShellProps) {
  const { user, logout } = useAuth();
  const pathname = usePathname();

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
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
          <Link href="/" className="text-headline-md font-bold text-on-surface">
            App Template
          </Link>
          <LicenseHolderLabel className="hidden max-w-[14rem] truncate text-body-sm text-on-surface-variant sm:block" />
          <nav
            aria-label="Main"
            className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
          >
            {visible.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`inline-flex min-h-9 items-center rounded-md px-3 text-body-md font-semibold transition-colors ${
                    active
                      ? "bg-secondary-fixed text-on-secondary-fixed-variant"
                      : "text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <SyncIndicator />
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

      <main
        id="main-content"
        className={`mx-auto flex w-full min-h-0 max-w-6xl flex-1 flex-col gap-4 px-4 py-4 ${contentClassName}`}
      >
        {children}
      </main>
    </div>
  );
}
