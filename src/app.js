const FN={NR:"北方王国",MO:"怪兽",NG:"尼弗迦德",ST:"松鼠党",SK:"斯凯利格",SY:"辛迪加",NE:"中立"};
const OPP=["NR","MO","NG","ST","SK","SY"];
const C=RAW.map((r,i)=>({i,n:r[0],f:r[1],col:r[2],t:r[3],pw:r[4],pv:parseInt(r[5])||0,rar:r[6],tags:r[7],tx:r[8],en:r[9]||"",txe:r[10]||"",ser:r[11]||"",art:r[12]||"",ar:r[13]||"-"}));
C.forEach(c=>{c.orig={pw:c.pw,pv:c.pv,tx:c.tx};c.token=c.ser==="token";});
const EN2ZH={};C.forEach(c=>{if(c.en&&c.en!==c.n)EN2ZH[c.en]=c.n;});
const BY={};C.forEach(c=>BY[c.n]=c);
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
  // 亢奋：先看这张牌打出时记的“成立/不成立”，再按记了手牌时推算的手牌数
  const frenzyOf=req=>{const i=log.indexOf(curX);for(let j=i;j>=0;j--){const y=log[j];if(y.c===req.source&&y.who===req.side&&y.fz!=null)return y.fz;}
    if(req.side==="me"&&g.hand&&curX){const n=myHand(g,curX.id).length-(curX.a==="play"&&curX.who==="me"&&!curX.via?1:0);return n<=req.n;}return null;};
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
  if(r>0&&g.log.some(x=>x.r===r-1)){const P=sim(g,r-1);
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
  const consumed=new Set();let acted=false;
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
      case "leader":case "tactic":{const nm=x.c||(side==="me"?g.leader:g.opLeader);if(nm)E.useAbility(side,nm,{force:true,row:subs[0]&&subs[0].row,pos:subs[0]&&subs[0].pos});else warns.push({id:x.id,m:"领袖未指定"});break;}
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
  const res={E,key2u,u2key,warns,unmod,score:{me:E.score("me"),op:E.score("op")}};
  simCache={key,res};return res;}
// 场外的计数：墓场里的洞察之球、牌组里单位的增益（埃兰）
function extraLine(E){const out=[];for(const sd of["me","op"]){const S=E.s.sides[sd];const p=[];
  (S.graveWatch||[]).forEach(w=>p.push("墓场 "+(w.name==="Orb of Insight"?"洞察之球":w.name)+" 计"+(w.vars.count==null?3:w.vars.count)));
  const db=Object.values(S.deckBuff||{}).reduce((a,L)=>a+L.reduce((x,y)=>x+y,0),0);if(db)p.push("牌组增益共 +"+db);
  if(p.length)out.push(sideN(sd)+"："+p.join("，"));}
  return out.length?`<p class="note coins">${esc(out.join("　"))}</p>`:"";}
function simBoard(g,r,excl){const S=sim(g,r,excl);if(!S)return null;const R={me:{m:[],r:[]},op:{m:[],r:[]}},all={};
  for(const s of["me","op"])for(const w of["m","r"])for(const u of S.E.s.sides[s].rows[w]){const k=S.u2key.get(u)||("?"+u.uid);const o={uid:k,n:u.name,side:s,row:w,eu:u};R[s][w].push(o);all[k]=o;}
  return{R,all,F:g.log.filter(x=>x.r===r&&x.a==="fx"),S};}

const isLeader=c=>c.t==="领袖能力", isTactic=c=>c.t==="战术";
// 小局开始时历变的牌（用户确认：只有在手牌里才会变，在牌组里不变）：第 i 次历变变成 chain[i]；dev = 这一步要求赤诚（上一形态卡面写“赤诚：……历变”）
const EVOLVE={"维拉克萨斯王子":[{n:"流放者维拉克萨斯"},{n:"维拉克萨斯国王",dev:true}],"奥贝伦王":[{n:"入侵者奥贝伦"}],"哈罗德·奎特":[{n:"好战者哈罗德"}],"新王艾思娜":[{n:"慈母艾思娜"}],"神童贾奎斯":[{n:"艾德斯伯格的贾奎斯"}],"篡位者 - 军官":[{n:"篡位者 - 将军"}]};
const EVBASE={};for(const[b,ch]of Object.entries(EVOLVE))ch.forEach(x=>EVBASE[x.n]=b);
const baseOf=n=>EVBASE[n]||n;
// 手牌里的牌历变了几次：从抽到它的那一局之后，每个小局开始变一次（起手牌算第 1 局抽到）
function handForm(g,n,vr,dev){const b=baseOf(n);const x=g.log.find(y=>y.who==="me"&&y.a==="draw"&&y.r<=vr&&(y.cards||[y.c]).some(m=>baseOf(m)===b));return formOf(b,x?vr-x.r:0,dev);}
function formOf(n,r,dev){let cur=n;const ch=EVOLVE[n]||[];for(let i=0;i<r&&i<ch.length;i++){if(ch[i].dev&&!dev)break;cur=ch[i].n;}return cur;}
// 赤诚：起始牌组没有中立牌
const devotionOf=d=>!!d&&Object.keys(d.cards).every(n=>!BY[n]||BY[n].f!=="NE");
const maxCopy=c=>c.col==="铜"?2:1;
const KEY="gwent-tracker-v3",OLDKEYS=["gwent-tracker-v2","gwent-tracker-v1"];
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));

// ---------- seed data ----------
const BASE=["落难的少女","水路突袭","法利波","安赛斯王子","赤红男爵","少女的盾牌","骑士册封","雷纳德·奥多","贝罗恒王","不朽者","亚特里的温德哈姆","不朽者骑兵","游侠骑士","游侠骑士","疯狂的冲锋","科德温骑士","科德温骑士","拉多维德皇家护卫","骑士随从","辛特拉骑士","神殿守卫","瑞达尼亚骑士","瑞达尼亚骑士"];
const toMap=a=>a.reduce((m,n)=>(m[n]=(m[n]||0)+1,m),{});
function seed(){return{v:3,owned:{},decks:[],games:[],live:null,nextId:1,edits:{},custom:[],tactics:[]};}
let db=seed();
let ui={cfilOpen:typeof matchMedia!=="undefined"&&matchMedia("(min-width:1100px)").matches,tab:"match",deckSel:2,collF:"NR",collQ:"",collOwned:false,deckQ:"",who:"me",act:"play",q:"",statA:1,statB:2};
let setup={deck:2,fac:null,coin:null};

// ---------- storage ----------
const hasCS=!!(window.storage&&typeof window.storage.get==="function");
async function readRaw(){if(hasCS){try{const r=await window.storage.get(KEY,false);if(r&&r.value)return r.value;}catch(e){}}
  try{return localStorage.getItem(KEY);}catch(e){return null;}}
async function writeRaw(s){let ok=false;if(hasCS){try{await window.storage.set(KEY,s,false);ok=true;}catch(e){}}
  try{localStorage.setItem(KEY,s);ok=true;}catch(e){}return ok;}
function importObj(d){if(d&&(d.v===2||d.v===3)&&d.decks&&d.games){db=Object.assign(seed(),d,{v:3});migrate();addCustom();applyEdits();return true;}
  if(d&&d.versions&&d.games){const map={"北方领域":"NR","怪兽":"MO","尼弗迦德":"NG","松鼠党":"ST","史凯利杰":"SK","辛迪加":"SY"};
    d.games.forEach(x=>{let dk=db.decks.find(k=>k.name===x.ver);if(!dk){dk={id:db.nextId++,name:x.ver,f:"NR",leader:"皇家激励",tactic:"",cards:toMap((d.versions.find(v=>v.name===x.ver)||{cards:[]}).cards)};db.decks.push(dk);}
      db.games.push({id:x.id,date:x.date,deck:dk.id,deckName:dk.name,myF:dk.f,leader:dk.leader,fac:map[x.fac]||x.fac,coin:x.coin,rounds:x.r.filter(Boolean).map(r=>({res:r,me:"",op:""})),diff:x.diff,log:[],stuck:x.stuck||[],note:x.note||"",res:x.res});});
    migrate();return true;}
  return false;}
function importData(s){try{if(!importObj(JSON.parse(s)))throw 0;persist();ui.deckSel=db.decks[0]?.id;setup.deck=ui.deckSel;ui.statA=db.decks[0]?.id;ui.statB=db.decks[db.decks.length-1]?.id;render();toast("已导入");return true;}catch(e){toast("数据格式不对");return false;}}
function migrate(){const m=n=>EN2ZH[n]||n;let ch=false;const mm=n=>{const r=m(n);if(r!==n)ch=true;return r;};
  const o={};for(const[n,k]of Object.entries(db.owned||{}))o[mm(n)]=Math.max(o[mm(n)]||0,k);db.owned=o;
  (db.decks||[]).forEach(d=>{const c={};for(const[n,k]of Object.entries(d.cards))c[mm(n)]=(c[mm(n)]||0)+k;d.cards=c;if(d.leader)d.leader=mm(d.leader);if(d.tactic)d.tactic=mm(d.tactic);});
  const fixG=g=>{if(!g)return;g.log.forEach(x=>{if(x.c)x.c=mm(x.c);});if(g.stuck)g.stuck=g.stuck.map(mm);if(g.opLeader)g.opLeader=mm(g.opLeader);if(g.leader)g.leader=mm(g.leader);};
  (db.games||[]).forEach(fixG);fixG(db.live);db.edits=db.edits||{};return ch;}
function addCustom(){(db.custom||[]).forEach(x=>{if(BY[x.n])return;const c={i:C.length,n:x.n,f:x.f,col:x.col,t:x.t,pw:x.pw||"-",pv:+x.pv||0,rar:"",tags:"自定义",tx:x.tx||"",en:"",txe:"",ser:"custom",custom:true};c.orig={pw:c.pw,pv:c.pv,tx:c.tx};C.push(c);BY[c.n]=c;});}
// 双阵营牌：数据里只有一个阵营，另一个阵营写在这里；用户可在卡牌详情里改（存进 edits.f2）
const DUAL={"神殿守卫":["NR"]};
// 按类别整组跨阵营：带这些类别的牌也属于对应阵营（用户说明：火誓者北方王国也能用）
const DUAL_TAG={"火誓者":["NR"]};
const dualOf=c=>{const out=new Set(DUAL[c.n]||[]);for(const[t,fs]of Object.entries(DUAL_TAG))if(c.f!=="NE"&&(c.tags||"").split(/[,、]\s*/).includes(t))fs.forEach(f=>{if(f!==c.f)out.add(f);});return[...out];};
const inFac=(c,f)=>c.f===f||(c.f2||[]).includes(f);
function applyEdits(){C.forEach(c=>{const e=db.edits[c.n];Object.assign(c,c.orig,{alias:"",f2:(e&&e.f2)||dualOf(c)});if(e){if(e.pv!=null)c.pv=e.pv;if(e.pw!=null)c.pw=e.pw;if(e.tx)c.tx=e.tx;c.alias=e.alias||"";}});}
async function load(){try{const raw=await readRaw();if(raw)db=JSON.parse(raw);}catch(e){}
  if(!db.games.length&&!db.decks.length){for(const k of OLDKEYS){try{const s=localStorage.getItem(k);if(s){ui.oldData=s;break;}}catch(e){}}}
  if(migrate())persist();addCustom();applyEdits();
  if(!db.decks.find(d=>d.id===ui.deckSel))ui.deckSel=db.decks[0]?.id;setup.deck=ui.deckSel;
  ui.statA=db.decks[0]?.id;ui.statB=db.decks[db.decks.length-1]?.id;render();}
let saveT;function persist(){clearTimeout(saveT);saveT=setTimeout(async()=>{if(!await writeRaw(JSON.stringify(db)))toast("浏览器不允许保存，请用「下载备份」存成文件");},250);}
function toast(t){const e=$("#toast");e.textContent=t;e.classList.add("show");clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove("show"),1700);}

// ---------- helpers ----------
const deckById=id=>db.decks.find(d=>d.id==id);
function deckInfo(d){let n=0,pv=0,units=0,bad=[];for(const[name,k]of Object.entries(d.cards)){const c=BY[name];n+=k;if(c){pv+=c.pv*k;if(c.t==="单位")units+=k;}else bad.push(name);}
  const L=BY[d.leader];const lim=150+(L?L.pv:0);return{n,pv,lim,units,bad};}
function outcome(rs){let w=0,l=0;rs.forEach(r=>{if(r.res==="W")w++;else if(r.res==="L")l++;else if(r.res==="D"){w++;l++;}});
  if(w>=2&&l>=2)return{res:"平",w,l};if(w>=2)return{res:"胜",w,l};if(l>=2)return{res:"负",w,l};return null;}
function search(q,pool,prio,facs){q=q.trim();if(!q)return[];const ql=q.toLowerCase();const out=[];for(const c of pool){let p=c.n.toLowerCase().indexOf(ql);if(p<0&&c.alias)p=c.alias.toLowerCase().indexOf(ql)>=0?5:-1;if(p<0&&c.en)p=c.en.toLowerCase().indexOf(ql)>=0?20:-1;if(p<0)continue;out.push([c,(prio&&prio.has(c.n)?-200:0)+(facs&&!facs.some(f=>inFac(c,f))?100:0)+p+c.n.length/100]);}
  return out.sort((a,b)=>a[1]-b[1]).slice(0,10).map(x=>x[0]);}
function cardTag(c){return c?`<span class="tag ${c.col==="金"?"gold":"bronze"}">${c.col==="领袖"?"领":c.col}${c.pv?" "+c.pv:""}</span>`:"";}
// opts.paste：导入类对话框显示“点击粘贴”；opts.file：显示选择文件
function openDlg(title,note,text,okLabel,onOk,opts){opts=opts||{};$("#fileIn").classList.toggle("hidden",!opts.file);$("#dlgPaste").classList.toggle("hidden",!opts.paste);$("#dlgT").textContent=title;$("#dlgN").textContent=note;$("#dlgX").value=text;$("#dlgOk").textContent=okLabel;
  $("#dlgOk").onclick=()=>{onOk($("#dlgX").value);};$("#dlg").showModal();}
function copyOut(title,text){openDlg(title,"已尝试复制到剪贴板。没复制上的话，长按下面的内容全选复制。",text,"再复制一次",t=>copy(t));copy(text);}
function copy(t){try{navigator.clipboard.writeText(t).then(()=>toast("已复制")).catch(()=>{});}catch(e){}}
$("#dlgNo").onclick=()=>$("#dlg").close();
$("#dlgPaste").onclick=async()=>{try{const t=await navigator.clipboard.readText();if(!t)return toast("剪贴板是空的");$("#dlgX").value=t;toast("已粘贴");}catch(e){$("#dlgX").focus();toast("浏览器不让读剪贴板，请在框里按 Ctrl+V");}};
// 全部迁移：整个对局簿（卡组、对局、进行中的对局、牌库、改过的牌、自定义牌）
const MIGHEAD="#GWMIG v1 昆特对局簿全部数据，用“全部导入”载入";
function migText(){return MIGHEAD+"\n"+JSON.stringify(db);}
function parseAll(txt){txt=(txt||"").trim();if(txt.startsWith("#GWMIG"))txt=txt.slice(txt.indexOf("\n")+1);return JSON.parse(txt);}

