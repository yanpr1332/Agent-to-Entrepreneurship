import {describe,expect,it} from "vitest";
import {loadStaticWordVectors,modelForStaticVectors,staticWordVector,
  staticWordVectorProvider,MAX_LOCAL_VECTOR_FILE} from "./knowledge-word-vectors";

const trainedToy=`6 3
mitochondria 0.9 0.1 0
energy 1 0 0
atp 1 0.2 0
线粒体 0.9 0.1 0
能量 1 0 0
calculus 0 0 1
`;
const data=()=>loadStaticWordVectors(Buffer.from(trainedToy,"utf8"));
describe("ALPHA-KB-005B actual offline static word-vector encoder",()=>{
  it("checks pinned hash, derives model identity and genuinely averages local vocabulary embeddings",async()=>{
    const lexicon=data();
    expect(lexicon.dimension).toBe(3);
    expect(lexicon.vocabulary.size).toBe(6);
    expect(modelForStaticVectors(lexicon).revision).toMatch(/^[0-9a-f]{64}$/);
    const v=staticWordVector("mitochondria atp energy",lexicon);
    expect(v[0]).toBeGreaterThan(.9);
    expect(v[2]).toBe(0);
    const chinese=staticWordVector("线粒体产生能量",lexicon);
    expect(chinese[0]).toBeGreaterThan(.9);
    const out=await staticWordVectorProvider(lexicon).embed(
      ["mitochondria ATP","线粒体有能量"],"passage");
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBeGreaterThan(.8);
    expect(out[1][0]).toBeGreaterThan(.8);
  });
  it("returns no fake vectors for an entirely unknown vocabulary",()=>{
    expect(()=>staticWordVector("wordunrelatedtotraining",data())).toThrow("No known words");
  });
  it.each([
    "3 2\na 1 0\nb 0 1\n","1 2\na 0 0\n",
    "2 2\na 1 0\na 0 1\n",
    "1 2\na NaN 2\n",
    "1 2\na 2 Infinity\n",
    "1 2\na 1 2 3\n",
    "1 2\na 1  2\n",
    "2 3\na 1 0 0\n",
    "1 3\n../private 1 0 0\n",
  ])("rejects corrupted, ambiguous or executable-looking word-vector format",(text)=>{
    expect(()=>loadStaticWordVectors(Buffer.from(text))).toThrow();
  });
  it("refuses oversized files, illegal dimensions, non-UTF8 and huge vectors",async()=>{
    expect(()=>loadStaticWordVectors(Buffer.alloc(MAX_LOCAL_VECTOR_FILE+1))).toThrow();
    expect(()=>loadStaticWordVectors(Buffer.from([0xff,0xfe]))).toThrow();
    expect(()=>loadStaticWordVectors(Buffer.from("1 500\na 0 0\n"))).toThrow();
    expect(()=>staticWordVector("a".repeat(2201),data())).toThrow();
    await expect(staticWordVectorProvider(data()).embed(
      Array.from({length:17},()=> "energy"),"query")).rejects.toThrow("batch");
  });
});
