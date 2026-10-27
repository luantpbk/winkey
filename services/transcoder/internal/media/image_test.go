package media

import (
	"encoding/binary"
	"errors"
	"strings"
	"testing"
)

// exifJPEG splices an APP1 Exif segment with one Orientation entry after the SOI of jpeg.
func exifJPEG(jpeg []byte, orientation uint16, bo binary.ByteOrder) []byte {
	tiff := make([]byte, 8+2+12+4)
	if bo == binary.LittleEndian {
		copy(tiff, "II")
	} else {
		copy(tiff, "MM")
	}
	bo.PutUint16(tiff[2:], 42)
	bo.PutUint32(tiff[4:], 8)
	bo.PutUint16(tiff[8:], 1)
	bo.PutUint16(tiff[10:], 0x0112)
	bo.PutUint16(tiff[12:], 3)
	bo.PutUint32(tiff[14:], 1)
	bo.PutUint16(tiff[18:], orientation)
	seg := append([]byte("Exif\x00\x00"), tiff...)
	app1 := []byte{0xff, 0xe1, 0, 0}
	binary.BigEndian.PutUint16(app1[2:], uint16(len(seg)+2))
	out := append([]byte{}, jpeg[:2]...)
	out = append(out, app1...)
	out = append(out, seg...)
	return append(out, jpeg[2:]...)
}

func TestJPEGOrientation(t *testing.T) {
	plain := []byte{0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9}
	if got := JPEGOrientation(plain); got != 1 {
		t.Fatalf("no EXIF: %d", got)
	}
	for o := uint16(1); o <= 8; o++ {
		for _, bo := range []binary.ByteOrder{binary.LittleEndian, binary.BigEndian} {
			if got := JPEGOrientation(exifJPEG(plain, o, bo)); got != int(o) {
				t.Fatalf("orientation %d (%v): got %d", o, bo, got)
			}
		}
	}
	if got := JPEGOrientation(exifJPEG(plain, 9, binary.BigEndian)); got != 1 {
		t.Fatalf("out of range: %d", got)
	}
	// Truncated or garbage input never panics.
	for _, b := range [][]byte{nil, {0xff}, {0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff}, []byte("not a jpeg")} {
		_ = JPEGOrientation(b)
	}
	if OrientFilter(1) != "" || OrientFilter(6) != "transpose=1" || OrientFilter(8) != "transpose=2" {
		t.Fatal("orient filter mapping changed")
	}
}

func TestSniffImage(t *testing.T) {
	webp := func(chunk string, flags byte) []byte {
		b := []byte("RIFF\x00\x00\x00\x00WEBP" + chunk + "\x0a\x00\x00\x00")
		return append(b, flags, 0, 0, 0)
	}
	png := func(chunks ...string) []byte {
		b := []byte("\x89PNG\r\n\x1a\n")
		for _, c := range chunks {
			b = append(b, 0, 0, 0, 0)
			b = append(b, c...)
			b = append(b, 0, 0, 0, 0)
		}
		return b
	}
	ok := map[string][]byte{
		"jpeg": {0xff, 0xd8, 0xff, 0xe0},
		"png":  png("IHDR", "IDAT"),
		"webp": webp("VP8X", 0x10),
		"avif": []byte("\x00\x00\x00\x1cftypavif"),
	}
	for want, b := range ok {
		if got, err := SniffImage(b); err != nil || got != want {
			t.Errorf("%s: %q %v", want, got, err)
		}
	}
	bad := map[string][]byte{
		"gif":       []byte("GIF89a"),
		"apng":      png("IHDR", "acTL", "IDAT"),
		"anim webp": webp("VP8X", 0x12),
		"avis":      []byte("\x00\x00\x00\x1cftypavis"),
		"text":      []byte("hello"),
		"mp4":       []byte("\x00\x00\x00\x18ftypisom"),
	}
	for name, b := range bad {
		var ie *InvalidInputError
		if _, err := SniffImage(b); !errors.As(err, &ie) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
}

func TestParseImageProbe(t *testing.T) {
	probe := func(codec string, w, h int, pix string) []byte {
		return []byte(`{"streams":[{"codec_type":"video","codec_name":"` + codec + `","width":` + itoa(w) +
			`,"height":` + itoa(h) + `,"pix_fmt":"` + pix + `"}],"format":{}}`)
	}
	info, err := ParseImageProbe(probe("png", 1200, 800, "rgba"))
	if err != nil || info.Width != 1200 || info.Height != 800 || !info.Alpha {
		t.Fatalf("%+v %v", info, err)
	}
	if info, _ := ParseImageProbe(probe("mjpeg", 10, 10, "yuvj420p")); info.Alpha {
		t.Fatal("JPEG has no alpha")
	}
	for name, b := range map[string][]byte{
		"gif":      probe("gif", 10, 10, "pal8"),
		"too wide": probe("mjpeg", 8001, 10, "yuvj420p"),
		"too many": probe("mjpeg", 7000, 7000, "yuvj420p"),
		"no size":  probe("png", 0, 0, "rgb24"),
		"two":      []byte(`{"streams":[{"codec_type":"video","codec_name":"av1","width":9,"height":9},{"codec_type":"video","codec_name":"av1","width":9,"height":9}]}`),
		"none":     []byte(`{"streams":[{"codec_type":"audio","codec_name":"aac"}]}`),
		"garbage":  []byte(`nope`),
	} {
		var ie *InvalidInputError
		if _, err := ParseImageProbe(b); !errors.As(err, &ie) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestBuildWebPArgs(t *testing.T) {
	full, thumb := ImageFilters(PurposeAvatar)
	if !strings.Contains(full, "scale=400:400") || !strings.Contains(thumb, "scale=96:96") {
		t.Fatalf("avatar filters %q %q", full, thumb)
	}
	args := strings.Join(BuildWebPArgs("/in", "/out.webp", "transpose=1,"+full, false), " ")
	for _, want := range []string{"-noautorotate", "-map_metadata -1", "-c:v libwebp", "-quality 72", "format=yuv420p", "-frames:v 1"} {
		if !strings.Contains(args, want) {
			t.Errorf("missing %q in %s", want, args)
		}
	}
	if !strings.Contains(strings.Join(BuildWebPArgs("/in", "/o", "null", true), " "), "format=yuva420p") {
		t.Error("alpha input must keep alpha")
	}
}
