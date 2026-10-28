-- SOC-2b (ADR-049 addendum 2026-10-28): short social videos in posts.
--   media.videos.purpose  FILM (everything so far, unchanged) | SOCIAL (uploaded for a post: ≤ 3 min, 720p + 360p,
--                         strongly compressed, raw deleted when READY, always UNLISTED, no AV1, no storyboard)
--   media.videos.attached_at  set by video-svc when social-svc reports the video attached to a post; a SOCIAL video
--                         never attached within 48 h, or released by its post, is deleted by video-svc.
--   social.videos.purpose  projected from video.ready.
--   social.posts.video_social  the post owns its video (SOCIAL): at most one live post per social video.

CREATE TYPE media.video_purpose AS ENUM ('FILM', 'SOCIAL');

ALTER TABLE media.videos
    ADD COLUMN purpose media.video_purpose NOT NULL DEFAULT 'FILM',
    ADD COLUMN attached_at timestamptz;
-- Social videos are reachable only through their post: never listed, never public in catalogues.
ALTER TABLE media.videos ADD CONSTRAINT videos_social_unlisted CHECK (purpose = 'FILM' OR visibility = 'UNLISTED');
ALTER TABLE media.videos ADD CONSTRAINT videos_social_size CHECK (purpose = 'FILM' OR size_bytes <= 314572800);  -- 300 MiB
ALTER TABLE media.videos ADD CONSTRAINT videos_attached_social CHECK (attached_at IS NULL OR purpose = 'SOCIAL');
-- video-svc janitor: READY social videos never attached.
CREATE INDEX videos_social_unattached ON media.videos (created_at) WHERE purpose = 'SOCIAL' AND attached_at IS NULL;

ALTER TABLE social.videos
    ADD COLUMN purpose text NOT NULL DEFAULT 'FILM',
    ADD CONSTRAINT social_videos_purpose CHECK (purpose IN ('FILM', 'SOCIAL'));

ALTER TABLE social.posts ADD COLUMN video_social boolean NOT NULL DEFAULT false;
ALTER TABLE social.posts ADD CONSTRAINT posts_video_social CHECK (NOT video_social OR video_id IS NOT NULL);
CREATE UNIQUE INDEX posts_one_per_social_video ON social.posts (video_id) WHERE video_social AND status <> 'DELETED';
