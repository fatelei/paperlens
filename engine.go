package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"
)

const engineRelease = "b11901"

var modelFiles = []struct {
	Name, Repo, SHA256 string
	Size               int64
}{
	{"MiniCPM-OCR-1_0-Q8_0.gguf", "MiniCPM-OCR-1.0-gguf", "791486a476bdacb48acb3f31aa3a18dbb5be87e723a4074bcd13a37d61c852e2", 811598432},
	{"mmproj-model-f16-4x.gguf", "MiniCPM-OCR-1.0-gguf", "ceed82261b3b1380c3165f8b37c10117a50093be1362cbfeeb692fa036444682", 901017536},
	{"dspark-MiniCPM-OCR-1_0-Q8_0.gguf", "MiniCPM-OCR-1.0-DSpark-gguf", "fd8f64bb62cf5a5c6b4c0999bfa58f64453690c9f75f1124ab613dfb44a822da", 327293024},
}

func completeModel(path string, size int64) error {
	stat, err := os.Stat(path)
	if err != nil {
		return err
	}
	if stat.Size() != size {
		return errors.New("模型文件大小不完整")
	}
	return validGGUF(path)
}

type EngineStatus struct {
	Running  bool     `json:"running"`
	Ready    bool     `json:"ready"`
	Files    []string `json:"files"`
	Missing  []string `json:"missing"`
	Engine   string   `json:"engine"`
	Platform string   `json:"platform"`
}

func (a *App) EngineStatus() EngineStatus {
	s := a.GetSettings()
	result := EngineStatus{Files: []string{}, Missing: []string{}, Engine: s.EnginePath, Platform: goruntime.GOOS + "/" + goruntime.GOARCH}
	for _, m := range modelFiles {
		if completeModel(filepath.Join(s.ModelDir, m.Name), m.Size) == nil {
			result.Files = append(result.Files, m.Name)
		} else {
			result.Missing = append(result.Missing, m.Name)
		}
	}
	a.mu.Lock()
	result.Running = a.process != nil
	a.mu.Unlock()
	u, err := endpoint(s.OCRURL, true)
	if err != nil {
		return result
	}
	ctx, cancel := context.WithTimeout(a.ctx, 1500*time.Millisecond)
	defer cancel()
	addr := strings.TrimSuffix(strings.TrimRight(u.String(), "/"), "/v1") + "/health"
	req, _ := http.NewRequestWithContext(ctx, "GET", addr, nil)
	resp, err := a.client.Do(req)
	if err == nil {
		defer resp.Body.Close()
		result.Ready = resp.StatusCode == 200
	}
	return result
}

func validGGUF(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var magic [4]byte
	if _, err = io.ReadFull(f, magic[:]); err != nil {
		return err
	}
	if string(magic[:]) != "GGUF" {
		return errors.New("文件不是 GGUF 模型")
	}
	return nil
}

func (a *App) DownloadModels(source string) error {
	if source != "modelscope" && source != "huggingface" {
		return errors.New("未知下载源")
	}
	ctx, done, err := a.begin()
	if err != nil {
		return err
	}
	defer done()
	s := a.GetSettings()
	if err = os.MkdirAll(s.ModelDir, 0700); err != nil {
		return err
	}
	for i, m := range modelFiles {
		path := filepath.Join(s.ModelDir, m.Name)
		if completeModel(path, m.Size) == nil {
			a.emit("已存在："+m.Name, float64(i+1)/3)
			continue
		}
		addr := "https://modelscope.cn/models/OpenBMB/" + m.Repo + "/resolve/master/" + m.Name
		if source == "huggingface" {
			addr = "https://huggingface.co/openbmb/" + m.Repo + "/resolve/main/" + m.Name
		}
		if err = a.download(ctx, addr, path, m.SHA256, func(n, total int64) {
			p := float64(i) / 3
			if total > 0 {
				p += float64(n) / float64(total) / 3
			}
			a.emit(fmt.Sprintf("下载 %s · %.0f MB", m.Name, float64(n)/(1<<20)), p)
		}); err != nil {
			return err
		}
		if err = completeModel(path, m.Size); err != nil {
			os.Remove(path)
			return fmt.Errorf("%s 校验失败：%w", m.Name, err)
		}
	}
	a.emit("三个模型文件已下载", 1)
	return nil
}

