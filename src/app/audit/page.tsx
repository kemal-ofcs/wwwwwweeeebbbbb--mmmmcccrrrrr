"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { AuditLog } from "@/components/audit/AuditLog";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

/** Log audit domain (PRD FR-10.3). Isinya dipakai bersama Mobile. */
export default function AuditPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  if (!isHydrated || authLoading) return <div className="min-h-dvh" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "audit")) redirect("/forbidden");

  return (
    <AppShell>
      <AuditLog />
    </AppShell>
  );
}
