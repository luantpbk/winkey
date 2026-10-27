package media

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
)

// Social images (task SOC-1b, ADR-049 §4): one still image in, WebP out, metadata stripped, EXIF orientation
// applied. The file's bytes decide its format; the uploader's Content-Type is never trusted.

// Image input limits (upload.v1.yaml tag images).
const (
	MaxImageSide   = 8000
	MaxImagePixels = 40_000_000
	WebPQuality    = 72
)

// Image purposes (media.image_purpose).
const (
	PurposeAvatar = "AVATAR"
	PurposeBanner = "BANNER"
	PurposePost   = "POST"
)

// ImageInfo is what the image job needs to know about a still image.
type ImageInfo struct {
	Width, Height int
	Codec         string
	Alpha         bool
}

// SniffImage identifies the format from the first bytes of the file (at least 64 KiB, or the whole file when
// shorter) and refuses animations: GIF, APNG (acTL before IDAT), animated WebP (VP8X animation flag) and AVIF
// image sequences (brand avis). Errors are *InvalidInputError.
func SniffImage(head []byte) (string, error) {
	switch {
	case bytes.HasPrefix(head, []byte{0xff, 0xd8, 0xff}):
		return "jpeg", nil
	case bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n")):
		if pngAnimated(head) {
			return "", invalid("animated images are not supported")
		}
		return "png", nil
	case len(head) >= 12 && string(head[0:4]) == "RIFF" && string(head[8:12]) == "WEBP":
		if len(head) >= 21 && string(head[12:16]) == "VP8X" && head[20]&0x02 != 0 {
			return "", invalid("animated images are not supported")
		}
		return "webp", nil
	case len(head) >= 12 && string(head[4:8]) == "ftyp":
		switch string(head[8:12]) {
		case "avif":
			return "avif", nil
		case "avis":
			return "", invalid("animated images are not supported")
		}
	case bytes.HasPrefix(head, []byte("GIF8")):
		return "", invalid("GIF is not supported; upload a JPEG, PNG, WebP or AVIF image")
	}
	return "", invalid("the file is not a JPEG, PNG, WebP or AVIF image")
}

// pngAnimated walks the PNG chunks until IDAT and reports an acTL chunk (APNG).
func pngAnimated(b []byte) bool {
	for i := 8; i+8 <= len(b); {
		n := int(binary.BigEndian.Uint32(b[i : i+4]))
		typ := string(b[i+4 : i+8])
		switch typ {
		case "acTL":
			return true
		case "IDAT", "IEND":
			return false
		}
		if n < 0 || i+12+n > len(b) || i+12+n <= i {
			return false
		}
		i += 12 + n
	}
	return false
}

// JPEGOrientation returns the EXIF orientation (1..8) of a JPEG, 1 when absent or unreadable.
func JPEGOrientation(b []byte) int {
	if !bytes.HasPrefix(b, []byte{0xff, 0xd8}) {
		return 1
	}
	for i := 2; i+4 <= len(b); {
		if b[i] != 0xff {
			return 1
		}
		marker := b[i+1]
		if marker == 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker == 0x01 {
			i += 2
			continue
		}
		if marker == 0xda || marker == 0xd9 { // start of scan / end of image: no EXIF before the data
			return 1
		}
		size := int(binary.BigEndian.Uint16(b[i+2 : i+4]))
		if size < 2 || i+2+size > len(b) {
			return 1
		}
		seg := b[i+4 : i+2+size]
		if marker == 0xe1 && bytes.HasPrefix(seg, []byte("Exif\x00\x00")) {
			return tiffOrientation(seg[6:])
		}
		i += 2 + size
	}
	return 1
}

