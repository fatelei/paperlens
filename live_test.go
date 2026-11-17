package main

import (
	"context"
	"encoding/base64"

	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Opt-in: runs the actual downloaded MiniCPM-OCR model, not a mock server.
func TestLiveOCR(t *testing.T) {
	addr := os.Getenv("PAPERLENS_LIVE_OCR_URL")
	if addr == "" {
		t.Skip("set PAPERLENS_LIVE_OCR_URL to test real inference")
	}
	a := NewApp()
	a.ctx = context.Background()
	a.settings = Settings{OCRURL: addr, Model: "minicpm-ocr"}
	for _, tc := range []struct {
		name, category string
		want           []string
	}{{"sample", "text", []string{"PaperLens", "128.00"}}, {"table", "table", []string{"<table", "128"}}, {"formula", "formula", []string{"mc"}}} {
		t.Run(tc.name, func(t *testing.T) {
			b, e := os.ReadFile(filepath.Join("tests", "fixtures", tc.name+".png"))
			if e != nil {
				t.Fatal(e)
			}
			result, e := a.Recognize(base64.StdEncoding.EncodeToString(b), tc.category)
			if e != nil {
				t.Fatal(e)
			}
			for _, want := range tc.want {
				if !strings.Contains(strings.Join(strings.Fields(result.Text), ""), want) {
					t.Errorf("missing %q in %s", want, result.Text)
				}
			}
			os.MkdirAll("build/test-artifacts", 0755)
			os.WriteFile(filepath.Join("build/test-artifacts", "real-"+tc.name+".txt"), []byte(result.Text), 0644)
			t.Log(result.Text)
		})
	}
}

func TestLiveManagedEngine(t *testing.T) {
	engine := os.Getenv("PAPERLENS_LIVE_ENGINE")
	models := os.Getenv("PAPERLENS_LIVE_MODELS")
	if engine == "" || models == "" {
		t.Skip("set engine and model directory for managed lifecycle test")
	}
	a := NewApp()
	a.ctx = context.Background()
	a.configDir = t.TempDir()
	a.settings = Settings{OCRURL: "http://127.0.0.1:18509", Model: "minicpm-ocr", EnginePath: engine, ModelDir: models}
	if e := a.StartEngine(); e != nil {
		t.Fatal(e)
	}
	defer a.StopEngine()
	ready := false
	for deadline := time.Now().Add(90 * time.Second); time.Now().Before(deadline); {
		if a.EngineStatus().Ready {
			ready = true
			break
		}
		time.Sleep(time.Second)
	}
	if !ready {
		t.Fatal("managed engine did not become ready")
	}
	b, e := os.ReadFile("tests/fixtures/sample.png")
	if e != nil {
		t.Fatal(e)
	}
	r, e := a.Recognize(base64.StdEncoding.EncodeToString(b), "text")
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(r.Text, "128.00") {
		t.Fatal("managed engine OCR mismatch")
	}
	if e = a.StopEngine(); e != nil {
		t.Fatal(e)
	}
	if a.EngineStatus().Running {
		t.Fatal("engine still running")
	}
}
