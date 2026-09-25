"use client";

import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { SampleWorkspace } from "@/components/samples/SampleWorkspace";
import { canAccessArea } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

/** Tiket sampel (PRD FR-06, SCR-03). Isinya dipakai bersama Mobile. */
export default function SamplesPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  if (!isHydrated || authLoading) return <div className="min-h-dvh" />;
  if (!isAuthenticated) redirect("/login");
  if (!canAccessArea(user, "samples")) redirect("/forbidden");

  return (
    <AppShell>
      <SampleWorkspace />
    </AppShell>
  );
}
