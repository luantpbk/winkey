import type { FastifyRequest } from 'fastify';
import { ProblemError } from '../errors/problem.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id.trim());
}

export interface CallerIdentity {
  userId: string | null;
  roles: string[];
  isModeratorOrAdmin: boolean;
}

export function parseRoles(rawRoles?: string | string[]): string[] {
  if (!rawRoles) return [];
  if (Array.isArray(rawRoles)) {
    return rawRoles
      .flatMap((r) => r.split(','))
      .map((r) => r.trim())
      .filter(Boolean);
  }
  return rawRoles
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}

export function getCaller(request: FastifyRequest): CallerIdentity {
  const rawUserId = request.headers['x-user-id'];
  let userId: string | null = null;
  if (typeof rawUserId === 'string' && rawUserId.trim().length > 0) {
    const trimmed = rawUserId.trim();
    if (!isValidUuid(trimmed)) {
      throw ProblemError.unauthorized('Invalid user ID in X-User-Id header', 'UNAUTHORIZED');
    }
    userId = trimmed;
  }
  const roles = parseRoles(request.headers['x-user-roles']);
  const isModeratorOrAdmin = roles.includes('moderator') || roles.includes('admin');

  return {
    userId,
    roles,
    isModeratorOrAdmin,
  };
}

export function requireAuth(request: FastifyRequest): {
  userId: string;
  roles: string[];
  isModeratorOrAdmin: boolean;
} {
  const caller = getCaller(request);
  if (!caller.userId) {
    throw ProblemError.unauthorized('Authentication required', 'UNAUTHORIZED');
  }
  return {
    userId: caller.userId,
    roles: caller.roles,
    isModeratorOrAdmin: caller.isModeratorOrAdmin,
  };
}

export interface VideoAccessTarget {
  owner_id: string;
  hidden: boolean;
  visibility?: string | null;
}

/**
 * Task C4 & A2: A video is "closed" for a caller when:
 * (hidden OR visibility = 'PRIVATE') AND caller is neither the video owner nor a moderator/admin.
 * Closed -> 404 on every comment/like endpoint of that video.
 * UNLISTED behaves like PUBLIC.
 */
export function isVideoClosedForCaller(video: VideoAccessTarget, caller: CallerIdentity): boolean {
  const isOwner = caller.userId !== null && caller.userId === video.owner_id;
  const isPrivileged = isOwner || caller.isModeratorOrAdmin;
  const isRestricted = video.hidden || video.visibility === 'PRIVATE';
  return isRestricted && !isPrivileged;
}
