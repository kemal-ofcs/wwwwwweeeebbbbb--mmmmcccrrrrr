"use client";

import { redirect } from "next/navigation";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { FeedbackBanner } from "@/components/ui/FeedbackBanner";
import { Icon } from "@/components/ui/Icon";
import { Modal } from "@/components/ui/Modal";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { hasPermission } from "@/lib/auth/access";
import { useAuth } from "@/lib/context/AuthContext";
import {
  createOperator,
  createRole,
  deleteMasterOperator,
  deleteRole,
  getMasterOperators,
  getRoleRecords,
  setRolePermissions,
  updateMasterOperator,
  updateRole,
} from "@/lib/gateways/master-operator";
import { adminDisableTwoFactor } from "@/lib/gateways/two-factor";
import { useHydrated } from "@/lib/hooks/useHydrated";
import type { OperatorDraft, OperatorRecord } from "@/lib/operators/types";
import {
  PERMISSION_CATALOG,
  type PermissionKey,
  SUPERADMIN_ONLY_PERMISSIONS,
} from "@/lib/rbac/catalog";
import type { RoleRecord } from "@/lib/rbac/types";

type ActiveTab = "operators" | "roles";
type RecordStatus = OperatorDraft["status"];

const EMPTY_OPERATOR: OperatorDraft = {
  kodeOperator: "",
  name: "",
  username: "",
  email: "",
  noHp: "",
  password: "",
  roleId: 0,
  status: "Active",
};

const EDITABLE_PERMISSION_GROUPS = PERMISSION_CATALOG.filter(
  ({ key }) => !SUPERADMIN_ONLY_PERMISSIONS.has(key),
).reduce<Record<string, (typeof PERMISSION_CATALOG)[number][]>>(
  (groups, permission) => {
    groups[permission.group] = [
      ...(groups[permission.group] ?? []),
      permission,
    ];
    return groups;
  },
  {},
);

interface RoleFormState {
  name: string;
  description: string;
  status: RecordStatus;
  requireTotp: boolean;
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return "The operation could not be completed.";
  if (error.message.includes("UNIQUE")) {
    return "The operator code, username, or role name is already in use.";
  }
  return error.message;
}

