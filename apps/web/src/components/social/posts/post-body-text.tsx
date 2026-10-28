import React from 'react';
import { Link } from '../../../i18n/routing';
import type { PostMention, PostHashtag } from '@winkey/api-client';

export interface PostBodyTextProps {
  body: string;
  mentions?: PostMention[];
  hashtags?: PostHashtag[];
  className?: string;
}

export interface TextToken {
  type: 'text' | 'mention' | 'hashtag';
  text: string;
  href?: string;
}

/**
 * Tokenize post body into text, valid mentions, and valid hashtags.
 * Only handles and hashtags present in the respective arrays are converted to links.
 * All other content (including unlisted tags, mentions, HTML) remains plain text.
 */
export function tokenizePostBody(
  body: string,
  mentions: PostMention[] = [],
  hashtags: PostHashtag[] = [],
): TextToken[] {
  if (!body) return [];

  const mentionMap = new Map<string, PostMention>();
  for (const m of mentions) {
    if (m?.handle) {
      mentionMap.set(m.handle.toLowerCase(), m);
    }
  }

  const hashtagMap = new Map<string, PostHashtag>();
  for (const h of hashtags) {
    if (h?.tag) {
      hashtagMap.set(h.tag.toLowerCase(), h);
    }
    if (h?.slug) {
      hashtagMap.set(h.slug.toLowerCase(), h);
    }
  }

  // Regex matching potential @handles or #tags (server rule: letters, digits, underscore)
  const TOKEN_REGEX = /(@[A-Za-z0-9_.]{3,30}|#[\p{L}\p{N}_]+)/gu;
  const parts = body.split(TOKEN_REGEX);
  const result: TextToken[] = [];

  for (const part of parts) {
    if (!part) continue;

    if (part.startsWith('@')) {
      const handle = part.slice(1);
      const match = mentionMap.get(handle.toLowerCase());
      if (match) {
        result.push({
          type: 'mention',
          text: part,
          href: `/c/${match.handle}`,
        });
        continue;
      }
    } else if (part.startsWith('#')) {
      const rawTag = part.slice(1);
      const match = hashtagMap.get(rawTag.toLowerCase());
      if (match) {
        result.push({
          type: 'hashtag',
          text: part,
          href: `/hashtag/${match.slug}`,
        });
        continue;
      }
    }

    result.push({
      type: 'text',
      text: part,
    });
  }

  return result;
}

export function PostBodyText({
  body,
  mentions = [],
  hashtags = [],
  className = '',
}: PostBodyTextProps) {
  const tokens = tokenizePostBody(body, mentions, hashtags);

  return (
    <div
      className={`whitespace-pre-wrap break-words text-sm sm:text-base text-zinc-900 dark:text-zinc-100 leading-relaxed ${className}`}
    >
      {tokens.map((token, idx) => {
        if (token.type === 'mention' && token.href) {
          return (
            <Link
              key={idx}
              href={token.href}
              className="text-red-600 dark:text-red-400 font-semibold hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {token.text}
            </Link>
          );
        }
        if (token.type === 'hashtag' && token.href) {
          return (
            <Link
              key={idx}
              href={token.href}
              className="text-red-600 dark:text-red-400 font-semibold hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {token.text}
            </Link>
          );
        }
        return <React.Fragment key={idx}>{token.text}</React.Fragment>;
      })}
    </div>
  );
}
