"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ClientImport } from "@/components/clients/ClientImport";
import { canAccessArea, hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

/**
 * Impor CSV klien (PRD FR-09). Menetapkan PIC untuk operator lain, jadi
 * butuh `clients.manage` DAN `leads.reassign` (keputusan H). Isinya dipakai
 * bersama Mobile.
 */
export default function ClientImportPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  if (!isHydrated || authLoading) return <div className="min-h-dvh" />;
  if (!isAuthenticated) redirect("/login");
  if (
    !canAccessArea(user, "clients") ||
    !hasPermission(user, "clients.manage") ||
    !hasPermission(user, "leads.reassign")
  ) {
    redirect("/forbidden");
  }

  return (
    <AppShell>
      <ClientImport />
    </AppShell>
  );
}