// ---------- export codes ----------
function deckCode(d){const i=deckInfo(d);const L=[`【昆特卡组】${d.name}`,`阵营：${FN[d.f]}｜领袖：${d.leader||"未选"}｜战术：${d.tactic||"未填"}`,`张数 ${i.n}｜粮草 ${i.pv}/${i.lim}｜单位 ${i.units}`];
  const rows=Object.entries(d.cards).map(([n,k])=>[BY[n],n,k]).sort((a,b)=>((b[0]?.col==="金")-(a[0]?.col==="金"))||((b[0]?.pv||0)-(a[0]?.pv||0)));
  rows.forEach(([c,n,k])=>L.push(`${k}× ${n}（${c?c.col+" "+c.t+" "+c.pv:"数据库无此牌"}）`));return L.join("\n");}
function collCode(){const L=["【昆特牌库】"];for(const f of ["NR","NE","MO","NG","ST","SK","SY"]){
  const all=C.filter(c=>c.f===f&&!isTactic(c)&&!isLeader(c)&&!c.token);const own=all.filter(c=>db.owned[c.n]>0);if(!own.length)continue;
  L.push(`${FN[f]}（${own.length}/${all.length} 种）：`+own.map(c=>c.n+(db.owned[c.n]>1?"×"+db.owned[c.n]:"")).join("、"));}return L.join("\n");}
const ACT={coin:"金币",adj:"改战力",play:"打出",order:"指令",leader:"领袖",tactic:"战术",effect:"效果",spawn:"生成",summon:"召唤",draw:"抽牌",fx:"整排效果",move:"移位",kill:"摧毁",mull:"换牌",pass:"停牌",note:"备注"};
const FX=["霜","雨","雾","风暴","龙之梦","血月","灾厄"];
const ROWN={m:"近战",r:"远程",all:"整个半场"};
const ART=a=>a?`https://gwent.one/image/gwent/assets/card/art/medium/${a}.jpg`:"";
const thumb=c=>c&&c.art?`<img class="art" loading="lazy" src="${ART(c.art)}" alt="" onerror="this.remove()">`:"";
function tile(n,badge,cls,attrs){const c=BY[n];return `<button class="tile ${c?(c.col==="金"?"g":c.col==="领袖"?"l":"b"):""} ${cls||""}" ${attrs||""}>
  ${c&&c.art?`<img loading="lazy" src="${ART(c.art)}" alt="" onerror="this.remove()">`:""}
  ${c&&c.pv?`<span class="pv">${c.pv}</span>`:""}${c&&c.t==="单位"&&c.pw!=="-"?`<span class="pw"><i>${c.pw}</i></span>`:""}${c&&c.ar&&c.ar!=="-"&&c.ar!=="0"?`<span class="ar">${c.ar}</span>`:""}
  <span class="nm">${esc(n)}</span>${badge?`<span class="bd">${badge}</span>`:""}</button>`;}
const segs=(c,kind)=>{if(!c)return[];const s=c.tx.split(" / ");if(kind==="order"||kind==="leader")return s.filter(x=>/指令/.test(x));if(c.t==="单位")return s.filter(x=>/部署/.test(x));return s;};
const TGT=/1 ?(?:个|名)(?:敌军|友军)?单位|敌军单位|友军单位|伤害|锁定|中毒|重伤|摧毁 ?1|重置|交锋|对决/;
const PULL=/从(?:己方)?(?:牌组|墓场)[^。/]{0,10}(?:打出|召唤)(?!自身)|生成并打出|创造并打出/;
const SPAWN=/生成|召唤(?!自身)/;
// 生成整排效果（霜、雨……）不是生成单位，走“整排效果”记录
const HZTXT=/(生成)+\s*(霜|雨|雾|风暴|龙之梦|血月|灾厄)|(霜|雨|雾|风暴|龙之梦|血月|灾厄)至/g;
const spawns=(c,kind)=>segs(c,kind).some(s=>{s=s.replace(HZTXT,"");return SPAWN.test(s)&&!PULL.test(s);});
function spawnPicks(c){if(!c)return[];const s=new Set();(c.tx.match(/“([^”]+)”/g)||[]).forEach(q=>{const n=q.slice(1,-1);if(BY[n]&&!isLeader(BY[n]))s.add(n);});if(/自身的基础同名牌|同名牌/.test(c.tx))s.add(c.n);return[...s];}
function spawnStep(c,kind,who,parent){return c&&spawns(c,kind)?[{t:"spawn",who,parent:parent||c.n,picks:spawnPicks(c)}]:[];}
const needsTarget=(c,kind)=>kind==="leader"||segs(c,kind).some(s=>TGT.test(s));
const pulls=(c,kind)=>segs(c,kind).some(s=>PULL.test(s));
const sideN=s=>s==="me"?"我方":"对方";
const VR=()=>{const g=db.live;return ui.vr!=null?ui.vr:g.cur;};
function logText(x){const w=x.who==="me"?"我":"对";
  const tg=x.tgts&&x.tgts.length?" → "+x.tgts.map(t=>t.label).join("、"):(x.tgt?" → "+x.tgt:"");
  const place=x.row?`〔${x.side&&x.side!==x.who?sideN(x.side)+"·":""}${ROWN[x.row]}${x.pos!=null?"·第"+(x.pos+1)+"位":""}〕`:"";
  const via=x.via?`（${x.via}）`:"";
  switch(x.a){
    case "play":case "summon":case "spawn":return `${w}：${via}${ACT[x.a]} ${x.c}${place}${tg}${x.fz!=null?(x.fz?"（亢奋）":"（未亢奋）"):""}${x.dn!=null?"（牌组 "+x.dn+" 单位）":""}`;
    case "order":case "leader":case "tactic":case "effect":return `${w}：${ACT[x.a]}${x.c?" "+x.c:""}${tg}`;
    case "draw":return `${w}：抽牌 ${(x.cards||[x.c]).join("、")}`;
    case "mull":return `${w}：换牌 ${x.c}${x.into?" → "+x.into:""}`;
    case "fx":return `${w}：整排效果 ${x.c} → ${sideN(x.side)}${ROWN[x.row]}${x.dur?"，"+x.dur+" 回合":""}`;
    case "move":return `${w}：${x.fix?"修正位置":"移位"} ${sideN(x.side)}的 ${x.c} → ${ROWN[x.row]}${x.pos!=null?"·第"+(x.pos+1)+"位":""}`;
    case "kill":return `${w}：摧毁 ${sideN(x.side)}的 ${x.c}`;
    case "note":return `${w}：备注 ${x.c}`;
    case "adj":return `${w}：修正 ${sideN(x.side)}的 ${x.c} ${/^\d+$/.test(x.v)?"= "+x.v:x.v}`;
    case "coin":return `${w}：修正${sideN(x.side)}金币 ${/^\d+$/.test(x.v)?"= "+x.v:x.v}`;
    default:return `${w}：${ACT[x.a]||x.a}${x.c?" "+x.c:""}${tg}`;}}
// give every entry a stable id; convert old index-based references
function ensureIds(g){if(!g||g.log.every(x=>x.id))return;const idOf=i=>g.log[i]&&g.log[i].id;g.nextE=g.nextE||1;
  g.log.forEach(x=>{if(!x.id)x.id="e"+(g.nextE++);});
  g.log.forEach(x=>{(x.tgts||[]).forEach(t=>{if(typeof t.uid==="number"&&idOf(t.uid))t.uid=idOf(t.uid);});if(typeof x.uid==="number"&&idOf(x.uid))x.uid=idOf(x.uid);});}
function board(g,r,excl){r=r??VR();try{const B=simBoard(g,r,excl);if(B)return B;}catch(e){console.error(e);}return boardLog(g,r,excl);}
function boardLog(g,r,excl){const R={me:{m:[],r:[]},op:{m:[],r:[]}};const all={};
  const find=(x)=>{if(x.uid!=null&&all[x.uid])return all[x.uid];for(const s of["me","op"])for(const w of["m","r"]){const u=R[s][w].find(u=>u.n===x.c&&(!x.side||u.side===x.side));if(u)return u;}return null;};
  const rm=u=>{const a=R[u.side][u.row];const i=a.indexOf(u);if(i>=0)a.splice(i,1);};
  const ins=(u,row,pos)=>{const a=R[u.side][row];a.splice(pos==null?a.length:Math.min(pos,a.length),0,u);};
  g.log.forEach((x,i)=>{if(x.r!==r||x.id===excl)return;
    if((x.a==="play"||x.a==="summon")&&x.row){const k=x.id||i;const u={uid:k,n:x.c,side:x.side||x.who,row:x.row};all[k]=u;ins(u,x.row,x.pos);}
    else if(x.a==="move"){const u=find(x);if(u){rm(u);u.row=x.row;ins(u,x.row,x.pos);}}
    else if(x.a==="kill"){const u=find(x);if(u){rm(u);delete all[u.uid];}}});
  return{R,all,F:g.log.filter(x=>x.r===r&&x.a==="fx")};}
function myGrave(g){const r=VR();const {all}=board(g,r);const on=new Set(Object.values(all).filter(u=>u.side==="me").map(u=>u.n));const s=new Set();
  g.log.forEach(x=>{if((x.a==="play"||x.a==="summon")&&x.who==="me"&&x.row&&(x.side||"me")==="me"&&x.r<r)s.add(x.c);if(x.a==="kill"&&x.side==="me"&&x.r<=r)s.add(x.c);});
  return[...s].filter(n=>!on.has(n));}
function returners(g,played){const c=BY[played];if(!c||c.t!=="单位")return[];const tags=c.tags||"";
  return myGrave(g).filter(n=>{const r=BY[n];if(!r)return false;const m=r.tx.match(/每打出 ?1 ?个“([^”]+)”单位，便从己方墓场召唤自身/);return m&&tags.includes(m[1]);});}
// my hand, derived from draw / mull / play entries
function myHand(g,uptoId){const h=[];for(const x of g.log){if(uptoId&&x.id===uptoId)break;if(x.who!=="me")continue;
  if(x.a==="draw")(x.cards||[x.c]).forEach(n=>h.push(n));
  else if(x.a==="mull"){const i=h.indexOf(x.c);if(i>=0)h.splice(i,1);if(x.into)h.push(x.into);}
  else if((x.a==="play"||x.a==="summon")&&!x.via){let i=h.indexOf(x.c);if(i<0)i=h.findIndex(n=>baseOf(n)===baseOf(x.c));if(i>=0)h.splice(i,1);}}return h;}
function pushLog(e){const g=db.live;g.nextE=g.nextE||1;const x=Object.assign({r:VR(),id:"e"+(g.nextE++)},e);if(g.t0&&!ui.insertBefore&&ui.vr==null){x.t=Math.round((Date.now()-g.t0)/1000);g.lastT=Date.now();}
  if(ui.insertBefore){const i=g.log.findIndex(y=>y.id===ui.insertBefore);if(i>=0){x.r=g.log[i].r;g.log.splice(i,0,x);persist();return i;}ui.insertBefore=null;}
  g.log.push(x);persist();return g.log.length-1;}
function queue(...steps){ui.flow=[...steps,...(ui.flow||[])];}
function nextStep(){ui.flow=(ui.flow||[]).slice(1);if(!ui.flow.length){ui.flow=null;doSwitch();if(["leader","pass","fx","note","summon"].includes(ui.act))ui.act="play";}ui.q="";ui.sel=[];rMatch();}
function startCard(name,a,who,via){const c=BY[name];
  if(c&&(c.t==="特殊"||c.t==="战术")){const idx=pushLog({who,a,c:name,via:via||undefined});afterCard(idx,name,a,who);return;}
  // 不忠：放到出牌方的对面半场
  const side=c&&/^不忠/.test(c.tx||"")?(who==="me"?"op":"me"):who;
  queue({t:"place",a,who,side,card:name,via});rMatch();}
function afterCard(idx,name,a,who){const g=db.live;const c=BY[name];const st=[];const id=g.log[idx].id;
  if(c&&a==="play"&&needsTarget(c,"play"))st.push({t:"target",id});
  {const m=c&&a==="play"&&(c.tx||"").match(/献金\s*(\d+)/);if(m)st.push({t:"tribute",id,n:+m[1]});}
  {const m=c&&a==="play"&&(c.tx||"").match(/亢奋\s*(\d+)/);if(m&&(who==="op"||!g.hand))st.push({t:"frenzy",id,n:+m[1]});}
  if(c&&a==="play"&&name==="拉尔维克的埃兰"&&(who==="op"||!deckById(g.deck)))st.push({t:"deckCount",id});
  if(c&&a==="play"&&pulls(c,"play"))st.push({t:"pull",who,parent:name});
  if(a==="play")st.push(...spawnStep(c,"play",who,name));
  if(a==="play"&&!g.log[idx].via&&!ui.insertBefore&&ui.vr==null)ui.pendingSwitch=who;
  if(who==="me"&&(a==="play"||a==="summon"))returners(g,name).forEach(n=>st.push({t:"ret",card:n}));
  ui.flow=[...st,...((ui.flow||[]).slice(1))];if(!ui.flow.length){ui.flow=null;doSwitch();}ui.q="";ui.sel=[];
  // 整排效果牌：直接进入整排效果，预填效果和回合数，只需点哪一排
  const hz=a==="play"&&ENG&&GwentCards.behaviors[name]&&GwentCards.behaviors[name].hazardCard;
  if(hz&&!ui.flow){ui.act="fx";ui.fx={k:hz.kind,side:who==="me"?"op":"me",row:"m",dur:hz.turns,who};}
  toast(logText(g.log[idx]));rMatch();}
function doSwitch(){const g=db.live;const w=ui.pendingSwitch;ui.pendingSwitch=null;if(!g||!w)return;const other=w==="me"?"op":"me";
  if(!g.log.some(x=>x.r===VR()&&x.a==="pass"&&x.who===other)){ui.who=other;ui.act="play";ui.q="";}}
