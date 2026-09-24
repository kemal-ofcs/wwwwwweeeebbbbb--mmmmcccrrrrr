"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { landingPath } from "@/lib/auth/landing";
import { useAuth } from "@/lib/context/AuthContext";
import { useHydrated } from "@/lib/hooks/useHydrated";

/**
 * `/` tidak punya isi sendiri: ia meneruskan ke halaman pertama akun ini —
 * Pengaturan bila boleh (`landingPath`). Akun yang tidak boleh membuka apa
 * pun tetap mendapat penjelasan di sini, bukan dilempar ke halaman lain.
 */
export default function HomePage() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const hydrated = useHydrated();
  const router = useRouter();
  const ready = hydrated && !isLoading;
  const target = isAuthenticated ? landingPath(user) : "/login";

  useEffect(() => {
    if (ready && target) router.replace(target);
  }, [ready, target, router]);

  if (!ready || target) {
    return (
      <AppShell>
        <p className="text-body-md text-on-surface-variant">Loading...</p>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <p className="app-panel p-4 text-body-md text-on-surface-variant">
        Your account does not have access to any module yet. Ask the Superadmin
        to adjust your role.
      </p>
    </AppShell>
  );
}