func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(t[0:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	ifd := int(bo.Uint32(t[4:8]))
	if ifd < 8 || ifd+2 > len(t) {
		return 1
	}
	n := int(bo.Uint16(t[ifd : ifd+2]))
	for k := 0; k < n; k++ {
		e := ifd + 2 + 12*k
		if e+12 > len(t) {
			return 1
		}
		if bo.Uint16(t[e:e+2]) == 0x0112 { // Orientation, SHORT
			if v := int(bo.Uint16(t[e+8 : e+10])); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// OrientFilter is the ffmpeg filter that turns an image stored with EXIF orientation o upright ("" for 1).
// ffmpeg transpose: 0 = transpose, 1 = 90° clockwise, 2 = 90° counter-clockwise, 3 = transverse.
func OrientFilter(o int) string {
	switch o {
	case 2:
		return "hflip"
	case 3:
		return "hflip,vflip"
	case 4:
		return "vflip"
	case 5:
		return "transpose=0"
	case 6:
		return "transpose=1"
	case 7:
		return "transpose=3"
	case 8:
		return "transpose=2"
	}
	return ""
}

// ImageFilters returns the scale/crop filters of the full image and of the thumbnail for a purpose
// (upload.v1.yaml tag images). AVATAR and BANNER are centre-cropped to their aspect ratio and sized exactly;
// POST fits in a 1600 px (thumb 400 px) box and is never upscaled.
func ImageFilters(purpose string) (full, thumb string) {
	const square = "crop='min(iw,ih)':'min(iw,ih)'"
	const wide = "crop='if(gt(iw/ih,3),ih*3,iw)':'if(gt(iw/ih,3),ih,iw/3)'"
	box := func(n int) string {
		s := strconv.Itoa(n)
		return "scale='min(" + s + ",iw)':'min(" + s + ",ih)':force_original_aspect_ratio=decrease:flags=lanczos"
	}
	switch purpose {
	case PurposeAvatar:
		return square + ",scale=400:400:flags=lanczos", square + ",scale=96:96:flags=lanczos"
	case PurposeBanner:
		return wide + ",scale=1500:500:flags=lanczos", wide + ",scale=600:200:flags=lanczos"
	default:
		return box(1600), box(400)
	}
}

// BuildWebPArgs converts the first frame of input to a lossy WebP at output with the given filter chain
// (orientation first, then ImageFilters), without any metadata.
func BuildWebPArgs(input, output, filter string, alpha bool) []string {
	pix := "yuv420p"
	if alpha {
		pix = "yuva420p"
	}
	return []string{
		"-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-protocol_whitelist", "file",
		"-noautorotate", "-i", filepath.ToSlash(input),
		"-frames:v", "1", "-an", "-sn", "-dn",
		"-vf", filter + ",format=" + pix,
		"-map_metadata", "-1",
		"-c:v", "libwebp", "-quality", strconv.Itoa(WebPQuality), "-compression_level", "6", "-preset", "picture",
		"-f", "webp", filepath.ToSlash(output),
	}
}

// BuildEncoderCheckArgs lists the encoders (to verify libwebp at start-up).
func BuildEncoderCheckArgs() []string { return []string{"-hide_banner", "-encoders"} }

// ParseImageProbe interprets ffprobe JSON output for a still image and applies the input limits.
// Errors are *InvalidInputError.
func ParseImageProbe(data []byte) (ImageInfo, error) {
	var p probeOutput
	if err := json.Unmarshal(data, &p); err != nil {
		return ImageInfo{}, invalid("unreadable probe output")
	}
	var info ImageInfo
	videos := 0
	for _, s := range p.Streams {
		if s.CodecType != "video" {
			continue
		}
		videos++
		info = ImageInfo{Width: s.Width, Height: s.Height, Codec: s.CodecName, Alpha: hasAlpha(s.PixFmt)}
	}
	switch {
	case videos == 0:
		return ImageInfo{}, invalid("the file is not an image")
	case videos > 1:
		return ImageInfo{}, invalid("the file holds more than one image")
	}
	switch info.Codec {
	case "mjpeg", "png", "webp", "av1":
	default:
		return ImageInfo{}, invalid("unsupported image codec %s", info.Codec)
	}
	if info.Width < 1 || info.Height < 1 {
		return ImageInfo{}, invalid("the image size is unknown")
	}
	if info.Width > MaxImageSide || info.Height > MaxImageSide || info.Width*info.Height > MaxImagePixels {
		return ImageInfo{}, invalid("the image is larger than %d px on a side or %d megapixels", MaxImageSide, MaxImagePixels/1_000_000)
	}
	return info, nil
}

func hasAlpha(pix string) bool {
	switch {
	case strings.HasPrefix(pix, "yuva"), strings.HasPrefix(pix, "rgba"), strings.HasPrefix(pix, "bgra"),
		strings.HasPrefix(pix, "argb"), strings.HasPrefix(pix, "abgr"), strings.HasPrefix(pix, "ya"),
		strings.HasPrefix(pix, "gbrap"), pix == "pal8":
		return true
	}
	return false
}