const entry=id=>db.live.log.find(x=>x.id===id);
function liveClick(t,D){const g=db.live;if(!g)return false;const step=ui.flow&&ui.flow[0];
  if(D.vr!==undefined){ui.vr=+D.vr===g.cur?null:+D.vr;ui.flow=null;ui.insertBefore=null;rMatch();return true;}
  if(D.nm!==undefined){const n=D.nm;
    if(step&&step.t==="spawn"){const c=BY[n];if(c&&c.t==="特殊"){const i=pushLog({who:step.who,a:"spawn",c:n,via:step.parent});ui.flow=[{t:"target",id:g.log[i].id},...ui.flow.slice(1)];rMatch();return true;}
      ui.flow=[{t:"place",a:"spawn",who:step.who,side:step.who,card:n,via:step.parent},...ui.flow.slice(1)];ui.q="";rMatch();return true;}
    if(ui.act==="spawn"&&!step){startCard(n,"spawn",ui.who);return true;}
    if(step&&step.t==="pull"){ui.flow=[{t:"place",a:"play",who:step.who,side:step.who,card:n,via:step.parent},...ui.flow.slice(1)];ui.q="";rMatch();return true;}
    if(step&&step.t==="rename"){const e=entry(step.id);e.c=n;if(BY[n]&&BY[n].t==="特殊"){delete e.row;delete e.pos;}persist();nextStep();return true;}
    if(step&&step.t==="mullinto"){const e=entry(step.id);e.into=n;persist();nextStep();return true;}
    if(step&&step.t==="hand"){const e=entry(step.id);e.cards.push(n);persist();rMatch();return true;}
    if(ui.act==="draw"){const i=pushLog({who:"me",a:"draw",cards:[n]});toast(logText(g.log[i]));rMatch();return true;}
    if(ui.act==="mull"){const i=pushLog({who:"me",a:"mull",c:n});if(g.hand)queue({t:"mullinto",id:g.log[i].id});toast(logText(g.log[i]));rMatch();return true;}
    if(ui.act==="summon"){startCard(n,"summon",ui.who);return true;}
    startCard(n,"play",ui.who);return true;}
  if(D.slot){const [s,r,p]=D.slot.split("|");
    if(step.editId){const e=entry(step.editId);e.row=r;e.pos=+p;if(e.a==="move"){e.side=s;}else{if(s!==e.who)e.side=s;else delete e.side;}persist();nextStep();return true;}
    if(step.move){const i=pushLog({who:ui.who,a:"move",c:step.card,uid:step.uid,side:s,row:r,pos:+p});ui.flow=ui.flow.slice(1);if(!ui.flow.length)ui.flow=null;toast(logText(g.log[i]));rMatch();return true;}
    const i=pushLog({who:step.who,a:step.a,c:step.card,side:s!==step.who?s:undefined,row:r,pos:+p,via:step.via||undefined});
    afterCard(i,step.card,step.a,step.who);return true;}
  if(D.side&&step&&step.t==="place"){step.side=D.side;rMatch();return true;}
  if(D.u!==undefined){const {all}=board(g);const u=all[D.u]||all[+D.u];if(!u)return true;
    if(D.umode==="multi"){const s=ui.sel=ui.sel||[];const k=s.findIndex(x=>x.uid===u.uid);if(k>=0)s.splice(k,1);else s.push({uid:u.uid,label:sideN(u.side)+" "+u.n});rMatch();return true;}
    // 指令、触发效果属于点到的单位那一方（打完牌后界面已切到对方，我方接着用指令也不会记错）
    if(ui.act==="order"||ui.act==="effect"){const i=pushLog({who:u.side,a:ui.act,c:u.n,uid:u.uid});const c=BY[u.n];queue({t:"target",id:g.log[i].id},...(ui.act==="order"?spawnStep(c,"order",u.side):[]));toast(logText(g.log[i]));rMatch();return true;}
    if(ui.act==="move"){queue({t:"place",move:true,card:u.n,uid:u.uid,side:u.side});rMatch();return true;}
    if(ui.act==="adj"){const eu=u.eu;const last=g.log.filter(x=>x.r===VR()).pop();
      const st=eu?eu.status:{};const has=[st.shield?"盾":"",st.lock?"锁":"",st.resilience?"坚":"",st.veil?"遮":"",st.vitality?"活"+st.vitality:"",st.bleed?"伤"+st.bleed:""].filter(Boolean).join(" ");
      openDlg("修正 "+u.n,"当前 "+(eu?eu.power:"?")+"（基础 "+(eu?eu.base:"?")+"，护甲 "+(eu?eu.armor:0)+(has?"，"+has:"")+"）。战力：+n / -n / 目标值；状态：-盾 +盾 -锁 +坚 ±潜 ±伏 ±赏，甲3 设护甲，活2 伤2 设回合（0 去掉）。多项用逗号隔开。",st.shield?"-盾":(eu?String(eu.power):""),"记录",v=>{v=(v||"").trim().replace(/[，\s]+/g,",");if(!v)return;$("#dlg").close();
        if(last&&last.id===u.uid&&last.a==="play"&&/^\d+$/.test(v)){last.pw=+v;persist();toast("落地战力 "+v);}
        else{const i=pushLog({who:ui.who,a:"adj",c:u.n,uid:u.uid,side:u.side,v});toast(logText(g.log[i]));}rMatch();});return true;}
    if(ui.act==="kill"){const i=pushLog({who:ui.who,a:"kill",c:u.n,uid:u.uid,side:u.side});toast(logText(g.log[i]));rMatch();return true;}
    return true;}
  if(D.rowpick){const s=ui.sel=ui.sel||[];const k=s.findIndex(x=>x.row===D.rowpick);const lab=(D.rowpick.startsWith("me")?"我方":"对方")+ROWN[D.rowpick.slice(-1)]+"排";
    if(k>=0)s.splice(k,1);else s.push({row:D.rowpick,label:lab});rMatch();return true;}
  if(D.fixstep){ui.flow=[JSON.parse(D.fixstep)];rMatch();window.scrollTo(0,0);return true;}
  if(D.fixtgt){const e=entry(D.fixtgt);ui.sel=(e.tgts||[]).slice();ui.flow=[{t:"target",id:e.id}];rMatch();window.scrollTo(0,0);return true;}
  if(D.edit){ui.flow=[{t:"edit",id:D.edit}];rMatch();window.scrollTo(0,0);return true;}
  if(D.oplead){g.opLeader=D.oplead;const i=pushLog({who:"op",a:"leader",c:D.oplead});ui.act="play";queue({t:"target",id:g.log[i].id},...spawnStep(BY[D.oplead],"leader","op"));rMatch();return true;}
  if(D.fz!==undefined&&step&&step.t==="frenzy"){const e=entry(step.id);if(e){e.fz=D.fz==="1";persist();}nextStep();return true;}
  if(D.dn!==undefined&&step&&step.t==="deckCount"){const e=entry(step.id);const v=D.dn==="?"?parseInt($("#dnIn")?.value):+D.dn;if(e&&!isNaN(v)){e.dn=v;persist();}nextStep();return true;}
  if(D.trib!==undefined&&step&&step.t==="tribute"){const e=entry(step.id);if(e){e.pay=D.trib==="1";persist();}nextStep();return true;}
  if(D.coinfix){const sd=D.coinfix;const S0=sim(g,VR());const cur=S0?S0.E.s.sides[sd].coins:0;
    openDlg(sideN(sd)+"金币","推算现有 "+cur+" 个。输入 +n / -n 或实际数量：",String(cur),"记录",v=>{v=(v||"").trim();if(!v)return;$("#dlg").close();const i=pushLog({who:sd,a:"coin",side:sd,v});toast(logText(g.log[i]));rMatch();});return true;}
  if(D.hzfx){const [sd,w,k]=D.hzfx.split("|");const i=pushLog({who:sd,a:"effect",c:k,row:w});queue({t:"target",id:g.log[i].id});toast(logText(g.log[i]));rMatch();return true;}
  if(D.fxk){ui.fx.k=D.fxk;const H=ENG&&ENG.HAZARDS[D.fxk];if(H)ui.fx.dur=H.turns;rMatch();return true;}
  if(D.fxside){ui.fx.side=D.fxside;rMatch();return true;}
  if(D.fxrow){ui.fx.row=D.fxrow;rMatch();return true;}
  if(D.fxdur){ui.fx.dur=Math.max(0,Math.min(9,ui.fx.dur+ +D.fxdur));rMatch();return true;}
  if(D.hrm!==undefined&&step&&step.t==="hand"){const e=entry(step.id);e.cards.splice(+D.hrm,1);persist();rMatch();return true;}
  const sw=(d)=>{const e=entry(step.id);const i=g.log.indexOf(e);let j=i+d;while(j>=0&&j<g.log.length&&g.log[j].r!==e.r)j+=d;if(j<0||j>=g.log.length)return toast("已经到头了");g.log.splice(i,1);g.log.splice(j,0,e);persist();rMatch();};
  const A={
    tgtDone(){const e=entry(step.id);e.tgts=(ui.sel||[]).slice();delete e.tgt;persist();nextStep();},
    flowSkip(){nextStep();},
    flowCancel(){ui.flow=null;ui.q="";rMatch();},
    noPlace(){const i=pushLog({who:step.who,a:step.a,c:step.card,via:step.via||undefined});afterCard(i,step.card,step.a,step.who);},
    retYes(){ui.flow=[{t:"place",a:"summon",who:"me",side:"me",card:step.card,via:"墓场"},...ui.flow.slice(1)];rMatch();},
    leader(){const i=pushLog({who:"me",a:"leader",c:g.leader||null});ui.act="play";queue({t:"target",id:g.log[i].id},...spawnStep(BY[g.leader],"leader","me"));rMatch();},
    tactic(){const nm=deckById(g.deck)?.tactic||"战术";const i=pushLog({who:"me",a:"tactic",c:nm});ui.act="play";queue({t:"target",id:g.log[i].id},...spawnStep(BY[nm],"leader","me"));rMatch();},
    tacticOp(){const i=pushLog({who:"op",a:"tactic",c:"战术"});ui.act="play";queue({t:"target",id:g.log[i].id});rMatch();},
    pass(){const i=pushLog({who:ui.who,a:"pass"});ui.act="play";if(!ui.insertBefore&&ui.vr==null){ui.pendingSwitch=ui.who;doSwitch();}toast(logText(g.log[i]));rMatch();},
    fxRec(){const f=ui.fx;const i=pushLog({who:f.who||ui.who,a:"fx",c:f.k,side:f.side,row:f.row,dur:f.dur||null});ui.fx=null;ui.act="play";toast(logText(g.log[i]));rMatch();},
    noteRec(){const v=($("#noteIn").value||"").trim();if(!v)return toast("写点内容");pushLog({who:ui.who,a:"note",c:v});ui.act="play";rMatch();},
    undo(){const r=VR();const idx=g.log.map((x,i)=>[x,i]).filter(([x])=>x.r===r).pop();if(!idx)return;const x=g.log.splice(idx[1],1)[0];ui.flow=null;persist();rMatch();toast("已撤销："+logText(x));},
    handStart(){const i=pushLog({who:"me",a:"draw",cards:[]});ui.flow=[{t:"hand",id:g.log[i].id}];rMatch();},
    handDone(){const e=entry(step.id);if(!e.cards.length){g.log.splice(g.log.indexOf(e),1);}persist();nextStep();},
    eUp(){sw(-1);},eDown(){sw(1);},
    eDel(){const e=entry(step.id);g.log.splice(g.log.indexOf(e),1);persist();nextStep();},
    eRename(){ui.flow=[{t:"rename",id:step.id}];ui.q="";rMatch();},
    eFlip(){const e=entry(step.id);const i=g.log.indexOf(e);const from=e.who,to=from==="me"?"op":"me";
      // 连同这张牌带出的后续记录一起改方；落在自己一侧的，位置也跟着换边
      const fl=x=>{if(!x.side||x.side===from)x.side=to;x.who=to;};fl(e);
      for(let j=i+1;j<g.log.length;j++){const y=g.log[j];if(y.via&&y.via===e.c&&y.who===from)fl(y);else if(!y.via)break;}
      persist();toast("已改为"+sideN(to));rMatch();},
    ePlace(){const e=entry(step.id);ui.flow=[{t:"place",editId:e.id,card:e.c,side:e.side||e.who,who:e.who,move:e.a==="move"}];rMatch();},
    eTgt(){const e=entry(step.id);ui.sel=(e.tgts||[]).slice();ui.flow=[{t:"target",id:e.id}];rMatch();},
    eInsert(){ui.insertBefore=step.id;ui.flow=null;rMatch();toast("插入模式：新记录会放在这一步之前");},
    insertOff(){ui.insertBefore=null;rMatch();},
    handToggle(){g.hand=!g.hand;db.handPref=g.hand;persist();rMatch();}
  };
  if(D.do&&A[D.do]){A[D.do]();return true;}
  return false;}

const LEGEND="#GWLOG v1 行=序号 方(A我B对) 动作(P打出 S召唤 Y生成衍生牌 T战术 E触发效果(牌=来源单位) O指令 L领袖 D抽牌(逗号分隔) F整排 V移位(V!=修正记录错误,非游戏内移动) K摧毁 J修正战力(+n增益 -n伤害 n设定) G金币修正(方 +n/-n/n) $付/$不付=献金 !亢/!不亢=亢奋是否成立 #n=牌组里的单位数(埃兰) X换牌(+换来的牌) -停牌 N备注) 牌 位置(m近r远+从0起序号,前缀X=放在出牌方的对面半场) >目标(序号或排如Bm,8/0=第8步带出的第1个单位) <来源(序号,G=墓场) ; R行=局 结果 比分 结束手牌我:对 用时秒";
const ACODE={coin:"G",adj:"J",draw:"D",play:"P",tactic:"T",effect:"E",spawn:"Y",summon:"S",order:"O",leader:"L",fx:"F",move:"V",kill:"K",mull:"X",pass:"-",note:"N"};
function gameCodeC(g){const o=outcome(g.rounds)||{w:0,l:0,res:"?"};const num={};let n=0;g.log.forEach((x,i)=>{n++;num[x.id||i]=n;x._n=n;});
  const byIdx0=(k)=>{if(k==null)return"?";return num[k]!=null?num[k]:(typeof k==="number"&&g.log[k]?g.log[k]._n:"?");};
  // 由某步产生的单位（生成的衍生牌等）键为 “e8/0”，导出成 “8/0”
  const byIdx=(k)=>{if(typeof k==="string"&&k.includes("/")){const [a,b]=k.split("/");return byIdx0(a)+"/"+b;}return byIdx0(k);};
  const L=[`G ${g.date} ${g.deckName}|${g.leader||"-"} vs ${g.fac}|${g.opLeader||"-"} ${g.coin||"?"} ${o.w}:${o.l}`];
  g.rounds.forEach((r,ri)=>{L.push(`R${ri+1} ${r.res} ${r.me||"-"}:${r.op||"-"} ${r.hm??"-"}:${r.ho??"-"}${r.sec!=null?" "+r.sec:""}`);
    g.log.forEach((x,i)=>{if(x.r!==ri)return;const p=[x._n,x.who==="me"?"A":"B",(ACODE[x.a]||x.a)+(x.fix?"!":"")];
      if(x.a==="fx")p.push(x.c,(x.side==="me"?"A":"B")+(x.row==="all"?"*":x.row)+(x.dur?"/"+x.dur:""));
      else{if(x.a==="draw")p.push((x.cards||[]).join(","));if(x.c)p.push(x.c.replace(/\s+/g,"_"));if(x.into)p.push("+"+x.into);
        if(x.row)p.push((x.side&&x.side!==x.who?"X":"")+x.row+(x.pos??""));
        if(x.a==="adj")p.push("@"+(x.uid!=null?byIdx(x.uid):"")+(x.side==="me"?"A":"B"),x.v);
        if(x.a==="coin")p.push(x.side==="me"?"A":"B",x.v);
        if(x.pay!=null)p.push(x.pay?"$付":"$不付");
        if(x.fz!=null)p.push(x.fz?"!亢":"!不亢");
        if(x.dn!=null)p.push("#"+x.dn);
        if(x.pw!=null)p.push("="+x.pw);
        if(x.a==="move"||x.a==="kill")p.push("@"+(x.uid!=null?byIdx(x.uid):"")+(x.side==="me"?"A":"B"));
        const tg=(x.tgts||[]).map(t=>t.row?(t.row.startsWith("me")?"A":"B")+t.row.slice(-1):byIdx(t.uid));if(tg.length)p.push(">"+tg.join(","));else if(x.tgt)p.push(">"+x.tgt.replace(/\s+/g,""));
        if(x.via){if(x.via==="墓场")p.push("<G");else{let k=-1;for(let j=i-1;j>=0;j--)if(g.log[j].c===x.via){k=j;break;}p.push("<"+(k>=0?g.log[k]._n:x.via));}}}
      L.push(p.join(" "));});});
  if(g.stuck?.length)L.push("STUCK "+g.stuck.join(","));if(g.note)L.push("NOTE "+g.note.replace(/\n/g," "));
  g.log.forEach(x=>delete x._n);return L.join("\n");}
