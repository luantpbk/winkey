package domain

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestNormalizeTags(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
		err  error
	}{
		{"nil gives empty", nil, []string{}, nil},
		{"trim and collapse", []string{"  du   lịch  ", "phở"}, []string{"du lịch", "phở"}, nil},
		{"drop empty", []string{"", "   ", "a"}, []string{"a"}, nil},
		{"dedupe case and accents keeps first", []string{"Hà Nội", "ha noi", "HÀ NỘI", "Đà Lạt", "da lat"}, []string{"Hà Nội", "Đà Lạt"}, nil},
		{"exactly 10 after dedupe", []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "A"}, []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"}, nil},
		{"too many", []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"}, nil, ErrTooManyTags},
		{"30 runes ok", []string{strings.Repeat("ố", 30)}, []string{strings.Repeat("ố", 30)}, nil},
		{"31 runes too long", []string{strings.Repeat("a", 31)}, nil, ErrTagTooLong},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeTags(tc.in)
			if !errors.Is(err, tc.err) {
				t.Fatalf("err = %v, want %v", err, tc.err)
			}
			if tc.err == nil && !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