func (a *App) download(ctx context.Context, addr, path, digest string, progress func(int64, int64)) error {
	part := path + ".part"
	var offset int64
	if stat, err := os.Lstat(part); err == nil {
		if !stat.Mode().IsRegular() {
			return errors.New("下载临时路径不是普通文件")
		}
		offset = stat.Size()
	} else if !os.IsNotExist(err) {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", addr, nil)
	if err != nil {
		return err
	}
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	client := &http.Client{Timeout: 90 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("下载失败，已保留进度：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable && offset > 0 {
		resp.Body.Close()
		if digest != "" && verifiedArchive(part, strings.TrimPrefix(digest, "sha256:")) {
			return os.Rename(part, path)
		}
		if err = os.Remove(part); err != nil {
			return err
		}
		return a.download(ctx, addr, path, digest, progress)
	}
	if resp.StatusCode != 200 && resp.StatusCode != 206 {
		return fmt.Errorf("下载失败 HTTP %d，已保留进度", resp.StatusCode)
	}
	total := resp.ContentLength
	if resp.StatusCode == 206 {
		var start, end int64
		if _, err = fmt.Sscanf(resp.Header.Get("Content-Range"), "bytes %d-%d/%d", &start, &end, &total); err != nil || start != offset || end < start {
			return errors.New("服务器返回了错误的下载范围")
		}
	} else {
		offset = 0
	}
	flags := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flags |= os.O_TRUNC
	} else {
		flags |= os.O_APPEND
	}
	f, err := os.OpenFile(part, flags, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	hash := sha256.New()
	if offset > 0 {
		prefix, err := os.Open(part)
		if err != nil {
			return err
		}
		_, err = io.CopyN(hash, prefix, offset)
		prefix.Close()
		if err != nil {
			return err
		}
	}
	writer := io.MultiWriter(f, hash)
	buf := make([]byte, 256*1024)
	n := offset
	last := time.Time{}
	for {
		nr, e := resp.Body.Read(buf)
		if nr > 0 {
			if _, err = writer.Write(buf[:nr]); err != nil {
				return err
			}
			n += int64(nr)
			if n > 8<<30 {
				return errors.New("下载超出大小限制")
			}
			if time.Since(last) > 300*time.Millisecond {
				progress(n, total)
				last = time.Now()
			}
		}
		if e == io.EOF {
			break
		}
		if e != nil {
			return fmt.Errorf("下载中断，点击下载可继续：%w", e)
		}
	}
	if err = f.Close(); err != nil {
		return err
	}
	if total >= 0 && n != total {
		return errors.New("下载不完整，已保留进度，可再次点击下载继续")
	}
	if digest != "" && !strings.EqualFold(strings.TrimPrefix(digest, "sha256:"), hex.EncodeToString(hash.Sum(nil))) {
		os.Remove(part)
		return errors.New("SHA256 校验失败，请重新下载")
	}
	progress(n, n)
	return os.Rename(part, path)
}

func (a *App) InstallEngine() error {
	ctx, done, err := a.begin()
	if err != nil {
		return err
	}
	defer done()
	a.mu.Lock()
	running := a.process != nil
	a.mu.Unlock()
	if running {
		return errors.New("请先停止引擎")
	}
	platform := ""
	if goruntime.GOOS == "darwin" && goruntime.GOARCH == "arm64" {
		platform = "macos-arm64"
	}
	if goruntime.GOOS == "darwin" && goruntime.GOARCH == "amd64" {
		platform = "macos-x64"
	}
	if goruntime.GOOS == "windows" && goruntime.GOARCH == "amd64" {
		platform = "win-cpu-x64"
	}
	if platform == "" {
		return errors.New("当前平台需手动选择兼容的 llama-server")
	}
	assets := map[string]struct{ Name, Digest string }{
		"macos-arm64": {"llama-b11901-bin-macos-arm64.tar.gz", "dde35fc01722157f31af2c3a6e859e971427deb8e65b9e038606fcc9c44ce79c"},
		"macos-x64":   {"llama-b11901-bin-macos-x64.tar.gz", "44e20ca54d93ae3987272ca2631a7f4b9d3745962654ddfd89ff9e9a21f606aa"},
		"win-cpu-x64": {"llama-b11901-bin-win-cpu-x64.zip", "039951745399d7c1228b1e882d6e41b24d393f1795e3a6e176162bfb8193500a"},
	}
	asset := assets[platform]
	root := filepath.Join(a.configDir, "engine", engineRelease)
	if err = os.MkdirAll(root, 0700); err != nil {
		return err
	}
	dir, err := os.MkdirTemp(root, "install-")
	if err != nil {
		return err
	}
	success := false
	defer func() {
		if !success {
			os.RemoveAll(dir)
		}
	}()
	archive := filepath.Join(dir, asset.Name)
	addr := "https://github.com/ggml-org/llama.cpp/releases/download/" + engineRelease + "/" + asset.Name
	err = a.download(ctx, addr, archive, asset.Digest, func(n, total int64) {
		p := 0.0
		if total > 0 {
			p = float64(n) / float64(total)
		}
		a.emit("下载推理引擎", p)
	})
	if err != nil {
		return err
	}
	if strings.HasSuffix(archive, ".zip") {
		err = extractZip(archive, dir)
	} else {
		err = extractTarGzip(archive, dir)
	}
	if err != nil {
		return err
	}
	os.Remove(archive)
	executable := "llama-server"
	if goruntime.GOOS == "windows" {
		executable += ".exe"
	}
	found := ""
	err = filepath.WalkDir(dir, func(path string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if !d.IsDir() && d.Name() == executable {
			found = path
		}
		return nil
	})
	if err != nil {
		return err
	}
	if found == "" {
		return errors.New("安装包中没有 llama-server")
	}
	a.mu.Lock()
	updated := a.settings
	updated.EnginePath = found
	if goruntime.GOOS == "windows" {
		updated.CPUOnly = true
	}
	b, e := json.MarshalIndent(updated, "", "  ")
	if e == nil {
		e = atomicWrite(filepath.Join(a.configDir, "settings.json"), b)
	}
	if e == nil {
		a.settings = updated
	}
	a.mu.Unlock()
	if e != nil {
		return e
	}
	success = true
	a.emit("引擎已安装", 1)
	return nil
}

func extractZip(archive, dir string) error {
	r, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer r.Close()
	var total uint64
	for _, entry := range r.File {
		name := filepath.FromSlash(entry.Name)
		target := filepath.Join(dir, name)
		rel, err := filepath.Rel(dir, target)
		if err != nil || filepath.IsAbs(name) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.Contains(entry.Name, "\\") || strings.Contains(entry.Name, ":") {
			return errors.New("安装包包含不安全路径")
		}
		if entry.Mode()&os.ModeSymlink != 0 {
			return errors.New("安装包包含符号链接，请手动安装")
		}
		total += entry.UncompressedSize64
		if total > 3<<30 {
			return errors.New("引擎解压体积超过限制")
		}
		if entry.FileInfo().IsDir() {
			if err = os.MkdirAll(target, 0755); err != nil {
				return err
			}
			continue
		}
		if err = os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		in, err := entry.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
		if err != nil {
			in.Close()
			return err
		}
		_, err = io.Copy(out, io.LimitReader(in, 3<<30))
		in.Close()
		closeErr := out.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func extractTarGzip(archive, dir string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	var total int64
	type link struct{ path, target string }
	links := []link{}
	for {
		header, e := reader.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return e
		}
		name := filepath.FromSlash(header.Name)
		target := filepath.Join(dir, name)
		rel, e := filepath.Rel(dir, target)
		if e != nil || filepath.IsAbs(name) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.Contains(header.Name, "\\") {
			return errors.New("引擎归档包含不安全路径")
		}
		total += header.Size
		if total > 3<<30 {
			return errors.New("解压大小超过限制")
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if e = os.MkdirAll(target, 0755); e != nil {
				return e
			}
		case tar.TypeReg, tar.TypeRegA:
			if e = os.MkdirAll(filepath.Dir(target), 0755); e != nil {
				return e
			}
			out, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
			if e != nil {
				return e
			}
			_, e = io.Copy(out, reader)
			ce := out.Close()
			if e != nil {
				return e
			}
			if ce != nil {
				return ce
			}
		case tar.TypeSymlink:
			links = append(links, link{target, header.Linkname})
		default:
			return errors.New("引擎归档包含不支持的文件类型")
		}
	}
	// Create links after all regular files so archive paths cannot write through links.
	for _, l := range links {
		if filepath.IsAbs(l.target) {
			return errors.New("引擎包含绝对符号链接")
		}
		resolved, e := filepath.EvalSymlinks(filepath.Join(filepath.Dir(l.path), l.target))
		if e != nil {
			return e
		}
		rel, e := filepath.Rel(dir, resolved)
		if e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return errors.New("引擎链接超出安装目录")
		}
		if e = os.Symlink(l.target, l.path); e != nil {
			return e
		}
	}
	return nil
}

func (a *App) StartEngine() error {
	a.mu.Lock()
	if a.process != nil || a.busy {
		a.mu.Unlock()
		return errors.New("引擎或其他任务正在运行")
	}
	s := a.settings
	a.mu.Unlock()
	if s.EnginePath == "" {
		return errors.New("请先安装或选择 llama-server 引擎")
	}
	for _, m := range modelFiles {
		if err := completeModel(filepath.Join(s.ModelDir, m.Name), m.Size); err != nil {
			return fmt.Errorf("请先下载模型 %s", m.Name)
		}
	}
	u, err := endpoint(s.OCRURL, true)
	if err != nil {
		return err
	}
	if u.Hostname() != "127.0.0.1" {
		return errors.New("托管引擎地址请使用 http://127.0.0.1:端口")
	}
	port := u.Port()
	if port == "" {
		return errors.New("请在 OCR 地址中指定端口")
	}
	layers := "99"
	if s.CPUOnly {
		layers = "0"
	}
	keyBytes := make([]byte, 32)
	if _, err = rand.Read(keyBytes); err != nil {
		return err
	}
	key := hex.EncodeToString(keyBytes)
	args := []string{"--model", filepath.Join(s.ModelDir, modelFiles[0].Name), "--mmproj", filepath.Join(s.ModelDir, modelFiles[1].Name), "--model-draft", filepath.Join(s.ModelDir, modelFiles[2].Name), "--spec-type", "draft-dspark", "--spec-draft-n-max", "15", "--n-gpu-layers", layers, "--gpu-layers-draft", layers, "--flash-attn", "on", "--ctx-size", "16384", "--parallel", "1", "--host", "127.0.0.1", "--port", port, "--alias", s.Model, "--jinja", "--reasoning", "off"}
	if s.CPUOnly {
		args = append(args, "--no-mmproj-offload")
	}
	args = append(args, "--api-key", key, "--no-webui", "--no-slots", "--cors-origins", "http://127.0.0.1")
	cmd := exec.Command(s.EnginePath, args...)
	configureProcess(cmd)
	cmd.Dir = filepath.Dir(s.EnginePath)
	if err = os.MkdirAll(a.configDir, 0700); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(a.configDir, "engine.log"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	cmd.Stdout = log
	cmd.Stderr = log
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.process != nil || a.busy {
		log.Close()
		return errors.New("已有任务在运行")
	}
	if err = cmd.Start(); err != nil {
		log.Close()
		return err
	}
	a.process = cmd
	a.engineKey = key
	a.processDone = make(chan struct{})
	done := a.processDone
	go func() {
		err := cmd.Wait()
		log.Close()
		a.mu.Lock()
		if a.process == cmd {
			a.process = nil
			a.engineKey = ""
		}
		a.mu.Unlock()
		close(done)
		if err != nil {
			a.emit("引擎已退出，请检查模型兼容性及 engine.log", 0)
		}
	}()
	return nil
}
func (a *App) StopEngine() error {
	a.mu.Lock()
	cmd := a.process
	done := a.processDone
	a.mu.Unlock()
	if cmd == nil {
		return nil
	}
	if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	if done != nil {
		<-done
	}
	return nil
}
