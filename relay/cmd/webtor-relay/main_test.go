package main

import "testing"

func TestUploadSetting(t *testing.T) {
	for _, tc := range []struct {
		noUpload bool
		rate     int64
		limit    int64
		text     string
	}{
		{true, 1 << 20, -1, "off"},
		{false, 0, 0, "unlimited"},
		{false, -3, 0, "unlimited"},
		{false, 1 << 20, 1 << 20, "up to 1.0 MB/s"},
	} {
		limit, text := uploadSetting(tc.noUpload, tc.rate)
		if limit != tc.limit || text != tc.text {
			t.Errorf("uploadSetting(%v, %d) = %d, %q; want %d, %q", tc.noUpload, tc.rate, limit, text, tc.limit, tc.text)
		}
	}
}
