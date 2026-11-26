import {describe,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {
  parseNeuralDoctorReply,resolveNeuralPython,inspectNeuralRuntime,
  neuralSubprocessEnv,
} from "./knowledge-neural-runtime";

const asJson=(status:string,missing:string[]=[])=>JSON.stringify({
  schema:1,status,pythonVersion:"3.12.6",missing,
});
describe("V0.2 neural Python provider choice and read-only diagnostics",()=>{
  it("prefers a private managed venv, unless an existing absolute user override is explicit",()=>{
    const home="/synthetic-home";
    const exists=(name:string)=>name.includes("neural-runtime");
    expect(resolveNeuralPython({},home,"win32",exists)).toEqual({
      command:join(home,".study-anchor","neural-runtime","Scripts/python.exe"),
      source:"managed",invalid:false,
    });
    expect(resolveNeuralPython({},home,"darwin",exists)).toEqual({
      command:join(home,".study-anchor","neural-runtime","bin/python"),
      source:"managed",invalid:false,
    });
    expect(resolveNeuralPython({},home,"darwin",()=>false)).toEqual({
      command:"python3",source:"system",invalid:false,
    });
    expect(resolveNeuralPython({STUDY_ANCHOR_PYTHON_PATH:"relative/python"},
      home,"win32",()=>true)).toMatchObject({source:"custom",invalid:true});
  });
  it("never inherits the user's AI keys, mail tokens or private cloud secrets in Python",()=>{
    const safe=neuralSubprocessEnv({
      PATH:"/usr/bin",HOME:"/test",OPENAI_API_KEY:"SECRET",
      DEEPSEEK_API_KEY:"SECRET2",ATE_POC_A_PASSWORD:"PRIVATE",
      PYTHONPATH:"malicious",STUDY_ANCHOR_PYTHON_PATH:"/custom/python",
    });
    expect(safe).toMatchObject({PATH:"/usr/bin",HOME:"/test",HF_HUB_OFFLINE:"1",
      PYTHONNOUSERSITE:"1",OMP_NUM_THREADS:"4"});
    for(const key of ["OPENAI_API_KEY","DEEPSEEK_API_KEY","ATE_POC_A_PASSWORD",
      "PYTHONPATH","STUDY_ANCHOR_PYTHON_PATH"])
      expect(safe).not.toHaveProperty(key);
  });

  it("checks ready only for a strict, allowlisted fixed-size doctor reply",()=>{
    expect(parseNeuralDoctorReply(asJson("ready"),"managed")).toMatchObject({
      ready:true,source:"managed",reason:"ready",pythonVersion:"3.12.6",missing:[],
    });
    expect(parseNeuralDoctorReply(asJson("missing-packages",["onnxruntime"]),
      "system")).toMatchObject({
        ready:false,reason:"missing-packages",missing:["onnxruntime"],
      });
    for(const raw of [
      asJson("made-up"),asJson("ready",["numpy"]),asJson("missing-packages"),
      asJson("missing-packages",["pip"]),asJson("missing-packages",["numpy","numpy"]),
      asJson("ready").replace('"schema":1','"schema":2'),
      asJson("ready").replace('"status":"ready"','"status":"ready","path":"/secret"'),
      "A".repeat(3000),"{invalid-json",
    ])expect(()=>parseNeuralDoctorReply(raw,"system")).toThrow();
  });
  it("rejects invalid explicit runtime without spawning a binary or reading user data",async()=>{
    const status=await inspectNeuralRuntime("/synthetic-check.py",{
      STUDY_ANCHOR_PYTHON_PATH:"not-an-absolute-path",
    });
    expect(status).toMatchObject({ready:false,source:"custom",reason:"invalid-config"});
  });
  it("fails closed when configured Python script is missing or returns invalid output",async()=>{
    const folder=mkdtempSync(join(tmpdir(),"sa-python-doctor-"));
    try{
      // Explicit path is not a real executable; no user home / system script touched.
      const bogus=join(folder,"untrusted-python");
      writeFileSync(bogus,"not a python executable");
      const status=await inspectNeuralRuntime(join(folder,"missing-doctor.py"),{
        STUDY_ANCHOR_PYTHON_PATH:bogus,
      });
      expect(status.ready).toBe(false);
      expect(["missing-python","timeout"]).toContain(status.reason);
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
});
