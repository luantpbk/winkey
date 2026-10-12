-- Task ENC2 (ADR-041): a video can have an AV1 HLS set (hls-av1/) beside the H.264 one (hls/), with the same rendition
-- names. Existing rows are H.264. The primary key gains the codec so 1080p can exist once per codec.
ALTER TABLE media.video_renditions
    ADD COLUMN codec text NOT NULL DEFAULT 'h264',
    ADD CONSTRAINT video_renditions_codec CHECK (codec IN ('h264', 'av1'));

ALTER TABLE media.video_renditions DROP CONSTRAINT video_renditions_pkey;
ALTER TABLE media.video_renditions ADD CONSTRAINT video_renditions_pkey PRIMARY KEY (video_id, codec, name);
