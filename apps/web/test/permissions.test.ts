import { describe, it, expect } from 'vitest';
import { computePermissions, ANONYMOUS_PERMISSIONS } from '../src/lib/auth/permissions';

describe('Task ROLE1 (ADR-046): Permission Helper computePermissions', () => {
  it('returns all false for anonymous / unauthenticated users', () => {
    expect(computePermissions(null, false)).toEqual(ANONYMOUS_PERMISSIONS);
    expect(computePermissions(undefined, false)).toEqual(ANONYMOUS_PERMISSIONS);
    expect(computePermissions(null)).toEqual(ANONYMOUS_PERMISSIONS);
    expect(computePermissions(undefined)).toEqual(ANONYMOUS_PERMISSIONS);
    expect(computePermissions({ roles: ['creator', 'admin'] }, false)).toEqual(
      ANONYMOUS_PERMISSIONS,
    );
  });

  it('viewer role: can requestCreator, cannot upload/studio/moderate/adminOnly', () => {
    const perms = computePermissions({ roles: ['viewer'] });
    expect(perms).toEqual({
      upload: false,
      studio: false,
      requestCreator: true,
      moderate: false,
      adminOnly: false,
    });
  });

  it('signed in user with empty roles: defaults to viewer permissions', () => {
    const perms = computePermissions({ roles: [] });
    expect(perms).toEqual({
      upload: false,
      studio: false,
      requestCreator: true,
      moderate: false,
      adminOnly: false,
    });
  });

  it('creator role (without admin/moderator): can upload/studio, cannot requestCreator/moderate/adminOnly', () => {
    const perms = computePermissions({ roles: ['viewer', 'creator'] });
    expect(perms).toEqual({
      upload: true,
      studio: true,
      requestCreator: false,
      moderate: false,
      adminOnly: false,
    });
  });

  it('moderator without creator: can moderate and requestCreator, cannot upload/studio/adminOnly', () => {
    const perms = computePermissions({ roles: ['viewer', 'moderator'] });
    expect(perms).toEqual({
      upload: false,
      studio: false,
      requestCreator: true,
      moderate: true,
      adminOnly: false,
    });
  });

  it('moderator with creator: can upload, studio, and moderate', () => {
    const perms = computePermissions({ roles: ['viewer', 'creator', 'moderator'] });
    expect(perms).toEqual({
      upload: true,
      studio: true,
      requestCreator: false,
      moderate: true,
      adminOnly: false,
    });
  });

  it('admin without explicit creator: can upload/studio like the server (admin has every role), cannot requestCreator', () => {
    const perms = computePermissions({ roles: ['viewer', 'admin'] });
    expect(perms).toEqual({
      upload: true,
      studio: true,
      requestCreator: false,
      moderate: true,
      adminOnly: true,
    });
  });

  it('admin with creator: can upload, studio, moderate, and adminOnly, cannot requestCreator', () => {
    const perms = computePermissions({ roles: ['viewer', 'creator', 'admin'] });
    expect(perms).toEqual({
      upload: true,
      studio: true,
      requestCreator: false,
      moderate: true,
      adminOnly: true,
    });
  });

  it('super-user with all roles: viewer, creator, moderator, admin', () => {
    const perms = computePermissions({ roles: ['viewer', 'creator', 'moderator', 'admin'] });
    expect(perms).toEqual({
      upload: true,
      studio: true,
      requestCreator: false,
      moderate: true,
      adminOnly: true,
    });
  });
});
