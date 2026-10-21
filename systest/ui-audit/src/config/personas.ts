// systest/ui-audit/src/config/personas.ts
import { PersonaRole } from '../types.js';

export const PERSONA_ROUTES: Record<PersonaRole, string[]> = {
  anon: [
    '/',
    '/kham-pha',
    '/trending',
    '/the-loai/:seed',
    '/tag/:seed',
    '/watch/:seed',
    '/embed/:seed',
    '/c/:seed',
    '/playlist/:seed',
    '/login',
    '/register',
    '/forgot-password',
  ],
  member: [
    '/',
    '/kham-pha',
    '/trending',
    '/the-loai/:seed',
    '/tag/:seed',
    '/watch/:seed',
    '/embed/:seed',
    '/c/:seed',
    '/playlist/:seed',
    '/thu-vien',
    '/feed/subscriptions',
    '/settings/account',
    '/notifications',
  ],
  creator: ['/studio', '/upload'],
  admin: ['/admin'],
};
