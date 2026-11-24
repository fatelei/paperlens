package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type runtimePackage struct{ Name, Directory, URL, SHA256, Executable, Version string }

func runtimePackages(system, arch string) ([]runtimePackage, error) {
	const pyBase = "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/"
	const nodeBase = "https://nodejs.org/dist/v24.22.3/"
	python := runtimePackage{Name: "识别运行组件", Directory: "python-3.12.16-20261110", Version: "3.12.16"}
	node := runtimePackage{Name: "文档渲染组件", Directory: "node-24.22.3", Version: "v24.22.3"}
	switch system + "/" + arch {
	case "darwin/arm64":
		python.URL = pyBase + "cpython-3.12.16%2B20261110-aarch64-apple-darwin-install_only_stripped.tar.gz"
		python.SHA256 = "2f11b8aa3726bdbd87dd9eb76568412faddf4f47e26913fa45d6a2e424972acd"
		python.Executable = "python/bin/python3"
		node.URL = nodeBase + "node-v24.22.3-darwin-arm64.tar.gz"
		node.SHA256 = "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd"
		node.Executable = "node-v24.22.3-darwin-arm64/bin/node"
	case "windows/amd64":
		python.URL = pyBase + "cpython-3.12.16%2B20261110-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
		python.SHA256 = "355ee61b8207b91574491b1c6dc9b0ebb4408fc56bfafe498f3ef439314b52dc"
		python.Executable = "python/python.exe"
		node.URL = nodeBase + "node-v24.22.3-win-x64.zip"
		node.SHA256 = "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f"
		node.Executable = "node-v24.22.3-win-x64/node.exe"
	default:
		return nil, errors.New("当前平台暂不支持自动准备运行环境")
	}
	return []runtimePackage{python, node}, nil
}

// Ignore user Python overrides and never install into the system environment.
func isolatedRuntimeEnv() []string {
	var env []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		key = strings.ToUpper(key)
		if strings.HasPrefix(key, "PYTHON") || strings.HasPrefix(key, "PIP_") || key == "VIRTUAL_ENV" || key == "NODE_OPTIONS" || key == "NODE_PATH" {
			continue
		}
		env = append(env, entry)
	}
	return append(env, "PYTHONNOUSERSITE=1", "PYTHONUTF8=1", "PIP_CONFIG_FILE="+os.DevNull, "PIP_DISABLE_PIP_VERSION_CHECK=1")
}

func runtimeCommand(ctx context.Context, executable string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Env = isolatedRuntimeEnv()
	configureJevProcess(cmd)
	cmd.Cancel = func() error { killJevProcess(cmd); return nil }
	cmd.WaitDelay = 3 * time.Second
	return cmd
}

func runtimeComponentReady(root string, p runtimePackage) bool {
	var marker struct {
		SHA256 string `json:"sha256"`
	}
	b, err := os.ReadFile(filepath.Join(root, "installed.json"))
	return err == nil && json.Unmarshal(b, &marker) == nil && marker.SHA256 == p.SHA256 && regularFile(filepath.Join(root, filepath.FromSlash(p.Executable)))
}

func (a *App) managedRuntimePaths() (string, string) {
	packages, err := runtimePackages(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", ""
	}
	paths := make([]string, 2)
	for i, p := range packages {
		root := filepath.Join(a.configDir, "runtimes", p.Directory)
		if runtimeComponentReady(root, p) {
			paths[i] = filepath.Join(root, filepath.FromSlash(p.Executable))
		}
	}
	return paths[0], paths[1]
}

func verifiedArchive(path, digest string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return false
	}
	return hex.EncodeToString(h.Sum(nil)) == digest
}

func checkRuntime(ctx context.Context, root string, p runtimePackage) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	args := []string{"--version"}
	if strings.HasPrefix(p.Directory, "python-") {
		args = []string{"-I", "-c", "import sys,ssl,venv,ensurepip; print('.'.join(map(str,sys.version_info[:3])))"}
	}
	output, err := runtimeCommand(ctx, filepath.Join(root, filepath.FromSlash(p.Executable)), args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s启动检查失败：%w · %s", p.Name, err, output)
	}
	if strings.TrimSpace(string(output)) != p.Version {
		return fmt.Errorf("%s版本检查失败", p.Name)
	}
	return nil
}

func (a *App) installRuntimeComponent(ctx context.Context, p runtimePackage) error {
	root := filepath.Join(a.configDir, "runtimes")
	if info, err := os.Lstat(root); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("运行环境目录不能是符号链接")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	target := filepath.Join(root, p.Directory)
	if info, err := os.Lstat(target); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("运行组件目录不能是符号链接")
	}
	if runtimeComponentReady(target, p) {
		if err := checkRuntime(ctx, target, p); err == nil {
			return nil
		} else if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	archive := filepath.Join(root, p.Directory+".tar.gz")
	if strings.HasSuffix(p.URL, ".zip") {
		archive = filepath.Join(root, p.Directory+".zip")
	}
	if !verifiedArchive(archive, p.SHA256) {
		if err := a.download(ctx, p.URL, archive, p.SHA256, func(n, total int64) {
			var pct float64
			if total > 0 {
				pct = float64(n) / float64(total)
			}
			a.emit(fmt.Sprintf("正在下载%s · %.0f MB", p.Name, float64(n)/(1<<20)), pct)
		}); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(root, "unpack-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	a.emit("正在解压并检查"+p.Name, 0)
	if strings.HasSuffix(archive, ".zip") {
		err = extractZip(archive, stage)
	} else {
		err = extractTarGzip(archive, stage)
	}
	if err != nil {
		return fmt.Errorf("%s解压失败：%w", p.Name, err)
	}
	if err = checkRuntime(ctx, stage, p); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// Publish only fully extracted and executable components.
	if err = os.RemoveAll(target); err != nil {
		return err
	}
	if err = os.Rename(stage, target); err != nil {
		return err
	}
	marker, _ := json.Marshal(map[string]string{"sha256": p.SHA256, "version": p.Version})
	if err = atomicWrite(filepath.Join(target, "installed.json"), marker); err != nil {
		return err
	}
	a.emit(p.Name+"已就绪", 1)
	return nil
}

func (a *App) ensureSetupRuntime(ctx context.Context) error {
	packages, err := runtimePackages(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	a.mu.Lock()
	running := a.jevProcess != nil
	a.mu.Unlock()
	if running {
		return errors.New("请先停止核验服务，再准备运行环境")
	}
	for _, p := range packages {
		if err = a.installRuntimeComponent(ctx, p); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) InstallSetupRuntime() error {
	ctx, done, err := a.begin()
	if err != nil {
		return err
	}
	defer done()
	return a.ensureSetupRuntime(ctx)
}
