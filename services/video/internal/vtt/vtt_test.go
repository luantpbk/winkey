package vtt

import (
	"strings"
	"testing"
)

func TestValidateAcceptsAndNormalises(t *testing.T) {
	for _, c := range []struct {
		name, in, want string
	}{
		{"minimal", "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n", "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n"},
		{"no trailing newline gets one", "WEBVTT\n\n00:00.000 --> 00:01.000\nHello", "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n"},
		{"BOM removed", "\ufeffWEBVTT\n\n00:00.000 --> 00:01.000\nHi\n", "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n"},
		{"CRLF", "WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nHi\r\n", "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n"},
		{"CR only", "WEBVTT\r\r00:00.000 --> 00:01.000\rHi\r", "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n"},
		{"mixed endings", "WEBVTT\r\n\n00:00.000 --> 00:01.000\rHi\n", "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n"},
		{"header text after a space", "WEBVTT - my subtitles\n\n00:00.000 --> 00:01.000\nHi\n", "WEBVTT - my subtitles\n\n00:00.000 --> 00:01.000\nHi\n"},
		{"header text after a tab", "WEBVTT\tmy subtitles\n\n00:00.000 --> 00:01.000\nHi\n", "WEBVTT\tmy subtitles\n\n00:00.000 --> 00:01.000\nHi\n"},
		{"header metadata", "WEBVTT\nKind: captions\nLanguage: vi\n\n00:00.000 --> 00:01.000\nHi\n", "WEBVTT\nKind: captions\nLanguage: vi\n\n00:00.000 --> 00:01.000\nHi\n"},
		{"NOTE block", "WEBVTT\n\nNOTE a comment\nover two lines\n\n00:00.000 --> 00:01.000\nHi\n", "WEBVTT\n\nNOTE a comment\nover two lines\n\n00:00.000 --> 00:01.000\nHi\n"},
		{"NOTE alone", "WEBVTT\n\nNOTE\n\n00:00.000 --> 00:01.000\nHi\n", "WEBVTT\n\nNOTE\n\n00:00.000 --> 00:01.000\nHi\n"},
		{"STYLE and REGION blocks", "WEBVTT\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:fred\nwidth:40%\n\n00:00.000 --> 00:01.000\nHi\n", "WEBVTT\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:fred\nwidth:40%\n\n00:00.000 --> 00:01.000\nHi\n"},
		{"cue identifier", "WEBVTT\n\nintro\n00:00.000 --> 00:01.000\nHi\n\n2\n00:01.000 --> 00:02.000\nBye\n", "WEBVTT\n\nintro\n00:00.000 --> 00:01.000\nHi\n\n2\n00:01.000 --> 00:02.000\nBye\n"},
		{"cue settings", "WEBVTT\n\n00:00.000 --> 00:01.000 align:start line:0% position:10%\nHi\n", "WEBVTT\n\n00:00.000 --> 00:01.000 align:start line:0% position:10%\nHi\n"},
		{"hours", "WEBVTT\n\n01:02:03.004 --> 01:02:04.000\nHi\n", "WEBVTT\n\n01:02:03.004 --> 01:02:04.000\nHi\n"},
		{"more than two hour digits", "WEBVTT\n\n100:00:00.000 --> 100:00:01.000\nHi\n", "WEBVTT\n\n100:00:00.000 --> 100:00:01.000\nHi\n"},
		{"multi-line text and markup", "WEBVTT\n\n00:00.000 --> 00:01.000\nline one\n<b>line two</b>\n♪ line three ♪\n", "WEBVTT\n\n00:00.000 --> 00:01.000\nline one\n<b>line two</b>\n♪ line three ♪\n"},
		{"cue without text", "WEBVTT\n\n00:00.000 --> 00:01.000\n", "WEBVTT\n\n00:00.000 --> 00:01.000\n"},
		{"Vietnamese", "WEBVTT\n\n00:00.000 --> 00:01.500\nXin chào Hà Nội, Đà Lạt\n", "WEBVTT\n\n00:00.000 --> 00:01.500\nXin chào Hà Nội, Đà Lạt\n"},
		{"tabs around the arrow", "WEBVTT\n\n00:00.000\t-->\t00:01.000\nHi\n", "WEBVTT\n\n00:00.000\t-->\t00:01.000\nHi\n"},
		{"several blank lines", "WEBVTT\n\n\n\n00:00.000 --> 00:01.000\nHi\n\n\n\n00:01.000 --> 00:02.000\nBye\n\n\n", "WEBVTT\n\n\n\n00:00.000 --> 00:01.000\nHi\n\n\n\n00:01.000 --> 00:02.000\nBye\n\n\n"},
		{"whitespace-only lines separate blocks", "WEBVTT\n \t\n00:00.000 --> 00:01.000\nHi\n  \n00:01.000 --> 00:02.000\nBye\n", "WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n\n00:01.000 --> 00:02.000\nBye\n"},
		{"overlapping cues are fine", "WEBVTT\n\n00:00.000 --> 00:05.000\nA\n\n00:02.000 --> 00:03.000\nB\n", "WEBVTT\n\n00:00.000 --> 00:05.000\nA\n\n00:02.000 --> 00:03.000\nB\n"},
	} {
		got, err := Validate(c.in)
		if err != nil {
			t.Errorf("%s: rejected: %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s:\n got %q\nwant %q", c.name, got, c.want)
		}
		if again, err2 := Validate(got); err2 != nil || again != got { // normalising is idempotent
			t.Errorf("%s: not idempotent: %v %q", c.name, err2, again)
		}
	}
}

