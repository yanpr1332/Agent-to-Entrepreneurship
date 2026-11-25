import {describe,it,expect,vi} from "vitest";
import {OpenAIResponsesClient} from "./openai-responses";
const key="ds-"+"k".repeat(45);
const response=(text:string)=>new Response(JSON.stringify({
  model:"deepseek-flash",choices:[{finish_reason:"stop",message:{role:"assistant",content:text}}],
  usage:{prompt_tokens:10,completion_tokens:20},
}),{status:200});
describe("DeepSeek and provider API adapters",()=>{
  it("sends a single authorized DeepSeek request to official HTTPS Chat Completions",async()=>{
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      expect(url).toBe("https://api.deepseek.com/chat/completions");
      expect((init.headers as Record<string,string>).Authorization).toBe("Bearer "+key);
      expect(init.redirect).toBe("error");
      const req=JSON.parse(init.body as string);
      expect(req).toMatchObject({
        model:"deepseek-flash",stream:false,thinking:{type:"disabled"},
        messages:[{role:"system"},{role:"user",content:"Help me study"}],
      });
      expect(JSON.stringify(req)).not.toContain("tools");
      return response("Study with spaced repetition");
    });
    const result=await new OpenAIResponsesClient(fetcher).ask({
      apiKey:key,model:"deepseek-flash",provider:"deepseek",endpoint:null,
    },"Help me study");
    expect(result).toMatchObject({text:"Study with spaced repetition",
      model:"deepseek-flash",usage:{inputTokens:10,outputTokens:20}});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps Anthropic and Gemini keys in their own non-URL headers",async()=>{
    const key2="a".repeat(36);
    const a=vi.fn(async(url:string,init:RequestInit)=>{
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect((init.headers as Record<string,string>)["x-api-key"]).toBe(key2);
      return new Response(JSON.stringify({
        model:"claude-sonnet-4-5",stop_reason:"end_turn",
        content:[{type:"text",text:"Done"}],usage:{input_tokens:10,output_tokens:4},
      }));
    });
    expect((await new OpenAIResponsesClient(a).ask({
      apiKey:key2,model:"claude-sonnet-4-5",provider:"anthropic",endpoint:null,
    },"Hi")).text).toBe("Done");
    const g=vi.fn(async(url:string,init:RequestInit)=>{
      expect(url).toContain("generativelanguage.googleapis.com");
      expect((init.headers as Record<string,string>)["x-goog-api-key"]).toBe(key2);
      return new Response(JSON.stringify({
        candidates:[{finishReason:"STOP",content:{parts:[{text:"Okay"}]}}],
        usageMetadata:{promptTokenCount:5,candidatesTokenCount:6},
      }));
    });
    expect((await new OpenAIResponsesClient(g).ask({
      apiKey:key2,model:"gemini-2.5-flash",provider:"gemini",endpoint:null,
    },"Hi")).text).toBe("Okay");
  });
  it("rejects incomplete DeepSeek responses, keeps raw provider error messages private",async()=>{
    const incomplete=new OpenAIResponsesClient(async()=>new Response(JSON.stringify({
      choices:[{finish_reason:"length",message:{content:"a partial answer"}}],
    })));
    await expect(incomplete.ask({apiKey:key,provider:"deepseek",
      model:"deepseek-flash",endpoint:null},"Hi")).rejects.toThrow("incomplete");
    const bad=new OpenAIResponsesClient(async()=>new Response(
      JSON.stringify({error:"private credential in server log"}),{status:401}));
    await expect(bad.ask({apiKey:key,provider:"deepseek",
      model:"deepseek-flash",endpoint:null},"Hi")).rejects.toThrow("authentication failed");
  });
});
