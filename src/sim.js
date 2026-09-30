// 对局簿推算：按记录逐步喂给引擎（sim / simBoard），偏差报告（devReport），场外计数（extraLine）。
// 从 app.js 拆出；和 app.js 共用全局（BY、db、esc、logText 等只在调用时用到），index.html 里在 app.js 之前载入。
// ---------- 规则引擎接入：按记录逐步推算场面 ----------
const ENG=(typeof GwentEngine!=="undefined")?GwentEngine:null;
const ENGRAW=RAW;
let simCache={key:"",res:null};
// 未确认规则的覆盖值（校准用），见引擎 DEFAULT_RULES
const SIM_RULES={};
function sim(g,r,excl){
  if(!ENG)return null;
  const key=g.id+"|"+r+"|"+(excl||"")+"|"+JSON.stringify(g.log.filter(x=>x.r<=r))+"|"+g.leader+"|"+JSON.stringify(SIM_RULES);
  if(simCache.key===key)return simCache.res;
  const log=g.log.filter(x=>x.r===r&&x.id!==excl);
  const E=new ENG.Game({manualRounds:true,rules:SIM_RULES,first:(log.find(x=>["play","leader","tactic","order","pass"].includes(x.a))||{who:g.coin==="后"?"op":"me"}).who});
  E.loadData(ENGRAW);E.loadBehaviors(GwentCards.behaviors);
  E.s.sides.me.vars.devotion=devotionOf(deckById(g.deck))||!deckById(g.deck);
  const key2u={},u2key=new Map(),warns=[],unmod={};
  const bind=(k,u)=>{key2u[k]=u;u2key.set(u,k);};
  const unitByKey=k=>{const u=key2u[k];return u&&E.find(u.uid)?u:null;};
  let tq=[],dq=[],effQ={},hzQ={};
  const HZ=ENG.HAZARDS||{};
  // 目标来源：先用这一步自己的 tgts，再用“触发效果”记录里对应来源的目标（例如法利波的随机伤害）
  const takeFrom=(q,req,n,out)=>{while(q.length&&out.length<n){const u=unitByKey(q[0]);if(!u||!req.from.includes(u))break;out.push(u);q.shift();}};
  let curPay=null,curX=null;
  // 亢奋：先看这张牌打出时记的“成立/不成立”（旧记录），没有就由引擎按推算的手牌数判断
  const frenzyOf=req=>{const i=log.indexOf(curX);for(let j=i;j>=0;j--){const y=log[j];if(y.c===req.source&&y.who===req.side&&y.fz!=null)return y.fz;}
    return null;};   // 否则引擎按推算的手牌数（handCount）判断
  // 我方牌组里还剩的牌（拉尔维克的埃兰）：卡组 − 打出/召唤过的 − 手牌（记了手牌时）
  const dk=deckById(g.deck);
  E.deckInfo=sd=>{if(sd!=="me"||!dk||!curX)return null;const left=Object.assign({},dk.cards);const take=n=>{const b=baseOf(n);if(left[b]>0)left[b]--;};
    for(const y of g.log){if(y.id===curX.id)break;if(y.who==="me"&&(y.a==="play"||y.a==="summon")&&y.via!=="墓场")take(y.c);}
    if(curX.who==="me"&&(curX.a==="play"||curX.a==="summon")&&curX.via!=="墓场")take(curX.c);
    if(g.hand)myHand(g,curX.id).forEach(take);
    const out=[];for(const[n,k]of Object.entries(left))for(let i=0;i<k;i++)out.push(n);return out;};
  E.chooser=(req)=>{
    if(req.kind==="deck"){return dq.length?dq.shift():null;}
    if(req.kind==="tribute")return curPay;      // 献金：记录里的“付了/没付”，没记则按规则默认
    if(req.kind==="frenzy")return frenzyOf(req);
    if(req.kind==="deckCount")return curX&&curX.c===req.source&&curX.dn!=null?curX.dn:null;
    const n=req.n||1,out=[];
    // 整排效果的随机结果只从“效果”记录（来源 = 效果名）里取
    if(HZ[req.source]){if(hzQ[req.source])takeFrom(hzQ[req.source],req,n,out);return out.length?out:null;}
    takeFrom(tq,req,n,out);
    if(out.length<n&&req.source&&effQ[req.source])takeFrom(effQ[req.source],req,n,out);
    return out.length?out:null;};
  const TURN=["play","leader","tactic","order","pass","spawn","summon"];
  const isTurnAct=y=>TURN.includes(y.a)&&!y.via;
  // 已建模的来源：它的“触发效果”记录只提供目标，效果由引擎结算
  const modeled=nm=>{const d=nm&&E.def(nm);return !!(d&&!d.unmodeled);};
  // 只在回合结束时触发的来源：记录到它的效果 = 该方回合已经结束
  const endOnly=nm=>{const d=E.def(nm);const ab=(d&&d.abilities)||[];return ab.length>0&&ab.every(a=>a.on==="turnEnd")&&!d.bless&&!d.order;};
  const relocate=(u,row,pos)=>{const a=E.s.sides[u.side].rows[u.row];const k=a.indexOf(u);if(k<0)return;a.splice(k,1);const b=E.s.sides[u.side].rows[row];u.row=row;b.splice(pos==null||pos>b.length?b.length:pos,0,u);};
  // 上一局的坚韧单位留场（老兵在小局开始时 +1）
  let Pprev=null;
  if(r>0&&g.log.some(x=>x.r===r-1)){const P=Pprev=sim(g,r-1);
    if(P)for(const sd of["me","op"]){for(const w of["m","r"])for(const u of P.E.s.sides[sd].rows[w])if(u.status.resilience){const v=E.carryIn(u,sd,w);const k=P.u2key.get(u);if(k)bind(k,v);}
      // 跨局延续：金币（小局开始时减半）、墓场、放逐、牌组里回响的牌、领袖/战术剩余充能
      const A=P.E.s.sides[sd],B=E.s.sides[sd];B.coins=A.coins;B.grave=A.grave.slice();B.banished=A.banished.slice();
      // 上一局结束时场上的非坚韧单位进墓场（佚亡的放逐）
      for(const w of["m","r"])for(const u of P.E.s.sides[sd].rows[w])if(!u.status.resilience)(P.E.isDoomed(u)?B.banished:B.grave).push(u.name);B.deck=A.deck.slice();B.echoed=(A.echoed||[]).slice();
      // 墓场里的计数（洞察之球）、牌组里单位的增益（埃兰）、最大耐性（校友会，ASSUME 跨小局保留）
      B.graveWatch=JSON.parse(JSON.stringify(A.graveWatch||[]));B.deckBuff=JSON.parse(JSON.stringify(A.deckBuff||{}));if(A.vars.maxPat)B.vars.maxPat=Object.assign({},A.vars.maxPat);
      for(const[nm,h]of Object.entries(A.abilities||{})){const h2=E.addAbility(sd,nm,h.charges);h2.vars=JSON.parse(JSON.stringify(h.vars||{}));}}}
  E.s.round=r;
  E.startRound();
  // 手牌数推算：第一局起手 10 张；之后 = 上一局结束时的手牌（R 行记了就用记录，否则用推算）+ 3，上限 10。打出（不含牌组/墓场/生成）-1，“手牌”记录修正
  {const P=Pprev;const R0=g.rounds&&g.rounds[r-1];
    for(const sd of["me","op"]){const rec=R0&&R0[sd==="me"?"hm":"ho"];let prev=rec!=null&&rec!==""?+rec:P?P.E.s.sides[sd].handCount:null;
      // 希里：己方输掉小局时回到手牌（在场上或墓场里）；R 行记了手牌就以记录为准
      if((rec==null||rec==="")&&P&&R0){const lost=R0.res==="D"||(R0.res==="L")===(sd==="me");const A=P.E.s.sides[sd];
        if(lost&&(A.grave.includes("希里")||P.E.allUnits(sd).some(u=>u.name==="希里")))prev=Math.min(E.rules.handLimit,prev+1);}
      const S=E.s.sides[sd];S.handCount=r===0?E.rules.draws[0]:Math.min(E.rules.handLimit,(prev==null?Math.max(0,E.rules.draws[0]-4*r):prev)+E.rules.draws[r]);S.handKnown=true;}}
  const consumed=new Set();let acted=false;
  // 逐步记录：第几手（每方各自计数，换人行动算新的一手）和这一步结算后的比分，偏差报告用
  const steps={},turnCnt={me:0,op:0};let lastTurn=null;
  const hzCard=nm=>{const d=nm&&E.def(nm);return d&&d.hazardCard;};
  const pushHz=y=>{(hzQ[y.c]=hzQ[y.c]||[]).push(...(y.tgts||[]).filter(t=>t.uid!=null).map(t=>t.uid));consumed.add(y.id);};
  for(let i=0;i<log.length;i++){const x=log[i];if(consumed.has(x.id))continue;
    let side=x.who;
    // 领袖记错方（记录时停在“对方”）：目标是另一方单位且另一方领袖同名时，按另一方推算
    if(x.a==="leader"&&x.tgts&&x.tgts[0]&&x.tgts[0].uid!=null){const tu=unitByKey(x.tgts[0].uid);const other=side==="me"?"op":"me";const otherLeader=other==="me"?g.leader:g.opLeader;
      if(tu&&tu.side===other&&x.c&&x.c===otherLeader){warns.push({id:x.id,m:"目标是"+sideN(other)+"单位，已按"+sideN(other)+"领袖推算（建议改记录的方）"});side=other;}}
    // 换人行动 = 回合切换（触发效果、整排效果不算，它们可能在任一方回合里发生）
    const turnAct=isTurnAct(x);
    // 整排效果的命中记录可能记在回合行动前后：换回合结算整排效果前先备好
    if(turnAct)for(let j=i+1;j<log.length&&!isTurnAct(log[j]);j++){const y=log[j];if(y.a==="effect"&&HZ[y.c]&&!consumed.has(y.id))pushHz(y);}
    if(turnAct&&side!==E.s.active&&!E.s.sides[E.s.active].passed){E.endTurn();acted=false;}
    else if(turnAct&&side!==E.s.active){E.s.active=side;acted=false;}
    if(turnAct){effQ={};
      // 往后看到下一个回合行动为止，把已建模来源的触发效果目标先备好
      for(let j=i+1;j<log.length&&!isTurnAct(log[j]);j++){const y=log[j];
        if(y.a==="effect"&&modeled(y.c)&&!endOnly(y.c)){(effQ[y.c]=effQ[y.c]||[]).push(...(y.tgts||[]).filter(t=>t.uid!=null).map(t=>t.uid));consumed.add(y.id);}}}
    tq=(x.tgts||[]).filter(t=>t.uid!=null).map(t=>t.uid);
    // 由这张牌带出的后续记录（生成/召唤/从牌组打出）
    const subs=[];for(let j=i+1;j<log.length;j++){const y=log[j];if(y.via&&y.via===x.c&&y.who===x.who&&["spawn","summon","play"].includes(y.a))subs.push(y);else if(!y.via)break;}
    dq=subs.map(y=>y.c);
    const before=new Set(E.allUnits());const t0=E.trace.length;curPay=x.pay===undefined?null:x.pay;curX=x;
    const def=x.c?E.def(x.c):null;
    try{
    switch(x.a){
      case "play":{if(def&&(def.type==="tactic"||def.type==="leader")){E.useAbility(side,x.c,{force:true});break;}
        if(def&&def.type==="special"){E.play(side,x.c,null,null,{row:subs[0]&&subs[0].row,pos:subs[0]&&subs[0].pos});
}
        else if(x.row){const u=E.play(x.side||side,x.c,x.row,x.pos,{power:x.pw,fromDeck:!!x.via&&x.via!=="墓场",fromGrave:x.via==="墓场",player:side});if(u)bind(x.id,u);}
        else E.log("不上场",{name:x.c});break;}
      case "summon":{if(x.row){const u=E.summon(x.c,x.side||side,x.row,x.pos);if(u)bind(x.id,u);}break;}
      case "spawn":{if(def&&def.type==="special"){E.play(side,x.c,null,null,{spawned:true});}
        else if(x.row){const u=E.spawn(x.c,x.side||side,x.row,x.pos);if(u)bind(x.id,u);}break;}
      case "order":{const u=(x.uid&&unitByKey(x.uid))||E.allUnits(side).find(v=>v.name===x.c&&E.canOrder(v))||E.allUnits(side).find(v=>v.name===x.c);
        if(u)E.order(u.uid,{force:true,row:subs[0]&&subs[0].row,pos:subs[0]&&subs[0].pos});else warns.push({id:x.id,m:"找不到指令单位 "+x.c});break;}
      case "leader":case "tactic":{if(x.a==="tactic"&&g.coin&&side!==(g.coin==="先"?"me":"op"))warns.push({id:x.id,m:"只有先手方有战术牌，这条记成了"+sideN(side)+"（记错方或先后手记错）"});
        const nm=x.c||(side==="me"?g.leader:g.opLeader);if(nm)E.useAbility(side,nm,{force:true,row:subs[0]&&subs[0].row,pos:subs[0]&&subs[0].pos});else warns.push({id:x.id,m:"领袖未指定"});break;}
      case "move":{const u=unitByKey(x.uid);if(u)E.move(u,x.row,x.pos);break;}
      case "kill":{const u=unitByKey(x.uid);if(u)E.destroy(u);break;}
      case "adj":{const u=unitByKey(x.uid);if(u){
        // 可以多项，逗号分隔：+2 / -3 / 7（战力），+盾 -盾 +锁 -锁 +坚 -坚 +遮 -遮（状态），甲3（护甲），活2 伤2（回合数，0 = 去掉）
        for(const v of String(x.v).split(/[,，\s]+/).filter(Boolean)){let m;
          if((m=v.match(/^([+-])(盾|锁|坚|遮|潜|伏|赏)$/))){const k={盾:"shield",锁:"lock",坚:"resilience",遮:"veil",潜:"spying",伏:"ambush",赏:"bounty"}[m[2]];u.status[k]=m[1]==="+";E.log("手动状态",{name:u.name,key:k,val:u.status[k]});}
          else if((m=v.match(/^甲(\d+)$/)))u.armor=+m[1];
          else if((m=v.match(/^(活|伤)(\d+)$/))){u.status[m[1]==="活"?"vitality":"bleed"]=+m[2];}
          else{const n=parseInt(v.replace(/^[=+]/,""));if(isNaN(n)){warns.push({id:x.id,m:"看不懂的修正「"+v+"」"});continue;}
            if(/^\+/.test(v))E.boost(u,n,{name:"手动"});else if(/^-/.test(v))E.damage(u,-n,{name:"手动"});else{E.log("手动设定",{name:u.name,from:u.power,to:n});u.power=n;if(u.power<=0)E.destroy(u);}}}
        if(x.armor!=null)u.armor=x.armor;}break;}
      case "coin":{const S2=E.s.sides[x.side||side];const v=String(x.v).trim();const n=parseInt(v.replace(/^[=+]/,""));if(isNaN(n)){warns.push({id:x.id,m:"看不懂的金币修正「"+v+"」"});break;}
        const before=S2.coins;S2.coins=/^\+/.test(v)?Math.min(E.rules.coinLimit,S2.coins+n):/^-/.test(v)?Math.max(0,S2.coins+n):n;E.log("手动金币",{side:x.side||side,from:before,to:S2.coins});break;}
      case "pass":{E.pass(side);break;}
      case "hand":{const S2=E.s.sides[x.side||side];const v=String(x.v).trim();const n=parseInt(v.replace(/^[=+]/,""));if(isNaN(n)){warns.push({id:x.id,m:"看不懂的手牌修正「"+v+"」"});break;}
        const before=S2.handCount;S2.handCount=Math.max(0,Math.min(E.rules.handLimit,/^\+/.test(v)?S2.handCount+n:/^-/.test(v)?S2.handCount+n:n));E.log("手动手牌",{side:x.side||side,from:before,to:S2.handCount});break;}
      case "fx":{if(!HZ[x.c])warns.push({id:x.id,m:"整排效果「"+x.c+"」未建模"});
        if(!x.dur&&HZ[x.c])warns.push({id:x.id,m:"「"+x.c+"」没记持续回合，按 "+HZ[x.c].turns+" 回合算"});
        E.addHazard(x.side,x.row,x.c,x.dur||undefined);break;}
      case "effect":{if(HZ[x.c]){pushHz(x);break;}
        if(!modeled(x.c)){warns.push({id:x.id,m:"效果「"+(x.c||"")+"」未建模，请用改战力修正"});break;}
        (effQ[x.c]=effQ[x.c]||[]).push(...tq);tq=[];
        // 回合结束效果：记录到它时，该方回合已结束
        const src=E.allUnits().find(u=>u.name===x.c);
        if(endOnly(x.c)&&src&&src.side===E.s.active&&acted&&!E.s.sides[E.s.active].passed){E.endTurn();acted=false;}
        break;}
    }}catch(err){warns.push({id:x.id,m:"推算出错："+err.message});}
    // 会生成整排效果的牌（刺骨冰霜、艾瑞汀等）：后面要有“整排效果”记录说明放在哪排
    if(x.a==="play"&&def&&def.hazardCard){let ok=false;for(let j=i+1;j<log.length&&!isTurnAct(log[j]);j++)if(log[j].a==="fx")ok=true;if(!ok)warns.push({id:x.id,m:"「"+x.c+"」生成的整排效果没记在哪排（用“整排效果”补上）",fix:true});}
    if(turnAct)acted=true;
    if(turnAct&&side!==lastTurn){turnCnt[side]++;lastTurn=side;}
    {const who=lastTurn||side;const cards=new Set();let wn=0;
      for(const t of E.trace.slice(t0)){const d=t.data||{};if(d.by&&d.by!=="手动")cards.add(d.by);if(t.type==="打出"||t.type==="生成"||t.type==="召唤")cards.add(d.name);if(t.warn)wn++;}
      if(x.c&&BY[x.c])cards.add(x.c);
      steps[x.id]={who,n:turnCnt[who]||1,me:E.score("me").total,op:E.score("op").total,cards:[...cards].filter(Boolean),wn};}
    // 后续记录对应到引擎自动产生的单位；引擎没产生的就按记录手动放
    const fresh=E.allUnits().filter(u=>!before.has(u)&&!u2key.has(u));
    for(const y of subs){const k=fresh.findIndex(u=>u.name===y.c);if(k>=0){const u=fresh[k];bind(y.id,u);fresh.splice(k,1);consumed.add(y.id);
        if(y.row&&(y.side||y.who)===u.side&&(u.row!==y.row||(y.pos!=null&&E.s.sides[u.side].rows[u.row].indexOf(u)!==y.pos)))relocate(u,y.row,y.pos);}}
    fresh.forEach((u,k)=>bind(x.id+"/"+k,u));
    // 落地战力：以整步结算完后看到的为准（包括牌组拉出的牌）
    for(const y of [x,...subs]){if(y.pw==null)continue;const u=unitByKey(y.id);
      if(u&&u.power!==y.pw){E.log("录入战力",{uid:u.uid,name:u.name,from:u.power,to:y.pw});u.power=y.pw;}}
    // 提示：未建模、待选
    for(const t of E.trace.slice(t0)){
      if(t.type==="待选")warns.push({id:x.id,m:"「"+(t.data.prompt||"")+"」没有指定目标",fix:true});
      if(t.type==="指令不可用")warns.push({id:x.id,m:t.data.name+" 本回合不能用指令"});
      if(t.type==="计时触发"&&t.data.unmodeled)warns.push({id:x.id,m:t.data.name+" 计时归零，效果未建模（用改战力修正）"});
      if((t.type==="献金"||t.type==="费用")&&t.data.unmodeled)warns.push({id:x.id,m:t.data.name+" 的"+t.type+"效果未建模（用改战力修正）"});
      if(t.type==="亢奋未知"&&t.data.name===x.c&&x.a==="play")warns.push({id:x.id,m:t.data.name+" 亢奋 "+t.data.n+" 是否成立没记，按"+(E.rules.frenzyDefault?"成立":"不成立")+"算",step:{t:"frenzy",id:x.id,n:t.data.n}});
      if(t.type==="牌组单位数未知")warns.push({id:x.id,m:t.data.name+"：牌组里有几个单位没记，牌组增益没算",step:{t:"deckCount",id:x.id}});
      if(t.type==="金币不足")warns.push({id:x.id,m:t.data.name+" 需要 "+t.data.need+" 金币，推算只有 "+t.data.coins+"（用“金币”修正）"});
      if(t.data&&t.data.unmodeled){unmod[t.data.name]=(unmod[t.data.name]||0)+1;}}
  }
  // 这一局已结束但最后一方的停牌没记：补一次停牌（结算回合结束效果）
  if(g.rounds&&g.rounds[r]&&!E.s.sides[E.s.active].passed&&log.length){const a=E.s.active;E.s.sides[a].passed=true;E.log("停牌（补）",{side:a});E.endTurn();}
  {const R1=g.rounds&&g.rounds[r];if(R1&&log.length)for(const sd of["me","op"]){const rec=R1[sd==="me"?"hm":"ho"];
    if(rec!=null&&rec!==""&&+rec!==E.s.sides[sd].handCount)warns.push({id:log[log.length-1].id,m:"推算"+sideN(sd)+"局末手牌 "+E.s.sides[sd].handCount+" 张，记录是 "+rec+" 张（中途抽牌、回手没记，用“修正手牌”补上）"});}}
  const res={E,key2u,u2key,warns,unmod,steps,score:{me:E.score("me"),op:E.score("op")}};
  simCache={key,res};return res;}
