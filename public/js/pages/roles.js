import { el, clear, table, toast, errorBanner, selectInput, confirmModal, loadingState } from '../ui.js';
import { t } from '../i18n.js';
import { getLocale } from '../state.js';
import { api } from '../api.js';

const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'assign', 'transfer', 'unmask'];
const RESOURCES = ['employee', 'lead', 'opportunity', 'unit', 'payment_plan_template', 'payment_schedule', 'contract', 'broker_company', 'audit_log', 'role'];
const SCOPES = ['own', 'team', 'department', 'branch', 'company', 'broker_own'];
// These RBAC identifiers (action/resource/scope) sent to and received from
// the API are unchanged — only the human-readable label shown in the
// permission grant UI is localized, via the key maps below. The 'opportunity'
// resource keeps its long-standing "Offers" display name (see
// quotation.service.ts's sibling module, opportunities.js).
const ACTION_LABEL_KEYS = {
  view: 'roles_action_view', create: 'roles_action_create', edit: 'roles_action_edit', delete: 'automation_btn_delete',
  approve: 'brokers_approve_btn', export: 'roles_action_export', assign: 'roles_action_assign', transfer: 'roles_action_transfer',
  unmask: 'roles_action_unmask',
};
const RESOURCE_LABEL_KEYS = {
  employee: 'comm_employee_col', lead: 'ai_panel_lead_word', opportunity: 'nav_offers', unit: 'sales_col_unit',
  payment_plan_template: 'roles_resource_payment_plan_template', payment_schedule: 'roles_resource_payment_schedule',
  contract: 'brokers_col_contract', broker_company: 'roles_resource_broker_company', audit_log: 'nav_audit', role: 'roles_resource_role',
};
const SCOPE_LABEL_KEYS = {
  own: 'roles_scope_own', team: 'branches_field_team', department: 'branches_field_department', branch: 'branches_field_branch',
  company: 'roles_scope_company', broker_own: 'roles_scope_broker_own',
};
const actionLabel = (locale, a) => t(locale, ACTION_LABEL_KEYS[a] || a);
const resourceLabel = (locale, r) => t(locale, RESOURCE_LABEL_KEYS[r] || r);
const scopeLabel = (locale, s) => t(locale, SCOPE_LABEL_KEYS[s] || s);

