import type { DatabaseCheckResult } from "@/lib/gateways/bootstrap";

export type DatabaseCheckTone = "success" | "warning" | "danger";

export type DatabaseCheckFact = {
  label: string;
  value: string;
};

export type DatabaseCheckSummary = {
  tone: DatabaseCheckTone;
  title: string;
  detail: string;
  /** Form Superadmin boleh dibuka. */
  canCreateSuperadmin: boolean;
  /** Database sudah punya Superadmin aktif; cukup dipakai tanpa membuat akun baru. */
  canUseExisting: boolean;
  /** Skema asing terdeteksi sehingga user wajib mengonfirmasi database benar. */
  requiresConfirmation: boolean;
  facts: DatabaseCheckFact[];
};

const numberFormatter = new Intl.NumberFormat("id-ID");

function formatCount(total: number) {
  return numberFormatter.format(Math.max(0, Math.trunc(total)));
}

function buildFacts(check: DatabaseCheckResult): DatabaseCheckFact[] {
  const facts: DatabaseCheckFact[] = [
    { label: "Database origin", value: check.serverOrigin || "-" },
    {
      label: "Latency",
      value:
        check.latencyMs === null ? "-" : `${formatCount(check.latencyMs)} ms`,
    },
    {
      label: "Company profile",
      value: check.companyName ?? "Not set",
    },
    {
      label: "Active Superadmin",
      value: check.superadminExists
        ? `${formatCount(check.superadminCount)} accounts (${check.superadminUsername ?? "-"})`
        : "None yet",
    },
    { label: "Active operators", value: formatCount(check.operatorCount) },
    {
      label: "Items (example domain)",
      value: formatCount(check.karyawanCount),
    },
    {
      label: "Activity log entries",
      value: formatCount(check.attendanceCount),
    },
    { label: "Tables found", value: formatCount(check.tableCount) },
  ];
  return facts;
}

/**
 * Menerjemahkan hasil pemeriksaan database menjadi verdict yang dipakai
 * layar provisioning Desktop maupun Mobile.
 */
export function summarizeDatabaseCheck(
  check: DatabaseCheckResult,
): DatabaseCheckSummary {
  if (!check.reachable) {
    return {
      tone: "danger",
      title: "The database cannot be reached",
      detail:
        check.errorMessage ??
        "Check the Turso database URL, the Auth Token, and the device's internet connection.",
      canCreateSuperadmin: false,
      canUseExisting: false,
      requiresConfirmation: false,
      facts: check.serverOrigin
        ? [{ label: "Database origin", value: check.serverOrigin }]
        : [],
    };
  }

  const facts = buildFacts(check);

  if (check.superadminExists) {
    return {
      tone: "success",
      title: "A Superadmin already exists in this database",
      detail: `The account "${check.superadminUsername ?? "superadmin"}" is still active, so there is no need to create a new Superadmin. Use this database and sign in with that account.`,
      canCreateSuperadmin: false,
      canUseExisting: true,
      requiresConfirmation: false,
      facts,
    };
  }

  if (check.emptyDatabase) {
    return {
      tone: "warning",
      title: "The database is empty",
      detail:
        "There are no tables at all. The App Template schema is created automatically when the first Superadmin is set up. Make sure this URL really is your new database.",
      canCreateSuperadmin: true,
      canUseExisting: false,
      requiresConfirmation: false,
      facts,
    };
  }

  if (!check.schemaReady) {
    return {
      tone: "danger",
      title: "Connected, but this is not an App Template schema",
      detail: `Missing core tables: ${check.missingTables.join(", ")}. The database URL is most likely wrong. Check it again before continuing so the database of another app is not changed.`,
      canCreateSuperadmin: true,
      canUseExisting: false,
      requiresConfirmation: true,
      facts,
    };
  }

  if (check.bootstrapClaimed) {
    return {
      tone: "danger",
      title: "The bootstrap claim was already used",
      detail:
        "An App Template schema was found, but the Superadmin claim on this database was already used and there is no active Superadmin. Reactivate the old Superadmin account, or use another database.",
      canCreateSuperadmin: true,
      canUseExisting: false,
      requiresConfirmation: true,
      facts,
    };
  }

  return {
    tone: "success",
    title: "This App Template database is ready to provision",
    detail:
      "The schema is complete and has no active Superadmin yet. Continue creating the first Superadmin account.",
    canCreateSuperadmin: true,
    canUseExisting: false,
    requiresConfirmation: false,
    facts,
  };
}
