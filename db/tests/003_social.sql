\set ON_ERROR_STOP on

-- Two videos in the projection; owner/users are plain uuids (no cross-schema FK).
INSERT INTO social.videos (id, owner_id) VALUES
    ('00000000-0000-7000-8000-00000000c001', '00000000-0000-7000-8000-0000000000c0'),
    ('00000000-0000-7000-8000-00000000c002', '00000000-0000-7000-8000-0000000000c0');

-- Top-level comment and a reply.
INSERT INTO social.comments (id, video_id, author_id, body) VALUES
    ('00000000-0000-7000-8000-00000000d001', '00000000-0000-7000-8000-00000000c001',
     '00000000-0000-7000-8000-0000000000a1', 'first');
INSERT INTO social.comments (id, video_id, author_id, parent_id, body) VALUES
    ('00000000-0000-7000-8000-00000000d002', '00000000-0000-7000-8000-00000000c001',
     '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-00000000d001', 'reply');

DO $$
BEGIN
    IF (SELECT comment_count FROM social.videos WHERE id = '00000000-0000-7000-8000-00000000c001') <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: comment_count after insert';
    END IF;
    IF (SELECT reply_count FROM social.comments WHERE id = '00000000-0000-7000-8000-00000000d001') <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: reply_count after insert';
    END IF;
END $$;

-- Only two levels: replying to a reply is rejected.
DO $$
BEGIN
    INSERT INTO social.comments (id, video_id, author_id, parent_id, body) VALUES
        ('00000000-0000-7000-8000-00000000d003', '00000000-0000-7000-8000-00000000c001',
         '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-00000000d002', 'nested');
    RAISE EXCEPTION 'TEST FAILED: reply to a reply was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- A reply must be on the same video as its parent.
DO $$
BEGIN
    INSERT INTO social.comments (id, video_id, author_id, parent_id, body) VALUES
        ('00000000-0000-7000-8000-00000000d004', '00000000-0000-7000-8000-00000000c002',
         '00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-00000000d001', 'cross');
    RAISE EXCEPTION 'TEST FAILED: reply across videos was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- Comments need a known video (projection), and a non-empty body while not DELETED.
DO $$
BEGIN
    INSERT INTO social.comments (id, video_id, author_id, body) VALUES
        ('00000000-0000-7000-8000-00000000d005', '00000000-0000-7000-8000-00000000c0ff',
         '00000000-0000-7000-8000-0000000000a1', 'orphan');
    RAISE EXCEPTION 'TEST FAILED: comment on unknown video was allowed';
EXCEPTION WHEN foreign_key_violation THEN NULL;
END $$;
DO $$
BEGIN
    INSERT INTO social.comments (id, video_id, author_id, body) VALUES
        ('00000000-0000-7000-8000-00000000d006', '00000000-0000-7000-8000-00000000c001',
         '00000000-0000-7000-8000-0000000000a1', '');
    RAISE EXCEPTION 'TEST FAILED: empty body was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$
BEGIN
    UPDATE social.comments SET status = 'DELETED' WHERE id = '00000000-0000-7000-8000-00000000d002';
    RAISE EXCEPTION 'TEST FAILED: DELETED comment kept its body';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- Hide the reply, restore it, then delete it: counters follow VISIBLE transitions.
UPDATE social.comments SET status = 'HIDDEN' WHERE id = '00000000-0000-7000-8000-00000000d002';
DO $$
BEGIN
    IF (SELECT comment_count FROM social.videos WHERE id = '00000000-0000-7000-8000-00000000c001') <> 1
       OR (SELECT reply_count FROM social.comments WHERE id = '00000000-0000-7000-8000-00000000d001') <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: counters after hide';
    END IF;
END $$;
UPDATE social.comments SET status = 'VISIBLE' WHERE id = '00000000-0000-7000-8000-00000000d002';
UPDATE social.comments SET status = 'DELETED', body = '' WHERE id = '00000000-0000-7000-8000-00000000d002';
DO $$
BEGIN
    IF (SELECT comment_count FROM social.videos WHERE id = '00000000-0000-7000-8000-00000000c001') <> 1
       OR (SELECT reply_count FROM social.comments WHERE id = '00000000-0000-7000-8000-00000000d001') <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: counters after restore + delete';
    END IF;
END $$;

-- A reply bumping reply_count must not touch the parent's updated_at.
UPDATE social.comments SET updated_at = '2000-01-01' WHERE id = '00000000-0000-7000-8000-00000000d001';
INSERT INTO social.comments (id, video_id, author_id, parent_id, body) VALUES
    ('00000000-0000-7000-8000-00000000d007', '00000000-0000-7000-8000-00000000c001',
     '00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-00000000d001', 'reply 2');
DO $$
BEGIN
    IF (SELECT updated_at FROM social.comments WHERE id = '00000000-0000-7000-8000-00000000d001') <> '2000-01-01' THEN
        RAISE EXCEPTION 'TEST FAILED: parent updated_at changed by a reply';
    END IF;
END $$;

-- Likes: one per user and video; like_count follows inserts and deletes.
INSERT INTO social.video_likes (video_id, user_id) VALUES
    ('00000000-0000-7000-8000-00000000c001', '00000000-0000-7000-8000-0000000000a1'),
    ('00000000-0000-7000-8000-00000000c001', '00000000-0000-7000-8000-0000000000a2');
DO $$
BEGIN
    INSERT INTO social.video_likes (video_id, user_id)
    VALUES ('00000000-0000-7000-8000-00000000c001', '00000000-0000-7000-8000-0000000000a1');
    RAISE EXCEPTION 'TEST FAILED: duplicate like was allowed';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;
DELETE FROM social.video_likes
WHERE video_id = '00000000-0000-7000-8000-00000000c001' AND user_id = '00000000-0000-7000-8000-0000000000a2';
DO $$
BEGIN
    IF (SELECT like_count FROM social.videos WHERE id = '00000000-0000-7000-8000-00000000c001') <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: like_count';
    END IF;
END $$;

-- Subscriptions: no self-subscribe; subscriber_count follows inserts and deletes.
DO $$
BEGIN
    INSERT INTO social.subscriptions (subscriber_id, channel_id)
    VALUES ('00000000-0000-7000-8000-0000000000c0', '00000000-0000-7000-8000-0000000000c0');
    RAISE EXCEPTION 'TEST FAILED: self-subscription was allowed';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
INSERT INTO social.subscriptions (subscriber_id, channel_id) VALUES
    ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-0000000000c0'),
    ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-0000000000c0');
DELETE FROM social.subscriptions
WHERE subscriber_id = '00000000-0000-7000-8000-0000000000a1' AND channel_id = '00000000-0000-7000-8000-0000000000c0';
DO $$
BEGIN
    IF (SELECT subscriber_count FROM social.channels WHERE id = '00000000-0000-7000-8000-0000000000c0') <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: subscriber_count';
    END IF;
END $$;

-- video.deleted removes the projection row and everything hanging off it.
DELETE FROM social.videos WHERE id = '00000000-0000-7000-8000-00000000c001';
DO $$
BEGIN
    IF (SELECT count(*) FROM social.comments WHERE video_id = '00000000-0000-7000-8000-00000000c001') <> 0
       OR (SELECT count(*) FROM social.video_likes WHERE video_id = '00000000-0000-7000-8000-00000000c001') <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: cascade on video delete';
    END IF;
END $$;

\echo 'ok 003_social'