// ---------- 偏差报告：真实比分（录屏核对的 C 记录、R 行局末比分）和推算逐步对比 ----------
const NOTE_PRESETS=["失误","关键回合","该停牌","没算到","对面读牌","卡手","好操作","节奏亏"];
function parseScore(v){const m=String(v||"").match(/(\d+)\s*[:：\s]\s*(\d+)/);return m?{me:+m[1],op:+m[2]}:null;}
function stepLabel(st){return st?(st.who==="me"?"我":"对")+"第"+st.n+"手":"";}
function devReport(g,r,S){if(!S||!S.steps)return null;const log=g.log.filter(x=>x.r===r);if(!log.length)return null;
  const FL=(typeof GwentCardFlags!=="undefined"&&GwentCardFlags)||{};
  const chk=[];log.forEach((x,i)=>{if(x.a==="real"){const v=parseScore(x.v);if(v&&S.steps[x.id])chk.push({i,id:x.id,real:v,eng:{me:S.steps[x.id].me,op:S.steps[x.id].op},lab:stepLabel(S.steps[x.id])});}});
  const R=g.rounds[r];if(R&&R.me!==""&&R.me!=null&&R.op!==""&&R.op!=null)chk.push({i:log.length,id:"end",real:{me:+R.me,op:+R.op},eng:{me:S.score.me.total,op:S.score.op.total},lab:"局末"});
  chk.forEach(c=>{c.dm=c.eng.me-c.real.me;c.dop=c.eng.op-c.real.op;c.ok=!c.dm&&!c.dop;});
  const bad=chk.find(c=>!c.ok);const prevOk=bad?[...chk].reverse().find(c=>c.ok&&c.i<bad.i):null;
  // 每一步的比分变化和可疑来源
  let pm=0,po=0;const rows=log.map((x,i)=>{const st=S.steps[x.id];if(!st)return null;const d={i,x,st,dm:st.me-pm,dop:st.op-po};pm=st.me;po=st.op;
    d.flags=st.cards.filter(n=>FL[n]||(ENG&&S.E.def(n).unmodeled)).map(n=>n+"（"+(FL[n]||"未建模")+"）");if(st.wn)d.flags.push("提示 "+st.wn+" 条");return d;}).filter(Boolean);
  const range=bad?rows.filter(d=>d.i>(prevOk?prevOk.i:-1)&&d.i<=(bad.id==="end"?log.length:bad.i)):[];
  const sus=range.filter(d=>d.flags.length||(bad.dm&&d.dm)||(bad.dop&&d.dop));
  const sgn=n=>(n>0?"+":"")+n;
  const txt=[];const html=[];
  if(!chk.length){html.push(`<p class="note">还没有真实比分。复盘录屏时，在某一手之后点“录入真实比分”（或在 R 行填局末比分），就能定位从哪一步开始偏。</p>`);txt.push("（没有真实比分）");}
  else{html.push(`<div class="dev">${chk.map(c=>`<div class="${c.ok?"ok":"bad"}">${esc(c.lab)}　真实 ${c.real.me}:${c.real.op}　推算 ${c.eng.me}:${c.eng.op}　${c.ok?"一致":"差 "+sgn(c.dm)+" : "+sgn(c.dop)}</div>`).join("")}</div>`);
    chk.forEach(c=>txt.push(`${c.lab} 真实 ${c.real.me}:${c.real.op} 推算 ${c.eng.me}:${c.eng.op} ${c.ok?"一致":"差 "+sgn(c.dm)+":"+sgn(c.dop)}`));
    if(bad){const from=prevOk?prevOk.lab+"之后":"本局开始";const to=bad.lab;
      html.push(`<p class="note">偏差出现在 <b>${esc(from)} → ${esc(to)}</b> 之间（${range.length} 步）。${bad.dm?"我方"+(bad.dm>0?"多算":"少算")+" "+Math.abs(bad.dm)+"。":""}${bad.dop?"对方"+(bad.dop>0?"多算":"少算")+" "+Math.abs(bad.dop)+"。":""}可疑的步骤：</p>`);
      txt.push(`偏差区间：${from} → ${to}`);
      html.push(sus.length?`<div class="dev">${sus.map(d=>`<div>${esc(stepLabel(d.st))}${d.x.vt?"（录屏 "+esc(d.x.vt)+"）":""}　${esc(logText(d.x))}　<b>${sgn(d.dm)} : ${sgn(d.dop)}</b>${d.flags.length?`<br><small>${esc(d.flags.join("、"))}</small>`:""}</div>`).join("")}</div>`:`<p class="note">这段里没有标记为推测/未建模的牌，可能是记录漏了（对方落地战力、触发效果）。</p>`);
      sus.forEach(d=>txt.push(`  ${stepLabel(d.st)}${d.x.vt?"（录屏 "+d.x.vt+"）":""} ${logText(d.x)} ${sgn(d.dm)}:${sgn(d.dop)}${d.flags.length?" ["+d.flags.join("、")+"]":""}`));}
    else{html.push(`<p class="note">所有核对点都一致。</p>`);}}
  const notes=rows.filter(d=>d.x.a==="note");
  if(notes.length){html.push(`<p class="note">备注：</p><div class="dev">${notes.map(d=>`<div>${esc(stepLabel(d.st))}　${esc(d.x.c)}</div>`).join("")}</div>`);notes.forEach(d=>txt.push(`备注 ${stepLabel(d.st)} ${d.x.c}`));}
  html.push(`<details><summary class="note">逐步比分（${rows.length} 步）</summary><div class="dev steps">${rows.map(d=>`<div class="${d.x.who}">${esc(stepLabel(d.st))}${d.x.vt?" · 录屏 "+esc(d.x.vt):d.x.t!=null?" · "+fmt(d.x.t):""}　${esc(logText(d.x))}　<b>${d.st.me}:${d.st.op}</b>${d.dm||d.dop?` <small>(${sgn(d.dm)}:${sgn(d.dop)})</small>`:""}${d.flags.length?` <small class="fl">${esc(d.flags.join("、"))}</small>`:""}</div>`).join("")}</div></details>`);
  return {html:html.join(""),text:txt.join("\n"),bad:!!bad,n:chk.length};}
