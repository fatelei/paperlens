package main

import (
	"bufio"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Bundled installer and SDK make onboarding independent of a source checkout.
//
//go:embed local_jev/install.py all:local_jev/service
var setupAssets embed.FS

type SetupStatus struct {
	Supported    bool   `json:"supported"`
	Platform     string `json:"platform"`
	Python       string `json:"python"`
	Node         string `json:"node"`
	OCRModels    bool   `json:"ocrModels"`
	OCREngine    bool   `json:"ocrEngine"`
	Verification bool   `json:"verification"`
	Complete     bool   `json:"complete"`
	Directory    string `json:"directory"`
}

func regularFile(path string) bool {
	s, e := os.Stat(path)
	return e == nil && s.Mode().IsRegular() && s.Size() > 0
}

func (a *App) localJevInstalled() bool {
	python, node := a.managedRuntimePaths()
	return a.localJevInstalledForRuntime(python, node)
}
func sameExecutable(a, b string) bool {
	first, err := os.Stat(a)
	if err != nil {
		return false
	}
	second, err := os.Stat(b)
	return err == nil && os.SameFile(first, second)
}
func (a *App) localJevInstalledForRuntime(basePython, baseNode string) bool {
	dir := a.localJevDir()
	var manifest struct {
		Version string `json:"version"`
		Python  string `json:"python"`
		Node    string `json:"node"`
	}
	data, err := os.ReadFile(filepath.Join(dir, "runtime.json"))
	if err != nil || json.Unmarshal(data, &manifest) != nil || manifest.Version != "0.4.0" || !sameExecutable(manifest.Python, basePython) || !sameExecutable(manifest.Node, baseNode) {
		return false
	}
	for _, m := range []struct {
		name string
		size int64
	}{{"MiniCPM-OCR-Jev-Q8_0.gguf", 2012021120}, {"mmproj-model-f16.gguf", 671372416}} {
		if completeModel(filepath.Join(dir, "models", m.name), m.size) != nil {
			return false
		}
	}
	python, engine := "venv/bin/python", "engine/llama-server"
	if runtime.GOOS == "windows" {
		python = "venv/Scripts/python.exe"
		engine = "engine/llama-server.exe"
	}
	for _, name := range []string{python, engine, "service/sdk/app.py", "layout-ready.json"} {
		if !regularFile(filepath.Join(dir, filepath.FromSlash(name))) {
			return false
		}
	}
	var ready struct {
		Browser string `json:"browser"`
		Layout  string `json:"layout"`
		Ready   bool   `json:"ready"`
	}
	data, err = os.ReadFile(filepath.Join(dir, "layout-ready.json"))
	return err == nil && json.Unmarshal(data, &ready) == nil && ready.Ready && regularFile(ready.Browser) && regularFile(ready.Layout)
}

func (a *App) SetupStatus() SetupStatus {
	s := a.GetSettings()
	r := SetupStatus{Supported: runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" || runtime.GOOS == "windows" && runtime.GOARCH == "amd64", Platform: runtime.GOOS + "/" + runtime.GOARCH, Directory: a.configDir, OCRModels: true, OCREngine: regularFile(s.EnginePath), Verification: a.localJevInstalled()}
	r.Python, r.Node = a.managedRuntimePaths()
	for _, m := range modelFiles {
		if completeModel(filepath.Join(s.ModelDir, m.Name), m.Size) != nil {
			r.OCRModels = false
		}
	}
	r.Complete = r.Python != "" && r.Node != "" && r.OCRModels && r.OCREngine && r.Verification
	return r
}

func (a *App) InstallLocalJev() error {
	ctx, done, err := a.begin()
	if err != nil {
		return err
	}
	defer done()
	a.mu.Lock()
	running := a.jevProcess != nil
	a.mu.Unlock()
	if running {
		return errors.New("请先停止核验模型，再安装环境")
	}
	if err = a.ensureSetupRuntime(ctx); err != nil {
		return err
	}
	python, node := a.managedRuntimePaths()
	if err = os.MkdirAll(a.configDir, 0700); err != nil {
		return err
	}
	bundle, err := os.MkdirTemp(a.configDir, "setup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(bundle)
	err = fs.WalkDir(setupAssets, "local_jev", func(path string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		target := filepath.Join(bundle, filepath.FromSlash(strings.TrimPrefix(path, "local_jev")))
		if d.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		b, e := setupAssets.ReadFile(path)
		if e != nil {
			return e
		}
		return os.WriteFile(target, b, 0600)
	})
	if err != nil {
		return err
	}
	dir := a.localJevDir()
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(dir, "install.log"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.Command(python, filepath.Join(bundle, "install.py"))
	cmd.Dir = bundle
	cmd.Env = append(isolatedRuntimeEnv(), "PAPERLENS_DATA_DIR="+a.configDir, "PAPERLENS_NODE="+node, "PAPERLENS_MANAGED_RUNTIME=1", "PYTHONUNBUFFERED=1", "PATH="+filepath.Dir(node)+string(os.PathListSeparator)+filepath.Dir(python)+string(os.PathListSeparator)+os.Getenv("PATH"))
	configureJevProcess(cmd)
	reader, writer := io.Pipe()
	cmd.Stdout = io.MultiWriter(log, writer)
	cmd.Stderr = cmd.Stdout
	if err = cmd.Start(); err != nil {
		reader.Close()
		writer.Close()
		return err
	}
	scanned := make(chan struct{})
	go func() {
		defer close(scanned)
		defer reader.Close()
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "PAPERLENS_PROGRESS ") {
				var p struct {
					Message string  `json:"message"`
					Percent float64 `json:"percent"`
				}
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "PAPERLENS_PROGRESS ")), &p) == nil {
					a.emit(p.Message, p.Percent)
				}
			}
		}
	}()
	exited := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			killJevProcess(cmd)
		case <-exited:
		}
	}()
	err = cmd.Wait()
	close(exited)
	writer.Close()
	<-scanned
	if ctx.Err() != nil {
		return errors.New("安装已取消；已完成的下载已保留，点击继续安装可重试")
	}
	if err != nil {
		return fmt.Errorf("核验环境安装失败：%w。可重试，详细日志：%s", err, filepath.Join(dir, "install.log"))
	}
	if !a.localJevInstalled() {
		return errors.New("安装未通过完整性检查，请重试")
	}
	a.emit("核验与版面分析环境安装完成", 1)
	return nil
}

