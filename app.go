package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	wr "github.com/wailsapp/wails/v2/pkg/runtime"
)

type Settings struct {
	OCRURL     string  `json:"ocrURL"`
	Model      string  `json:"model"`
	JevURL     string  `json:"jevURL"`
	JevMode    string  `json:"jevMode"`
	JevModel   string  `json:"jevModel"`
	Threshold  float64 `json:"threshold"`
	EnginePath string  `json:"enginePath"`
	ModelDir   string  `json:"modelDir"`
	CPUOnly    bool    `json:"cpuOnly"`
}

type App struct {
	ctx         context.Context
	native      bool
	mu          sync.Mutex
	settings    Settings
	configDir   string
	cancel      context.CancelFunc
	busy        bool
	process     *exec.Cmd
	processDone chan struct{}
	engineKey   string
	jevProcess  *exec.Cmd
	jevDone     chan struct{}
	jevKey      string
	client      *http.Client
}

func NewApp() *App {
	return &App{client: &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return errors.New("接口重定向已拒绝，请填写最终接口地址")
	}}}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.native = true
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	a.configDir = filepath.Join(dir, "PaperLens")
	if override := os.Getenv("PAPERLENS_DATA_DIR"); override != "" {
		a.configDir = override
	}
	a.settings = Settings{OCRURL: "http://127.0.0.1:18499", Model: "minicpm-ocr", JevURL: localJevURL, JevMode: "local", JevModel: "MiniCPM-OCR-Jev", Threshold: 0.9, ModelDir: filepath.Join(a.configDir, "models")}
	if b, err := os.ReadFile(filepath.Join(a.configDir, "settings.json")); err == nil {
		var s Settings
		if json.Unmarshal(b, &s) == nil {
			s.JevURL = localJevURL
			s.JevMode = "local"
			s.JevModel = "MiniCPM-OCR-Jev"
			if validateSettings(s) != nil {
				return
			}
			a.settings = s
		}
	}
}

func (a *App) shutdown(ctx context.Context) { a.Cancel(); a.StopLocalJev(); a.StopEngine() }
func (a *App) GetSettings() Settings        { a.mu.Lock(); defer a.mu.Unlock(); return a.settings }

func validateSettings(s Settings) error {
	if _, err := endpoint(s.OCRURL, true); err != nil {
		return fmt.Errorf("OCR: %w", err)
	}
	if s.JevURL != "" {
		if _, err := endpoint(s.JevURL, true); err != nil {
			return fmt.Errorf("Jev: %w", err)
		}
	}
	if s.Threshold < 0 || s.Threshold > 1 {
		return errors.New("阈值应在 0～1 之间")
	}
	if s.JevMode != "local" {
		return errors.New("未知 Jev 接口类型")
	}
	if strings.TrimSpace(s.Model) == "" {
		return errors.New("请填写 OCR 模型名称")
	}
	return nil
}

func (a *App) SaveSettings(s Settings) error {
	if err := validateSettings(s); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.busy {
		return errors.New("请等待当前任务完成后修改设置")
	}
	old := a.settings
	if a.process != nil && (s.OCRURL != old.OCRURL || s.Model != old.Model || s.ModelDir != old.ModelDir || s.EnginePath != old.EnginePath || s.CPUOnly != old.CPUOnly) {
		return errors.New("修改本地引擎配置前请先停止引擎")
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(a.configDir, 0700); err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(a.configDir, "settings.json"), b); err != nil {
		return err
	}
	a.settings = s
	return nil
}

func atomicWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".paperlens-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func (a *App) begin() (context.Context, func(), error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.busy {
		return nil, nil, errors.New("已有任务正在运行，请等待或取消")
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.busy = true
	a.cancel = cancel
	return ctx, func() { cancel(); a.mu.Lock(); a.busy = false; a.cancel = nil; a.mu.Unlock() }, nil
}
func (a *App) Cancel() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		a.cancel()
	}
}

type InputFile struct {
	Name string `json:"name"`
	MIME string `json:"mime"`
	Data string `json:"data"`
}

func (a *App) ChooseDocuments() ([]InputFile, error) {
	paths, err := wr.OpenMultipleFilesDialog(a.ctx, wr.OpenDialogOptions{Title: "导入文档", Filters: []wr.FileFilter{{DisplayName: "PDF 和图片", Pattern: "*.pdf;*.png;*.jpg;*.jpeg;*.webp"}}})
	if err != nil {
		return nil, err
	}
	return a.ReadDocuments(paths)
}
func (a *App) ReadDocuments(paths []string) ([]InputFile, error) {
	if len(paths) > 20 {
		return nil, errors.New("一次最多导入 20 个文件")
	}
	files := []InputFile{}
	var total int64
	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() > 80<<20 {
			f.Close()
			return nil, errors.New("仅支持 80MB 以下的普通文件")
		}
		total += info.Size()
		if total > 160<<20 {
			f.Close()
			return nil, errors.New("单次导入总大小不能超过 160MB")
		}
		data, err := io.ReadAll(io.LimitReader(f, 80<<20+1))
		f.Close()
		if err != nil {
			return nil, err
		}
		mime := http.DetectContentType(data)
		if mime != "application/pdf" && mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
			return nil, fmt.Errorf("不支持的文件类型：%s", filepath.Base(path))
		}
		files = append(files, InputFile{Name: filepath.Base(path), MIME: mime, Data: base64.StdEncoding.EncodeToString(data)})
	}
	return files, nil
}

func (a *App) ChooseEngine() (string, error) {
	return wr.OpenFileDialog(a.ctx, wr.OpenDialogOptions{Title: "选择 llama-server 可执行文件"})
}
func (a *App) ChooseModelDirectory() (string, error) {
	return wr.OpenDirectoryDialog(a.ctx, wr.OpenDialogOptions{Title: "选择模型目录"})
}
func (a *App) CopyText(text string) error {
	if len(text) > 20<<20 {
		return errors.New("文本过大")
	}
	return wr.ClipboardSetText(a.ctx, text)
}

func (a *App) OpenJevConsole() {
	wr.BrowserOpenURL(a.ctx, "https://huggingface.co/openbmb/MiniCPM-OCR-Jev")
}
func (a *App) OpenJevDocs() {
	wr.BrowserOpenURL(a.ctx, "https://github.com/OpenBMB/MiniCPM-OCR/blob/main/docs/llamacpp_deploy_jev_zh.md")
}
func (a *App) Export(name, format, content string) (string, error) {
	if format != "txt" && format != "md" && format != "json" {
		return "", errors.New("不支持的导出格式")
	}
	if len(content) > 50<<20 {
		return "", errors.New("导出内容过大")
	}
	name = strings.TrimSuffix(filepath.Base(name), filepath.Ext(name)) + "." + format
	p, err := wr.SaveFileDialog(a.ctx, wr.SaveDialogOptions{Title: "导出识别结果", DefaultFilename: name, Filters: []wr.FileFilter{{DisplayName: strings.ToUpper(format), Pattern: "*." + format}}})
	if err != nil || p == "" {
		return "", err
	}
	if err = atomicWrite(p, []byte(content)); err != nil {
		return "", err
	}
	return p, nil
}

func (a *App) emit(status string, percent float64) {
	if a.ctx != nil && a.native {
		wr.EventsEmit(a.ctx, "engine-progress", map[string]any{"message": status, "percent": percent})
	}
}
