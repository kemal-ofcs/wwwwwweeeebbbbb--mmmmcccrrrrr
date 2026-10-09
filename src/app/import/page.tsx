"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { SheetImport } from "@/components/imports/SheetImport";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

/**
 * Impor CSV sheet lama (v2.7, PRD F-22). Terbuka bagi pemegang salah satu
 * izin impor; jenis yang ditawarkan dan izin per jenis diputuskan
 * `sheetImportPermission`, dan backend memeriksanya ulang.
 */
export default function SheetImportPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  if (!isHydrated || authLoading) return <div className="min-h-dvh" />;
  if (!isAuthenticated) redirect("/login");
  if (
    !hasPermission(user, "finance.manage") &&
    !hasPermission(user, "rnd.manage") &&
    !hasPermission(user, "design.manage")
  ) {
    redirect("/forbidden");
  }

  return (
    <AppShell>
      <SheetImport />
    </AppShell>
  );
}
