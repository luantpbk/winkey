-- AV1 renditions cannot fit the old key (video_id, name); they are dropped (the H.264 set is untouched).
DELETE FROM media.video_renditions WHERE codec <> 'h264';
ALTER TABLE media.video_renditions DROP CONSTRAINT video_renditions_pkey;
ALTER TABLE media.video_renditions ADD CONSTRAINT video_renditions_pkey PRIMARY KEY (video_id, name);
ALTER TABLE media.video_renditions DROP CONSTRAINT IF EXISTS video_renditions_codec;
ALTER TABLE media.video_renditions DROP COLUMN IF EXISTS codec;
