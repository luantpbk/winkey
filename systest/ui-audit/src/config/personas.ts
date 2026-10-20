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
    '/search?q=video',
    '/login',
    '/register',
    '/forgot-password',
    '/legal/terms',
    '/legal/privacy',
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
    '/search?q=video',
    '/thu-vien',
    '/feed/subscriptions',
    '/settings',
    '/notifications',
  ],
  creator: [
    '/studio',
    '/upload',
    '/studio/series',
  ],
  admin: [
    '/admin',
  ],
};
