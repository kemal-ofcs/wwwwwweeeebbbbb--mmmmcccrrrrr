"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ClientWorkspace } from "@/components/clients/ClientWorkspace";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

/** Workspace klien & intake lead (PRD FR-04). Isinya dipakai bersama Mobile. */
export default function ClientsPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  if (!isHydrated || authLoading) return <div className="min-h-dvh" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "clients")) redirect("/forbidden");

  return (
    <AppShell>
      <ClientWorkspace />
    </AppShell>
  );
}
