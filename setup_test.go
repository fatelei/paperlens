package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLocalJevMarkerAloneIsNotInstalled(t *testing.T) {
	a := NewApp()
	a.ctx = context.Background()
	a.configDir = t.TempDir()
	dir := a.localJevDir()
	os.MkdirAll(dir, 0700)
	os.WriteFile(filepath.Join(dir, "runtime.json"), []byte(`{"version":"0.2.0"}`), 0600)
	if a.LocalJevStatus().Installed {
		t.Fatal("a leftover marker must not hide deleted models or an incomplete install")
	}
}

func TestSetupCompletenessChecksActualAssets(t *testing.T) {
	a := NewApp()
	a.ctx = context.Background()
	a.configDir = t.TempDir()
	dir := a.localJevDir()
	put := func(name string) {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if e := os.MkdirAll(filepath.Dir(p), 0700); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(p, []byte("fixture"), 0600); e != nil {
			t.Fatal(e)
		}
	}
	python, engine := "venv/bin/python", "engine/llama-server"
	if runtime.GOOS == "windows" {
		python = "venv/Scripts/python.exe"
		engine = "engine/llama-server.exe"
	}
	names := []string{python, engine, "service/sdk/app.py", "node", "browser", "layout.onnx"}
	for _, name := range names {
		put(name)
	}
	marker, _ := json.Marshal(map[string]any{"version": "0.3.0", "node": filepath.Join(dir, "node")})
	os.WriteFile(filepath.Join(dir, "runtime.json"), marker, 0600)
	layout, _ := json.Marshal(map[string]any{"ready": true, "browser": filepath.Join(dir, "browser"), "layout": filepath.Join(dir, "layout.onnx")})
	os.WriteFile(filepath.Join(dir, "layout-ready.json"), layout, 0600)
	for _, m := range []struct {
		name string
		size int64
	}{{"MiniCPM-OCR-Jev-Q8_0.gguf", 2012021120}, {"mmproj-model-f16.gguf", 671372416}} {
		put("models/" + m.name)
		f, e := os.OpenFile(filepath.Join(dir, "models", m.name), os.O_RDWR, 0600)
		if e != nil {
			t.Fatal(e)
		}
		f.WriteAt([]byte("GGUF"), 0)
		if e = f.Truncate(m.size); e != nil {
			t.Fatal(e)
		}
		f.Close()
	}
	if !a.localJevInstalled() {
		t.Fatal("complete fixture rejected")
	}
	for _, name := range append(names, "models/MiniCPM-OCR-Jev-Q8_0.gguf", "models/mmproj-model-f16.gguf", "runtime.json", "layout-ready.json") {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if e := os.Rename(p, p+".saved"); e != nil {
			t.Fatal(e)
		}
		if a.localJevInstalled() {
			t.Errorf("missing %s accepted", name)
		}
		os.Rename(p+".saved", p)
	}
}
