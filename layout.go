package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
)

//go:embed local_jev/layout.py
var layoutScript string

type LayoutRegion struct {
	BBox       [4]int  `json:"bbox"`
	Category   string  `json:"category"`
	Label      string  `json:"label"`
	Confidence float64 `json:"confidence"`
	Recovered  bool    `json:"recovered"`
}
type LayoutResult struct {
	CoverageChecked bool           `json:"coverageChecked"`
	Regions         []LayoutRegion `json:"regions"`
	Model           string         `json:"model"`
	Width           int            `json:"width"`
	Height          int            `json:"height"`
}

func (a *App) DetectLayout(data string) (LayoutResult, error) {
	var result LayoutResult
	if err := validateImage(data); err != nil {
		return result, err
	}
	ctx, done, err := a.begin()
	if err != nil {
		return result, err
	}
	defer done()
	python := filepath.Join(a.localJevDir(), "venv", "bin", "python")
	if runtime.GOOS == "windows" {
		python = filepath.Join(a.localJevDir(), "venv", "Scripts", "python.exe")
	}
	cmd := runtimeCommand(ctx, python, "-c", layoutScript)
	cmd.Stdin = bytes.NewBufferString(data)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err = cmd.Run(); err != nil {
		return result, fmt.Errorf("本地版面分析失败，请检查 rapid-layout 安装：%w；%s", err, stderr.String())
	}
	if err = json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return result, fmt.Errorf("版面结果无效：%w", err)
	}
	if len(result.Regions) == 0 {
		return result, fmt.Errorf("未找到可识别区域")
	}
	return result, nil
}
