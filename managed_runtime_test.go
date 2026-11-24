package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestManagedRuntimeDoesNotUseSystemPath(t *testing.T) {
	a := NewApp()
	a.ctx = context.Background()
	a.configDir = t.TempDir()
	python, node := a.managedRuntimePaths()
	if python != "" || node != "" {
		t.Fatal("system runtimes counted as installed")
	}
	for _, platform := range [][2]string{{"darwin", "arm64"}, {"windows", "amd64"}} {
		specs, err := runtimePackages(platform[0], platform[1])
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range specs {
			if len(s.SHA256) != 64 || s.URL == "" || s.Executable == "" {
				t.Fatal("unpinned runtime")
			}
		}
	}
	if _, err := runtimePackages("linux", "amd64"); err == nil {
		t.Fatal("unsupported platform accepted")
	}
}

func TestManagedRuntimeLive(t *testing.T) {
	if os.Getenv("PAPERLENS_TEST_RUNTIME") != "1" {
		t.Skip("opt-in real runtime downloads")
	}
	if !(runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" || runtime.GOOS == "windows" && runtime.GOARCH == "amd64") {
		t.Skip("unsupported host")
	}
	a := NewApp()
	a.ctx = context.Background()
	a.configDir = t.TempDir()
	if d := os.Getenv("PAPERLENS_TEST_RUNTIME_DIR"); d != "" {
		a.configDir = d
	}
	t.Setenv("PATH", t.TempDir())
	t.Setenv("PYTHONHOME", "/invalid-user-python")
	t.Setenv("PYTHONPATH", "/invalid-user-packages")
	if err := a.InstallSetupRuntime(); err != nil {
		t.Fatal(err)
	}
	python, node := a.managedRuntimePaths()
	if python == "" || node == "" {
		t.Fatal("runtime not published")
	}
	if err := a.InstallSetupRuntime(); err != nil {
		t.Fatal("retry:", err)
	}
	venv := filepath.Join(a.configDir, "smoke-venv")
	if out, err := runtimeCommand(a.ctx, python, "-m", "venv", venv).CombinedOutput(); err != nil {
		t.Fatalf("venv: %v %s", err, out)
	}
	venvPython := filepath.Join(venv, "bin", "python")
	if runtime.GOOS == "windows" {
		venvPython = filepath.Join(venv, "Scripts", "python.exe")
	}
	if out, err := runtimeCommand(a.ctx, venvPython, "-m", "pip", "--version").CombinedOutput(); err != nil {
		t.Fatalf("pip: %v %s", err, out)
	}
	if out, err := runtimeCommand(a.ctx, node, "-e", "if(require('path').basename(process.execPath).indexOf('node')!==0)process.exit(1)").CombinedOutput(); err != nil {
		t.Fatalf("node: %v %s", err, out)
	}
	if os.Getenv("PAPERLENS_TEST_RENDER") == "1" {
		commands := [][]string{
			{"-m", "pip", "install", "-r", "local_jev/service/requirements.txt", "-r", "local_jev/service/sdk/requirements-score.txt", "rapid-layout==1.2.1", "onnxruntime>=1.20,<2"},
			{"-m", "playwright", "install", "chromium"},
			{"tests/runtime_smoke.py", filepath.Join(a.configDir, "render-smoke")},
		}
		for _, args := range commands {
			ctx, cancel := context.WithTimeout(a.ctx, 10*time.Minute)
			cmd := runtimeCommand(ctx, venvPython, args...)
			cmd.Env = append(cmd.Env, "PATH="+filepath.Dir(node), "PLAYWRIGHT_BROWSERS_PATH="+filepath.Join(a.configDir, "browsers"))
			output, err := cmd.CombinedOutput()
			cancel()
			if err != nil {
				t.Fatalf("managed renderer %v: %v\n%s", args, err, output)
			}
			t.Logf("passed managed runtime stage: %v", args)
		}
	}
	t.Log("App-owned Python, venv/pip and Node work without system PATH")
}

func TestRuntimeInstallRetryAndCancellation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell fixture; Windows uses real runtime smoke")
	}
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	content := []byte("#!/bin/sh\nprintf 'v-test\\n'\n")
	if err := tw.WriteHeader(&tar.Header{Name: "bin/node", Mode: 0755, Size: int64(len(content))}); err != nil {
		t.Fatal(err)
	}
	tw.Write(content)
	tw.Close()
	gz.Close()
	sum := sha256.Sum256(archive.Bytes())
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests++; w.Write(archive.Bytes()) }))
	defer server.Close()
	p := runtimePackage{Name: "fixture", Directory: "node-test", URL: server.URL + "/node.tar.gz", SHA256: hex.EncodeToString(sum[:]), Executable: "bin/node", Version: "v-test"}
	a := NewApp()
	a.ctx = context.Background()
	a.configDir = t.TempDir()
	if err := a.installRuntimeComponent(a.ctx, p); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(a.configDir, "runtimes", p.Directory)
	if !runtimeComponentReady(target, p) {
		t.Fatal("complete installation missing")
	}
	if err := os.Remove(filepath.Join(target, "bin/node")); err != nil {
		t.Fatal(err)
	}
	if runtimeComponentReady(target, p) {
		t.Fatal("missing executable accepted")
	}
	if err := a.installRuntimeComponent(a.ctx, p); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("downloaded complete archive again: %d", requests)
	}
	os.RemoveAll(target)
	ctx, cancel := context.WithCancel(a.ctx)
	cancel()
	if err := a.installRuntimeComponent(ctx, p); err == nil {
		t.Fatal("cancelled installation succeeded")
	}
	if runtimeComponentReady(target, p) {
		t.Fatal("cancelled install published")
	}
	p.Version = "wrong-version"
	if err := a.installRuntimeComponent(a.ctx, p); err == nil {
		t.Fatal("wrong runtime accepted")
	}
	if runtimeComponentReady(target, p) {
		t.Fatal("failed check published")
	}
}
