package domain

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// Tag limits (task TAG1, ADR-036). The database also enforces MaxTags.
const (
	MaxTags     = 10
	MaxTagRunes = 30
)

// Errors returned by NormalizeTags; the API maps them to 400 field errors.
var (
	ErrTooManyTags = errors.New("at most 10 tags")
	ErrTagTooLong  = errors.New("a tag is longer than 30 characters")
)

// NormalizeTags trims each tag and collapses its inner whitespace, drops empty tags, and drops duplicates that differ
// only in case or Vietnamese accents (the first spelling wins, order is kept). The result is never nil.
func NormalizeTags(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, raw := range in {
		t := strings.Join(strings.Fields(raw), " ")
		if t == "" {
			continue
		}
		if utf8.RuneCountInString(t) > MaxTagRunes {
			return nil, ErrTagTooLong
		}
		k := foldTag(t)
		if seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, t)
	}
	if len(out) > MaxTags {
		return nil, ErrTooManyTags
	}
	return out, nil
}

// foldTag lowercases and strips diacritics (đ → d), like public.winkey_fold does for search.
func foldTag(s string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(strings.ToLower(s)) {
		switch {
		case unicode.Is(unicode.Mn, r):
			continue
		case r == 'đ':
			b.WriteRune('d')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
