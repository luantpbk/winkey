// Package vtt validates and normalises WebVTT subtitle files (task V5b, ADR-018). It is a pure
// function of the file content: no I/O, no clock.
//
// The rules are the ones of video.v1.yaml (putSubtitle), a strict subset of the WebVTT spec that
// every browser text track accepts:
//
//   - at most MaxBytes of UTF-8, valid UTF-8, no NUL;
//   - an optional BOM, then a first line "WEBVTT" alone or followed by a space or tab and text;
//   - blocks separated by blank lines; NOTE, STYLE and REGION blocks are allowed anywhere after the header;
//   - a cue is an optional identifier line, a timing line
//     "[HH:]MM:SS.mmm --> [HH:]MM:SS.mmm[ settings]" (MM and SS below 60, end after start) and any
//     number of text lines;
//   - at least one cue.
//
// Every error names the line ("line N: reason", N counted from 1 in the file as sent).
package vtt

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// MaxBytes is the largest accepted file (contract: 524288 bytes of UTF-8).
const MaxBytes = 524288

// Error is a rejected file.
type Error struct {
	Line   int    // 1-based; 0 for TooLarge
	Reason string // without the "line N: " prefix
	// TooLarge is true for a file above MaxBytes (the API answers SUBTITLE_TOO_LARGE, not INVALID_WEBVTT).
	TooLarge bool
}

// Error is the `detail` of the problem: "line N: reason".
func (e *Error) Error() string {
	if e.Line == 0 {
		return e.Reason
	}
	return fmt.Sprintf("line %d: %s", e.Line, e.Reason)
}

func fail(line int, format string, args ...any) *Error {
	return &Error{Line: line, Reason: fmt.Sprintf(format, args...)}
}

// timing is "[HH:]MM:SS.mmm --> [HH:]MM:SS.mmm[ settings]"; the groups are the two timestamps and the settings.
var timing = regexp.MustCompile(`^((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})[ \t]+-->[ \t]+((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(?:[ \t]+(.*))?$`)

// setting is one "name:value" cue setting.
var setting = regexp.MustCompile(`^[A-Za-z]+:\S+$`)

// Validate checks content and returns it normalised: BOM removed, CRLF and CR turned into LF,
// blank-looking lines emptied, one trailing newline. The error is nil on success.
func Validate(content string) (string, *Error) {
	if len(content) > MaxBytes {
		return "", &Error{Reason: fmt.Sprintf("the file is %d bytes, above the limit of %d", len(content), MaxBytes), TooLarge: true}
	}
	// Line numbers first: they must be right for the UTF-8 and NUL errors too.
	if i := strings.IndexByte(content, 0); i >= 0 {
		return "", fail(lineOf(content, i), "the file contains a NUL character")
	}
	if !utf8.ValidString(content) {
		i := 0
		for i < len(content) {
			r, size := utf8.DecodeRuneInString(content[i:])
			if r == utf8.RuneError && size == 1 {
				break
			}
			i += size
		}
		return "", fail(lineOf(content, i), "the file is not valid UTF-8")
	}

	text := strings.TrimPrefix(content, "\ufeff")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	for i, l := range lines { // a line of only spaces or tabs separates blocks like an empty one
		if strings.Trim(l, " \t") == "" {
			lines[i] = ""
		}
	}

	if !isHeader(lines[0]) {
		return "", fail(1, `the first line must be "WEBVTT" alone or followed by a space or tab and text`)
	}

	cues := 0
	i := 1
	// The header block: lines up to the first blank line (metadata such as "Kind: captions").
	for ; i < len(lines) && lines[i] != ""; i++ {
		if strings.Contains(lines[i], "-->") {
			return "", fail(i+1, `a blank line must separate the "WEBVTT" header from the first cue`)
		}
	}
	for i < len(lines) {
		if lines[i] == "" {
			i++
			continue
		}
		start := i
		for i < len(lines) && lines[i] != "" {
			i++
		}
		block := lines[start:i] // the lines of one block, without the blank line after it
		if blockKind(block[0]) != "" {
			continue // NOTE, STYLE and REGION blocks are not cues
		}
		if err := checkCue(block, start+1); err != nil {
			return "", err
		}
		cues++
	}
	if cues == 0 {
		return "", fail(len(lines), "the file has no cue")
	}
	return strings.Join(lines, "\n") + "\n", nil
}

