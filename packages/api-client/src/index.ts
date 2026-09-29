import createClient, { type ClientOptions, type Middleware } from 'openapi-fetch';
import type { paths as AuthPaths, components as AuthComponents } from './types/auth.js';
import type { paths as UploadPaths, components as UploadComponents } from './types/upload.js';
import type { paths as VideoPaths, components as VideoComponents } from './types/video.js';

// Export raw generated paths and components
export type { paths as AuthPaths, components as AuthComponents } from './types/auth.js';
export type { paths as UploadPaths, components as UploadComponents } from './types/upload.js';
export type { paths as VideoPaths, components as VideoComponents } from './types/video.js';

// Convenient domain type shortcuts
export type User = AuthComponents['schemas']['User'];
export type PublicProfile = AuthComponents['schemas']['PublicProfile'];
export type Role = AuthComponents['schemas']['Role'];
export type TokenResponse = AuthComponents['schemas']['TokenResponse'];
export type RegisterRequest = AuthComponents['schemas']['RegisterRequest'];
export type LoginRequest = AuthComponents['schemas']['LoginRequest'];
export type Problem = AuthComponents['schemas']['Problem'];
export type ProblemError = NonNullable<Problem['errors']>[number];

export type CreateUploadRequest = UploadComponents['schemas']['CreateUploadRequest'];
export type CreateUploadResponse = UploadComponents['schemas']['CreateUploadResponse'];
export type PresignPartsRequest = UploadComponents['schemas']['PresignPartsRequest'];
export type PresignPartsResponse = UploadComponents['schemas']['PresignPartsResponse'];
export type CompleteUploadRequest = UploadComponents['schemas']['CompleteUploadRequest'];
export type UploadStatus = UploadComponents['schemas']['UploadStatus'];

export type Video = VideoComponents['schemas']['Video'];
export type VideoSummary = VideoComponents['schemas']['VideoSummary'];
export type VideoPage = VideoComponents['schemas']['VideoPage'];
export type StudioVideo = VideoComponents['schemas']['StudioVideo'];
export type StudioVideoPage = VideoComponents['schemas']['StudioVideoPage'];
export type UpdateVideoRequest = VideoComponents['schemas']['UpdateVideoRequest'];
export type Playback = VideoComponents['schemas']['Playback'];
export type Rendition = VideoComponents['schemas']['Rendition'];
export type VideoStatus = VideoComponents['schemas']['VideoStatus'];
export type Visibility = VideoComponents['schemas']['Visibility'];

export interface WinkeyClientOptions extends Omit<ClientOptions, 'baseUrl'> {
  baseUrl?: string;
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
}

export function createAuthInterceptor(
  getAccessToken: () => string | null | undefined | Promise<string | null | undefined>,
): Middleware {
  return {
    async onRequest({ request }) {
      const token = await getAccessToken();
      if (token && !request.headers.has('Authorization')) {
        request.headers.set('Authorization', `Bearer ${token}`);
      }
      return request;
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
export type UploadClient = ReturnType<typeof createUploadClient>;
export type VideoClient = ReturnType<typeof createVideoClient>;

export function createAuthClient(options: WinkeyClientOptions = {}) {
  const { baseUrl = '', getAccessToken, ...clientOptions } = options;
  const client = createClient<AuthPaths>({ baseUrl, ...clientOptions });
  if (getAccessToken) {
    client.use(createAuthInterceptor(getAccessToken));
  }
  return client;
}

export function createUploadClient(options: WinkeyClientOptions = {}) {
  const { baseUrl = '', getAccessToken, ...clientOptions } = options;
  const client = createClient<UploadPaths>({ baseUrl, ...clientOptions });
  if (getAccessToken) {
    client.use(createAuthInterceptor(getAccessToken));
  }
  return client;
}

export function createVideoClient(options: WinkeyClientOptions = {}) {
  const { baseUrl = '', getAccessToken, ...clientOptions } = options;
  const client = createClient<VideoPaths>({ baseUrl, ...clientOptions });
  if (getAccessToken) {
    client.use(createAuthInterceptor(getAccessToken));
  }
  return client;
}

export function createWinkeyClient(options: WinkeyClientOptions = {}) {
  return {
    auth: createAuthClient(options),
    upload: createUploadClient(options),
    video: createVideoClient(options),
  };
}