function gameCode(g){const o=g.rounds?outcome(g.rounds):null;const L=[`【昆特对局】${g.date}｜${g.deckName} vs ${FN[g.fac]||g.fac}｜${g.coin?g.coin+"手":"先后手未记"}｜结果 ${o?o.w+":"+o.l+" "+o.res:"未完成"}`];
  g.rounds.forEach((r,ri)=>{const sc=(r.me!==""&&r.me!=null&&r.op!==""&&r.op!=null)?` 比分 ${r.me}:${r.op}`:"";const hd=(r.hm!=null&&r.ho!=null)?`｜结束时手牌 我${r.hm} 对${r.ho}`:"";L.push(`第${ri+1}局 ${{W:"赢",L:"输",D:"平"}[r.res]||"?"}${sc}${hd}`);
    g.log.filter(x=>x.r===ri).forEach(x=>L.push("  "+logText(x)));});
  if(g.diff!=null&&!(g.rounds[0]&&g.rounds[0].hm!=null))L.push(`第一局结束牌差：${g.diff>0?"+":""}${g.diff}`);if(g.stuck?.length)L.push("卡手："+g.stuck.join("、"));if(g.note)L.push("备注："+g.note);return L.join("\n");}

// ---------- render ----------
function render(){$("#count").textContent=db.games.length+" 局";
  document.querySelectorAll("nav button[data-t]").forEach(b=>b.classList.toggle("on",b.dataset.t===ui.tab));
  ["match","stats","deck","coll"].forEach(k=>$("#tab-"+k).classList.toggle("hidden",k!==ui.tab));
  ({match:rMatch,stats:rStats,deck:rDeck,coll:rColl})[ui.tab]();}

function facChips(sel,attr){return OPP.map(f=>`<button class="chip fac ${sel===f?"on":""}" style="--c:var(--${f})" data-${attr}="${f}">${FN[f]}</button>`).join("");}

function bindSearch(id,set,update){const el=$(id);if(!el)return;let comp=false;
  el.addEventListener("compositionstart",()=>comp=true);
  el.addEventListener("compositionend",e=>{comp=false;set(e.target.value);update();});
  el.addEventListener("input",e=>{set(e.target.value);if(!comp&&!e.isComposing)update();});}

function matchRes(){const g=db.live,d=deckById(g.deck);const pool=C.filter(c=>!isLeader(c)&&!isTactic(c));const facs=ui.who==="me"?[g.myF,"NE"]:[g.fac,"NE"];
  const myNames=new Set(d?Object.keys(d.cards):[]);const q=ui.q.trim();if(!q)return `<p class="note">输入牌名搜索，英文名也能搜。</p>`;
  const res=search(q,pool,ui.who==="me"?myNames:null,facs);
  return `<div class="grid">${res.map(c=>tile(c.n,"","",`data-nm="${esc(c.n)}"`)).join("")}</div>`+(res.length?"":`<button class="res" data-nm="${esc(q)}"><span class="rn">按原文记录「${esc(q)}」</span><small>数据库没有</small></button>`);}
