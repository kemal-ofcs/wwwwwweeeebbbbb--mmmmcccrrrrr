"use client";

import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/ui/Icon";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

export default function ForbiddenPage() {
  const isHydrated = useHydrated();
  const { isAuthenticated, isLoading } = useAuth();

  if (!isHydrated || isLoading) {
    return <div className="min-h-dvh bg-background" />;
  }
  if (!isAuthenticated) redirect("/login");

  return (
    <AppShell contentClassName="grid place-items-center px-4 py-10">
      <section className="app-panel w-full max-w-xl p-6 text-center sm:p-8">
        <span className="mx-auto grid size-14 place-items-center rounded-md bg-surface-container-low text-on-surface-variant">
          <Icon name="lock" className="size-7" />
        </span>
        <h1 className="mt-4 text-headline-xl text-on-surface">
          Your role does not have permission for this page
        </h1>
        <p className="mx-auto mt-2 max-w-md text-body-md text-on-surface-variant">
          Ask the Superadmin if you need this feature for your work. No data was
          changed.
        </p>
        <Link href="/" className="app-btn app-btn-primary mt-6">
          Back to home
        </Link>
      </section>
    </AppShell>
  );
}
