import { el, clear, table, toast, errorBanner, selectInput, confirmModal, loadingState } from '../ui.js';
import { api } from '../api.js';

const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'export', 'assign', 'transfer', 'unmask'];
const RESOURCES = ['employee', 'lead', 'opportunity', 'unit', 'payment_plan_template', 'payment_schedule', 'contract', 'broker_company', 'audit_log', 'role'];
const SCOPES = ['own', 'team', 'department', 'branch', 'company', 'broker_own'];
// The 'opportunity' RBAC resource is unchanged (see quotation.service.ts's
// sibling module, opportunities.js) — only its user-facing name is "Offers"
// now, so the permission grant UI shows that instead of the raw key.
const RESOURCE_LABELS = { opportunity: 'Offers' };
const resourceLabel = (r) => RESOURCE_LABELS[r] || r;

export async function renderRoles(container) {
  clear(container);
  container.appendChild(el('div', { class: 'page-header' }, el('h1', {}, 'Roles & Permissions')));

  const errorSlot = el('div');
  container.appendChild(errorSlot);

  // ---- Create role ----
  const newRoleName = el('input', { type: 'text', placeholder: 'e.g. Sales Manager' });
  const createRoleBtn = el('button', { class: 'primary' }, 'Create role');
  createRoleBtn.addEventListener('click', async () => {
    clear(errorSlot);
    if (!newRoleName.value.trim()) {
      errorSlot.appendChild(errorBanner('Enter a role name.'));
      return;
    }
    createRoleBtn.disabled = true;
    try {
      await api.post('/api/roles', { name: newRoleName.value.trim() });
      newRoleName.value = '';
      toast('Role created.', 'success');
      await loadRoles();
      await loadAssignCard(); // the new role should be selectable immediately
    } catch (err) {
      errorSlot.appendChild(errorBanner(err.message));
    } finally {
      createRoleBtn.disabled = false;
    }
  });
  container.appendChild(el('div', { class: 'card' }, [
    el('h3', { style: 'margin-top:0' }, 'Create a role'),
    el('div', { class: 'form-row' }, [el('div', {}, [el('label', {}, 'Role name'), newRoleName])]),
    el('div', { class: 'form-actions' }, [createRoleBtn]),
  ]));

  const rolesListSlot = el('div', { class: 'card' });
  const grantsCard = el('div', { class: 'card' }, el('p', { class: 'empty-state' }, 'Select a role above to manage its permission grants.'));
  const assignCard = el('div', { class: 'card' });
  container.append(rolesListSlot, grantsCard, assignCard);

  let roles = [];

  async function loadRoles() {
    clear(rolesListSlot);
    rolesListSlot.appendChild(el('h3', { style: 'margin-top:0' }, 'Roles'));
    const loading = loadingState();
    rolesListSlot.appendChild(loading);
    try {
      const page = await api.get('/api/roles', { limit: 100 });
      roles = page.items;
      loading.remove();
      rolesListSlot.appendChild(table(
        [
          { label: 'Name', key: 'name' },
          { label: 'System', render: (r) => (r.isSystem ? 'Yes' : 'No') },
          { label: '', render: (r) => {
            const btn = el('button', {}, 'Manage grants');
            btn.addEventListener('click', () => selectRole(r.id));
            return btn;
          } },
        ],
        roles,
        { empty: 'No roles yet.' },
      ));
    } catch (err) {
      loading.remove();
      rolesListSlot.appendChild(errorBanner(err.message));
    }
  }

  async function selectRole(roleId) {
    const role = roles.find((r) => r.id === roleId);
    clear(grantsCard);
    grantsCard.appendChild(el('h3', { style: 'margin-top:0' }, `Grants for "${role?.name ?? roleId}"`));

    const actionSelect = selectInput(ACTIONS.map((a) => ({ value: a, label: a })));
    const resourceSelect = selectInput(RESOURCES.map((r) => ({ value: r, label: resourceLabel(r) })));
    const scopeSelect = selectInput(SCOPES.map((s) => ({ value: s, label: s })));
    const addBtn = el('button', { class: 'primary' }, 'Add grant');
    addBtn.addEventListener('click', async () => {
      clear(errorSlot);
      addBtn.disabled = true;
      try {
        await api.post(`/api/roles/${roleId}/grants`, {
          action: actionSelect.value,
          resource: resourceSelect.value,
          scope: scopeSelect.value,
        });
        toast('Grant added.', 'success');
        await selectRole(roleId);
      } catch (err) {
        errorSlot.appendChild(errorBanner(err.message));
        addBtn.disabled = false;
      }
    });

    grantsCard.appendChild(el('div', { class: 'form-row' }, [
      el('div', {}, [el('label', {}, 'Action'), actionSelect]),
      el('div', {}, [el('label', {}, 'Resource'), resourceSelect]),
      el('div', {}, [el('label', {}, 'Scope'), scopeSelect]),
    ]));
    grantsCard.appendChild(el('div', { class: 'form-actions' }, [addBtn]));

    const grantsListSlot = el('div');
    grantsCard.appendChild(grantsListSlot);
    try {
      const grants = await api.get(`/api/roles/${roleId}/grants`);
      grantsListSlot.appendChild(table(
        [
          { label: 'Action', key: 'action' },
          { label: 'Resource', render: (g) => resourceLabel(g.resource) },
          { label: 'Scope', key: 'scope' },
          { label: '', render: (g) => {
            const btn = el('button', { class: 'danger' }, 'Revoke');
            btn.addEventListener('click', async () => {
              if (!(await confirmModal('Revoke this grant?', { confirmLabel: 'Revoke', danger: true }))) return;
              try {
                await api.delete(`/api/roles/${roleId}/grants/${g.id}`);
                toast('Grant revoked.', 'success');
                await selectRole(roleId);
              } catch (err) {
                errorSlot.appendChild(errorBanner(err.message));
              }
            });
            return btn;
          } },
        ],
        grants,
        { empty: 'No grants on this role yet — it currently allows nothing.' },
      ));
    } catch (err) {
      grantsListSlot.appendChild(errorBanner(err.message));
    }
  }

  // ---- Assign role to a user ----
  async function loadAssignCard() {
    clear(assignCard);
    assignCard.appendChild(el('h3', { style: 'margin-top:0' }, 'Assign a role'));
    try {
      const usersPage = await api.get('/api/users', { limit: 200 });
      const userSelect = selectInput(usersPage.items.map((u) => ({ value: u.id, label: u.email })));
      const roleSelect = selectInput(roles.map((r) => ({ value: r.id, label: r.name })));
      const assignBtn = el('button', { class: 'primary' }, 'Assign');
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
            { label: 'Role', render: (ur) => roles.find((r) => r.id === ur.roleId)?.name ?? ur.roleId },
            { label: '', render: (ur) => {
              const btn = el('button', { class: 'danger' }, 'Revoke');
              btn.addEventListener('click', async () => {
                if (!(await confirmModal('Revoke this role assignment?', { confirmLabel: 'Revoke', danger: true }))) return;
                try {
                  await api.delete(`/api/users/${userSelect.value}/roles/${ur.id}`);
                  toast('Role assignment revoked.', 'success');
                  await loadAssignments();
                } catch (err) {
                  errorSlot.appendChild(errorBanner(err.message));
                }
              });
              return btn;
            } },
          ],
          userRoles,
          { empty: 'This user has no role assignments — they can log in but do nothing yet.' },
        ));
      }

      userSelect.addEventListener('change', loadAssignments);
      assignBtn.addEventListener('click', async () => {
        clear(errorSlot);
        if (!userSelect.value || !roleSelect.value) {
          errorSlot.appendChild(errorBanner('Choose both a user and a role.'));
          return;
        }
        assignBtn.disabled = true;
        try {
          await api.post(`/api/users/${userSelect.value}/roles`, { roleId: roleSelect.value });
          toast('Role assigned.', 'success');
          await loadAssignments();
        } catch (err) {
          errorSlot.appendChild(errorBanner(err.message));
        } finally {
          assignBtn.disabled = false;
        }
      });

      assignCard.appendChild(el('div', { class: 'form-row' }, [
        el('div', {}, [el('label', {}, 'User'), userSelect]),
        el('div', {}, [el('label', {}, 'Role'), roleSelect]),
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
