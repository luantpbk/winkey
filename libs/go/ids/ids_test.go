package ids

import "testing"

func TestNewIsV7AndMonotonicPrefix(t *testing.T) {
	a, b := New(), New()
	if a.Version() != 7 || a.Variant().String() != "RFC4122" {
		t.Fatalf("not a v7 uuid: %s", a)
	}
	if a == b {
		t.Fatal("duplicate ids")
	}
	if a.String() > b.String() {
		t.Fatalf("ids not time ordered: %s > %s", a, b)
	}
}

func TestParseStrict(t *testing.T) {
	if _, err := Parse(NewString()); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "urn:uuid:" + NewString(), "{" + NewString() + "}", "nope"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("Parse(%q) should fail", bad)
		}
	}
}
