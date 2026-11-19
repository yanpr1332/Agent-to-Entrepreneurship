export interface MathNode {tag:string;children:Array<MathNode|string>}
const m=(tag:string,...children:Array<MathNode|string>):MathNode=>({tag,children});
const symbols:Record<string,string>={
  alpha:"α",beta:"β",gamma:"γ",delta:"δ",epsilon:"ε",theta:"θ",lambda:"λ",
  mu:"μ",pi:"π",rho:"ρ",sigma:"σ",phi:"φ",omega:"ω",
  Gamma:"Γ",Delta:"Δ",Theta:"Θ",Lambda:"Λ",Sigma:"Σ",Omega:"Ω",
  infty:"∞",times:"×",cdot:"·",div:"÷",pm:"±",leq:"≤",geq:"≥",
  neq:"≠",approx:"≈",equiv:"≡",in:"∈",notin:"∉",subset:"⊂",
  subseteq:"⊆",rightarrow:"→",leftarrow:"←",Rightarrow:"⇒",
  sum:"∑",prod:"∏",int:"∫",partial:"∂",nabla:"∇",
  forall:"∀",exists:"∃",cup:"∪",cap:"∩",emptyset:"∅",
};
const operators=new Set("=+-*/(),[]<>|:;!");
/** Safe, bounded subset of TeX math converted to MathML without any engine.
 * Unsupported commands remain inert text; no file/system/HTML access exists.
 */
export function mathTree(source:string):MathNode {
  const raw=source.slice(0,2500);
  let pos=0,ops=0;
  function skip():void{while(pos<raw.length&&/\s/.test(raw[pos]))pos++;}
  function flatten(n:MathNode):string{
    return n.children.map(x=>typeof x==="string"?x:flatten(x)).join("");
  }
  function group():MathNode{
    skip();
    if(raw[pos]==="{"){pos++;const value=expression("}");if(raw[pos]==="}")pos++;return value;}
    return atom();
  }
  function atom():MathNode{
    skip();
    if(++ops>5000||pos>=raw.length)return m("mrow");
    const c=raw[pos++];
    if(c==="{"){const value=expression("}");if(raw[pos]==="}")pos++;return value;}
    if(c==="\\"){
      const command=/^[a-zA-Z]+/.exec(raw.slice(pos));
      if(!command)return m("mo",raw[pos++]??"");
      pos+=command[0].length;
      if(command[0]==="frac")return m("mfrac",group(),group());
      if(command[0]==="sqrt")return m("msqrt",group());
      if(command[0]==="text")return m("mtext",flatten(group()));
      if(command[0]==="left"||command[0]==="right")return atom();
      const glyph=symbols[command[0]];
      return m(glyph?"mo":"mi",glyph??command[0]);
    }
    if(/[0-9]/.test(c)){
      let digits=c;
      while(pos<raw.length&&/[0-9.]/.test(raw[pos]))digits+=raw[pos++];
      return m("mn",digits);
    }
    if(/[A-Za-z]/.test(c))return m("mi",c);
    return m(operators.has(c)?"mo":"mi",c);
  }
  function expression(end?:string):MathNode{
    const items:MathNode[]=[];
    while(pos<raw.length&&raw[pos]!==end&&ops<5000){
      skip();if(pos>=raw.length||raw[pos]===end)break;
      let base=atom(),sub:MathNode|null=null,sup:MathNode|null=null;
      for(let index=0;index<2;index++){
        skip();const marker=raw[pos];
        if(marker!=="_"&&marker!=="^")break;
        pos++;const item=group();
        if(marker==="_")sub=item;else sup=item;
      }
      if(sub&&sup)base=m("msubsup",base,sub,sup);
      else if(sub)base=m("msub",base,sub);
      else if(sup)base=m("msup",base,sup);
      items.push(base);
    }
    return m("mrow",...items);
  }
  return m("math",expression());
}
