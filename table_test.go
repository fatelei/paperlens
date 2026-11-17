package main

import (
	"strings"
	"testing"
)

func TestTableConversion(t *testing.T) {
	s, e := tableHTML("<fcel>项目<fcel>金额<nl><fcel>OCR<fcel>128.00<nl>")
	if e != nil || !strings.Contains(s, "<td>金额</td>") || !strings.Contains(s, "128.00") {
		t.Fatal(s, e)
	}
	s, e = tableHTML("<fcel>合计<lcel><nl><fcel>128<lcel><nl>")
	if e != nil || strings.Count(s, `colspan="2"`) != 2 {
		t.Fatal(s, e)
	}
	s, e = tableHTML("<fcel>A<lcel><nl><ucel><xcel><nl>")
	if e != nil || !strings.Contains(s, `rowspan="2" colspan="2"`) {
		t.Fatal(s, e)
	}
	s, e = tableHTML("<fcel><script>alert(1)</script><nl>")
	if e != nil || strings.Contains(s, "<script>") {
		t.Fatal(s, e)
	}
	for _, input := range []string{"<ucel><nl>", "<lcel><nl>", "<fcel>A<fcel>B<nl><ucel><xcel><nl>", "<fcel>A<fcel>B<nl><fcel>C<nl>"} {
		if _, e := tableHTML(input); e == nil {
			t.Fatal("invalid table accepted", input)
		}
	}
}
