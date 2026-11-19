import {describe,expect,it} from "vitest";
import {parseSafeHtml,parseMarkdown,parseLatex,parsePreview} from "./safe-preview-ast";
import {mathTree} from "./mathml-preview";

describe("inert local document preview",()=>{
  it("removes unsafe elements and every HTML attribute/URL",()=>{
    const source="<h1 onclick='bad()'>Safe</h1>"+
      "<p style='color:red'>Real text</p><script>alert('evil')</script>"+
      "<iframe src='https://host.invalid'></iframe><img src='https://host.invalid/pic.png'>";
    const tree=parseSafeHtml(source);
    const json=JSON.stringify(tree);
    expect(json).toContain("Safe");
    expect(json).toContain("Real text");
    for(const unsafe of ["alert","onclick","style","iframe","https://","img"])
      expect(json).not.toContain(unsafe);
    expect(json).toContain('"tag":"h1"');
  });
  it("supports Markdown headings, fenced code, lists, tables and math",()=>{
    const tree=parseMarkdown("# Study\n\n- One\n- Two\n\n"+
      "| A | B |\n|---|---|\n| 1 | 2 |\n\n"+
      "Here is $x^2$ and **bold**.\n\n"+String.fromCharCode(96).repeat(3)+
      "ts\nconst x = 1;\n"+String.fromCharCode(96).repeat(3));
    const json=JSON.stringify(tree);
    for(const token of ['"tag":"h1"','"tag":"ul"','"tag":"table"',
      '"tag":"pre"','"kind":"math"','"tag":"strong"'])expect(json).toContain(token);
  });
  it("recognizes basic TeX structural commands and MathML fractions",()=>{
    const tree=parseLatex("\\documentclass{article}\n\\begin{document}\n"+
      "\\section{Algebra}\n\\begin{itemize}\n\\item First\n\\end{itemize}\n"+
      "\\[\\frac{a}{b}\\]\n\\end{document}");
    const json=JSON.stringify(tree);
    expect(json).toContain('"tag":"h2"');
    expect(json).toContain('"tag":"ul"');
    expect(json).toContain('"kind":"math"');
    expect(JSON.stringify(mathTree("\\frac{x^2}{y_1}+\\alpha"))).toContain('"tag":"mfrac"');
    expect(JSON.stringify(mathTree("x^2"))).toContain('"tag":"msup"');
    expect(JSON.stringify(mathTree("y_1"))).toContain('"tag":"msub"');
    expect(JSON.stringify(mathTree("\\sqrt{x}"))).toContain('"tag":"msqrt"');
    expect(JSON.stringify(parsePreview("html","<p>Hi</p>"))).toContain("Hi");
  });
});