function rMatch(){const g=db.live;let h="";{const st=document.documentElement.style;st.setProperty("--mine",`var(--${g?.myF||deckById(setup.deck)?.f||"NR"})`);st.setProperty("--theirs",`var(--${g?.fac||setup.fac||"MO"})`);}
  if(!g){if(ui.oldData)h+=`<div class="sheet flow"><h2>发现旧版本的数据</h2><p class="note">这个浏览器里有旧版对局簿的数据，要导入吗？</p><button class="primary" data-do="importOld">导入旧数据</button></div>`;
   h+=`<div class="sheet"><h2>开始新对局</h2>
   <div class="row"><div class="lab">我的卡组</div><select id="sDeck">${db.decks.map(d=>`<option value="${d.id}" ${d.id==setup.deck?"selected":""}>${esc(d.name)}</option>`).join("")}</select></div>
   <div class="row"><div class="lab">对手阵营</div><div class="chips">${facChips(setup.fac,"sfac")}</div></div>
   <div class="row"><div class="lab">先后手</div><div class="seg">${["先","后"].map(v=>`<button data-scoin="${v}" class="${setup.coin===v?"on":""}">${v}手</button>`).join("")}</div></div>
   <button class="primary" data-do="start">开始记录</button></div>`;
   h+=`<div class="btns" style="justify-content:space-between;align-items:center;margin:4px 0 6px"><h2 style="font-size:17px">历史对局</h2><div class="btns"><button class="ghost" data-do="exAll">导出全部对局</button><button class="ghost" data-do="migAll">全部迁移导出</button><button class="ghost" data-do="dl">下载备份</button><button class="ghost" data-do="impAll">全部导入</button></div></div>`;
   h+=db.games.length?db.games.slice().reverse().map(x=>{const col={W:"var(--win)",L:"var(--loss)",D:"var(--draw)"};const r0=x.rounds[0]||{};
     const hand=(r0.hm!=null&&r0.ho!=null)?`首局手牌 ${r0.hm}:${r0.ho}`:(x.diff!=null?`牌差 ${x.diff>0?"+":""}${x.diff}`:"");
     return `<div class="item"><div class="gems">${x.rounds.map(r=>`<i class="gem" style="--c:${col[r.res]}"></i>`).join("")}</div>
     <div class="meta"><b>${x.res} vs ${FN[x.fac]||x.fac}</b>　${x.date}<br>${esc(x.deckName)}　${x.coin||"?"}手　${hand}　${x.log.length} 步</div>
     <button class="ghost" data-reopen="${x.id}">修改</button><button class="ghost" data-ex="${x.id}">导出</button><button class="x" data-delg="${x.id}" aria-label="删除">×</button></div>`;}).join(""):`<p class="note">还没有对局，从上面开始第一局。</p>`;
   $("#tab-match").innerHTML=h;const sd=$("#sDeck");if(sd)sd.onchange=e=>{setup.deck=+e.target.value;};return;}
  ensureIds(g);
  const d=deckById(g.deck);const cur=g.cur;const o=outcome(g.rounds);const vr=VR();const editing=ui.vr!=null;
  const nR=Math.max(g.rounds.length+(o?0:1),1);
  h+=`<div class="sheet"><div class="live-head"><h2>${esc(g.deckName)} vs ${FN[g.fac]}</h2><button class="ghost" data-do="abort">放弃</button></div>${g.t0&&!o?`<div class="clock" id="clock"></div>`:""}
   <div class="rtabs">${Array.from({length:nR},(_,i)=>{const r=g.rounds[i];return `<button class="${i===vr?"on":""}" data-vr="${i}">第${i+1}局${r?" "+{W:"赢",L:"输",D:"平"}[r.res]:"·进行中"}</button>`;}).join("")}</div>
   ${editing?`<p class="note">正在查看/修改第${vr+1}局的记录，新记录会加到这一局。</p>`:""}</div>`;
  if(!o||editing){
    const {R,all,F,S}=board(g,vr);const step=ui.flow&&ui.flow[0];
    // 电脑宽屏：左边比分 + 场面常驻，右边记录；手机上 .duo 不分栏，场面仍在记录面板里折叠
    h+=`<div class="duo"><div class="colL">`;
    if(S){const rr=g.rounds[vr];const me=S.score.me.total,op=S.score.op.total;
      const cal=rr&&rr.me!==""&&rr.me!=null?`<span class="note">　真实 ${rr.me}:${rr.op}${(+rr.me!==me||+rr.op!==op)?`，差 ${me-rr.me>=0?"+":""}${me-rr.me} : ${op-rr.op>=0?"+":""}${op-rr.op}`:"，一致"}</span>`:"";
      const um=Object.entries(S.unmod);
      const cm=S.E.s.sides.me.coins,co=S.E.s.sides.op.coins,coinUsed=cm||co||S.E.trace.some(t=>/金币|献金|费用/.test(t.type));
      h+=`<div class="sheet eng"><div class="score"><b class="sm">${me}</b><span>:</span><b class="so">${op}</b>${cal}</div>${coinUsed?`<p class="note coins">金币　我方 <b>${cm}</b>　对方 <b>${co}</b></p>`:""}${extraLine(S.E)}
        ${S.warns.length?`<details><summary class="note">引擎提示 ${S.warns.length} 条</summary>${S.warns.map(w=>`<div class="warn">${w.fix?`<button class="ghost" data-fixtgt="${w.id}">补目标</button>`:""}${w.step?`<button class="ghost" data-fixstep="${esc(JSON.stringify(w.step))}">补上</button>`:""}${esc(logText(entry(w.id)||{}).slice(0,24))}：${esc(w.m)}</div>`).join("")}</details>`:""}
        ${um.length?`<p class="note">未建模：${um.map(([n,k])=>esc(n)+(k>1?"×"+k:"")).join("、")}</p>`:""}</div>`;}
    const hz=S&&S.E&&S.E.s.hazards;
    const fxTags=(s,r)=>hz?["m","r"].filter(w=>w===r&&hz[s][w]).map(w=>`<span class="fxtag">${esc(hz[s][w].kind)} ${hz[s][w].turns===Infinity?"":hz[s][w].turns}</span>`).join(""):F.filter(x=>x.side===s&&(x.row===r||x.row==="all")).map(x=>`<span class="fxtag">${esc(x.c)}${x.dur?" "+x.dur:""}</span>`).join("");
    const unitFace=n=>{const c=BY[n];return `${c&&c.art?`<img src="${ART(c.art)}" alt="" loading="lazy" onerror="this.remove()">`:""}${c&&c.t==="单位"&&c.pw!=="-"?`<span class="upw">${c.pw}</span>`:""}<span class="un">${esc(n)}</span>`;};
const unitFaceU=u=>{const e=u.eu;if(!e)return unitFace(u.n);const c=BY[u.n];const st=e.status||{};
      const cls=e.power>e.base?"up":e.power<e.base?"dn":"";
      const marks=[st.shield?"盾":"",st.vitality?"活"+st.vitality:"",st.bleed?"伤"+st.bleed:"",st.lock?"锁":"",st.poison?"毒":"",st.veil?"遮":"",st.resilience?"坚":"",
        st.spying?"潜":"",st.ambush?"伏":"",st.bounty?"赏":"",e.timer!=null?"计"+e.timer:"",e.def.cooldown!=null&&e.cd>0?"冷"+e.cd:"",e.def.order&&e.def.cooldown==null&&((e.def.charges!=null?e.def.charges:1)+(e.bonusCharges||0))!==1?"充"+Math.max(0,(e.def.charges!=null?e.def.charges:1)+(e.bonusCharges||0)-e.orderUsed):"",e.pat!=null?"耐"+e.pat:"",e.vars&&e.vars.count!=null?"倒"+e.vars.count:"",st.immune&&!e.def.status?.immune?"免":""].filter(Boolean).join(" ");
      return `${c&&c.art?`<img src="${ART(c.art)}" alt="" loading="lazy" onerror="this.remove()">`:""}${e.def.type!=="artifact"?`<span class="upw ${cls}">${e.power}</span>`:""}${e.armor?`<span class="uar">${e.armor}</span>`:""}${e.unmodeled?`<span class="unm">?</span>`:""}${marks?`<span class="ust">${marks}</span>`:""}<span class="un">${esc(u.n)}</span>`;};
const unitPw=n=>{const c=BY[n];return c&&c.t==="单位"&&c.pw!=="-"?`<small class="upw">${c.pw}</small>`:"";};
    const lanes=(mode,only,R2)=>{const RR=R2||R;return `<div class="board" style="--mine:var(--${g.myF||"NR"});--theirs:var(--${g.fac||"MO"})">${[["op","r"],["op","m"],["me","m"],["me","r"]].filter(([s])=>!only||s===only).map(([s,r])=>{
      const us=RR[s][r];let inner="";
      if(mode==="slots"){inner=us.map((u,i)=>`<button class="slot" data-slot="${s}|${r}|${i}">＋</button><span class="chip unit ${s==="me"?"bm":"bo"} ${BY[u.n]?.col==="金"?"g":""} dim">${unitFace(u.n)}</span>`).join("")+`<button class="slot" data-slot="${s}|${r}|${us.length}">＋</button>`;}
      else inner=us.map(u=>{const on=mode==="multi"&&(ui.sel||[]).some(t=>t.uid===u.uid);return `<button class="chip unit ${s==="me"?"bm":"bo"} ${BY[u.n]?.col==="金"?"g":""} ${on?"on":""}" data-u="${u.uid}" data-umode="${mode}" title="${esc(u.n)}">${unitFaceU(u)}</button>`;}).join("")||`<span class="note">空</span>`;
      const lab=mode==="multi"?`<button class="bl rowpick ${(ui.sel||[]).some(t=>t.row===s+r)?"on":""}" data-rowpick="${s}${r}">${s==="me"?"我":"对"}·${ROWN[r]}</button>`:`<span class="bl">${s==="me"?"我":"对"}·${ROWN[r]}</span>`;
      const rsum=us.reduce((a,u)=>a+(u.eu?u.eu.power:0),0);
      return `<div class="brow ${s}" data-side="${s}" data-row="${r}">${lab}${us.some(u=>u.eu)?`<span class="rsum">${rsum}</span>`:""}${fxTags(s,r)}${inner}</div>`;}).join("")}</div>`;};
    const hand=g.hand?myHand(g):[];
    const deckGrid=(opts)=>{opts=opts||{};if(!d)return"";const used={};const dev=devotionOf(d);g.log.forEach(x=>{if(x.who==="me"&&(x.a==="play"||x.a==="summon")&&x.via!=="墓场")used[baseOf(x.c)]=(used[baseOf(x.c)]||0)+1;if(x.who==="me"&&x.a==="draw"&&opts.forHand)(x.cards||[]).forEach(n=>used[baseOf(n)]=(used[baseOf(n)]||0)+1);});
      if(opts.forHand)hand.forEach(()=>{});
      const names=Object.keys(d.cards).sort((a,b)=>(BY[b]?.pv||0)-(BY[a]?.pv||0));
      const handSet={};hand.forEach(n=>handSet[baseOf(n)]=(handSet[baseOf(n)]||0)+1);
      let html="";
      if(g.hand&&!opts.forHand&&hand.length&&!opts.deckOnly){html+=`<div class="lab gl">手牌 ${hand.length} 张</div><div class="grid">${hand.map(n=>{const f=handForm(g,n,vr,dev);return tile(f,"手牌","",`data-nm="${esc(f)}"`);}).join("")}</div><div class="lab gl">牌组中其他牌</div>`;}
      // 牌组里的牌不历变；没记手牌时不知道它在不在手里，把可能的变身形态一起列出来（标“手牌历变”）
      const extra=n=>{if(g.hand||!EVOLVE[n]||!vr)return"";const out=[];for(let k=1;k<=vr;k++){const f=formOf(n,k,dev);if(f!==n&&!out.includes(f))out.push(f);}return out.map(f=>tile(f,"手牌历变","",`data-nm="${esc(f)}"`)).join("");};
      html+=`<div class="grid">${names.map(n=>{const left=d.cards[n]-(used[n]||0)-(opts.forHand?0:(handSet[n]||0));return tile(n,`剩${Math.max(0,left)}`,left<=0?"gone":"",`data-nm="${esc(n)}"`)+(left>0?extra(n):"");}).join("")}</div>`;return html;};
    const searchBox=(ph)=>`<div class="row"><input id="q" placeholder="${ph}" value="${esc(ui.q)}" autocomplete="off"></div>`;
    h+=`<div class="sheet pcOnly"><div class="lab">场面（根据记录推算）</div>${lanes("none")}</div></div><div class="colR">`;
    if(ui.insertBefore){const e=entry(ui.insertBefore);h+=`<div class="sheet flow"><div class="btns" style="justify-content:space-between;align-items:center"><span>插入模式：记录会放在「${esc(e?logText(e).slice(2):"")}」之前</span><button class="ghost" data-do="insertOff">退出插入</button></div></div>`;}
    if(step){
      h+=`<div class="sheet flow">`;
      if(step.t==="place"){const R2=step.editId?board(g,vr,step.editId).R:null;
        h+=`<h2>${esc(step.card)} 放在哪？</h2><p class="note">${step.via?"由「"+esc(step.via)+"」"+(step.a==="summon"?"召唤":"打出")+"。":""}点「＋」选择排和位置。</p>
        ${lanes("slots",step.side,R2)}<div class="btns" style="margin-top:8px">${step.move||step.editId?"":`<button class="ghost" data-side="${step.side==="me"?"op":"me"}">放到${step.side==="me"?"对方":"我方"}半场</button><button class="ghost" data-do="noPlace">不上场</button>`}${step.editId?`<button class="ghost" data-side="${step.side==="me"?"op":"me"}">换到${step.side==="me"?"对方":"我方"}半场</button>`:""}<button class="ghost" data-do="flowCancel">取消</button></div>`;}
      else if(step.t==="target"){const e=entry(step.id);
        h+=`<h2>「${esc(e.c||ACT[e.a])}」的目标</h2><p class="note">可以多选单位或整排，没有目标就跳过。</p>${lanes("multi")}
        <div class="btns" style="margin-top:8px"><button class="primary" data-do="tgtDone" style="flex:1">完成${(ui.sel||[]).length?"（"+ui.sel.length+"）":""}</button><button class="ghost" data-do="flowSkip">跳过</button></div>`;}
      else if(step.t==="tribute"){const e=entry(step.id);const S0=S&&S.E?S.E.s.sides[e?e.who:"me"].coins:null;
        h+=`<h2>「${esc(e?e.c:"")}」献金 ${step.n}：付了吗？</h2>${S0!=null?`<p class="note">推算${sideN(e?e.who:"me")}现有金币 ${S0}</p>`:""}
        <div class="btns" style="margin-top:8px"><button class="primary" data-trib="1" style="flex:1">付了</button><button class="ghost" data-trib="0" style="flex:1">没付</button></div>`;}
      else if(step.t==="frenzy"){const e=entry(step.id);
        h+=`<h2>「${esc(e?e.c:"")}」亢奋 ${step.n}：成立吗？</h2><p class="note">打出后手牌不多于 ${step.n} 张即成立（游戏里效果会高亮）。</p>
        <div class="btns" style="margin-top:8px"><button class="primary" data-fz="1" style="flex:1">成立</button><button class="ghost" data-fz="0" style="flex:1">不成立</button><button class="ghost" data-do="flowSkip">不清楚</button></div>`;}
      else if(step.t==="deckCount"){const e=entry(step.id);
        h+=`<h2>「${esc(e?e.c:"")}」：${sideN(e?e.who:"op")}牌组里还有几个单位？</h2><p class="note">用于推算牌组增益和之后指令转移的数值；不清楚就跳过，之后用改战力修正。</p>
        <div class="btns" style="margin-top:8px;flex-wrap:wrap">${[0,1,2,3,4,5,6,7,8,9,10,12,15].map(n=>`<button class="ghost" data-dn="${n}">${n}</button>`).join("")}</div>
        <div class="btns" style="margin-top:8px"><input id="dnIn" type="number" min="0" inputmode="numeric" placeholder="其他" style="flex:1"><button class="primary" data-dn="?">确定</button><button class="ghost" data-do="flowSkip">跳过</button></div>`;}
      else if(step.t==="pull"){h+=`<h2>「${esc(step.parent)}」拉出了哪张？</h2>${searchBox("搜牌名")}<div id="resBox">${step.who==="me"&&!ui.q?deckGrid({deckOnly:true}):matchRes()}</div>
        <div class="btns" style="margin-top:8px"><button class="ghost" data-do="flowSkip">没拉出 / 跳过</button></div>`;}
      else if(step.t==="spawn"){h+=`<h2>「${esc(step.parent)}」生成了什么？</h2>${step.picks.length?`<p class="note">根据卡牌效果推测：</p><div class="grid">${step.picks.map(n=>tile(n,"","",`data-nm="${esc(n)}"`)).join("")}</div>`:""}
        ${searchBox("搜衍生牌或其他牌名")}<div id="resBox">${ui.q?matchRes():""}</div>
        <div class="btns" style="margin-top:8px"><button class="ghost" data-do="flowSkip">没有生成 / 跳过</button></div>`;}
      else if(step.t==="ret"){h+=`<h2>${esc(step.card)} 从墓场回到场上了吗？</h2><p class="note">根据卡牌效果推测可能触发，没有就选「没有」。</p>
        <div class="btns"><button class="primary" data-do="retYes" style="flex:1">回来了，选位置</button><button class="ghost" data-do="flowSkip">没有</button></div>`;}
      else if(step.t==="hand"){const e=entry(step.id);h+=`<h2>选抽到的牌（已选 ${e.cards.length} 张）</h2><p class="note">第一局起手 10 张，第二、三局各抽 3 张。点下面的已选牌可以去掉。</p>
        <div class="grid">${e.cards.map((n,i)=>tile(n,"×","",`data-hrm="${i}"`)).join("")||`<span class="note">还没选</span>`}</div>${searchBox("搜牌名")}<div id="resBox">${ui.q?matchRes():deckGrid({forHand:true})}</div>
        <div class="btns" style="margin-top:8px"><button class="primary" data-do="handDone" style="flex:1">完成</button></div>`;}
      else if(step.t==="mullinto"){h+=`<h2>换来了哪张？</h2>${searchBox("搜牌名")}<div id="resBox">${ui.q?matchRes():deckGrid({deckOnly:true})}</div><div class="btns" style="margin-top:8px"><button class="ghost" data-do="flowSkip">不记</button></div>`;}
      else if(step.t==="rename"){h+=`<h2>改成哪张牌？</h2>${searchBox("搜牌名")}<div id="resBox">${matchRes()}</div><div class="btns" style="margin-top:8px"><button class="ghost" data-do="flowCancel">取消</button></div>`;}
      else if(step.t==="edit"){const e=entry(step.id);if(!e){ui.flow=null;}else{const placeable=e.row||e.a==="move";
        h+=`<h2>修改这一步</h2><p>${esc(logText(e))}</p><div class="ebtns">
          ${e.c&&!["note","fx","pass","draw"].includes(e.a)?`<button class="ghost" data-do="eRename">换牌名</button>`:""}
          ${["play","order","leader","tactic","summon","spawn","effect","adj"].includes(e.a)?`<button class="ghost" data-do="eFlip">改成${e.who==="me"?"对方":"我方"}</button>`:""}
          ${placeable?`<button class="ghost" data-do="ePlace">改位置</button>`:""}
          ${["play","order","leader","summon"].includes(e.a)?`<button class="ghost" data-do="eTgt">改目标</button>`:""}
          <button class="ghost" data-do="eUp">↑ 上移</button><button class="ghost" data-do="eDown">↓ 下移</button>
          <button class="ghost" data-do="eInsert">在这之前插入</button><button class="ghost bad" data-do="eDel">删除</button><button class="ghost" data-do="flowCancel">关闭</button></div>`;}}
      h+=`</div>`;
    }
    if(!step){
      const acts=ui.who==="me"?["play","order","leader","tactic","effect","adj","spawn","summon","fx","move","kill","mull",...(g.hand?["draw"]:[]),"pass","note"]:["play","order","leader","tactic","effect","adj","spawn","summon","fx","move","kill","pass","note"];
      if(!acts.includes(ui.act))ui.act="play";
      const roundHasHand=g.log.some(x=>x.r===vr&&x.who==="me"&&x.a==="draw");
      h+=`<div class="sheet"><div class="who"><button class="me ${ui.who==="me"?"on":""}" data-who="me">我方</button><button class="op ${ui.who==="op"?"on":""}" data-who="op">对方</button></div>
       <div class="acts">${acts.map(k=>`<button data-act="${k}" class="${ui.act===k?"on":""}">${ACT[k].replace("整排效果","整排")}</button>`).join("")}</div>
       <div class="btns" style="margin-top:8px;align-items:center"><button class="chip ${g.hand?"on":""}" data-do="handToggle">记录手牌</button>${g.hand&&!roundHasHand?`<button class="ghost" data-do="handStart">选第${vr+1}局${vr===0?"起手 10 张":"抽到的 3 张"}</button>`:""}</div>`;
      if(["play","mull","summon","draw","spawn"].includes(ui.act)){
        h+=searchBox(ui.who==="me"?"搜牌名，或点下面的牌":"搜对手打出的牌")+`<div id="resBox">${ui.who==="me"&&!ui.q?(ui.act==="mull"&&g.hand?`<div class="grid">${hand.map(n=>tile(n,"手牌","",`data-nm="${esc(n)}"`)).join("")}</div>`:deckGrid({deckOnly:ui.act==="draw"})):matchRes()}</div>`;
      }else if(ui.act==="order"){h+=`<p class="note" style="margin:10px 0 4px">点使用指令的单位（记为该单位那一方）：</p>${lanes("pick")}`;}
      else if(ui.act==="effect"){const hzs=hz?["me","op"].flatMap(s=>["m","r"].filter(w=>hz[s][w]&&ENG.HAZARDS[hz[s][w].kind]&&/雨|血月|灾厄|霜|雾/.test(hz[s][w].kind)).map(w=>`<button class="ghost" data-hzfx="${s}|${w}|${esc(hz[s][w].kind)}">${esc(hz[s][w].kind)}（${sideN(s)}${ROWN[w]}）命中</button>`)).join(""):"";
        h+=`${hzs?`<p class="note" style="margin:10px 0 4px">整排效果的随机结果：</p><div class="btns">${hzs}</div>`:""}<p class="note" style="margin:10px 0 4px">点触发效果的单位（例如法利波的随机伤害、回合结束效果），下一步选它影响了谁：</p>${lanes("pick")}`;}
      else if(ui.act==="tactic"){const bm=`<button class="${ui.who==="me"?"primary":"ghost"}" data-do="tactic">我用战术 ${esc(deckById(g.deck)?.tactic||"")}</button>`,bo=`<button class="${ui.who==="op"?"primary":"ghost"}" data-do="tacticOp">对方用战术</button>`;
        h+=`<div class="btns" style="margin-top:8px">${ui.who==="op"?bo+bm:bm+bo}</div>`;}
      else if(ui.act==="leader"){const ls=C.filter(c=>isLeader(c)&&c.f===g.fac).sort((a,b)=>(b.n===g.opLeader)-(a.n===g.opLeader));
        // 两方都列出来，按按钮区分是谁用的，不依赖上面的“我方/对方”
        const mine=`<div class="row"><button class="primary" data-do="leader">我方用领袖 ${esc(g.leader||"")}</button></div>`;
        const theirs=`<p class="note" style="margin:10px 0 4px">对方用的领袖${g.opLeader?"（第一个是上次选的）":""}：</p><div class="grid">${ls.map(c=>tile(c.n,c.n===g.opLeader?"上次":"","",`data-oplead="${esc(c.n)}"`)).join("")}</div>`;
        h+=ui.who==="op"?theirs+mine:mine+theirs;}
      else if(ui.act==="fx"){const f=ui.fx=ui.fx||{k:"霜",side:ui.who==="me"?"op":"me",row:"m",dur:3};
        h+=`<div class="row"><div class="lab">效果</div><div class="chips">${FX.map(k=>`<button class="chip ${f.k===k?"on":""}" data-fxk="${k}">${k}</button>`).join("")}</div></div>
         <div class="row"><div class="lab">作用在</div><div class="seg">${[["op","对方半场"],["me","我方半场"]].map(([v,l])=>`<button class="${f.side===v?"on":""}" data-fxside="${v}">${l}</button>`).join("")}</div>
         <div class="seg" style="margin-top:6px">${["m","r","all"].map(v=>`<button class="${f.row===v?"on":""}" data-fxrow="${v}">${ROWN[v]}</button>`).join("")}</div></div>
         <div class="row"><div class="lab">持续回合（卡面写的回合数）</div><div class="step"><button data-fxdur="-1">−</button><output>${f.dur}</output><button data-fxdur="1">+</button></div></div>
         <button class="primary" data-do="fxRec">记录：${(f.who||ui.who)==="me"?"我":"对方"}施加 ${f.k} → ${sideN(f.side)}${ROWN[f.row]}</button>`;}
      else if(ui.act==="move"){h+=`<p class="note" style="margin:10px 0 4px">点要移动的单位（同排换位或换排都行）：</p>${lanes("pick")}`;}
      else if(ui.act==="adj"){h+=`<div class="btns" style="margin-top:8px"><button class="ghost" data-coinfix="me">修正我方金币</button><button class="ghost" data-coinfix="op">修正对方金币</button></div><p class="note" style="margin:10px 0 4px">点要修正的单位。输入 +2 / -3 按增益或伤害结算（会过护盾、护甲），输入 7 直接设成 7；-盾 去掉护盾，+盾 加上，甲3 设护甲。对面刚落地的单位会记成它的落地战力。</p>${lanes("pick")}`;}
      else if(ui.act==="kill"){h+=`<p class="note" style="margin:10px 0 4px">点被摧毁的单位：</p>${lanes("pick")}`;}
      else if(ui.act==="note"){h+=`<div class="row"><input id="noteIn" placeholder="例如：对方洗回 2 张牌 / 我方被锁定" autocomplete="off"></div><button class="primary" data-do="noteRec">记录备注</button>`;}
      else h+=`<div class="row"><button class="primary" data-do="${ui.act}">${ui.who==="me"?"记录：我停牌":"记录：对方停牌"}</button></div>`;
      if(!["order","move","kill"].includes(ui.act))h+=`<details class="row mbOnly" ${ui.showBoard?"open":""} id="bdet"><summary class="note">场面（根据记录推算）</summary>${lanes("none")}</details>`;
      h+=`</div>`;
    }
    const lg=g.log.map((x,i)=>[x,i]).filter(([x])=>x.r===vr);
    h+=`<div class="sheet"><div class="btns" style="justify-content:space-between;align-items:center"><span class="lab" style="margin:0">第${vr+1}局记录 · 点一条可修改</span><button class="ghost" data-do="undo" ${lg.length?"":"disabled"}>↶ 撤销上一步</button></div>
     <div class="log">${lg.length?lg.slice().reverse().map(([x,i])=>`<div class="${x.who} ${ui.insertBefore===x.id?"ins":""}"><button class="le" data-edit="${x.id}">${esc(logText(x).slice(2))}</button></div>`).join(""):`<p class="note">这一局还没有记录。</p>`}</div></div>`;
    if(!o&&vr===cur){const p=g.pend;const hmAuto=g.hand?myHand(g).length:null;
    h+=`<div class="sheet"><h2>第${cur+1}局结束</h2><div class="row"><div class="lab">结果</div><div class="seg">${["W","L","D"].map(k=>`<button class="${k} ${p.res===k?"on":""}" data-rres="${k}">${{W:"赢",L:"输",D:"平"}[k]}</button>`).join("")}</div></div>
     <div class="row"><div class="lab">本局结束时的手牌数${hmAuto!=null?`（按记录我方是 ${hmAuto} 张，不填就用这个）`:""}</div><div class="seg"><input id="hMe" inputmode="numeric" placeholder="我方手牌" value="${p.hm??""}"><input id="hOp" inputmode="numeric" placeholder="对方手牌" value="${p.ho??""}"></div></div>
     <div class="row"><div class="lab">比分（可不填）</div><div class="seg"><input id="sMe" inputmode="numeric" placeholder="我方" value="${p.me??""}"><input id="sOp" inputmode="numeric" placeholder="对方" value="${p.op??""}"></div></div>
     <button class="primary" data-do="endRound">结束第${cur+1}局</button></div>`;}
    h+=`</div></div>`;
  }
  if(o){
    const uniq=d?Object.keys(d.cards):[];const playedMe=new Set(g.log.filter(x=>x.who==="me"&&x.a==="play").map(x=>x.c));
    if(g.hand&&!g.stuckInit){g.stuck=[...new Set(myHand(g))];g.stuckInit=true;}
    h+=`<div class="sheet"><h2>对局结束：${o.w}:${o.l} ${o.res}</h2><p class="note">点上面的「第几局」可以查看和修改那一局的记录。</p>
     <div class="row"><div class="lab">卡手的牌（到最后都没打出去的）${g.hand?"，已按手牌记录自动勾选":""}</div><div class="chips">${uniq.filter(n=>!playedMe.has(n)||g.stuck.includes(n)).map(n=>`<button class="chip ${g.stuck.includes(n)?"on":""}" data-stuck="${esc(n)}">${esc(n)}</button>`).join("")}</div></div>
     <div class="row"><div class="lab">备注</div><textarea id="gNote" rows="2">${esc(g.note)}</textarea></div>
     <div class="btns"><button class="primary" data-do="finish" style="flex:1">保存对局</button><button class="ghost" data-do="undoRound">改上一局结果</button></div></div>`;}
  $("#tab-match").innerHTML=h;
  bindSearch("#q",v=>ui.q=v,()=>{const b=$("#resBox");if(!b)return;if(!ui.q.trim()){rMatch();return;}b.innerHTML=matchRes();});
  const bd=$("#bdet");if(bd)bd.ontoggle=()=>{ui.showBoard=bd.open;};
  const num=v=>{v=String(v).trim();return v===""?null:(isNaN(+v)?null:+v);};
  for(const[id,k,isNum]of[["#sMe","me"],["#sOp","op"],["#hMe","hm",1],["#hOp","ho",1]]){const el=$(id);if(el)el.oninput=e=>{g.pend[k]=isNum?num(e.target.value):e.target.value;persist();};}
  const gn=$("#gNote");if(gn)gn.oninput=e=>{g.note=e.target.value;persist();};
}

