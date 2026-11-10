import { describe,expect,it,vi } from "vitest";
import { OpenAIResponsesClient } from "./openai-responses";
const settings={apiKey:"sk-"+"s".repeat(40),model:"gpt-4.1-mini"};
function ok(text="The answer is 42") {
  return new Response(JSON.stringify({
    status:"completed",model:"gpt-4.1-mini",
    output:[{type:"message",content:[{type:"output_text",text}]}],
    usage:{input_tokens:22,output_tokens:17},
  }),{status:200});
}

describe("OpenAI Responses API secure request boundaries",()=>{
  it("sends a single user-approved prompt only, disables tools and server storage",async()=>{
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(init.redirect).toBe("error");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string,string>).Authorization).toBe(`Bearer ${settings.apiKey}`);
      const body=JSON.parse(init.body as string);
      expect(body).toMatchObject({
        model:"gpt-4.1-mini",store:false,max_output_tokens:512,tools:[],
        input:[{role:"user",content:[{type:"input_text",text:"Explain mitosis."}]}],
      });
      expect(JSON.stringify(body)).not.toContain("Canvas Token");
      expect(JSON.stringify(body)).not.toContain("email password");
      return ok();
    });
    const result=await new OpenAIResponsesClient(fetcher).ask(settings,"Explain mitosis.");
    expect(result).toMatchObject({text:"The answer is 42",usage:{inputTokens:22,outputTokens:17}});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never forwards private error messages or headers to the UI",async()=>{
    const provider=new OpenAIResponsesClient(async()=>new Response(
      '{"error":{"message":"secret credential: sk-secret"}}',{status:401}));
    await expect(provider.ask(settings,"Hi")).rejects.toThrow("authentication failed");
    await expect(provider.ask(settings,"Hi")).rejects.not.toThrow("sk-secret");
  });
  it("rejects incomplete or oversized provider responses without storing text",async()=>{
    const unfinished=new OpenAIResponsesClient(async()=>new Response(JSON.stringify({
      status:"in_progress",output:[{type:"message",content:[{type:"output_text",text:"unfinished"}]}],
    })));
    await expect(unfinished.ask(settings,"Hi")).rejects.toThrow("incomplete");
    const huge=new OpenAIResponsesClient(async()=>ok("x".repeat(200_000)));
    await expect(huge.ask(settings,"Hi")).rejects.toThrow("exceeded safety limits");
  });
  it("does not retry network failures even if submission outcome is unknown",async()=>{
    const fetcher=vi.fn(async()=>{throw Error("trace with sensitive data");});
    await expect(new OpenAIResponsesClient(fetcher).ask(settings,"Hi")).rejects.toThrow("uncertain");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
