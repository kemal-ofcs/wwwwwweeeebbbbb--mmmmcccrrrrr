"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { CrmWorkspace } from "@/components/crm/CrmWorkspace";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

/** Klien yang dikelola CRM (v3.6a, PRD F-29, SCR-18). Isinya dipakai bersama Mobile. */
export default function CrmPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  if (!isHydrated || authLoading) return <div className="min-h-dvh" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "crm")) redirect("/forbidden");

  return (
    <AppShell>
      <CrmWorkspace />
    </AppShell>
  );
}