function pct(a,b){return b?Math.round(a/b*100)+"%":"—";}
function calc(id){const g=db.games.filter(x=>x.deck==id),n=g.length,w=a=>a.filter(x=>x.res==="胜").length;
  const r1w=g.filter(x=>x.rounds[0]?.res==="W"),r1l=g.filter(x=>x.rounds[0]?.res==="L");
  const R={n,win:[w(g),n],two0:[g.filter(x=>x.res==="胜"&&x.rounds.length===2).length,n],r1:[r1w.length,n],afterR1W:[w(r1w),r1w.length],afterR1L:[w(r1l),r1l.length],
   up:[w(g.filter(x=>x.diff!=null&&x.diff>=0)),g.filter(x=>x.diff!=null&&x.diff>=0).length],down:[w(g.filter(x=>x.diff!=null&&x.diff<0)),g.filter(x=>x.diff!=null&&x.diff<0).length],
   first:[w(g.filter(x=>x.coin==="先")),g.filter(x=>x.coin==="先").length],second:[w(g.filter(x=>x.coin==="后")),g.filter(x=>x.coin==="后").length],
   avgDiff:(()=>{const a=g.filter(x=>x.diff!=null);return a.length?a.reduce((s,x)=>s+x.diff,0)/a.length:null;})(),fac:{},stuck:{},cards:{},lead:null,opp:{}};
  OPP.forEach(f=>{const s=g.filter(x=>x.fac===f);R.fac[f]=[w(s),s.length];});
  g.forEach(x=>x.stuck.forEach(c=>R.stuck[c]=(R.stuck[c]||0)+1));
  const lg=g.filter(x=>x.log.length);let lu=0;
  lg.forEach(x=>{const seen={};x.log.forEach(e=>{if(e.who==="me"&&e.a==="play"&&!seen[e.c]){seen[e.c]=e.r+1;}if(e.who==="me"&&e.a==="leader")lu++;if(e.who==="op"&&e.a==="play")R.opp[e.c]=(R.opp[e.c]||0)+1;});
    for(const[c,r]of Object.entries(seen)){const k=R.cards[c]||(R.cards[c]={g:0,w:0,rs:0});k.g++;k.rs+=r;if(x.res==="胜")k.w++;}});
  R.logged=lg.length;R.lead=lg.length?lu/lg.length:null;return R;}
function rStats(){if(!db.decks.length){$("#tab-stats").innerHTML=`<p class="note">先去「卡组」建一个卡组。</p>`;return;}
  const opts=sel=>db.decks.map(d=>`<option value="${d.id}" ${d.id==sel?"selected":""}>${esc(d.name)}</option>`).join("");
  const A=ui.statA,B=ui.statB,a=calc(A),b=calc(B),same=A==B,na=deckById(A)?.name,nb=deckById(B)?.name;
  const cell=p=>`${pct(p[0],p[1])}<span class="note"> ${p[1]}</span>`;const two=(fa,fb)=>`<td>${fa}</td>${same?"":`<td>${fb}</td>`}`;
  const th=`<tr><th></th><th>${esc(na)}</th>${same?"":`<th>${esc(nb)}</th>`}</tr>`;
  let h=`<div class="cmp"><select id="stA">${opts(A)}</select><select id="stB">${opts(B)}</select></div>
   <div class="hero"><div><div class="big">${pct(...a.two0)}</div><span>${esc(na)} 的 2:0 率（${a.n} 局）</span></div>${same?"":`<div><div class="big" style="color:var(--txt)">${pct(...b.two0)}</div><span>${esc(nb)}（${b.n} 局）</span></div>`}</div>`;
  if(Math.max(a.n,b.n)<30)h+=`<p class="note">每个版本打到 30 局左右，对比才比较可信。</p>`;
  const rows=[["总胜率","win"],["2:0 率","two0"],["第一局胜率","r1"],["赢下第一局后的胜率","afterR1W"],["输掉第一局后的胜率","afterR1L"],["第一局结束手牌不少于对手时胜率","up"],["第一局结束手牌少于对手时胜率","down"],["先手胜率","first"],["后手胜率","second"]];
  const fd=x=>x==null?"—":(x>0?"+":"")+x.toFixed(1);
  h+=`<div class="sheet"><h2>核心数据</h2><table>${th}${rows.map(([t,k])=>`<tr><td>${t}</td>${two(cell(a[k]),cell(b[k]))}</tr>`).join("")}
   <tr><td>第一局结束平均手牌差（我−对）</td>${two(fd(a.avgDiff),fd(b.avgDiff))}</tr><tr><td>每局平均用领袖次数</td>${two(fd(a.lead),fd(b.lead))}</tr></table></div>`;
  h+=`<div class="sheet"><h2>对各阵营胜率</h2><table>${th}${OPP.map(f=>`<tr><td>${FN[f]}</td>${two(cell(a.fac[f]),cell(b.fac[f]))}</tr>`).join("")}</table></div>`;
  const cardT=(R,name)=>{const e=Object.entries(R.cards).sort((x,y)=>y[1].g-x[1].g);
    return `<div class="sheet"><h2>我方出牌表现：${esc(name)}</h2><p class="note">来自 ${R.logged} 局详细记录。「首次打出」指平均在第几局第一次打出。</p>${e.length?`<table><tr><th>牌</th><th>打出局数</th><th>打出时胜率</th><th>首次打出</th></tr>${e.map(([c,k])=>`<tr><td>${esc(c)}</td><td>${k.g}</td><td>${pct(k.w,k.g)}</td><td>${(k.rs/k.g).toFixed(1)}</td></tr>`).join("")}</table>`:`<p class="note">还没有详细出牌记录。</p>`}</div>`;};
  const stT=(R,name)=>{const e=Object.entries(R.stuck).sort((x,y)=>y[1]-x[1]).slice(0,8);return `<div class="sheet"><h2>最常卡手：${esc(name)}</h2>${e.length?`<table><tr><th>牌</th><th>次数</th><th>占对局</th></tr>${e.map(([c,k])=>`<tr><td>${esc(c)}</td><td>${k}</td><td>${pct(k,R.n)}</td></tr>`).join("")}</table>`:`<p class="note">还没有卡手记录。</p>`}</div>`;};
  const opT=R=>{const e=Object.entries(R.opp).sort((x,y)=>y[1]-x[1]).slice(0,10);return e.length?`<div class="sheet"><h2>对手最常打出的牌</h2><table><tr><th>牌</th><th>次数</th></tr>${e.map(([c,k])=>`<tr><td>${esc(c)}</td><td>${k}</td></tr>`).join("")}</table></div>`:"";};
  h+=cardT(a,na)+stT(a,na);if(!same)h+=cardT(b,nb)+stT(b,nb);h+=opT(a);
  $("#tab-stats").innerHTML=h;$("#stA").onchange=e=>{ui.statA=+e.target.value;rStats();};$("#stB").onchange=e=>{ui.statB=+e.target.value;rStats();};}

function deckRes(d){const pool=C.filter(c=>!isLeader(c)&&!isTactic(c)&&!c.token&&(!ui.deckOwned||db.owned[c.n]));
  const res=search(ui.deckQ,pool,new Set(Object.keys(db.owned).filter(n=>db.owned[n]>0)),[d.f,"NE"]);
  return res.map(c=>`<button class="res" data-dp="${esc(c.n)}"><span>${esc(c.n)} ${db.owned[c.n]?"":"<small>未拥有</small>"}</span><small>${cardTag(c)}${c.t}</small></button>`).join("");}
