package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLiveLocalJev(t *testing.T) {
	dir := os.Getenv("PAPERLENS_LIVE_JEV_CONFIG")
	if dir == "" {
		t.Skip("requires installed local Jev runtime")
	}
	a := NewApp()
	a.ctx = context.Background()
	a.configDir = dir
	a.settings = Settings{OCRURL: "http://127.0.0.1:18499", Model: "minicpm-ocr", JevURL: localJevURL, JevMode: "local"}
	if e := a.StartLocalJev(); e != nil {
		t.Fatal(e)
	}
	defer a.StopLocalJev()
	ready := false
	for deadline := time.Now().Add(180 * time.Second); time.Now().Before(deadline); {
		s := a.LocalJevStatus()
		if s.Ready {
			ready = true
			break
		}
		if !s.Running {
			t.Fatal("local service exited; inspect jev.log")
		}
		time.Sleep(time.Second)
	}
	if !ready {
		t.Fatal("local Jev not ready")
	}
	results := map[string]any{}
	// Official pre-rendered cases validate the engine/template independently of Mac fonts.
	for _, name := range []string{"01_text_putnam", "02_formula_putnam", "03_table_gb_standard"} {
		root := filepath.Join(dir, "local-jev", "service", "examples", name)
		b, e := os.ReadFile(filepath.Join(root, "case.json"))
		if e != nil {
			t.Fatal(e)
		}
		var c struct {
			ReferenceRenderOf string `json:"reference_render_of"`
			BlockImage        string `json:"block_image"`
			ReferenceRender   string `json:"reference_render"`
			Candidates        []struct {
				Role string `json:"role"`
				Text string `json:"text"`
			} `json:"candidates"`
			Observed map[string]float64 `json:"observed_prob_yes"`
		}
		if e = json.Unmarshal(b, &c); e != nil {
			t.Fatal(e)
		}
		text := ""
		for _, v := range c.Candidates {
			if v.Role == c.ReferenceRenderOf {
				text = v.Text
			}
		}
		files := []string{}
		for _, f := range []string{c.BlockImage, c.ReferenceRender} {
			b, e = os.ReadFile(filepath.Join(root, f))
			if e != nil {
				t.Fatal(e)
			}
			files = append(files, "data:image/png;base64,"+base64.StdEncoding.EncodeToString(b))
		}
		payload := map[string]any{"state": text, "files": files, "questions": map[string]any{"consistency": map[string]any{"type": "choice", "criteria": map[string]any{"0": nil, "1": nil}}}}
		var response struct {
			Answers map[string]struct {
				Probabilities map[string]float64 `json:"probabilities"`
			} `json:"answers"`
		}
		if e = a.post(a.ctx, "http://127.0.0.1:18519/v1/systemone", a.jevKey, payload, &response); e != nil {
			t.Fatal(e)
		}
		got, ok := response.Answers["consistency"].Probabilities["1"]
		if !ok {
			t.Fatal("missing classifier result")
		}
		ref := c.Observed[c.ReferenceRenderOf]
		results[name] = map[string]float64{"score": got, "reference": ref, "absoluteDifference": math.Abs(got - ref)}
		t.Logf("%s: %.6f reference %.6f", name, got, ref)
		if math.Abs(got-ref) > .02 {
			t.Errorf("%s reference difference >0.02", name)
		}
	}
	for _, tc := range []struct{ name, category string }{{"sample", "text"}, {"table", "table"}, {"formula", "formula"}} {
		b, e := os.ReadFile(filepath.Join("tests", "fixtures", tc.name+".png"))
		if e != nil {
			t.Fatal(e)
		}
		data := base64.StdEncoding.EncodeToString(b)
		ocr, e := a.Recognize(data, tc.category)
		if e != nil {
			t.Fatal(e)
		}
		r, e := a.Verify(data, ocr.Text, tc.category, "")
		if e != nil || r.Score == nil {
			t.Fatalf("%s: %+v %v", tc.name, r, e)
		}
		results[tc.name] = r
		t.Logf("%s %.6f", tc.name, *r.Score)
		if tc.name == "table" {
			bad, e := a.Verify(data, strings.ReplaceAll(ocr.Text, "128.00", "999.00"), tc.category, "")
			if e != nil || bad.Score == nil {
				t.Fatalf("wrong amount %+v %v", bad, e)
			}
			results["wrong_amount"] = bad
			t.Logf("wrong amount %.6f", *bad.Score)
			if *r.Score <= *bad.Score {
				t.Error("correct table must outrank wrong amount")
			}
		}
	}
	b, _ := json.MarshalIndent(map[string]any{"model": "MiniCPM-OCR-Jev-Q8_0", "engine": "b12435", "network": "loopback only", "testedAt": time.Now().Format(time.RFC3339), "cases": results}, "", "  ")
	os.MkdirAll("build/test-artifacts", 0755)
	os.WriteFile("build/test-artifacts/live-local-jev.json", b, 0644)
}
