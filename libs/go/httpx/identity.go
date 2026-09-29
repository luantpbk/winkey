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
		uid, err := uuid.Parse(r.Header.Get("X-User-Id"))
		if err != nil || uid == uuid.Nil {
			Unauthorized(w, r)
			return
		}
		var roles []string
		for _, p := range strings.Split(r.Header.Get("X-User-Roles"), ",") {
			if p = strings.TrimSpace(p); p != "" {
				roles = append(roles, p)
			}
		}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), Identity{UserID: uid, Roles: roles})))
	})
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