function rDeck(){let d=deckById(ui.deckSel);let h=`<div class="btns" style="margin-bottom:10px"><select id="dSel" style="flex:1;background:var(--night2);color:#fff;border-color:var(--line)">${db.decks.map(x=>`<option value="${x.id}" ${x.id==ui.deckSel?"selected":""}>${esc(x.name)}</option>`).join("")}</select>
   <button class="ghost" data-do="newDeck">新建</button><button class="ghost" data-do="dupDeck">复制</button><button class="ghost" data-do="impDeck">导入</button></div>`;
  if(!d){$("#tab-deck").innerHTML=h+`<p class="note">还没有卡组，点「新建」。</p>`;return;}
  const i=deckInfo(d);const leaders=C.filter(c=>isLeader(c)&&c.f===d.f);
  const tacs=C.filter(c=>isTactic(c)&&(c.f===d.f||c.f==="NE")).map(c=>c.n);const custom=(db.tactics||[]);
  const tacList=[...new Set([...(d.tactic?[d.tactic]:[]),...custom,...tacs])];
  h+=`<div class="sheet"><div class="row"><div class="lab">名称</div><input id="dName" value="${esc(d.name)}"></div>
   <div class="seg" style="gap:8px"><div style="flex:1"><div class="lab">阵营</div><select id="dF">${OPP.map(f=>`<option value="${f}" ${d.f===f?"selected":""}>${FN[f]}</option>`).join("")}</select></div>
   <div style="flex:1"><div class="lab">领袖</div><select id="dL"><option value="">未选</option>${leaders.map(c=>`<option value="${esc(c.n)}" ${d.leader===c.n?"selected":""}>${esc(c.n)}</option>`).join("")}</select></div></div>
   <div class="row"><div class="lab">战术</div><select id="dT"><option value="">未选</option>${tacList.map(n=>`<option value="${esc(n)}" ${d.tactic===n?"selected":""}>${esc(n)}</option>`).join("")}<option value="__new">＋ 手动输入其他战术…</option></select></div>
   <div class="sum"><span>张数 <b class="${i.n<25?"bad":""}">${i.n}</b>/25</span><span>粮草 <b class="${i.pv>i.lim?"bad":""}">${i.pv}</b>/${i.lim}</span><span>单位 <b>${i.units}</b></span></div>
   ${i.bad.length?`<p class="note bad">数据库里找不到：${esc(i.bad.join("、"))}</p>`:""}
   <div class="btns"><button class="primary" data-do="exDeck" style="flex:1">导出卡组代码</button><button class="ghost" data-do="delDeck">删除卡组</button></div></div>`;
  const rows=Object.entries(d.cards).map(([n,k])=>[BY[n],n,k]).sort((a,b)=>((b[0]?.col==="金")-(a[0]?.col==="金"))||((b[0]?.pv||0)-(a[0]?.pv||0)));
  h+=`<div class="sheet"><h2>牌表</h2>${rows.map(([c,n,k])=>{const miss=(db.owned[n]||0)<k;return `<div class="item">${thumb(c)}<div class="meta" ${c?`data-card="${c.i}"`:""} style="cursor:pointer"><b>${esc(n)}</b> ${miss?`<span class="bad">缺</span>`:""}<br>${cardTag(c)}${c?c.t:""}</div>
   <button class="cnt" data-dm="${esc(n)}">−</button><span style="min-width:22px;text-align:center">${k}</span><button class="cnt" data-dp="${esc(n)}">+</button></div>`;}).join("")}</div>`;
  h+=`<div class="sheet"><h2>加牌</h2><div class="btns" style="align-items:center"><input id="dQ" placeholder="搜牌名" value="${esc(ui.deckQ)}" style="flex:1" autocomplete="off"><button class="chip ${ui.deckOwned?"on":""}" data-do="deckOwned">只看已拥有</button></div>
   <div class="results" id="deckRes">${deckRes(d)}</div></div>`;
  $("#tab-deck").innerHTML=h;
  $("#dSel").onchange=e=>{ui.deckSel=+e.target.value;rDeck();};
  $("#dName").onchange=e=>{d.name=e.target.value.trim()||d.name;persist();rDeck();};
  $("#dF").onchange=e=>{d.f=e.target.value;d.leader="";persist();rDeck();};
  $("#dL").onchange=e=>{d.leader=e.target.value;persist();rDeck();};
  $("#dT").onchange=e=>{let v=e.target.value;if(v==="__new"){v=(prompt("战术名称")||"").trim();if(!v){rDeck();return;}db.tactics=[...new Set([...(db.tactics||[]),v])];}d.tactic=v;persist();rDeck();toast("战术已改为 "+(v||"未选"));};
  bindSearch("#dQ",v=>ui.deckQ=v,()=>{$("#deckRes").innerHTML=deckRes(d);});}

// 牌库筛选：同一组内“或”，组之间“且”；不存盘
const PVB=[["4","≤4",c=>c.pv<=4],["5","5",c=>c.pv===5],["6","6",c=>c.pv===6],["7","7",c=>c.pv===7],["8","8",c=>c.pv===8],["9","9",c=>c.pv===9],["10","10",c=>c.pv===10],["11","11–13",c=>c.pv>=11&&c.pv<=13],["14","14+",c=>c.pv>=14]];
const RARS=["普通","稀有","史诗","传奇"],COLS=["金","铜"];
// 扩展包中文名（用户提供），按这个顺序显示；数据里有、这里没有的排在最后显示原名
const SERN={"unmillable":"新手卡组","baseset":"核心卡牌","thronebreaker":"王权的陨落","crimsoncurse":"猩红诅咒","novigrad":"诺城之火","iron judgment":"钢铁审判","merchants of ofir":"异域游商","master mirror":"镜子大师","way of the witcher":"猎魔人之道","price of power":"权力的代价","cursed toad":"蟾蜍王子","uroboros":"衔尾蛇"};
const serName=k=>SERN[k]||k;
const SERS=(()=>{const have=new Set(C.filter(c=>!c.token&&c.ser&&c.ser!=="basic").map(c=>c.ser));return[...Object.keys(SERN).filter(k=>have.has(k)),...[...have].filter(k=>!SERN[k])];})();
ui.cfil={pv:[],rar:[],col:[],ser:[],t:[],kw:[]};
const collBase=()=>C.filter(c=>(ui.collF==="ALL"||inFac(c,ui.collF))&&!isLeader(c)&&!c.token);
const TYPES=["单位","神器","特殊","战术"];
// 词条：辞典里的关键词，只列出当前列表里出现过的，按出现次数排
const KWS=["部署","指令","神赐","激励","列阵","狂热","遗愿","致死","护盾","护甲","坚韧","佚亡","免疫","卫士","遮蔽","活力","重伤","中毒","锁定","净化","治愈","召唤","生成","灌注","对决","交锋","吞噬","放逐","计时","冷却","充能","老兵","剧情","统御","威势","夜宴","壁垒","破甲","狂暴","亢奋","会师","先机","成长","和谐","同化","战狂","掠食","操控","翼守","耐性","血统","赤诚","共生","共谋","抓捕","创造","揭示","丢弃","不忠","伏击","回响","增兵","利润","献金","费用","囤积","恐吓","赏金","败德","破裂","癫狂","翻开","近战","远程"];
function collFilter(list){const F=ui.cfil;
  if(F.pv.length)list=list.filter(c=>PVB.some(([k,,t])=>F.pv.includes(k)&&t(c)));
  if(F.rar.length)list=list.filter(c=>F.rar.includes(c.rar));
  if(F.col.length)list=list.filter(c=>F.col.includes(c.col));
  if(F.ser.length)list=list.filter(c=>F.ser.includes(c.ser));
  if(F.t.length)list=list.filter(c=>F.t.includes(c.t));
  if(F.kw.length)list=list.filter(c=>F.kw.every(k=>(c.tx||"").includes(k)));   // 词条：同时具备
  return list;}
function collList(){let list=collFilter(collBase());const q=ui.collQ.trim().toLowerCase();
  if(q)list=list.filter(c=>c.n.toLowerCase().includes(q)||c.en.toLowerCase().includes(q)||(c.alias||"").toLowerCase().includes(q));if(ui.collOwned)list=list.filter(c=>db.owned[c.n]>0);
  list=list.slice().sort((a,b)=>((b.col==="金")-(a.col==="金"))||(b.pv-a.pv));
  const info=ui.collMode==="info";
  return (list.length?`<div class="grid">${list.map(c=>{const k=db.owned[c.n]||0;return tile(c.n,k?"×"+k:"",(k?"":"gone")+(db.edits[c.n]?" edited":""),info?`data-cardb="${c.i}"`:`data-own="${c.i}"`);}).join("")}</div>`:`<p class="note">没有符合的牌。</p>`);}
function rColl(){const f=ui.collF;const all=collBase().filter(c=>!isTactic(c));const own=all.filter(c=>db.owned[c.n]>0).length;
  const cp=all.filter(c=>c.ser!=="unmillable");const copies=cp.reduce((s,c)=>s+Math.min(db.owned[c.n]||0,maxCopy(c)),0),copTot=cp.reduce((s,c)=>s+maxCopy(c),0);
  const F=ui.cfil,nF=F.pv.length+F.rar.length+F.col.length+F.ser.length+F.t.length+F.kw.length;
  const base=collBase();const kwc=KWS.map(k=>[k,base.filter(c=>(c.tx||"").includes(k)).length]).filter(([k,n])=>n>0||F.kw.includes(k)).sort((a,b)=>b[1]-a[1]);
  const grp=(lab,key,items)=>`<div class="row"><div class="lab">${lab}</div><div class="chips">${items.map(([v,t])=>`<button class="chip ${F[key].includes(v)?"on":""}" data-cfil="${key}|${esc(v)}">${esc(t)}</button>`).join("")}</div></div>`;
  let h=`<div class="chips" style="margin-bottom:10px"><button class="chip ${f==="ALL"?"on":""}" data-cf="ALL">全部</button>${["NR","NE","MO","NG","ST","SK","SY"].map(x=>`<button class="chip fac ${f===x?"on":""}" style="--c:var(--${x})" data-cf="${x}">${FN[x]}</button>`).join("")}</div>
   <div class="duo coll"><div class="colL"><details class="sheet" ${ui.cfilOpen?"open":""} id="cfilBox"><summary>筛选${nF?`（${nF} 项，<b>${collFilter(base).length}</b> 张）`:""}</summary>
    ${grp("类型","t",TYPES.map(x=>[x,x]))}${grp("费用","pv",PVB.map(([k,t])=>[k,t]))}${grp("颜色","col",COLS.map(x=>[x,x]))}${grp("稀有度","rar",RARS.map(x=>[x,x]))}${grp("扩展包","ser",SERS.map(x=>[x,serName(x)]))}${grp("词条（同时具备）","kw",kwc.map(([k,n])=>[k,k+" "+n]))}
    ${nF?`<button class="ghost" data-do="cfilClear">清除筛选</button>`:""}</details></div><div class="colR">
   <div class="sheet"><div class="sum"><span>${f==="ALL"?"全部阵营":FN[f]} 已拥有 <b>${own}</b>/${all.length} 种</span><span>按游戏算法 <b>${copies}</b>/${copTot}</span></div>
   <p class="note">「按游戏算法」：铜卡算 2 份，不算初始卡、领袖和战术。数据库总数会比游戏多约 9，拥有数应该和游戏一致。</p>
   <div class="btns" style="align-items:center"><input id="cQ" placeholder="搜牌名" value="${esc(ui.collQ)}" style="flex:1" autocomplete="off"><button class="chip ${ui.collOwned?"on":""}" data-do="collOwned">只看已拥有</button></div>
   <div class="seg" style="margin:8px 0"><button class="${ui.collMode!=="info"?"on":""}" data-do="collCount">点牌：登记张数</button><button class="${ui.collMode==="info"?"on":""}" data-do="collInfo">点牌：看详情/改数值</button></div>
   <p class="note">铜卡最多 2 张，金卡最多 1 张，没有的牌显示为灰色。领袖默认全部解锁，不用登记。</p>
   <div class="btns"><button class="ghost" data-do="exColl">导出牌库代码</button><button class="ghost" data-do="impColl">批量导入</button><button class="ghost" data-do="addCard">新增卡牌</button></div></div>
   <div id="collList">${collList()}</div></div></div>`;
  $("#tab-coll").innerHTML=h;const fb=$("#cfilBox");if(fb)fb.ontoggle=()=>{ui.cfilOpen=fb.open;};bindSearch("#cQ",v=>ui.collQ=v,()=>{$("#collList").innerHTML=collList();});}

