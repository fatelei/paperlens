package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func pixel() string {
	var b bytes.Buffer
	_ = png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 20, 20)))
	return base64.StdEncoding.EncodeToString(b.Bytes())
}
func testApp(server *httptest.Server) *App {
	a := NewApp()
	a.ctx = context.Background()
	a.settings = Settings{OCRURL: server.URL, Model: "minicpm-ocr", JevURL: server.URL + "/v1/chat/completions", JevMode: "local", JevModel: "MiniCPM-OCR-Jev"}
	return a
}

func TestEndpoints(t *testing.T) {
	for _, raw := range []string{"http://127.0.0.1:18499", "http://[::1]:9000", "http://localhost:8888"} {
		if _, e := endpoint(raw, true); e != nil {
			t.Error(e)
		}
	}
	for _, raw := range []string{"https://evil.example", "file:///etc/passwd", "http://127.0.0.1.evil.example", "http://name:secret@localhost", "http://localhost?q=secret"} {
		if _, e := endpoint(raw, true); e == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	if _, e := endpoint("http://remote.example/v1", false); e == nil {
		t.Fatal("plaintext cloud endpoint accepted")
	}
	if _, e := endpoint("https://api.modelbest.cn/v1/chat/completions", false); e != nil {
		t.Fatal(e)
	}
}

func TestScores(t *testing.T) {
	for _, s := range []string{"0", "0.93", "1"} {
		r, e := parseScore([]byte(`{"results":[{"verdict":"scored","prob_yes":` + s + `}]}`))
		if e != nil || r.Score == nil {
			t.Fatal(s, r, e)
		}
	}
	for _, s := range []string{"-1", "1.1", "null"} {
		if _, e := parseScore([]byte(`{"results":[{"verdict":"scored","prob_yes":` + s + `}]}`)); e == nil {
			t.Fatal("invalid score accepted", s)
		}
	}
	r, e := parseScore([]byte(`{"results":[{"verdict":"render_error","prob_yes":0,"detail":"invalid HTML"}]}`))
	if e != nil || r.Score != nil || r.Verdict != "render_error" {
		t.Fatal(r, e)
	}
	for _, s := range []string{`{}`, `{"results":[]}`, `{"results":[{},{}]}`, `bad json`} {
		if _, e := parseScore([]byte(s)); e == nil {
			t.Fatal("invalid response accepted", s)
		}
	}
}

func TestOCRAndTruncation(t *testing.T) {
	truncated := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path %s", r.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "minicpm-ocr" {
			t.Error(body)
		}
		reason := "stop"
		if truncated {
			reason = "length"
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": "总计：128.00"}, "finish_reason": reason}}})
	}))
	defer server.Close()
	a := testApp(server)
	r, e := a.Recognize(pixel(), "text")
	if e != nil || r.Text != "总计：128.00" {
		t.Fatal(r, e)
	}
	truncated = true
	if _, e = a.Recognize(pixel(), "page"); e == nil {
		t.Fatal("truncated output accepted")
	}
	if _, e = a.Recognize("not base64", "text"); e == nil {
		t.Fatal("invalid image accepted")
	}
}

func TestLocalJevProtocol(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer local-session" {
			t.Error("missing local session auth")
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["input_form"] != "ternary" {
			t.Error("wrong local payload")
		}
		w.Write([]byte(`{"results":[{"verdict":"scored","prob_yes":0.937}]}`))
	}))
	defer server.Close()
	a := testApp(server)
	a.jevKey = "local-session"
	r, e := a.Verify(pixel(), "金额 128", "text", "")
	if e != nil || r.Score == nil || *r.Score != .937 {
		t.Fatal(r, e)
	}
	if _, e = a.Verify(pixel(), "mixed page", "page", ""); e == nil {
		t.Fatal("mixed page accepted")
	}
	a.settings.JevURL = "https://api.typesafe.ai/v1/systemone"
	if _, e = a.Verify(pixel(), "text", "text", ""); e == nil {
		t.Fatal("remote verification allowed")
	}
}

func TestDockerFailures(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		if b["input_form"] != "ternary" {
			t.Error(b)
		}
		ioBody := `{"results":[{"verdict":"forward_error","prob_yes":-1,"detail":"not ready"}]}`
		w.Write([]byte(ioBody))
	}))
	defer server.Close()
	a := testApp(server)
	a.settings.JevMode = "local"
	r, e := a.Verify(pixel(), "text", "text", "")
	if e != nil || r.Score != nil || r.Verdict != "forward_error" {
		t.Fatal(r, e)
	}
}

func TestCancelAndNoConcurrentJobs(t *testing.T) {
	arrived := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(arrived)
		<-r.Context().Done()
	}))
	defer server.Close()
	a := testApp(server)
	done := make(chan error)
	go func() { _, e := a.Recognize(pixel(), "text"); done <- e }()
	select {
	case <-arrived:
	case <-time.After(time.Second):
		t.Fatal("request never started")
	}
	if _, e := a.Recognize(pixel(), "text"); e == nil {
		t.Fatal("concurrent job accepted")
	}
	a.Cancel()
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("cancel was ignored")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel timeout")
	}
}

func TestRedirectDoesNotLeakKey(t *testing.T) {
	called := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer redirect.Close()
	a := testApp(redirect)
	_, e := a.Verify(pixel(), "text", "text", "secret")
	if e == nil || called {
		t.Fatal("redirect followed", e)
	}
}

func TestHTTPErrorDoesNotExposeResponseSecrets(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte("secret-key sensitive-content"))
	}))
	defer s.Close()
	a := testApp(s)
	_, e := a.Verify(pixel(), "secret text", "text", "secret-key")
	if e == nil || strings.Contains(e.Error(), "secret") {
		t.Fatal(e)
	}
}

func TestArchiveTraversalRejected(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "bad.zip")
	f, _ := os.Create(archive)
	z := zip.NewWriter(f)
	w, _ := z.Create("../escape")
	w.Write([]byte("bad"))
	z.Close()
	f.Close()
	if e := extractZip(archive, filepath.Join(dir, "engine")); e == nil {
		t.Fatal("zip traversal accepted")
	}
}
func TestModelHeader(t *testing.T) {
	p := filepath.Join(t.TempDir(), "model.gguf")
	os.WriteFile(p, []byte("<html>error"), 0600)
	if validGGUF(p) == nil {
		t.Fatal("HTML accepted as model")
	}
	os.WriteFile(p, []byte("GGUFtest"), 0600)
	if e := validGGUF(p); e != nil {
		t.Fatal(e)
	}
}
