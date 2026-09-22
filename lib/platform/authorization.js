'use strict';

const ROLE_LEVEL = Object.freeze({ viewer:1, member:2, operator:3, admin:4, owner:5 });

function canAccessWorkspace(membership, requiredRole='viewer') {
  if (!membership || membership.status !== 'active') return false;
  const current = ROLE_LEVEL[membership.role] || 0;
  const required = ROLE_LEVEL[requiredRole] || 999;
  return current >= required;
}

function assertWorkspaceAccess(membership, requiredRole='viewer') {
  if (!canAccessWorkspace(membership, requiredRole)) {
    const error = new Error('workspace access denied');
    error.code = 'WORKSPACE_ACCESS_DENIED';
    throw error;
  }
  return true;
}

module.exports = { ROLE_LEVEL, canAccessWorkspace, assertWorkspaceAccess };
