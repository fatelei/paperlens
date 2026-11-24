package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestDownloadResumesPartialAndVerifiesHash(t *testing.T) {
	payload := []byte("GGUF-model-test-content")
	sum := fmt.Sprintf("%x", sha256.Sum256(payload))
	dir := t.TempDir()
	path := filepath.Join(dir, "model.gguf")
	os.WriteFile(path+".part", payload[:5], 0600)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Range") != "bytes=5-" {
			t.Error("missing range", r.Header)
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 5-%d/%d", len(payload)-1, len(payload)))
		w.WriteHeader(206)
		w.Write(payload[5:])
	}))
	defer server.Close()
	a := NewApp()
	if e := a.download(context.Background(), server.URL, path, sum, func(int64, int64) {}); e != nil {
		t.Fatal(e)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(payload) {
		t.Fatal(string(got))
	}
	if _, e := os.Stat(path + ".part"); !os.IsNotExist(e) {
		t.Fatal("partial not renamed")
	}
}
func TestDownloadRejectsWrongRange(t *testing.T) {
	p := filepath.Join(t.TempDir(), "model")
	os.WriteFile(p+".part", []byte("prefix"), 0600)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Range", "bytes 0-3/4")
		w.WriteHeader(206)
		w.Write([]byte("data"))
	}))
	defer s.Close()
	if e := NewApp().download(context.Background(), s.URL, p, "", func(int64, int64) {}); e == nil {
		t.Fatal("wrong range accepted")
	}
}
func TestDownloadRejectsWrongDigest(t *testing.T) {
	p := filepath.Join(t.TempDir(), "model")
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("data")) }))
	defer s.Close()
	if e := NewApp().download(context.Background(), s.URL, p, "deadbeef", func(int64, int64) {}); e == nil {
		t.Fatal("bad digest accepted")
	}
	if _, e := os.Stat(p); !os.IsNotExist(e) {
		t.Fatal("bad download published")
	}
}
func TestTarTraversalAndLinks(t *testing.T) {
	for _, name := range []string{"../escape", "valid"} {
		dir := t.TempDir()
		p := filepath.Join(dir, "engine.tar.gz")
		f, _ := os.Create(p)
		gz := gzip.NewWriter(f)
		tw := tar.NewWriter(gz)
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0755, Size: 4})
		tw.Write([]byte("test"))
		tw.Close()
		gz.Close()
		f.Close()
		dest := filepath.Join(dir, "extract")
		os.Mkdir(dest, 0700)
		e := extractTarGzip(p, dest)
		if name == "valid" && e != nil {
			t.Fatal(e)
		}
		if name != "valid" && e == nil {
			t.Fatal("tar traversal accepted")
		}
	}
}

func TestDownloadRecoversCompletedOrCorruptPartial(t *testing.T) {
	for _, corrupt := range []bool{false, true} {
		t.Run(fmt.Sprint(corrupt), func(t *testing.T) {
			data := []byte("complete archive")
			sum := sha256.Sum256(data)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Range") != "" {
					w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
					return
				}
				w.Write(data)
			}))
			defer server.Close()
			target := filepath.Join(t.TempDir(), "archive")
			part := append([]byte{}, data...)
			if corrupt {
				part[0] = 'X'
			}
			if err := os.WriteFile(target+".part", part, 0600); err != nil {
				t.Fatal(err)
			}
			a := NewApp()
			if err := a.download(context.Background(), server.URL, target, fmt.Sprintf("%x", sum), func(int64, int64) {}); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(target)
			if err != nil || string(got) != string(data) {
				t.Fatal("partial recovery failed", err)
			}
		})
	}
}
