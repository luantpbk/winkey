export interface UserPermissions {
  upload: boolean;
  studio: boolean;
  requestCreator: boolean;
  moderate: boolean;
  adminOnly: boolean;
}

export const ANONYMOUS_PERMISSIONS: UserPermissions = Object.freeze({
  upload: false,
  studio: false,
  requestCreator: false,
  moderate: false,
  adminOnly: false,
});

export function computePermissions(
  user: { roles?: string[] | null } | null | undefined,
  isAuthenticated?: boolean,
): UserPermissions {
  const isAuth = isAuthenticated !== undefined ? isAuthenticated : !!user;
  if (!isAuth || !user) {
    return ANONYMOUS_PERMISSIONS;
  }

  const rawRoles = user.roles ?? [];
  const roles = rawRoles.map((r) => String(r).toLowerCase());
  const isCreator = roles.includes('creator');
  const isModerator = roles.includes('moderator');
  const isAdmin = roles.includes('admin');

  return {
    upload: isCreator,
    studio: isCreator,
    requestCreator: !isCreator,
    moderate: isModerator || isAdmin,
    adminOnly: isAdmin,
  };
}
