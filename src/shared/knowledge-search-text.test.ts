import {describe,expect,it} from "vitest";
import {extractKnowledgeText,normalizeFuzzy,fuzzySubstringMatch,
  fuzzyCandidateExpression} from "./knowledge-search-text";
describe("offline text extraction and fuzzy matching",()=>{
  it("discards executable HTML regions and retains readable content",()=>{
    const source="<h1>Biology &amp; Chemistry</h1><script>DO_NOT_INDEX</script>"+
      "<style>.private{}</style><p>Cell &lt;division&gt;</p>";
    expect(extractKnowledgeText("html",source)).toBe("Biology & Chemistry Cell <division>");
    expect(extractKnowledgeText("html",source)).not.toContain("DO_NOT_INDEX");
  });
  it("indexes readable LaTeX sections without running TeX",()=>{
    expect(extractKnowledgeText("latex","\\section{Algebra}\n"+
      "A matrix is invertible.")).toContain("matrix is invertible");
  });
  it("matches one or two edits with punctuation flexibility",()=>{
    expect(normalizeFuzzy("DNA, Polymerase")).toBe("dnapolymerase");
    expect(fuzzySubstringMatch("polymeraze",
      "DNA polymerase reads the strand",2)?.distance).toBe(1);
    expect(fuzzySubstringMatch("pylymrxze",
      "DNA polymerase reads the strand",2)).toBeNull();
    expect(fuzzyCandidateExpression("polymeraze")).toContain(" OR ");
    expect(fuzzyCandidateExpression("a")).toBeNull();
  });
});