func TestValidateRejectsWithTheLineNumber(t *testing.T) {
	long := strings.Repeat("a", MaxBytes+1)
	for _, c := range []struct {
		name, in string
		line     int
		reason   string // a fragment of the reason
	}{
		{"empty file", "", 1, "first line"},
		{"missing header", "00:00.000 --> 00:01.000\nHi\n", 1, "first line"},
		{"lower-case header", "webvtt\n\n00:00.000 --> 00:01.000\nHi\n", 1, "first line"},
		{"WEBVTTX", "WEBVTTX\n\n00:00.000 --> 00:01.000\nHi\n", 1, "first line"},
		{"header glued to text", "WEBVTT-2\n\n00:00.000 --> 00:01.000\nHi\n", 1, "first line"},
		{"leading blank line", "\nWEBVTT\n\n00:00.000 --> 00:01.000\nHi\n", 1, "first line"},
		{"only a header", "WEBVTT\n", 1, "no cue"},
		{"header and blank lines only", "WEBVTT\n\n\n", 3, "no cue"},
		{"only NOTE blocks", "WEBVTT\n\nNOTE hi\n\nSTYLE\na\n", 6, "no cue"},
		{"cue right after the header", "WEBVTT\n00:00.000 --> 00:01.000\nHi\n", 2, "blank line"},
		{"text that is not a cue", "WEBVTT\n\nhello there\nnot a cue\n", 3, "expected a cue timing"},
		{"bad separator", "WEBVTT\n\n00:00.000 -> 00:01.000\nHi\n", 3, "expected a cue timing"},
		{"bad timing after an identifier", "WEBVTT\n\nid\n00:00.000 --> soon\nHi\n", 4, "invalid cue timing"},
		{"three-digit seconds", "WEBVTT\n\n00:00.000 --> 00:001.000\nHi\n", 3, "invalid cue timing"},
		{"two-digit milliseconds", "WEBVTT\n\n00:00.00 --> 00:01.000\nHi\n", 3, "invalid cue timing"},
		{"comma milliseconds (SRT)", "WEBVTT\n\n00:00,000 --> 00:01,000\nHi\n", 3, "invalid cue timing"},
		{"single-digit fields", "WEBVTT\n\n0:0.000 --> 0:1.000\nHi\n", 3, "invalid cue timing"},
		{"missing start", "WEBVTT\n\n --> 00:01.000\nHi\n", 3, "invalid cue timing"},
		{"end equals start", "WEBVTT\n\n00:01.000 --> 00:01.000\nHi\n", 3, "end after"},
		{"end before start", "WEBVTT\n\n00:02.000 --> 00:01.000\nHi\n", 3, "end after"},
		{"end before start in the second cue", "WEBVTT\n\n00:00.000 --> 00:01.000\nA\n\n00:05.000 --> 00:04.999\nB\n", 6, "end after"},
		{"minutes 60", "WEBVTT\n\n60:00.000 --> 61:00.000\nHi\n", 3, "below 60"},
		{"seconds 60", "WEBVTT\n\n00:00.000 --> 00:60.000\nHi\n", 3, "below 60"},
		{"hours with minutes 60", "WEBVTT\n\n00:00:00.000 --> 01:60:00.000\nHi\n", 3, "below 60"},
		{"bad setting", "WEBVTT\n\n00:00.000 --> 00:01.000 align\nHi\n", 3, "cue setting"},
		{"NUL", "WEBVTT\n\n00:00.000 --> 00:01.000\nH\x00i\n", 4, "NUL"},
		{"NUL in the header", "WEBVTT\x00\n\n00:00.000 --> 00:01.000\nHi\n", 1, "NUL"},
		{"NUL after CRLF lines", "WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nHi\x00\r\n", 4, "NUL"},
		{"invalid UTF-8", "WEBVTT\n\n00:00.000 --> 00:01.000\nH\xffi\n", 4, "UTF-8"},
		{"invalid UTF-8 after CR lines", "WEBVTT\r\r00:00.000 --> 00:01.000\rH\xc3(\r", 4, "UTF-8"},
		{"truncated UTF-8 at the end", "WEBVTT\n\n00:00.000 --> 00:01.000\nHi \xe2\x82", 4, "UTF-8"},
	} {
		got, err := Validate(c.in)
		if err == nil {
			t.Errorf("%s: accepted:\n%q", c.name, got)
			continue
		}
		if err.Line != c.line || !strings.Contains(err.Reason, c.reason) || err.TooLarge {
			t.Errorf("%s: line %d %q, want line %d containing %q", c.name, err.Line, err.Reason, c.line, c.reason)
		}
		if want := "line " + itoa(c.line) + ": "; !strings.HasPrefix(err.Error(), want) {
			t.Errorf("%s: Error() = %q", c.name, err.Error())
		}
	}

	// Above the limit: its own error, without a line.
	if _, err := Validate("WEBVTT\n\n00:00.000 --> 00:01.000\n" + long); err == nil || !err.TooLarge || err.Line != 0 {
		t.Errorf("too large: %+v", err)
	}
	// Exactly the limit is fine.
	head := "WEBVTT\n\n00:00.000 --> 00:01.000\n"
	if _, err := Validate(head + strings.Repeat("a", MaxBytes-len(head)-1) + "\n"); err != nil {
		t.Errorf("a file of exactly %d bytes: %v", MaxBytes, err)
	}
	if _, err := Validate(head + strings.Repeat("a", MaxBytes-len(head)) + "\n"); err == nil || !err.TooLarge {
		t.Errorf("one byte over: %v", err)
	}
	// The limit counts bytes, not characters: 3-byte characters reach it at a third of the length.
	if _, err := Validate(head + strings.Repeat("♪", MaxBytes/3) + "\n"); err == nil || !err.TooLarge {
		t.Errorf("multi-byte text: %v", err)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

// Line numbers refer to the file as the user sent it: the BOM does not shift them and CRLF, LF and CR all count once.
func TestErrorLinesAreOfTheFileAsSent(t *testing.T) {
	_, err := Validate("\ufeffWEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nHi\r\n\r\n00:03.000 --> 00:02.000\r\nBye\r\n")
	if err == nil || err.Line != 6 {
		t.Fatalf("%v", err)
	}
	_, err = Validate("\ufeffWEBVTT\r\r00:00.000 --> 00:01.000\rHi\r\r00:03.000 --> 00:02.000\rBye\r")
	if err == nil || err.Line != 6 {
		t.Fatalf("%v", err)
	}
}

func TestNormalisedOutputIsBOMFreeLFOnlyWithATrailingNewline(t *testing.T) {
	got, err := Validate("\ufeffWEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\nA\rB")
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(got, "\ufeff") || strings.ContainsRune(got, '\r') || !strings.HasSuffix(got, "\n") || strings.HasSuffix(got, "\n\n") {
		t.Fatalf("%q", got)
	}
}

func FuzzValidateNeverPanicsAndOnlyAcceptsNormalisableFiles(f *testing.F) {
	for _, s := range []string{"WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n", "", "\ufeff", "WEBVTT\r\r", "x\x00", "\xff"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		out, err := Validate(in)
		if err != nil {
			if err.Line < 0 || (err.Line == 0 && !err.TooLarge) {
				t.Fatalf("bad error %+v", err)
			}
			return
		}
		if again, err2 := Validate(out); err2 != nil || again != out {
			t.Fatalf("accepted %q but its normal form %q is not stable (%v)", in, out, err2)
		}
	})
}
