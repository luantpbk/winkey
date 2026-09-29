package httpx

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// Role names issued by auth-svc.
const (
	RoleViewer    = "viewer"
	RoleCreator   = "creator"
	RoleModerator = "moderator"
	RoleAdmin     = "admin"
)

// Identity is the caller as asserted by the gateway. Services trust only the
// X-User-Id / X-User-Roles headers set by the forwardAuth hop (ADR-009) and
// never parse JWTs.
type Identity struct {
	UserID uuid.UUID
	Roles  []string
}

// HasRole reports whether the identity has the role. Admins have every role.
func (i Identity) HasRole(role string) bool {
	for _, r := range i.Roles {
		if r == role || r == RoleAdmin {
			return true
		}
	}
	return false
}

type identityKey struct{}

// WithIdentity stores id in the context.
func WithIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, identityKey{}, id)
}

// IdentityFrom returns the identity set by Authenticate.
func IdentityFrom(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(identityKey{}).(Identity)
	return id, ok
}

// Authenticate reads the gateway identity headers. Requests without a valid
// X-User-Id get 401 (this also covers a misrouted request that bypassed the
// gateway).
func Authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, ok := identityFromHeaders(r)
		if !ok {
			Unauthorized(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}

// OptionalAuthenticate is Authenticate for routes that serve anonymous callers
// too (e.g. public GETs whose result depends on who is asking). No X-User-Id
// means an anonymous request: the handler runs without an identity in the
// context (IdentityFrom reports false). An X-User-Id that is present but
// malformed is still a 401: the gateway never produces one, so it signals a
// misrouted or forged request rather than an anonymous user.
func OptionalAuthenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-User-Id") == "" {
			next.ServeHTTP(w, r)
			return
		}
		id, ok := identityFromHeaders(r)
		if !ok {
			Unauthorized(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}

func identityFromHeaders(r *http.Request) (Identity, bool) {
	uid, err := uuid.Parse(r.Header.Get("X-User-Id"))
	if err != nil || uid == uuid.Nil {
		return Identity{}, false
	}
	var roles []string
	for _, p := range strings.Split(r.Header.Get("X-User-Roles"), ",") {
		if p = strings.TrimSpace(p); p != "" {
			roles = append(roles, p)
		}
	}
	return Identity{UserID: uid, Roles: roles}, true
}

// RequireRole allows the request only when the caller has the role
// (or is admin). It must run after Authenticate.
func RequireRole(role string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, ok := IdentityFrom(r.Context())
			if !ok {
				Unauthorized(w, r)
				return
			}
			if !id.HasRole(role) {
				Forbidden(w, r, "missing required role: "+role)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