// lineOf is the 1-based line of byte offset i in the file as sent (LF, CRLF and CR all end a line).
func lineOf(content string, i int) int {
	n := 1
	for j := 0; j < i && j < len(content); j++ {
		switch content[j] {
		case '\n':
			n++
		case '\r':
			if j+1 < len(content) && content[j+1] == '\n' {
				continue // counted at the LF
			}
			n++
		}
	}
	return n
}

// isHeader reports whether the first line is "WEBVTT", alone or followed by a space or tab and text.
func isHeader(line string) bool {
	if !strings.HasPrefix(line, "WEBVTT") {
		return false
	}
	rest := line[len("WEBVTT"):]
	return rest == "" || rest[0] == ' ' || rest[0] == '\t'
}

// blockKind returns "NOTE", "STYLE" or "REGION" for the first line of such a block, else "".
func blockKind(first string) string {
	for _, k := range []string{"NOTE", "STYLE", "REGION"} {
		if first == k || strings.HasPrefix(first, k+" ") || strings.HasPrefix(first, k+"\t") {
			return k
		}
	}
	return ""
}

// checkCue validates one cue block; first is the 1-based line number of block[0].
func checkCue(block []string, first int) *Error {
	ti := 0
	switch {
	case strings.Contains(block[0], "-->"):
	case len(block) > 1 && strings.Contains(block[1], "-->"):
		ti = 1 // block[0] is the cue identifier
	default:
		return fail(first, "expected a cue timing line (HH:MM:SS.mmm --> HH:MM:SS.mmm), a NOTE, STYLE or REGION block")
	}
	line := first + ti
	m := timing.FindStringSubmatch(block[ti])
	if m == nil {
		return fail(line, "invalid cue timing, expected [HH:]MM:SS.mmm --> [HH:]MM:SS.mmm [settings]")
	}
	start, ok := parseTime(m[1])
	if !ok {
		return fail(line, "invalid start time %q: minutes and seconds must be below 60", m[1])
	}
	end, ok := parseTime(m[2])
	if !ok {
		return fail(line, "invalid end time %q: minutes and seconds must be below 60", m[2])
	}
	if end <= start {
		return fail(line, "the cue must end after it starts (%s --> %s)", m[1], m[2])
	}
	if m[3] != "" {
		for _, s := range strings.Fields(m[3]) {
			if !setting.MatchString(s) {
				return fail(line, "invalid cue setting %q, expected name:value", s)
			}
		}
	}
	return nil
}

// parseTime turns "[HH:]MM:SS.mmm" into milliseconds; ok is false when MM or SS is 60 or more.
func parseTime(s string) (ms int64, ok bool) {
	main, frac, _ := strings.Cut(s, ".")
	parts := strings.Split(main, ":")
	var h, m, sec int64
	switch len(parts) {
	case 3:
		h, _ = strconv.ParseInt(parts[0], 10, 64)
		m, _ = strconv.ParseInt(parts[1], 10, 64)
		sec, _ = strconv.ParseInt(parts[2], 10, 64)
	default:
		m, _ = strconv.ParseInt(parts[0], 10, 64)
		sec, _ = strconv.ParseInt(parts[1], 10, 64)
	}
	f, _ := strconv.ParseInt(frac, 10, 64)
	if m > 59 || sec > 59 {
		return 0, false
	}
	return ((h*60+m)*60+sec)*1000 + f, true
}