func (a *App) CheckSetupRuntime() error {
	ctx, done, err := a.begin()
	if err != nil {
		return err
	}
	defer done()
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	dir := a.localJevDir()
	python := filepath.Join(dir, "venv", "bin", "python")
	if runtime.GOOS == "windows" {
		python = filepath.Join(dir, "venv", "Scripts", "python.exe")
	}
	cmd := exec.CommandContext(ctx, python, "-c", `from rapid_layout import RapidLayout
from playwright.sync_api import sync_playwright
from PIL import Image
layout=RapidLayout(model_type='doclayout_docstructbench')
layout(Image.new('RGB',(320,320),'white'))
with sync_playwright() as p:
    b=p.chromium.launch(headless=True)
    page=b.new_page()
    page.set_content('<p>PaperLens setup check</p>')
    assert page.locator('p').inner_text()=='PaperLens setup check'
    b.close()
`)
	cmd.Env = append(isolatedRuntimeEnv(), "PLAYWRIGHT_BROWSERS_PATH="+filepath.Join(dir, "browsers"))
	configureJevProcess(cmd)
	cmd.Cancel = func() error { killJevProcess(cmd); return nil }
	cmd.WaitDelay = 3 * time.Second
	if output, err := cmd.CombinedOutput(); err != nil {
		if len(output) > 2000 {
			output = output[len(output)-2000:]
		}
		return fmt.Errorf("版面 / 渲染检查失败：%w · %s", err, output)
	}
	return nil
}
