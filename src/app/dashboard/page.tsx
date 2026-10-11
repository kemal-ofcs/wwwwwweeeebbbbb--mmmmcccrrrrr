"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { DashboardWorkspace } from "@/components/dashboard/DashboardWorkspace";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

/** Dashboard eksekutif (F-40a, D-52). Isinya dipakai bersama Mobile. */
export default function DashboardPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  if (!isHydrated || authLoading) return <div className="min-h-dvh" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "dashboard")) redirect("/forbidden");

  return (
    <AppShell>
      <DashboardWorkspace />
    </AppShell>
  );
}
