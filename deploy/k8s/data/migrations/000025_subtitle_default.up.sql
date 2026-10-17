-- Task DEF1 (ADR-042 addendum 2026-10-17): the creator may mark one subtitle track per video as the default, turned
-- on when a viewer has no stored preference. No default (the starting state) means the video plays without
-- subtitles. Audio tracks already have is_default (000023); none set means the video's own audio.
ALTER TABLE media.video_subtitles ADD COLUMN is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX video_subtitles_one_default ON media.video_subtitles (video_id) WHERE is_default;
