import type { PermissionKey } from "@/lib/rbac/catalog";

export interface RoleRecord {
  id: number;
  roleKey: string;
  name: string;
  description: string;
  isSystem: boolean;
  isSuperadmin: boolean;
  status: "Active" | "Inactive";
  /**
   * Operator dengan role ini tidak boleh login sampai mendaftarkan 2FA.
   * Dinilai evaluateTwoFactorGate SETELAH password terbukti benar.
   */
  requireTotp: boolean;
  operatorCount: number;
  permissions: PermissionKey[];
}

export interface RoleDraft {
  name: string;
  description?: string;
  status?: "Active" | "Inactive";
  requireTotp?: boolean;
}