// ---------- actions ----------
let suppressClick=false;
document.addEventListener("click",e=>{if(suppressClick){e.preventDefault();e.stopPropagation();return;}const t=e.target.closest("button");if(!t||t.closest("dialog"))return;const D=t.dataset;const g=db.live;
  if(D.t){ui.tab=D.t;render();window.scrollTo(0,0);return;}
  if(D.who){ui.who=D.who;ui.q="";ui.fx=null;ui.flow=null;rMatch();return;}
  if(D.act){ui.act=D.act;ui.q="";ui.flow=null;rMatch();return;}
  if(D.reopen){if(db.live)return toast("先保存或放弃当前对局");const i=db.games.findIndex(x=>x.id==D.reopen);if(i<0)return;const gm=db.games.splice(i,1)[0];gm.cur=gm.rounds.length;gm.pend={res:null,me:"",op:"",hm:null,ho:null};gm.stuckInit=true;db.live=gm;ui.vr=0;ui.flow=null;persist();rMatch();window.scrollTo(0,0);return;}
  if(ui.tab==="match"&&liveClick(t,D))return;
  if(D.sfac){setup.fac=D.sfac;rMatch();return;}
  if(D.scoin){setup.coin=D.scoin;rMatch();return;}
  if(D.rres){g.pend.res=D.rres;persist();rMatch();return;}
  if(D.stuck){g.stuck=g.stuck.includes(D.stuck)?g.stuck.filter(x=>x!==D.stuck):[...g.stuck,D.stuck];persist();rMatch();return;}
  if(D.ex){copyOut("对局代码",LEGEND+"\n"+gameCodeC(db.games.find(x=>x.id==D.ex)));return;}
  if(D.delg){if(!confirm("删除这局记录？"))return;db.games=db.games.filter(x=>x.id!=D.delg);persist();render();return;}
  if(D.own){const c=C[+D.own];const k=((db.owned[c.n]||0)+1)%(maxCopy(c)+1);if(k)db.owned[c.n]=k;else delete db.owned[c.n];persist();rColl();return;}
  if(D.cf){ui.collF=D.cf;ui.collQ="";rColl();return;}
  if(D.cfil){const [k,v]=D.cfil.split("|");const a=ui.cfil[k];const i=a.indexOf(v);if(i>=0)a.splice(i,1);else a.push(v);rColl();return;}
  if(D.cardb){openCard(C[+D.cardb]);return;}
  if(D.dp||D.dm){const d=deckById(ui.deckSel),n=D.dp||D.dm,c=BY[n];let k=d.cards[n]||0;
    if(D.dp){if(c&&k>=maxCopy(c))return toast(c.col==="铜"?"铜卡最多 2 张":"金卡最多 1 张");k++;}else k--;
    if(k>0)d.cards[n]=k;else delete d.cards[n];persist();rDeck();return;}
  const act=D.do;if(!act)return;
  ({start(){if(!setup.fac)return toast("选一下对手阵营");const d=deckById(setup.deck)||deckById($("#sDeck")?.value);if(!d)return toast("先建一个卡组");
      db.live={id:Date.now(),date:new Date().toISOString().slice(0,10),deck:d.id,deckName:d.name,myF:d.f,leader:d.leader,fac:setup.fac,coin:setup.coin,rounds:[],cur:0,pend:{res:null,me:"",op:"",hm:null,ho:null},diff:null,opLeader:null,hand:!!db.handPref,t0:Date.now(),rt0:Date.now(),lastT:Date.now(),log:[],stuck:[],note:""};
      ui.who=setup.coin==="后"?"op":"me";ui.act="play";ui.q="";setup.fac=null;setup.coin=null;persist();rMatch();},
    endRound(){const p=g.pend;if(!p.res)return toast("选一下本局结果");if(p.hm==null&&g.hand)p.hm=myHand(g).length;ui.vr=null;const now=Date.now();g.rounds.push({res:p.res,me:p.me,op:p.op,hm:p.hm??null,ho:p.ho??null,sec:g.rt0?Math.round((now-g.rt0)/1000):null});g.rt0=now;g.lastT=now;
      if(g.rounds.length===1)g.diff=(p.hm!=null&&p.ho!=null)?p.hm-p.ho:null;g.pend={res:null,me:"",op:"",hm:null,ho:null};g.cur=g.rounds.length;
      if(!outcome(g.rounds)){ui.who=g.rounds[g.rounds.length-1].res==="W"?"op":"me";toast(`进入第${g.cur+1}局`);}persist();rMatch();window.scrollTo(0,0);},
    undoRound(){const r=g.rounds.pop();g.cur=g.rounds.length;g.pend={res:r.res,me:r.me,op:r.op,hm:r.hm,ho:r.ho};persist();rMatch();},
    finish(){ui.vr=null;ui.flow=null;ui.insertBefore=null;const o=outcome(g.rounds);const {pend,cur,...rest}=g;db.games.push({...rest,res:o.res});db.live=null;persist();render();toast("已保存");},
    abort(){if(!confirm("放弃这局记录？已记的步骤会丢失。"))return;db.live=null;persist();render();},
    exAll(){if(!db.games.length)return toast("还没有对局");copyOut("全部对局代码",LEGEND+"\n"+db.games.map(gameCodeC).join("\n"));},
    backup(){copyOut("完整备份",JSON.stringify(db));},
    migAll(){copyOut("全部迁移导出",migText());},
    impAll(){const fi=$("#fileIn");fi.onchange=async()=>{const f=fi.files[0];if(!f)return;$("#dlgX").value=await f.text();fi.value="";};
      openDlg("全部导入","粘贴“全部迁移导出”的内容（点“点击粘贴”），或选择下载的备份文件。会替换这个浏览器里现有的全部数据。","","导入并替换",txt=>{let d;try{d=parseAll(txt);}catch(err){return toast("内容格式不对");}
        const n=d&&d.games?d.games.length:0,k=d&&d.decks?d.decks.length:0;
        if(!confirm(`导入 ${k} 个卡组、${n} 局对局${d&&d.live?"和 1 局进行中的对局":""}，替换现有数据（现有 ${db.decks.length} 个卡组、${db.games.length} 局）？`))return;
        if(!importObj(d))return toast("内容格式不对");persist();$("#dlg").close();ui.deckSel=db.decks[0]?.id;setup.deck=ui.deckSel;ui.statA=db.decks[0]?.id;ui.statB=db.decks[db.decks.length-1]?.id;render();toast("已导入");},{paste:true,file:true});},
    dl(){const b=new Blob([JSON.stringify(db)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="昆特对局簿备份_"+new Date().toISOString().slice(0,10)+".json";document.body.appendChild(a);a.click();a.remove();toast("已下载备份文件");},
    importOld(){importData(ui.oldData);ui.oldData=null;},
    restore(){const fi=$("#fileIn");fi.onchange=async()=>{const f=fi.files[0];if(!f)return;$("#dlgX").value=await f.text();fi.value="";};
      openDlg("恢复备份","点下面「选择文件」载入下载的备份，或者直接粘贴备份内容。旧版对局簿的备份也可以导入。","","导入",txt=>{try{const d=JSON.parse(txt);
        if(!importObj(d))throw 0;persist();$("#dlg").close();render();toast("已导入");}catch(err){toast("备份内容格式不对");}},{paste:true,file:true});},
    newDeck(){const d={id:db.nextId++,name:"新卡组",f:"NR",leader:"",tactic:"",cards:{}};db.decks.push(d);ui.deckSel=d.id;persist();rDeck();},
    dupDeck(){const s=deckById(ui.deckSel);if(!s)return;const d={...JSON.parse(JSON.stringify(s)),id:db.nextId++,name:s.name+" 副本"};db.decks.push(d);ui.deckSel=d.id;persist();rDeck();toast("已复制，改好后记得改名");},
    delDeck(){if(db.decks.length<2)return toast("至少保留一个卡组");if(!confirm("删除这个卡组？对局记录会保留。"))return;db.decks=db.decks.filter(x=>x.id!=ui.deckSel);ui.deckSel=db.decks[0].id;persist();rDeck();},
    exDeck(){copyOut("卡组代码",deckCode(deckById(ui.deckSel)));},
    impDeck(){openDlg("导入卡组","粘贴导出的卡组代码，或者每行写一张牌（例如「2× 科德温骑士」或「科德温骑士 x2」）。第一行可写卡组名。","","导入",txt=>{
      const lines=txt.split("\n").map(s=>s.trim()).filter(Boolean);const d={id:db.nextId++,name:"导入的卡组",f:"NR",leader:"",tactic:"",cards:{}};const miss=[];
      lines.forEach((l,idx)=>{let m;if((m=l.match(/^【昆特卡组】(.+)/))){d.name=m[1];return;}
        if((m=l.match(/领袖：([^｜]+)/)))d.leader=m[1]==="未选"?"":m[1];if((m=l.match(/战术：([^｜]+)/)))d.tactic=m[1]==="未填"?"":m[1];
        if((m=l.match(/阵营：([^｜]+)/))){const f=Object.keys(FN).find(k=>FN[k]===m[1]);if(f)d.f=f;return;}
        if(/^张数/.test(l))return;
        let k=1,n=l;if((m=l.match(/^(\d)\s*[×xX*]\s*(.+?)(（.*）)?$/))){k=+m[1];n=m[2];}else if((m=l.match(/^(.+?)\s*[×xX*]\s*(\d)$/))){n=m[1];k=+m[2];}
        n=n.trim();if(BY[n]){if(!isLeader(BY[n]))d.cards[n]=(d.cards[n]||0)+k;else d.leader=n;}else if(idx===0&&!d.name.startsWith("【"))d.name=n;else miss.push(n);});
      const fs=Object.keys(d.cards).map(n=>BY[n].f).filter(f=>f!=="NE");if(fs.length)d.f=fs[0];
      db.decks.push(d);ui.deckSel=d.id;persist();$("#dlg").close();rDeck();toast(miss.length?"有 "+miss.length+" 张没找到："+miss.slice(0,3).join("、"):"已导入");},{paste:true});},
    deckOwned(){ui.deckOwned=!ui.deckOwned;rDeck();},
    collOwned(){ui.collOwned=!ui.collOwned;rColl();},
    cfilClear(){ui.cfil={pv:[],rar:[],col:[],ser:[],t:[],kw:[]};rColl();},
    collCount(){ui.collMode="count";rColl();},collInfo(){ui.collMode="info";rColl();},
    exColl(){copyOut("牌库代码",collCode());},
    addCard(){if(ui.collF==="ALL")return toast("先选一个阵营");openDlg("新增卡牌","数据库里没有的牌，加到「"+FN[ui.collF]+"」。每行一张：名称 | 金或铜 | 单位/特殊/神器 | 粮草 | 战力 | 效果（战力、效果可省略）","","添加",txt=>{
      let ok=0;const bad=[];txt.split("\n").map(s=>s.trim()).filter(Boolean).forEach(l=>{const p=l.split(/\s*[|｜]\s*/);const [n,col,tp,pv,pw,...tx]=p;
        if(!n||!["金","铜"].includes(col)||!["单位","特殊","神器"].includes(tp)||isNaN(+pv)){bad.push(l);return;}if(BY[n]){bad.push(n+"（已存在）");return;}
        (db.custom=db.custom||[]).push({n,f:ui.collF,col,t:tp,pv:+pv,pw:pw||"-",tx:tx.join(" | ")});ok++;});
      addCustom();applyEdits();persist();$("#dlg").close();rColl();toast(`已添加 ${ok} 张`+(bad.length?`，${bad.length} 行格式不对`:""));},{paste:true});},
    impColl(){openDlg("批量导入牌库","每行或用顿号、逗号分隔写牌名，可带张数（例如「科德温骑士×2」）。导入的牌会加到现有牌库里，已有的取较大张数。","","导入",txt=>{
      const parts=txt.replace(/^.*[：:]/gm,"").split(/[\n、，,]+/).map(s=>s.trim()).filter(Boolean);let ok=0;const miss=[];
      parts.forEach(p=>{let m,n=p,k=1;if((m=p.match(/^(.+?)\s*[×xX*]\s*(\d)$/))){n=m[1].trim();k=+m[2];}const c=BY[n];if(!c){miss.push(n);return;}
        k=Math.min(k,maxCopy(c));db.owned[n]=Math.max(db.owned[n]||0,k);ok++;});
      persist();$("#dlg").close();rColl();toast(`导入 ${ok} 张`+(miss.length?`，${miss.length} 张没找到：${miss.slice(0,3).join("、")}`:""));},{paste:true});}
  })[act]?.();
});
function openCard(c){$("#cdN").textContent=c.n;
  $("#cdMeta").textContent=`${FN[c.f]}　${c.col} ${c.t}　${c.rar}${c.tags?"　"+c.tags:""}${c.ser&&!c.custom?"　"+serName(c.ser):""}${c.en&&c.en!==c.n?"　英文名 "+c.en:""}${db.edits[c.n]?"　（已修改）":""}`;
  $("#cdPv").value=c.pv;$("#cdPw").value=c.pw;$("#cdTx").value=c.tx;$("#cdAl").value=c.alias||"";
  let f2=(c.f2||[]).slice();
  const drawF2=()=>{$("#cdF2").innerHTML=["NR","MO","NG","ST","SK","SY"].filter(x=>x!==c.f).map(x=>`<button class="chip fac ${f2.includes(x)?"on":""}" style="--c:var(--${x})" data-f2="${x}">${FN[x]}</button>`).join("");
    $("#cdF2").querySelectorAll("[data-f2]").forEach(b=>b.onclick=()=>{const x=b.dataset.f2;f2=f2.includes(x)?f2.filter(y=>y!==x):[...f2,x];drawF2();});};
  $("#cdF2row").classList.toggle("hidden",c.f==="NE"||isLeader(c));drawF2();
  $("#cdEn").textContent=c.txe?"游戏当前英文描述（数值以这个为准，上面的中文描述可能是旧版本）：\n"+c.txe:"";
  $("#cdOk").onclick=()=>{const pv=parseInt($("#cdPv").value),pw=$("#cdPw").value.trim(),tx=$("#cdTx").value.trim(),al=$("#cdAl").value.trim();const e={};
    if(!isNaN(pv)&&pv!==c.orig.pv)e.pv=pv;if(pw&&pw!==String(c.orig.pw))e.pw=pw;if(tx&&tx!==c.orig.tx)e.tx=tx;if(al)e.alias=al;const d2=dualOf(c);if(f2.slice().sort().join()!==d2.slice().sort().join())e.f2=f2;
    if(Object.keys(e).length)db.edits[c.n]=e;else delete db.edits[c.n];applyEdits();persist();$("#cdlg").close();render();toast("已保存修改");};
  $("#cdReset").onclick=()=>{delete db.edits[c.n];applyEdits();persist();$("#cdlg").close();render();toast("已恢复默认");};
  $("#cdlg").showModal();}
$("#cdNo").onclick=()=>$("#cdlg").close();
document.addEventListener("click",e=>{const el=e.target.closest("[data-card]");if(el&&!e.target.closest("button")){openCard(C[+el.dataset.card]);}});
// drag units on the board to reorder / change row (same side only)
(function(){let dr=null;
  const rowAt=(x,y)=>{const el=document.elementFromPoint(x,y);return el&&el.closest(".brow[data-side]");};
  const clear=()=>document.querySelectorAll(".brow.drop").forEach(r=>r.classList.remove("drop"));
  document.addEventListener("pointerdown",e=>{const el=e.target.closest(".board [data-u]");if(!el||!db.live||el.dataset.umode==="multi")return;dr={el,id:el.dataset.u,x:e.clientX,y:e.clientY,on:false};});
  document.addEventListener("pointermove",e=>{if(!dr)return;const dx=e.clientX-dr.x,dy=e.clientY-dr.y;
    if(!dr.on&&Math.hypot(dx,dy)>8){dr.on=true;dr.el.classList.add("dragging");}
    if(dr.on){e.preventDefault();dr.el.style.transform=`translate(${dx}px,${dy}px)`;clear();const r=rowAt(e.clientX,e.clientY);if(r)r.classList.add("drop");}},{passive:false});
  const end=e=>{if(!dr)return;const d=dr;dr=null;if(!d.on)return;d.el.style.transform="";d.el.classList.remove("dragging");clear();
    suppressClick=true;setTimeout(()=>suppressClick=false,60);
    const row=rowAt(e.clientX,e.clientY);if(!row)return;const g=db.live;const B=board(g);const u=B.all[d.id]||B.all[+d.id];if(!u)return;
    const side=row.dataset.side,r=row.dataset.row;if(side!==u.side)return toast("只能在同一方半场内移动");
    let pos=0;[...row.querySelectorAll("[data-u]")].filter(c=>c!==d.el).forEach(c=>{const b=c.getBoundingClientRect(),cy=b.top+b.height/2;if(cy<e.clientY-b.height/2||(Math.abs(cy-e.clientY)<=b.height/2&&b.left+b.width/2<e.clientX))pos++;});
    const curIdx=B.R[u.side][u.row].indexOf(u);if(r===u.row&&pos===curIdx)return;
    const i=pushLog({who:ui.act==="move"?ui.who:u.side,a:"move",c:u.n,uid:u.uid,side:u.side,row:r,pos,fix:ui.act==="move"?undefined:true});
    toast(logText(g.log[i]));rMatch();};
  document.addEventListener("pointerup",end);document.addEventListener("pointercancel",()=>{if(dr){dr.el.style.transform="";dr.el.classList.remove("dragging");clear();dr=null;}});
})();
function fmt(s){s=Math.max(0,Math.floor(s));return Math.floor(s/60)+":"+String(s%60).padStart(2,"0");}
setInterval(()=>{const el=document.getElementById("clock");const g=db.live;if(!el||!g||!g.t0)return;const now=Date.now();
  el.innerHTML=`<span>总用时 <b>${fmt((now-g.t0)/1000)}</b></span><span>本局 <b>${fmt((now-(g.rt0||g.t0))/1000)}</b></span><span>距上一步 <b class="${(now-(g.lastT||g.t0))>60000?"bad":""}">${fmt((now-(g.lastT||g.t0))/1000)}</b></span>`;},1000);
load();
