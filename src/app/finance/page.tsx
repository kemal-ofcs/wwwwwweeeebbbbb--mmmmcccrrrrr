"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { FinanceWorkspace } from "@/components/finance/FinanceWorkspace";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

/** Tagihan dan uang masuk (PRD F-17). Isinya dipakai bersama Mobile. */
export default function FinancePage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  if (!isHydrated || authLoading) return <div className="min-h-dvh" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "finance")) redirect("/forbidden");

  return (
    <AppShell>
      <FinanceWorkspace />
    </AppShell>
  );
}
