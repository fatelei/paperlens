package main

import (
	"errors"
	"fmt"
	"html"
	"regexp"
	"strings"
)

var tableToken = regexp.MustCompile(`<(?:fcel|ecel|lcel|ucel|xcel|nl)>`)

// OTSL encodes one grid slot per token. Resolve continuation slots to their
// owning cell, require rectangular spans, then produce escaped HTML for Jev.
func tableHTML(input string) (string, error) {
	if strings.Contains(strings.ToLower(input), "<table") {
		return input, nil
	}
	matches := tableToken.FindAllStringIndex(input, -1)
	if len(matches) == 0 {
		return input, nil
	}
	type cell struct {
		text                 string
		row, col, rows, cols int
	}
	cells := []*cell{}
	grid := [][]int{}
	row := []int{}
	for i, m := range matches {
		token := input[m[0]:m[1]]
		end := len(input)
		if i+1 < len(matches) {
			end = matches[i+1][0]
		}
		text := strings.TrimSpace(input[m[1]:end])
		r, c := len(grid), len(row)
		owner := -1
		switch token {
		case "<nl>":
			if len(row) > 0 {
				grid = append(grid, row)
				row = []int{}
			}
			continue
		case "<fcel>", "<ecel>":
			owner = len(cells)
			cells = append(cells, &cell{text: html.UnescapeString(text), row: r, col: c, rows: 1, cols: 1})
		case "<lcel>":
			if c == 0 {
				return "", errors.New("无效表格：首列不能横向合并")
			}
			owner = row[c-1]
		case "<ucel>", "<xcel>":
			if r == 0 || c >= len(grid[r-1]) {
				return "", errors.New("无效表格：没有上方单元格")
			}
			owner = grid[r-1][c]
			if token == "<xcel>" && (c == 0 || row[c-1] != owner) {
				return "", errors.New("无效表格：交叉合并不匹配")
			}
		}
		if owner < 0 {
			return "", errors.New("无效表格")
		}
		row = append(row, owner)
		root := cells[owner]
		root.rows = max(root.rows, r-root.row+1)
		root.cols = max(root.cols, c-root.col+1)
	}
	if len(row) > 0 {
		grid = append(grid, row)
	}
	if len(grid) == 0 {
		return "", errors.New("表格为空")
	}
	for _, r := range grid {
		if len(r) != len(grid[0]) {
			return "", errors.New("表格行列数量不一致，请重新识别")
		}
	}
	for owner, cell := range cells {
		for r := cell.row; r < cell.row+cell.rows; r++ {
			for c := cell.col; c < cell.col+cell.cols; c++ {
				if r >= len(grid) || c >= len(grid[r]) || grid[r][c] != owner {
					return "", errors.New("表格合并区域不规则")
				}
			}
		}
	}
	var out strings.Builder
	out.WriteString("<table>\n")
	for r, row := range grid {
		out.WriteString("  <tr>")
		for c, owner := range row {
			cell := cells[owner]
			if cell.row != r || cell.col != c {
				continue
			}
			out.WriteString("<td")
			if cell.rows > 1 {
				fmt.Fprintf(&out, ` rowspan="%d"`, cell.rows)
			}
			if cell.cols > 1 {
				fmt.Fprintf(&out, ` colspan="%d"`, cell.cols)
			}
			out.WriteString(">")
			out.WriteString(html.EscapeString(cell.text))
			out.WriteString("</td>")
		}
		out.WriteString("</tr>\n")
	}
	out.WriteString("</table>")
	return out.String(), nil
}
