"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { ProductionWorkspace } from "@/components/production/ProductionWorkspace";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

/** Work order produksi (v3.1, PRD F-23/F-24, SCR-15). Isinya dipakai bersama Mobile. */
export default function ProductionPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  if (!isHydrated || authLoading) return <div className="min-h-dvh" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "production")) redirect("/forbidden");

  return (
    <AppShell>
      <ProductionWorkspace />
    </AppShell>
  );
}
