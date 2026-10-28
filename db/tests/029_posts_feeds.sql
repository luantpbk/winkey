\set ON_ERROR_STOP on

INSERT INTO auth.users (id, email, handle, display_name)
VALUES ('00000000-0000-7000-8000-0000000000d1', 'soc2-a@example.com', 'soc2_a', 'S2 A'),
       ('00000000-0000-7000-8000-0000000000d2', 'soc2-b@example.com', 'soc2_b', 'S2 B');

INSERT INTO social.posts (id, author_id, body)
VALUES ('00000000-0000-7000-8000-00000000d001', '00000000-0000-7000-8000-0000000000d1', 'Xin chào #HàNội @soc2_b');

DO $$
DECLARE
    a constant uuid := '00000000-0000-7000-8000-0000000000d1';
    b constant uuid := '00000000-0000-7000-8000-0000000000d2';
    p constant uuid := '00000000-0000-7000-8000-00000000d001';
    c1 constant uuid := '00000000-0000-7000-8000-00000000dc01';
    c2 constant uuid := '00000000-0000-7000-8000-00000000dc02';
    n integer;
BEGIN
    -- Body length, deleted posts are empty, at most 10 images.
    BEGIN
        INSERT INTO social.posts (id, author_id, body) VALUES ('00000000-0000-7000-8000-00000000d0ff', a, repeat('x', 2001));
        RAISE EXCEPTION 'TEST FAILED: a 2001-character post was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE social.posts SET status = 'DELETED' WHERE id = p;
        RAISE EXCEPTION 'TEST FAILED: a DELETED post kept its body';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO social.post_media (post_id, position, image_id, image_key, thumb_key, width, height)
        VALUES (p, 10, gen_random_uuid(), 'k', 't', 1, 1);
        RAISE EXCEPTION 'TEST FAILED: an 11th image position was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Reactions: one per user, the counter follows insert / delete, not a kind change.
    INSERT INTO social.post_reactions (post_id, user_id, reaction) VALUES (p, b, 'LIKE');
    UPDATE social.post_reactions SET reaction = 'LOVE' WHERE post_id = p AND user_id = b;
    IF (SELECT reaction_count FROM social.posts WHERE id = p) <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: reaction_count after insert + kind change is not 1';
    END IF;
    DELETE FROM social.post_reactions WHERE post_id = p AND user_id = b;
    IF (SELECT reaction_count FROM social.posts WHERE id = p) <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: reaction_count after delete is not 0';
    END IF;

    -- Comments: two levels only, counters follow VISIBLE transitions.
    INSERT INTO social.post_comments (id, post_id, author_id, body) VALUES (c1, p, b, 'Hay quá');
    INSERT INTO social.post_comments (id, post_id, author_id, parent_id, body) VALUES (c2, p, a, c1, 'Cảm ơn');
    BEGIN
        INSERT INTO social.post_comments (id, post_id, author_id, parent_id, body)
        VALUES (gen_random_uuid(), p, b, c2, 'Cấp ba');
        RAISE EXCEPTION 'TEST FAILED: a reply to a reply was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    IF (SELECT comment_count FROM social.posts WHERE id = p) <> 2
       OR (SELECT reply_count FROM social.post_comments WHERE id = c1) <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: post comment counters wrong after two inserts';
    END IF;
    UPDATE social.post_comments SET status = 'DELETED', body = '' WHERE id = c2;
    IF (SELECT comment_count FROM social.posts WHERE id = p) <> 1
       OR (SELECT reply_count FROM social.post_comments WHERE id = c1) <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: post comment counters wrong after a delete';
    END IF;

    -- Reshares: counted while VISIBLE, at most one plain reshare per user, quotes are not limited.
    INSERT INTO social.posts (id, author_id, reshare_of) VALUES ('00000000-0000-7000-8000-00000000d002', b, p);
    BEGIN
        INSERT INTO social.posts (id, author_id, reshare_of) VALUES ('00000000-0000-7000-8000-00000000d003', b, p);
        RAISE EXCEPTION 'TEST FAILED: a second plain reshare was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    INSERT INTO social.posts (id, author_id, body, reshare_of)
    VALUES ('00000000-0000-7000-8000-00000000d004', b, 'Xem cái này', p);
    IF (SELECT reshare_count FROM social.posts WHERE id = p) <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: reshare_count is not 2';
    END IF;
    UPDATE social.posts SET status = 'HIDDEN' WHERE id = '00000000-0000-7000-8000-00000000d004';
    IF (SELECT reshare_count FROM social.posts WHERE id = p) <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: hiding a reshare did not decrement reshare_count';
    END IF;

    -- Hashtags share the video-tag slug; an empty slug is rejected.
    INSERT INTO social.post_hashtags (post_id, tag, created_at) VALUES (p, 'HàNội', now());
    BEGIN
        INSERT INTO social.post_hashtags (post_id, tag, created_at) VALUES (p, 'HANOI', now());
        RAISE EXCEPTION 'TEST FAILED: #HANOI was stored twice for one post (slug hanoi)';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    IF (SELECT slug FROM social.post_hashtags WHERE post_id = p) <> 'hanoi' THEN
        RAISE EXCEPTION 'TEST FAILED: #HàNội slug is %', (SELECT slug FROM social.post_hashtags WHERE post_id = p);
    END IF;
    BEGIN
        INSERT INTO social.post_hashtags (post_id, tag, created_at) VALUES (p, '!!!', now());
        RAISE EXCEPTION 'TEST FAILED: a hashtag with an empty slug was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Notifications: POST_* need the post refs, reactions dedup per actor, older kinds are unchanged.
    INSERT INTO social.notifications (id, user_id, kind, actor_id, post_id, post_comment_id)
    VALUES (gen_random_uuid(), a, 'POST_COMMENT', b, p, c1);
    BEGIN
        INSERT INTO social.notifications (id, user_id, kind, actor_id, post_id)
        VALUES (gen_random_uuid(), a, 'POST_COMMENT', b, p);
        RAISE EXCEPTION 'TEST FAILED: POST_COMMENT without post_comment_id was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO social.notifications (id, user_id, kind, actor_id, post_id)
    VALUES (gen_random_uuid(), a, 'POST_REACTION', b, p) ON CONFLICT DO NOTHING;
    INSERT INTO social.notifications (id, user_id, kind, actor_id, post_id)
    VALUES (gen_random_uuid(), a, 'POST_REACTION', b, p) ON CONFLICT DO NOTHING;
    SELECT count(*) INTO n FROM social.notifications WHERE user_id = a AND kind = 'POST_REACTION';
    IF n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: % POST_REACTION notifications for one actor and post', n;
    END IF;
    INSERT INTO social.notifications (id, user_id, kind, actor_id)
    VALUES (gen_random_uuid(), a, 'NEW_SUBSCRIBER', b) ON CONFLICT DO NOTHING;
    INSERT INTO social.notifications (id, user_id, kind, actor_id)
    VALUES (gen_random_uuid(), a, 'NEW_SUBSCRIBER', b) ON CONFLICT DO NOTHING;
    SELECT count(*) INTO n FROM social.notifications WHERE user_id = a AND kind = 'NEW_SUBSCRIBER';
    IF n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: NEW_SUBSCRIBER dedup changed (% rows)', n;
    END IF;

    -- Posts and post comments can be reported.
    INSERT INTO social.reports (id, reporter_id, target_type, target_id, reason)
    VALUES (gen_random_uuid(), b, 'POST', p, 'SPAM'), (gen_random_uuid(), a, 'POST_COMMENT', c1, 'SPAM');

    -- Deleting a post cascades to its media, reactions, comments, tags, mentions, score and notifications,
    -- and leaves its reshares in place with reshare_of = NULL.
    INSERT INTO social.post_mentions (post_id, user_id) VALUES (p, b);
    INSERT INTO social.post_scores (post_id, score) VALUES (p, 1.5);
    DELETE FROM social.posts WHERE id = p;
    IF EXISTS (SELECT 1 FROM social.post_comments WHERE post_id = p)
       OR EXISTS (SELECT 1 FROM social.post_hashtags WHERE post_id = p)
       OR EXISTS (SELECT 1 FROM social.post_scores WHERE post_id = p)
       OR EXISTS (SELECT 1 FROM social.notifications WHERE post_id = p) THEN
        RAISE EXCEPTION 'TEST FAILED: deleting a post left dependent rows';
    END IF;
    IF (SELECT reshare_of FROM social.posts WHERE id = '00000000-0000-7000-8000-00000000d002') IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: a reshare still points at a deleted post';
    END IF;
END
$$;