export async function renderRoles(container) {
  clear(container);
  const locale = getLocale();
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, t(locale, 'page_title_roles'))));

  const errorSlot = el('div');
  container.appendChild(errorSlot);

  // ---- Create role ----
  const newRoleName = el('input', { type: 'text', placeholder: t(locale, 'roles_name_placeholder') });
  const createRoleBtn = el('button', { class: 'primary' }, t(locale, 'roles_create_role_btn'));
  createRoleBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!newRoleName.value.trim()) {
      errorSlot.appendChild(errorBanner(t(locale, 'roles_enter_name_error')));
      return;
    }
    createRoleBtn.disabled = true;
    try {
      await api.post('/api/roles', { name: newRoleName.value.trim() });
      newRoleName.value = '';
      toast(t(locale, 'roles_created_toast'), 'success');
      await loadRoles();
      await loadAssignCard(); // the new role should be selectable immediately
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createRoleBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, t(locale, 'roles_create_role_title')),
    el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, t(locale, 'roles_name_field')), newRoleName])]),
    el('div', { class: 'form-actions' }, [createRoleBtn]),
  ]));

  const rolesListSlot = el('div', { class: 'card' });
  const grantsCard = el('div', { class: 'card' }, el('p', { class: 'empty-state' }, t(locale, 'roles_select_role_hint')));
  const assignCard = el('div', { class: 'card' });
  container.append(rolesListSlot, grantsCard, assignCard);

  let roles = [];

  async function loadRoles() {
    clear(rolesListSlot);
    rolesListSlot.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'roles_list_title')));
    const loading = loadingState();
    rolesListSlot.appendChild(loading);
    try {
      const page = await api.get('/api/roles', { limit: 100 });
      roles = page.items;
      loading.remove();
      rolesListSlot.appendChild(table(
        [
          { label: t(locale, 'crm_col_name'), key: 'name' },
          { label: t(locale, 'roles_system_col'), render: (r) => (r.isSystem ? t(locale, 'crm_yes') : t(locale, 'crm_no')) },
          { label: '', render: (r) => {
            const btn = el('button', {}, t(locale, 'roles_manage_grants_btn'));
            btn.addEventListener('click', () => selectRole(r.id));
            return btn;
          } },
        ],
        roles,
        { empty: t(locale, 'roles_list_empty') },
      ));
    } catch (err) {
      loading.remove();
      rolesListSlot.appendChild(errorBanner(err.message));
    }
  }

  async function selectRole(roleId) {
    const role = roles.find((r) => r.id === roleId);
    clear(grantsCard);
    grantsCard.appendChild(el('h3', { style: 'margin-top:0' }, `${t(locale, 'roles_grants_for_prefix')} "${role?.name ?? roleId}"`));

    const actionSelect = selectInput(ACTIONS.map((a) => ({ value: a, label: actionLabel(locale, a) })));
    const resourceSelect = selectInput(RESOURCES.map((r) => ({ value: r, label: resourceLabel(locale, r) })));
    const scopeSelect = selectInput(SCOPES.map((s) => ({ value: s, label: scopeLabel(locale, s) })));
    const addBtn = el('button', { class: 'primary' }, t(locale, 'roles_add_grant_btn'));
    addBtn.addEventListener('click', async () => {
      clear(errorSlot);
      addBtn.disabled = true;
      try {
        await api.post(`/api/roles/${roleId}/grants`, {
          action: actionSelect.value,
          resource: resourceSelect.value,
          scope: scopeSelect.value,
        });
        toast(t(locale, 'roles_grant_added_toast'), 'success');
        await selectRole(roleId);
      } catch (err) {
        errorSlot.appendChild(errorBanner(err.message));
        addBtn.disabled = false;
      }
    });

    grantsCard.appendChild(el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, t(locale, 'automation_field_action')), actionSelect]),
      el('div', {}, [el('label', {}, t(locale, 'roles_resource_field')), resourceSelect]),
      el('div', {}, [el('label', {}, t(locale, 'roles_scope_field')), scopeSelect]),
    ]));
    grantsCard.appendChild(el('div', { class: 'form-actions' }, [addBtn]));

    const grantsListSlot = el('div');
    grantsCard.appendChild(grantsListSlot);
    try {
      const grants = await api.get(`/api/roles/${roleId}/grants`);
      grantsListSlot.appendChild(table(
        [
          { label: t(locale, 'automation_field_action'), render: (g) => actionLabel(locale, g.action) },
          { label: t(locale, 'roles_resource_field'), render: (g) => resourceLabel(locale, g.resource) },
          { label: t(locale, 'roles_scope_field'), render: (g) => scopeLabel(locale, g.scope) },
          { label: '', render: (g) => {
            const btn = el('button', { class: 'danger' }, t(locale, 'roles_revoke_btn'));
            btn.addEventListener('click', async () => {
              if (!(await confirmModal(t(locale, 'roles_revoke_grant_confirm'), { confirmLabel: t(locale, 'roles_revoke_btn'), danger: true }))) return;
              try {
                await api.delete(`/api/roles/${roleId}/grants/${g.id}`);
                toast(t(locale, 'roles_grant_revoked_toast'), 'success');
                await selectRole(roleId);
              } catch (err) {
                errorSlot.appendChild(errorBanner(err.message));
              }
            });
            return btn;
          } },
        ],
        grants,
        { empty: t(locale, 'roles_grants_empty') },
      ));
    } catch (err) {
      grantsListSlot.appendChild(errorBanner(err.message));
    }
  }

  // ---- Assign role to a user ----
  async function loadAssignCard() {
    clear(assignCard);
    assignCard.appendChild(el('h3', { style: 'margin-top:0' }, t(locale, 'roles_assign_role_title')));
    try {
      const usersPage = await api.get('/api/users', { limit: 200 });
      const userSelect = selectInput(usersPage.items.map((u) => ({ value: u.id, label: u.email })));
      const roleSelect = selectInput(roles.map((r) => ({ value: r.id, label: r.name })));
      const assignBtn = el('button', { class: 'primary' }, t(locale, 'roles_assign_btn'));
      const assignmentsSlot = el('div', { style: 'margin-top:12px' });

      async function loadAssignments() {
        clear(assignmentsSlot);
        if (!userSelect.value) return;
        let userRoles;
        try {
          userRoles = await api.get(`/api/users/${userSelect.value}/roles`);
        } catch (err) {
          assignmentsSlot.appendChild(errorBanner(err.message));
          return;
        }
        assignmentsSlot.appendChild(table(
          [
            { label: t(locale, 'roles_resource_role'), render: (ur) => roles.find((r) => r.id === ur.roleId)?.name ?? ur.roleId },
            { label: '', render: (ur) => {
              const btn = el('button', { class: 'danger' }, t(locale, 'roles_revoke_btn'));
              btn.addEventListener('click', async () => {
                if (!(await confirmModal(t(locale, 'roles_revoke_assignment_confirm'), { confirmLabel: t(locale, 'roles_revoke_btn'), danger: true }))) return;
                try {
                  await api.delete(`/api/users/${userSelect.value}/roles/${ur.id}`);
                  toast(t(locale, 'roles_assignment_revoked_toast'), 'success');
                  await loadAssignments();
                } catch (err) {
                  errorSlot.appendChild(errorBanner(err.message));
                }
              });
              return btn;
            } },
          ],
          userRoles,
          { empty: t(locale, 'roles_no_assignments_empty') },
        ));
      }

      userSelect.addEventListener('change', loadAssignments);
      assignBtn.addEventListener('click', async () => {
        clear(errorSlot);
        if (!userSelect.value || !roleSelect.value) {
          errorSlot.appendChild(errorBanner(t(locale, 'roles_choose_user_role_error')));
          return;
        }
        assignBtn.disabled = true;
        try {
          await api.post(`/api/users/${userSelect.value}/roles`, { roleId: roleSelect.value });
          toast(t(locale, 'roles_assigned_toast'), 'success');
          await loadAssignments();
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
        } finally {
          assignBtn.disabled = false;
        }
      });

      assignCard.appendChild(el('div', { class: 'form-row' }, [
        el('div', {}, [el('label', {}, t(locale, 'roles_user_field')), userSelect]),
        el('div', {}, [el('label', {}, t(locale, 'roles_resource_role')), roleSelect]),
      ]));
      assignCard.appendChild(el('div', { class: 'form-actions' }, [assignBtn]));
      assignCard.appendChild(assignmentsSlot);
      await loadAssignments();
    } catch (err) {
      assignCard.appendChild(errorBanner(err.message));
    }
  }

  await loadRoles();
  await loadAssignCard();
}
