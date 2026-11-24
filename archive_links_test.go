package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTarLinkDependencies(t *testing.T) {
	for _, tc := range []struct {
		name  string
		links [][2]string
		valid bool
	}{
		{"forward chain", [][2]string{{"lib.dylib", "lib.0.dylib"}, {"lib.0.dylib", "lib.0.1.dylib"}}, true},
		{"cycle", [][2]string{{"a", "b"}, {"b", "a"}}, false},
		{"missing", [][2]string{{"a", "missing"}}, false},
		{"escaping chain", [][2]string{{"a", "b"}, {"b", "../outside"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			dest := filepath.Join(root, "extract")
			if err := os.Mkdir(dest, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "outside"), []byte("outside"), 0600); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, "archive.tar.gz")
			f, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			gz := gzip.NewWriter(f)
			tw := tar.NewWriter(gz)
			for _, l := range tc.links {
				if err := tw.WriteHeader(&tar.Header{Name: l[0], Typeflag: tar.TypeSymlink, Linkname: l[1]}); err != nil {
					t.Fatal(err)
				}
			}
			if err := tw.WriteHeader(&tar.Header{Name: "lib.0.1.dylib", Size: 4, Mode: 0755}); err != nil {
				t.Fatal(err)
			}
			if _, err := tw.Write([]byte("test")); err != nil {
				t.Fatal(err)
			}
			if err := tw.Close(); err != nil {
				t.Fatal(err)
			}
			if err := gz.Close(); err != nil {
				t.Fatal(err)
			}
			if err := f.Close(); err != nil {
				t.Fatal(err)
			}
			err = extractTarGzip(path, dest)
			if tc.valid {
				if err != nil {
					t.Fatal(err)
				}
				b, e := os.ReadFile(filepath.Join(dest, "lib.dylib"))
				if e != nil || string(b) != "test" {
					t.Fatalf("broken chain: %s %v", b, e)
				}
			} else if err == nil {
				t.Fatal("invalid links accepted")
			}
		})
	}
}

func TestOfficialEngineArchive(t *testing.T) {
	path := os.Getenv("PAPERLENS_TEST_ENGINE_ARCHIVE")
	if path == "" {
		t.Skip("opt-in official engine archive")
	}
	dest := t.TempDir()
	if err := extractTarGzip(path, dest); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "llama-b11901", "libggml.dylib")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := runtimeCommand(ctx, filepath.Join(dest, "llama-b11901", "llama-server"), "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("engine launch: %v\n%s", err, out)
	}
	t.Log(string(out))
}
