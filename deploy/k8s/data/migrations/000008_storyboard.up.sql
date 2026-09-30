-- Task V5a: seek-preview storyboard (sprite sheets + WebVTT) produced by the transcoder.
-- Best effort: a READY video may have no storyboard (old videos, or generation failed), so the
-- column stays nullable and is not part of the READY CHECK.
ALTER TABLE media.videos ADD COLUMN storyboard_key text;  -- key of storyboard.vtt in the media bucket
