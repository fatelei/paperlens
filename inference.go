package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strings"
)

func endpoint(raw string, localOnly bool) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("请输入完整 http(s) 接口地址")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("接口地址不能包含凭据、查询参数或锚点")
	}
	ip := net.ParseIP(u.Hostname())
	local := u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback())
	if localOnly && !local {
		return nil, errors.New("本地 OCR 仅允许 localhost 或 loopback 地址")
	}
	if !local && u.Scheme != "https" {
		return nil, errors.New("在线核验必须使用 HTTPS")
	}
	return u, nil
}

func validateImage(data string) error {
	if len(data) > 32<<20 {
		return errors.New("图片过大，请缩小到 24MB 以下")
	}
	b, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return errors.New("无效的图片编码")
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return errors.New("图片必须是 PNG 或 JPEG")
	}
	if config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		return errors.New("图片尺寸超过 4000 万像素")
	}
	return nil
}

func (a *App) post(ctx context.Context, addr, key string, payload any, target any) error {
	return a.postHeaders(ctx, addr, key, payload, target, nil)
}

func (a *App) postHeaders(ctx context.Context, addr, key string, payload any, target any, headers map[string]string) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, addr, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	resp, err := a.client.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return errors.New("已取消")
		}
		return fmt.Errorf("无法连接服务：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("服务返回 HTTP %d，请检查本地模型服务状态", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20+1))
	if err != nil {
		return err
	}
	if len(b) > 16<<20 {
		return errors.New("服务响应过大")
	}
	if err = json.Unmarshal(b, target); err != nil {
		return errors.New("服务返回了无效 JSON")
	}
	return nil
}

type OCRResult struct {
	Text  string `json:"text"`
	Model string `json:"model"`
}

func (a *App) Recognize(data, category string) (OCRResult, error) {
	if err := validateImage(data); err != nil {
		return OCRResult{}, err
	}
	s := a.GetSettings()
	u, err := endpoint(s.OCRURL, true)
	if err != nil {
		return OCRResult{}, err
	}
	ctx, done, err := a.begin()
	if err != nil {
		return OCRResult{}, err
	}
	defer done()
	prompts := map[string]string{"page": "Text Recognition:", "text": "Text Recognition:", "formula": "Formula Recognition:", "table": "Table Recognition:"}
	prompt, ok := prompts[category]
	if !ok {
		return OCRResult{}, errors.New("无效区域类型")
	}
	addr := strings.TrimRight(u.String(), "/")
	if !strings.HasSuffix(addr, "/v1") {
		addr += "/v1"
	}
	addr += "/chat/completions"
	request := map[string]any{"model": s.Model, "temperature": 0, "max_tokens": 8192, "stream": false, "messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:image/png;base64," + data}}, map[string]string{"type": "text", "text": prompt}}}}}
	var response struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	a.mu.Lock()
	localKey := a.engineKey
	a.mu.Unlock()
	if err = a.post(ctx, addr, localKey, request, &response); err != nil {
		return OCRResult{}, err
	}
	if len(response.Choices) == 0 {
		return OCRResult{}, errors.New("OCR 返回了空结果")
	}
	if response.Choices[0].FinishReason == "length" {
		return OCRResult{}, errors.New("识别结果被截断，请框选更小区域后重试")
	}
	text := strings.TrimSpace(response.Choices[0].Message.Content)
	if text == "" {
		return OCRResult{}, errors.New("未识别到文字，可尝试调整图片或重新框选")
	}
	if category == "table" {
		converted, err := tableHTML(text)
		if err != nil {
			return OCRResult{}, err
		}
		text = converted
	}
	return OCRResult{Text: text, Model: s.Model}, nil
}

type ScoreResult struct {
	Score   *float64 `json:"score"`
	Verdict string   `json:"verdict"`
	Detail  string   `json:"detail"`
}

func parseScore(raw []byte) (ScoreResult, error) {
	var result struct {
		Results []struct {
			Prob    *float64 `json:"prob_yes"`
			Verdict string   `json:"verdict"`
			Detail  string   `json:"detail"`
		} `json:"results"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return ScoreResult{}, errors.New("Jev 结果不是有效 JSON")
	}
	if len(result.Results) != 1 {
		return ScoreResult{}, errors.New("Jev 返回结果数量不正确")
	}
	r := result.Results[0]
	if r.Verdict == "" {
		return ScoreResult{}, errors.New("Jev 响应缺少核验状态")
	}
	if r.Verdict != "scored" {
		return ScoreResult{Verdict: r.Verdict, Detail: r.Detail}, nil
	}
	if r.Prob == nil || math.IsNaN(*r.Prob) || math.IsInf(*r.Prob, 0) || *r.Prob < 0 || *r.Prob > 1 {
		return ScoreResult{}, errors.New("Jev 分数缺失或超出 0～1 范围")
	}
	return ScoreResult{Score: r.Prob, Verdict: "scored"}, nil
}

func (a *App) Verify(data, text, category, _ string) (ScoreResult, error) {
	if err := validateImage(data); err != nil {
		return ScoreResult{}, err
	}
	if strings.TrimSpace(text) == "" || len(text) > 1<<20 {
		return ScoreResult{}, errors.New("核验文本为空或过长")
	}
	if category != "text" && category != "formula" && category != "table" {
		return ScoreResult{}, errors.New("请先框选文字、公式或表格区域，整页混合内容不能直接核验")
	}
	s := a.GetSettings()
	u, err := endpoint(s.JevURL, true)
	if err != nil {
		return ScoreResult{}, err
	}
	ctx, done, err := a.begin()
	if err != nil {
		return ScoreResult{}, err
	}
	defer done()
	item := map[string]any{"case_id": "region-1", "image": data, "ocr_text": text, "category": category}
	payload := map[string]any{"input_form": "ternary", "items": []any{item}}
	var raw json.RawMessage
	a.mu.Lock()
	key := a.jevKey
	a.mu.Unlock()
	if err = a.post(ctx, u.String(), key, payload, &raw); err != nil {
		return ScoreResult{}, err
	}
	result, err := parseScore(raw)
	if err == nil && result.Verdict == "scored" {
		result.Detail = "MiniCPM-OCR-Jev 独立模型 · 本机核验；分数不代表逐字准确率。"
	}
	return result, err
}