export default function MasterOperatorPage() {
  const isHydrated = useHydrated();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<ActiveTab>("operators");
  const [operators, setOperators] = useState<OperatorRecord[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Ref, bukan state `saving`: dua klik dalam satu tick sama-sama membaca state
  // lama, dan membuat operator dua kali menghasilkan dua akun.
  const isSubmittingRef = useRef(false);
  const [feedback, setFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [operatorModal, setOperatorModal] = useState(false);
  const [editingOperator, setEditingOperator] = useState<OperatorRecord | null>(
    null,
  );
  const [operatorDraft, setOperatorDraft] =
    useState<OperatorDraft>(EMPTY_OPERATOR);
  const [roleModal, setRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState<RoleRecord | null>(null);
  const [roleDraft, setRoleDraft] = useState<RoleFormState>({
    name: "",
    description: "",
    status: "Active",
    requireTotp: false,
  });
  const [selectedPermissions, setSelectedPermissions] = useState<
    Set<PermissionKey>
  >(new Set());
  const [deleteTarget, setDeleteTarget] = useState<
    | { type: "operator"; item: OperatorRecord }
    | { type: "role"; item: RoleRecord }
    | null
  >(null);

  const loadData = useCallback(
    async (silent = false) => {
      if (!user?.isSuperadmin) return;
      if (!silent) setLoading(true);
      try {
        const [operatorData, roleData] = await Promise.all([
          getMasterOperators(user.id),
          getRoleRecords(user.id),
        ]);
        setOperators(operatorData);
        setRoles(roleData);
      } catch (error) {
        if (!silent) {
          setFeedback({ tone: "error", message: errorMessage(error) });
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [user],
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const onSyncCompleted = () => {
      void loadData(true);
    };
    window.addEventListener("app:sync-completed", onSyncCompleted);
    return () => {
      window.removeEventListener("app:sync-completed", onSyncCompleted);
    };
  }, [loadData]);

  const openNewOperator = () => {
    const firstRole = roles.find((role) => role.status === "Active");
    setEditingOperator(null);
    setOperatorDraft({ ...EMPTY_OPERATOR, roleId: firstRole?.id ?? 0 });
    setOperatorModal(true);
  };

  const openEditOperator = (operator: OperatorRecord) => {
    setEditingOperator(operator);
    setOperatorDraft({
      kodeOperator: operator.kodeOperator,
      name: operator.name,
      username: operator.username,
      email: operator.email,
      noHp: operator.noHp,
      password: "",
      roleId: operator.roleId,
      status: operator.status,
    });
    setOperatorModal(true);
  };

  const submitOperator = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      if (editingOperator) {
        await updateMasterOperator(user.id, editingOperator.id, operatorDraft);
      } else {
        await createOperator(user.id, operatorDraft);
      }
      setOperatorModal(false);
      await loadData();
      setFeedback({
        tone: "success",
        message: editingOperator ? "Operator updated." : "Operator added.",
      });
    } catch (error) {
      setFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      isSubmittingRef.current = false;
      setSaving(false);
    }
  };

  const resetOperatorTwoFactor = async (operator: OperatorRecord) => {
    if (!user) return;
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      await adminDisableTwoFactor(operator.id);
      setFeedback({
        tone: "success",
        message: `Two-step verification for ${operator.name} is off. Ask them to turn it on again from Settings.`,
      });
      await loadData();
    } catch (error) {
      setFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      isSubmittingRef.current = false;
      setSaving(false);
    }
  };

  const openNewRole = () => {
    setEditingRole(null);
    setRoleDraft({
      name: "",
      description: "",
      status: "Active",
      requireTotp: false,
    });
    setSelectedPermissions(new Set());
    setRoleModal(true);
  };

  const openEditRole = (role: RoleRecord) => {
    setEditingRole(role);
    setRoleDraft({
      name: role.name,
      description: role.description,
      status: role.status,
      requireTotp: role.requireTotp,
    });
    setSelectedPermissions(new Set(role.permissions));
    setRoleModal(true);
  };

  const submitRole = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      if (editingRole) {
        await updateRole(user.id, editingRole.id, roleDraft);
        await setRolePermissions(user.id, editingRole.id, [
          ...selectedPermissions,
        ]);
      } else {
        await createRole(user.id, roleDraft, [...selectedPermissions]);
      }
      setRoleModal(false);
      await loadData();
      setFeedback({
        tone: "success",
        message: editingRole
          ? "Role and permissions updated."
          : "Role created.",
      });
    } catch (error) {
      setFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      isSubmittingRef.current = false;
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!user || !deleteTarget) return;
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      if (deleteTarget.type === "operator") {
        await deleteMasterOperator(user.id, deleteTarget.item.id);
      } else {
        await deleteRole(user.id, deleteTarget.item.id);
      }
      setDeleteTarget(null);
      await loadData();
      setFeedback({ tone: "success", message: "Deleted." });
    } catch (error) {
      setDeleteTarget(null);
      setFeedback({ tone: "error", message: errorMessage(error) });
    } finally {
      isSubmittingRef.current = false;
      setSaving(false);
    }
  };

  if (!isHydrated || authLoading)
    return <div className="min-h-dvh bg-background" />;
  if (!isAuthenticated) redirect("/login");
  if (!user?.isSuperadmin) redirect("/forbidden");

  return (
    <AppShell>
      <PageHeader
        title="Operators"
        description="Manage accounts, dynamic roles, and permissions. Security changes can only be made by the Superadmin while online."
        actions={
          <StatusBadge tone="warning">
            <Icon name="lock" className="size-3" />
            Superadmin only
          </StatusBadge>
        }
      />

      {feedback ? (
        <FeedbackBanner
          tone={feedback.tone}
          onDismiss={() => setFeedback(null)}
        >
          {feedback.message}
        </FeedbackBanner>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="Operators and roles"
          className="inline-grid grid-cols-2 gap-1 rounded-md border border-surface-container bg-surface-container-low p-1"
        >
          {(["operators", "roles"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={`min-h-9 rounded-md px-3 text-body-md font-semibold transition-colors ${
                activeTab === tab
                  ? "bg-surface-container-lowest text-on-surface shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {tab === "operators"
                ? `Users (${operators.length})`
                : `Roles and access (${roles.length})`}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={activeTab === "operators" ? openNewOperator : openNewRole}
          disabled={loading}
          className="app-btn app-btn-primary"
        >
          {activeTab === "operators" ? "Add operator" : "Create role"}
        </button>
      </div>

      {loading ? (
        <div className="app-panel grid min-h-60 place-items-center text-body-md text-on-surface-variant">
          Loading operators...
        </div>
      ) : activeTab === "operators" ? (
        <OperatorTable
          operators={operators}
          currentUserId={user.id}
          saving={saving}
          canResetTwoFactor={hasPermission(user, "two_factor.reset")}
          onEdit={openEditOperator}
          onDelete={(item) => setDeleteTarget({ type: "operator", item })}
          onResetTwoFactor={(item) => void resetOperatorTwoFactor(item)}
        />
      ) : (
        <RoleGrid
          roles={roles}
          onEdit={openEditRole}
          onDelete={(item) => setDeleteTarget({ type: "role", item })}
        />
      )}

      {operatorModal ? (
        <OperatorFormModal
          editingOperator={editingOperator}
          draft={operatorDraft}
          roles={roles}
          saving={saving}
          onChange={setOperatorDraft}
          onClose={() => setOperatorModal(false)}
          onSubmit={submitOperator}
        />
      ) : null}

      {roleModal ? (
        <RoleFormModal
          editingRole={editingRole}
          draft={roleDraft}
          permissions={selectedPermissions}
          saving={saving}
          onDraftChange={setRoleDraft}
          onPermissionsChange={setSelectedPermissions}
          onClose={() => setRoleModal(false)}
          onSubmit={submitRole}
        />
      ) : null}

      {deleteTarget ? (
        <Modal
          title="Confirm deletion"
          titleId="delete-modal-title"
          onClose={() => setDeleteTarget(null)}
        >
          <p className="text-body-md text-on-surface">
            Delete {deleteTarget.type === "operator" ? "operator" : "role"}{" "}
            <strong>{deleteTarget.item.name}</strong>? Records with history are
            rejected and must be set to inactive instead.
          </p>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setDeleteTarget(null)}
              className="app-btn app-btn-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={saving}
              className="app-btn app-btn-danger"
            >
              {saving ? "Deleting..." : "Delete"}
            </button>
          </div>
        </Modal>
      ) : null}
    </AppShell>
  );
}

function OperatorFormModal({
  editingOperator,
  draft,
  roles,
  saving,
  onChange,
  onClose,
  onSubmit,
}: {
  editingOperator: OperatorRecord | null;
  draft: OperatorDraft;
  roles: RoleRecord[];
  saving: boolean;
  onChange: (draft: OperatorDraft) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <Modal
      title={editingOperator ? "Edit operator" : "Add operator"}
      titleId="operator-modal-title"
      onClose={onClose}
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Operator code" htmlFor="operator-code">
            <input
              id="operator-code"
              required
              value={draft.kodeOperator}
              onChange={(event) =>
                onChange({ ...draft, kodeOperator: event.target.value })
              }
              className="app-input font-mono"
            />
          </FormField>
          <FormField label="Username" htmlFor="operator-username">
            <input
              id="operator-username"
              required
              autoComplete="username"
              value={draft.username}
              onChange={(event) =>
                onChange({ ...draft, username: event.target.value })
              }
              className="app-input"
            />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Email" htmlFor="operator-email">
            <input
              id="operator-email"
              type="email"
              required
              autoComplete="email"
              placeholder="operator@company.co.id"
              value={draft.email}
              onChange={(event) =>
                onChange({ ...draft, email: event.target.value })
              }
              className="app-input"
            />
          </FormField>
          <FormField label="Phone number" htmlFor="operator-phone">
            <input
              id="operator-phone"
              type="tel"
              required
              inputMode="tel"
              autoComplete="tel"
              placeholder="08xxxxxxxxxx"
              value={draft.noHp}
              onChange={(event) =>
                onChange({ ...draft, noHp: event.target.value })
              }
              className="app-input"
            />
          </FormField>
        </div>
        <p className="text-body-sm text-on-surface-variant">
          Email and phone number are required. The email receives recovery links
          for Forgot password, so an account without email cannot recover its
          own password.
        </p>
        <FormField label="Operator name" htmlFor="operator-name">
          <input
            id="operator-name"
            required
            value={draft.name}
            onChange={(event) =>
              onChange({ ...draft, name: event.target.value })
            }
            className="app-input"
          />
        </FormField>
        <FormField
          label={
            editingOperator
              ? "New password (optional, at least 8 characters)"
              : "Password (at least 8 characters)"
          }
          htmlFor="operator-password"
        >
          <input
            id="operator-password"
            type="password"
            required={!editingOperator}
            minLength={8}
            autoComplete="new-password"
            value={draft.password}
            onChange={(event) =>
              onChange({ ...draft, password: event.target.value })
            }
            className="app-input"
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Role" htmlFor="operator-role">
            <select
              id="operator-role"
              value={draft.roleId}
              onChange={(event) =>
                onChange({ ...draft, roleId: Number(event.target.value) })
              }
              className="app-input"
            >
              {roles
                .filter(
                  (role) =>
                    role.status === "Active" || role.id === draft.roleId,
                )
                .map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
            </select>
          </FormField>
          <FormField label="Status" htmlFor="operator-status">
            <select
              id="operator-status"
              value={draft.status}
              onChange={(event) =>
                onChange({
                  ...draft,
                  status: event.target.value as RecordStatus,
                })
              }
              className="app-input"
            >
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </FormField>
        </div>
        <ModalActions saving={saving} onCancel={onClose} />
      </form>
    </Modal>
  );
}

function RoleFormModal({
  editingRole,
  draft,
  permissions,
  saving,
  onDraftChange,
  onPermissionsChange,
  onClose,
  onSubmit,
}: {
  editingRole: RoleRecord | null;
  draft: RoleFormState;
  permissions: Set<PermissionKey>;
  saving: boolean;
  onDraftChange: (draft: RoleFormState) => void;
  onPermissionsChange: (permissions: Set<PermissionKey>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <Modal
      title={editingRole ? "Edit role and access" : "Create role"}
      titleId="role-modal-title"
      onClose={onClose}
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        <FormField label="Role name" htmlFor="role-name">
          <input
            id="role-name"
            required
            minLength={3}
            disabled={editingRole?.isSuperadmin}
            value={draft.name}
            onChange={(event) =>
              onDraftChange({ ...draft, name: event.target.value })
            }
            className="app-input"
          />
        </FormField>
        <FormField label="Description" htmlFor="role-description">
          <textarea
            id="role-description"
            rows={3}
            disabled={editingRole?.isSuperadmin}
            value={draft.description}
            onChange={(event) =>
              onDraftChange({ ...draft, description: event.target.value })
            }
            className="app-input py-2"
          />
        </FormField>
        {!editingRole?.isSuperadmin ? (
          <fieldset>
            <legend className="app-label">Role permissions</legend>
            <div className="mt-2 max-h-72 space-y-4 overflow-y-auto rounded-md border border-surface-container bg-surface-container-low p-3">
              {Object.entries(EDITABLE_PERMISSION_GROUPS).map(
                ([group, groupPermissions]) => (
                  <div key={group}>
                    <p className="mb-2 font-mono text-label-caps uppercase text-on-surface-variant">
                      {group}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {groupPermissions.map((permission) => (
                        <label
                          key={permission.key}
                          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-surface-container bg-surface-container-lowest px-3 text-body-md text-on-surface"
                        >
                          <input
                            type="checkbox"
                            checked={permissions.has(permission.key)}
                            onChange={(event) => {
                              const next = new Set(permissions);
                              if (event.target.checked)
                                next.add(permission.key);
                              else next.delete(permission.key);
                              onPermissionsChange(next);
                            }}
                            className="size-4 accent-secondary"
                          />
                          {permission.name}
                        </label>
                      ))}
                    </div>
                  </div>
                ),
              )}
            </div>
          </fieldset>
        ) : (
          <FeedbackBanner tone="info">
            The Superadmin always has every permission.
          </FeedbackBanner>
        )}
        {editingRole && !editingRole.isSuperadmin ? (
          <FormField label="Role status" htmlFor="role-status">
            <select
              id="role-status"
              value={draft.status}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  status: event.target.value as RecordStatus,
                })
              }
              className="app-input"
            >
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </FormField>
        ) : null}
        {!editingRole?.isSuperadmin ? (
          <label className="flex items-start gap-3 rounded-md border border-surface-container bg-surface-container-low p-3">
            <input
              type="checkbox"
              checked={draft.requireTotp}
              onChange={(event) =>
                onDraftChange({ ...draft, requireTotp: event.target.checked })
              }
              className="mt-0.5 size-4 shrink-0 accent-secondary"
            />
            <span className="text-body-md text-on-surface-variant">
              <strong className="text-on-surface">
                Require two-step verification
              </strong>
              <br />
              Operators with this role cannot sign in until they turn on 2FA in
              Settings. Turn this on only after they have had a chance to
              enroll; otherwise they will be stuck at sign-in until an admin
              unlocks them.
            </span>
          </label>
        ) : null}
        {!editingRole?.isSuperadmin ? (
          <ModalActions saving={saving} onCancel={onClose} />
        ) : null}
      </form>
    </Modal>
  );
}

function OperatorTable({
  operators,
  currentUserId,
  saving,
  canResetTwoFactor,
  onEdit,
  onDelete,
  onResetTwoFactor,
}: {
  operators: OperatorRecord[];
  currentUserId: number;
  saving: boolean;
  canResetTwoFactor: boolean;
  onEdit: (operator: OperatorRecord) => void;
  onDelete: (operator: OperatorRecord) => void;
  onResetTwoFactor: (operator: OperatorRecord) => void;
}) {
  return (
    <div className="app-panel overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-body-md">
          <thead className="border-b border-surface-container bg-surface-container-low">
            <tr className="font-mono text-label-caps uppercase text-on-surface-variant">
              <th className="px-3 py-2 font-semibold">Operator</th>
              <th className="px-3 py-2 font-semibold">Code / username</th>
              <th className="px-3 py-2 font-semibold">Role</th>
              <th className="px-3 py-2 font-semibold">2FA</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-container">
            {operators.map((operator) => (
              <tr key={operator.id} className="text-on-surface">
                <td className="px-3 py-2">
                  <p className="font-semibold">{operator.name}</p>
                  {operator.id === currentUserId ? (
                    <span className="text-body-sm text-secondary">
                      Signed in
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <p className="font-mono text-code-md">
                    {operator.kodeOperator}
                  </p>
                  <p className="text-body-sm text-on-surface-variant">
                    @{operator.username}
                  </p>
                  <p className="text-body-sm text-on-surface-variant">
                    {operator.email || "No email yet"}
                  </p>
                  <p className="text-body-sm text-on-surface-variant">
                    {operator.noHp || "No phone number yet"}
                  </p>
                </td>
                <td className="px-3 py-2">
                  <StatusBadge
                    tone={operator.isSuperadmin ? "warning" : "info"}
                  >
                    {operator.roleName}
                  </StatusBadge>
                </td>
                <td className="px-3 py-2">
                  <StatusBadge
                    tone={operator.totpEnabled ? "success" : "neutral"}
                  >
                    {operator.totpEnabled ? "On" : "Off"}
                  </StatusBadge>
                </td>
                <td className="px-3 py-2">
                  <StatusBadge
                    tone={operator.status === "Active" ? "success" : "neutral"}
                  >
                    {operator.status}
                  </StatusBadge>
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onEdit(operator)}
                      className="app-btn app-btn-secondary"
                    >
                      Edit
                    </button>
                    {canResetTwoFactor && operator.totpEnabled ? (
                      <button
                        type="button"
                        onClick={() => onResetTwoFactor(operator)}
                        disabled={saving}
                        title="Turn off this operator's two-step verification"
                        className="app-btn app-btn-secondary"
                      >
                        Reset 2FA
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onDelete(operator)}
                      disabled={operator.id === currentUserId}
                      className="app-btn app-btn-secondary text-error"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RoleGrid({
  roles,
  onEdit,
  onDelete,
}: {
  roles: RoleRecord[];
  onEdit: (role: RoleRecord) => void;
  onDelete: (role: RoleRecord) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {roles.map((role) => (
        <article key={role.id} className="app-panel flex flex-col p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-headline-md text-on-surface">
                  {role.name}
                </h2>
                {role.isSystem ? (
                  <StatusBadge tone="neutral">System</StatusBadge>
                ) : null}
              </div>
              <p className="mt-0.5 font-mono text-code-sm text-on-surface-variant">
                {role.roleKey}
              </p>
            </div>
            <StatusBadge
              tone={role.status === "Active" ? "success" : "neutral"}
            >
              {role.status}
            </StatusBadge>
          </div>
          <p className="mt-3 flex-1 text-body-md text-on-surface-variant">
            {role.description || "No description yet."}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-surface-container pt-3">
            <div>
              <dt className="font-mono text-label-caps uppercase text-on-surface-variant">
                Operators
              </dt>
              <dd className="font-mono text-headline-md tabular-nums text-on-surface">
                {role.operatorCount}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-label-caps uppercase text-on-surface-variant">
                Permissions
              </dt>
              <dd className="font-mono text-headline-md tabular-nums text-on-surface">
                {role.isSuperadmin ? "All" : role.permissions.length}
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => onEdit(role)}
              className="app-btn app-btn-secondary flex-1"
            >
              {role.isSuperadmin ? "View" : "Manage access"}
            </button>
            {!role.isSystem ? (
              <button
                type="button"
                onClick={() => onDelete(role)}
                className="app-btn app-btn-secondary text-error"
              >
                Delete
              </button>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function FormField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="app-label mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function ModalActions({
  saving,
  onCancel,
}: {
  saving: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col-reverse gap-2 border-t border-surface-container pt-4 sm:flex-row sm:justify-end">
      <button
        type="button"
        onClick={onCancel}
        className="app-btn app-btn-secondary"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={saving}
        className="app-btn app-btn-primary"
      >
        {saving ? "Saving..." : "Save"}
      </button>
    </div>
  );
}