// 场外的计数：墓场里的洞察之球、牌组里单位的增益（埃兰）
function extraLine(E){const out=[];for(const sd of["me","op"]){const S=E.s.sides[sd];const p=[];
  (S.graveWatch||[]).forEach(w=>p.push("墓场 "+(w.name==="Orb of Insight"?"洞察之球":w.name)+" 计"+(w.vars.count==null?3:w.vars.count)));
  const db=Object.values(S.deckBuff||{}).reduce((a,L)=>a+L.reduce((x,y)=>x+y,0),0);if(db)p.push("牌组增益共 +"+db);
  if(p.length)out.push(sideN(sd)+"："+p.join("，"));}
  return out.length?`<p class="note coins">${esc(out.join("　"))}</p>`:"";}
function simBoard(g,r,excl){const S=sim(g,r,excl);if(!S)return null;const R={me:{m:[],r:[]},op:{m:[],r:[]}},all={};
  for(const s of["me","op"])for(const w of["m","r"])for(const u of S.E.s.sides[s].rows[w]){const k=S.u2key.get(u)||("?"+u.uid);const o={uid:k,n:u.name,side:s,row:w,eu:u};R[s][w].push(o);all[k]=o;}
  return{R,all,F:g.log.filter(x=>x.r===r&&x.a==="fx"),S};}

