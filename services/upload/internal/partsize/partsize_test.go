package partsize

import "testing"

func TestCompute(t *testing.T) {
	tests := []struct {
		name      string
		size      int64
		wantSize  int64
		wantCount int
	}{
		{"1 byte", 1, 16 * MiB, 1},
		{"exactly one part", 16 * MiB, 16 * MiB, 1},
		{"one byte over one part", 16*MiB + 1, 16 * MiB, 2},
		{"100 MiB", 100 * MiB, 16 * MiB, 7},
		{"1 GiB", 1 << 30, 16 * MiB, 64},
		// 10000 parts * 16 MiB = 160000 MiB: the 16 MiB floor holds up to here.
		{"floor limit", 10000 * 16 * MiB, 16 * MiB, 10000},
		{"just above floor limit", 10000*16*MiB + 1, 17 * MiB, 9412},
		{"20 GiB", 20 << 30, 16 * MiB, 1280},
	}

	for _, tc := range tests {
		gotSize, gotCount := Compute(tc.size)
		if gotSize != tc.wantSize || gotCount != tc.wantCount {
			t.Errorf("%s: Compute(%d) = (%d, %d), want (%d, %d)",
				tc.name, tc.size, gotSize, gotCount, tc.wantSize, tc.wantCount)
		}
	}
}

func TestInvariants(t *testing.T) {
	for _, size := range []int64{1, 5 * MiB, 1<<30 - 1, 160000 * MiB, 160000*MiB + 1, MaxSize - 1, MaxSize} {
		ps, n := Compute(size)
		if n < 1 || n > MaxParts {
			t.Errorf("size %d: part_count %d out of range", size, n)
		}
		if ps%MiB != 0 || ps < MinPartSize {
			t.Errorf("size %d: part_size %d not a whole MiB >= 16 MiB", size, ps)
		}
		// Every part but the last is exactly ps, and the parts cover size.
		if int64(n-1)*ps >= size || int64(n)*ps < size {
			t.Errorf("size %d: %d parts of %d do not tile the object", size, n, ps)
		}
	}
}
