package main

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

//go:embed local_jev/bootstrap.py
var localJevBootstrap []byte

const localJevURL = "http://127.0.0.1:18520/v1/rm/score"

type LocalJevStatus struct {
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
	Ready     bool   `json:"ready"`
	Directory string `json:"directory"`
}

func (a *App) localJevDir() string { return filepath.Join(a.configDir, "local-jev") }
func (a *App) LocalJevStatus() LocalJevStatus {
	dir := a.localJevDir()
	r := LocalJevStatus{Installed: a.localJevInstalled(), Directory: dir}
	a.mu.Lock()
	r.Running = a.jevProcess != nil
	a.mu.Unlock()
	if !r.Running {
		return r
	}
	ctx, cancel := context.WithTimeout(a.ctx, 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:18520/healthz", nil)
	resp, err := a.client.Do(req)
	if err != nil {
		return r
	}
	defer resp.Body.Close()
	var health struct {
		Status string `json:"status"`
	}
	if resp.StatusCode == 200 && json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&health) == nil {
		r.Ready = health.Status == "ok"
	}
	return r
}
func (a *App) StartLocalJev() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.jevProcess != nil {
		return nil
	}
	if a.busy {
		return errors.New("请等待当前任务完成后启动核验模型")
	}
	dir := a.localJevDir()
	for _, m := range []struct {
		name string
		size int64
	}{{"MiniCPM-OCR-Jev-Q8_0.gguf", 2012021120}, {"mmproj-model-f16.gguf", 671372416}} {
		if err := completeModel(filepath.Join(dir, "models", m.name), m.size); err != nil {
			return errors.New("本地核验模型未安装完整，请打开首次安装引导")
		}
	}
	python := filepath.Join(dir, "venv", "bin", "python")
	if runtime.GOOS == "windows" {
		python = filepath.Join(dir, "venv", "Scripts", "python.exe")
	}
	if _, err := os.Stat(python); err != nil {
		return errors.New("核验运行环境尚未安装，请打开首次安装引导")
	}
	for _, addr := range []string{"127.0.0.1:18519", "127.0.0.1:18520"} {
		c, e := net.Listen("tcp", addr)
		if e != nil {
			return errors.New("本地核验端口已被占用，请关闭另一个核验服务")
		}
		c.Close()
	}
	if err := atomicWrite(filepath.Join(dir, "bootstrap.py"), localJevBootstrap); err != nil {
		return err
	}
	keyBytes := make([]byte, 32)
	if _, err := rand.Read(keyBytes); err != nil {
		return err
	}
	key := hex.EncodeToString(keyBytes)
	cmd := exec.Command(python, filepath.Join(dir, "bootstrap.py"), dir)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "PAPERLENS_LOCAL_JEV_TOKEN="+key, "PYTHONUNBUFFERED=1", "NO_PROXY=127.0.0.1,localhost", "no_proxy=127.0.0.1,localhost")
	if a.settings.CPUOnly {
		cmd.Env = append(cmd.Env, "PAPERLENS_JEV_CPU=1")
	}
	configureJevProcess(cmd)
	log, err := os.OpenFile(filepath.Join(dir, "jev.log"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	cmd.Stdout = log
	cmd.Stderr = log
	if err = cmd.Start(); err != nil {
		log.Close()
		return err
	}
	a.jevProcess = cmd
	a.jevKey = key
	a.jevDone = make(chan struct{})
	done := a.jevDone
	go func() {
		err := cmd.Wait()
		log.Close()
		a.mu.Lock()
		if a.jevProcess == cmd {
			a.jevProcess = nil
			a.jevKey = ""
		}
		a.mu.Unlock()
		close(done)
		if err != nil {
			a.emit("本地核验服务退出，请查看 local-jev/jev.log", 0)
		}
	}()
	return nil
}
func (a *App) StopLocalJev() error {
	a.mu.Lock()
	cmd, done := a.jevProcess, a.jevDone
	a.mu.Unlock()
	if cmd == nil {
		return nil
	}
	if err := stopJevProcess(cmd); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	select {
	case <-done:
		return nil
	case <-time.After(12 * time.Second):
		killJevProcess(cmd)
		<-done
		return nil
	}
}
