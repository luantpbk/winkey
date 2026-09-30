package api

import (
	"crypto/md5" //nolint:gosec // nginx secure_link_md5 is the verifier (ADR-017); the secret ends the input and links expire
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/luantpbk/winkey/libs/go/httpx"
)

// mediaLinkTTL is how long a signed media URL works (ADR-017).
const mediaLinkTTL = 6 * time.Hour

var mediaAccessTotal = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "video_media_access_total", Help: "mediaAccess answers (nginx auth_request): allow (204) or deny (403).",
}, []string{"result"})

func (h *Handler) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

// mediaExpiry is when URLs signed now stop working (whole seconds, so the URL and
// playback.expires_at agree).
func (h *Handler) mediaExpiry() time.Time { return h.now().Add(mediaLinkTTL).Truncate(time.Second) }

// signedMediaURL builds MEDIA_BASE_URL + "s/{expires}/{sig}/" + key for a video that the
// public cannot watch. It is the only place that signs.
func (h *Handler) signedMediaURL(videoID uuid.UUID, key string, expires time.Time) string {
	return signMediaURL(h.MediaBaseURL, h.MediaLinkSecret, videoID, key, expires.Unix())
}

// signMediaURL: sig = base64url-no-padding(md5("{expires}/v/{video_id}/ {secret}")), exactly what nginx
// checks with `secure_link_md5 "$secure_link_expires/v/$vid/ $media_link_secret"`.
func signMediaURL(baseURL string, secret []byte, videoID uuid.UUID, key string, expires int64) string {
	exp := strconv.FormatInt(expires, 10)
	sum := md5.Sum([]byte(exp + "/v/" + videoID.String() + "/ " + string(secret))) //nolint:gosec // see the import
	return strings.TrimRight(baseURL, "/") + "/s/" + exp + "/" + base64.RawURLEncoding.EncodeToString(sum[:]) + "/" +
		strings.TrimLeft(key, "/")
}

// ---- GET /internal/media-access/{video_id} (task SEC1) ---------------------------

// mediaAccess answers nginx's auth_request: 204 when the public may fetch the media of the
// video, 403 otherwise (unknown ids too, so it does not reveal what exists), 400 for a
// malformed id. No body, no identity headers, one primary-key query; both answers may be
// cached for 30 s. Hot path: logged at debug only (httpx.AccessLog does the same for /internal/).
func (h *Handler) mediaAccess(w http.ResponseWriter, r *http.Request) {
	raw := chi.URLParam(r, "video_id")
	id, err := uuid.Parse(raw)
	if err != nil || len(raw) != 36 { // canonical form only: uuid.Parse also accepts urn:, braces and no hyphens
		httpx.BadRequest(w, r, "VALIDATION_ERROR", "video_id must be a UUID",
			httpx.FieldError{Field: "video_id", Message: "must be a UUID"})
		return
	}
	ok, err := h.Store.MediaPublic(r.Context(), id)
	if err != nil {
		h.fail(w, r, "media access", err)
		return
	}
	w.Header().Set("Cache-Control", "max-age=30")
	if ok {
		mediaAccessTotal.WithLabelValues("allow").Inc()
		w.WriteHeader(http.StatusNoContent)
		return
	}
	mediaAccessTotal.WithLabelValues("deny").Inc()
	w.WriteHeader(http.StatusForbidden)
}
