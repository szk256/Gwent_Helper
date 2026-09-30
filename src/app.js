const FN={NR:"北方王国",MO:"怪兽",NG:"尼弗迦德",ST:"松鼠党",SK:"斯凯利格",SY:"辛迪加",NE:"中立"};
const OPP=["NR","MO","NG","ST","SK","SY"];
const C=RAW.map((r,i)=>({i,n:r[0],f:r[1],col:r[2],t:r[3],pw:r[4],pv:parseInt(r[5])||0,rar:r[6],tags:r[7],tx:r[8],en:r[9]||"",txe:r[10]||"",ser:r[11]||"",art:r[12]||"",ar:r[13]||"-"}));
C.forEach(c=>{c.orig={pw:c.pw,pv:c.pv,tx:c.tx};c.token=c.ser==="token";});
const EN2ZH={};C.forEach(c=>{if(c.en&&c.en!==c.n)EN2ZH[c.en]=c.n;});
const BY={};C.forEach(c=>BY[c.n]=c);
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
// 放在网址上时注册离线缓存（可安装到桌面）；本地文件打开时跳过
if(/^https?:/.test(location.protocol)&&"serviceWorker" in navigator&&/gwent_tracker\.html$|\/$/.test(location.pathname))navigator.serviceWorker.register("sw.js").catch(()=>{});
async function load(){try{if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(()=>{});}catch(e){}   // 申请持久存储，减少被浏览器自动清理
try{const raw=await readRaw();if(raw)db=JSON.parse(raw);}catch(e){}
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
  $("#dlgOk").onclick=()=>{onOk($("#dlgX").value);};$("#dlg").showModal();
  // 导入框：打开时直接读剪贴板填进去（省去点“点击粘贴”）；内容符合 opts.auto 时直接导入（导入本身会再确认）
  if(opts.paste&&!text&&navigator.clipboard&&navigator.clipboard.readText)navigator.clipboard.readText().then(t=>{t=(t||"").trim();if(!t||$("#dlgX").value||!$("#dlg").open)return;
    $("#dlgX").value=t;if(opts.auto&&opts.auto.test(t))onOk(t);else toast("已从剪贴板填入，确认后点「"+okLabel+"」");}).catch(()=>{});}
// 导出：复制成功只提示，不弹框；浏览器不让写剪贴板时才弹框让你手动复制
function copyOut(title,text,onDone){const fail=()=>openDlg(title,"浏览器不让写剪贴板，请全选下面的内容复制（Ctrl+A、Ctrl+C）。",text,"再复制一次",t=>copy(t));
  try{navigator.clipboard.writeText(text).then(()=>{toast("已复制："+title);if(onDone)onDone();}).catch(fail);}catch(e){fail();}}
function copy(t){try{navigator.clipboard.writeText(t).then(()=>toast("已复制")).catch(()=>{});}catch(e){}}
$("#dlgNo").onclick=()=>$("#dlg").close();
$("#dlgPaste").onclick=async()=>{try{const t=await navigator.clipboard.readText();if(!t)return toast("剪贴板是空的");$("#dlgX").value=t;toast("已粘贴");}catch(e){$("#dlgX").focus();toast("浏览器不让读剪贴板，请在框里按 Ctrl+V");}};
// 全部迁移：整个对局簿（卡组、对局、进行中的对局、牌库、改过的牌、自定义牌）
// 版本：构建号（打包时按内容生成，调试页面是“开发版”）+ 卡牌数据版本（patches.js 最新一条，没有则基线）
const BUILD=(typeof window!=="undefined"&&window.GWENT_BUILD)||"开发版";
const dataVer=()=>{const P=typeof GwentPatches!=="undefined"?GwentPatches:null;if(!P)return "?";const l=P.PATCHES.slice().sort((a,b)=>a.date<b.date?-1:1).pop();return "v"+((l&&l.ver)||P.BASE.ver);};
const verText=()=>"构建 "+BUILD+" · 卡牌数据 "+dataVer();
// 备份：记录上次下载备份/迁移导出的时间，超过 7 天提醒
function downloadBackup(){markBackup();const b=new Blob([JSON.stringify(db)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="昆特对局簿备份_"+new Date().toISOString().slice(0,10)+".json";document.body.appendChild(a);a.click();a.remove();toast("已下载备份文件");}
// 录屏时间：接受 12:30、1:02:05、1230（= 12:30），返回规范写法；空返回 ""，格式不对返回 false
function normVt(v){v=String(v||"").trim().replace(/：/g,":");if(!v)return "";let m;
  if((m=v.match(/^(\d{1,2}):(\d{1,2}):(\d{2})$/)))return +m[1]+":"+m[2].padStart(2,"0")+":"+m[3];
  if((m=v.match(/^(\d{1,3}):(\d{2})$/)))return +m[1]+":"+m[2];
  if((m=v.match(/^(\d{1,3})(\d{2})$/)))return +m[1]+":"+m[2];return false;}
function recTactic(who){const g=db.live;const nm=who==="me"?(deckById(g.deck)?.tactic||"战术"):"战术";const i=pushLog({who,a:"tactic",c:nm});ui.act="play";
  queue({t:"target",id:g.log[i].id},...(who==="me"?spawnStep(BY[nm],"leader","me"):[]));rMatch();}
// 导入 v2 对局代码（可多局，按 #GWLOG v2 分段）：卡组找同名同内容的，没有就新建；没结束的一局作为进行中的对局
function importGames(txt){const chunks=String(txt||"").split(/(?=^#GWLOG v2)/m).filter(t=>/^#GWLOG v2/.test(t.trim()));let n=0;
  if(!chunks.length){toast("不是对局代码（要 #GWLOG v2 开头）");return 0;}
  const key=o=>JSON.stringify(Object.entries(o||{}).sort());
  for(const ch of chunks){const r=GwentCodec.decodeGame(ch.trim());if(!r)continue;const g=r.game;
    if(r.deck){let dk=db.decks.find(d=>d.name===g.deckName&&key(d.cards)===key(r.deck.cards));if(!dk){dk=Object.assign({id:db.nextId++,name:g.deckName||"导入的卡组"},r.deck);db.decks.push(dk);}g.deck=dk.id;}
    const dup=db.games.find(x=>x.date===g.date&&x.deckName===g.deckName&&x.log.length===g.log.length&&JSON.stringify(x.rounds)===JSON.stringify(g.rounds));
    if(dup&&!confirm(`${g.date} ${g.deckName} 这局好像已经有了，还要再导入一份吗？`))continue;
    g.id=Date.now()+n;
    if(r.open||!g.res){if(db.live&&!confirm("有一局正在记录，用导入的这局替换它吗？"))continue;g.pend={res:null,me:"",op:"",hm:null,ho:null};db.live=g;}
    else db.games.push(g);n++;}
  if(n){persist();render();toast("导入了 "+n+" 局");}return n;}
function markBackup(){db.lastBackup=Date.now();persist();renderBackup();}
function backupAge(){return db.lastBackup?Math.floor((Date.now()-db.lastBackup)/86400000):null;}
function renderBackup(){const vi=document.getElementById("verInfo");if(vi)vi.textContent=verText();const el=document.getElementById("bkInfo");if(!el)return;const d=backupAge();const has=(db.games||[]).length||db.live;
  el.textContent=d==null?"还没有备份过":d===0?"今天已备份":"上次备份："+d+" 天前";el.classList.toggle("bad",!!has&&(d==null||d>=7));}
function migText(){return GwentCodec.encodeDb(db).replace("\n"," build="+BUILD+" data="+dataVer()+"\n");}   // 纯代码 v2（牌用官方编号，纯 ASCII）
function parseAll(txt){txt=(txt||"").trim();const v2=/^#GWMIG v2\b/.test(txt);if(txt.startsWith("#GWMIG"))txt=txt.slice(txt.indexOf("\n")+1);const d=JSON.parse(txt);return v2?GwentCodec.decodeDb(d):d;}   // v1（中文 JSON）、v2（纯代码）、备份文件都认

// ---------- export codes ----------
function deckCode(d){const i=deckInfo(d);const L=[`【昆特卡组】${d.name}`,`阵营：${FN[d.f]}｜领袖：${d.leader||"未选"}｜战术：${d.tactic||"未填"}`,`张数 ${i.n}｜粮草 ${i.pv}/${i.lim}｜单位 ${i.units}`];
  const rows=Object.entries(d.cards).map(([n,k])=>[BY[n],n,k]).sort((a,b)=>((b[0]?.col==="金")-(a[0]?.col==="金"))||((b[0]?.pv||0)-(a[0]?.pv||0)));
  rows.forEach(([c,n,k])=>L.push(`${k}× ${n}（${c?c.col+" "+c.t+" "+c.pv:"数据库无此牌"}）`));return L.join("\n");}
function collCode(){const L=["【昆特牌库】"];for(const f of ["NR","NE","MO","NG","ST","SK","SY"]){
  const all=C.filter(c=>c.f===f&&!isTactic(c)&&!isLeader(c)&&!c.token);const own=all.filter(c=>db.owned[c.n]>0);if(!own.length)continue;
  L.push(`${FN[f]}（${own.length}/${all.length} 种）：`+own.map(c=>c.n+(db.owned[c.n]>1?"×"+db.owned[c.n]:"")).join("、"));}return L.join("\n");}
const ACT={real:"真实比分",hand:"手牌",coin:"金币",adj:"改战力",play:"打出",order:"指令",leader:"领袖",tactic:"战术",effect:"效果",spawn:"生成",summon:"召唤",draw:"抽牌",fx:"整排效果",move:"移位",kill:"摧毁",mull:"换牌",pass:"停牌",note:"备注"};
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
    case "real":return `${w}：核对真实比分 ${x.v}`;
    case "hand":return `${w}：修正${sideN(x.side)}手牌 ${/^\d+$/.test(x.v)?"= "+x.v:x.v}`;
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
function pushLog(e){const g=db.live;g.nextE=g.nextE||1;const x=Object.assign({r:VR(),id:"e"+(g.nextE++)},e);if(g.vtCur&&x.vt==null)x.vt=g.vtCur;   // 录屏时间：复盘时填的当前录屏位置，之后的记录都带上if(g.t0&&!ui.insertBefore&&ui.vr==null){x.t=Math.round((Date.now()-g.t0)/1000);g.lastT=Date.now();}
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
    if(ui.act==="order"&&u.eu&&u.eu.isTactic){recTactic(u.side);return true;}   // 点场上的战术牌 = 用战术
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
  if(D.qnote){const i=pushLog({who:ui.who,a:"note",c:D.qnote});toast(logText(g.log[i]));rMatch();return true;}
  if(D.fixstep){ui.flow=[JSON.parse(D.fixstep)];rMatch();window.scrollTo(0,0);return true;}
  if(D.fixtgt){const e=entry(D.fixtgt);ui.sel=(e.tgts||[]).slice();ui.flow=[{t:"target",id:e.id}];rMatch();window.scrollTo(0,0);return true;}
  if(D.edit){ui.flow=[{t:"edit",id:D.edit}];rMatch();window.scrollTo(0,0);return true;}
  if(D.oplead){g.opLeader=D.oplead;const i=pushLog({who:"op",a:"leader",c:D.oplead});ui.act="play";queue({t:"target",id:g.log[i].id},...spawnStep(BY[D.oplead],"leader","op"));rMatch();return true;}
  if(D.fz!==undefined&&step&&step.t==="frenzy"){const e=entry(step.id);if(e){e.fz=D.fz==="1";persist();}nextStep();return true;}
  if(D.dn!==undefined&&step&&step.t==="deckCount"){const e=entry(step.id);const v=D.dn==="?"?parseInt($("#dnIn")?.value):+D.dn;if(e&&!isNaN(v)){e.dn=v;persist();}nextStep();return true;}
  if(D.trib!==undefined&&step&&step.t==="tribute"){const e=entry(step.id);if(e){e.pay=D.trib==="1";persist();}nextStep();return true;}
  if(D.handfix){const sd=D.handfix;const S0=sim(g,VR());const cur=S0?S0.E.s.sides[sd].handCount:0;
    openDlg(sideN(sd)+"手牌","推算现有 "+cur+" 张（抽牌、回手等没记时会偏）。输入 +n / -n 或实际张数：",String(cur),"记录",v=>{v=(v||"").trim();if(!v)return;$("#dlg").close();const i=pushLog({who:sd,a:"hand",side:sd,v});toast(logText(g.log[i]));rMatch();});return true;}
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
    tactic(){recTactic("me");},
    tacticOp(){recTactic("op");},
    pass(){const i=pushLog({who:ui.who,a:"pass"});ui.act="play";if(!ui.insertBefore&&ui.vr==null){ui.pendingSwitch=ui.who;doSwitch();}toast(logText(g.log[i]));rMatch();},
    fxRec(){const f=ui.fx;const i=pushLog({who:f.who||ui.who,a:"fx",c:f.k,side:f.side,row:f.row,dur:f.dur||null});ui.fx=null;ui.act="play";toast(logText(g.log[i]));rMatch();},
    keysHelp(){alert(window.GwentKeysHelp||"");},
    goNote(){ui.act="note";rMatch();window.scrollTo&&window.scrollTo(0,0);},
    editPresets(){openDlg("常用备注","每行一个，点一下就记录。",(db.notePresets||NOTE_PRESETS).join("\n"),"保存",v=>{db.notePresets=String(v||"").split(/\n/).map(x=>x.trim()).filter(Boolean);if(!db.notePresets.length)delete db.notePresets;persist();$("#dlg").close();rMatch();});},
    realScore(){const S0=sim(g,VR());const cur=S0?S0.score.me.total+":"+S0.score.op.total:"";
      openDlg("真实比分","录屏里这一手结束后的比分（我:对）。推算现在是 "+cur+"。想记在更早的位置，先在记录里点那一步选“在这之前插入”。",cur,"记录",v=>{const p=parseScore(v);if(!p)return toast("格式：我方:对方，例如 30:25");$("#dlg").close();const i=pushLog({who:ui.who,a:"real",v:p.me+":"+p.op});toast(logText(g.log[i]));rMatch();});},
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
    eVt(){const e=entry(step.id);openDlg("录屏时间","这一步在录屏里的时间（例如 12:30 或 1:02:05），清空则去掉。",e.vt||"","保存",v=>{v=normVt(v);if(v===false)return toast("格式：分:秒，例如 12:30");if(v)e.vt=v;else delete e.vt;persist();$("#dlg").close();rMatch();});},
    eInsert(){ui.insertBefore=step.id;ui.flow=null;rMatch();toast("插入模式：新记录会放在这一步之前");},
    insertOff(){ui.insertBefore=null;rMatch();},
    handToggle(){g.hand=!g.hand;db.handPref=g.hand;persist();rMatch();}
  };
  if(D.do&&A[D.do]){A[D.do]();return true;}
  return false;}

// 对局代码：纯代码 v2 见 codec.js（牌用官方编号，可导回）；gameCode 是中文可读的报告版
function gameCode(g){const o=g.rounds?outcome(g.rounds):null;const L=[`【昆特对局】${g.date}｜${g.deckName} vs ${FN[g.fac]||g.fac}｜${g.coin?g.coin+"手":"先后手未记"}｜结果 ${o?o.w+":"+o.l+" "+o.res:"未完成"}${g.ver?"｜构建 "+g.ver.build+"，卡牌数据 "+g.ver.data:""}`];
  g.rounds.forEach((r,ri)=>{const sc=(r.me!==""&&r.me!=null&&r.op!==""&&r.op!=null)?` 比分 ${r.me}:${r.op}`:"";const hd=(r.hm!=null&&r.ho!=null)?`｜结束时手牌 我${r.hm} 对${r.ho}`:"";L.push(`第${ri+1}局 ${{W:"赢",L:"输",D:"平"}[r.res]||"?"}${sc}${hd}`);
    let S0=null;try{S0=sim(g,ri);}catch(e){}
    g.log.filter(x=>x.r===ri).forEach(x=>{const st=S0&&S0.steps&&S0.steps[x.id];L.push("  "+(st?"["+stepLabel(st)+" "+st.me+":"+st.op+(x.vt?" 录屏 "+x.vt:"")+"] ":"")+logText(x));});
    const DR=S0?devReport(g,ri,S0):null;if(DR&&DR.n)L.push("  偏差报告：\n"+DR.text.split("\n").map(t=>"    "+t).join("\n"));});
  if(g.diff!=null&&!(g.rounds[0]&&g.rounds[0].hm!=null))L.push(`第一局结束牌差：${g.diff>0?"+":""}${g.diff}`);if(g.stuck?.length)L.push("卡手："+g.stuck.join("、"));if(g.note)L.push("备注："+g.note);return L.join("\n");}

// ---------- render ----------
function render(){$("#count").textContent=db.games.length+" 局";renderBackup();
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
   h+=`<div class="btns" style="justify-content:space-between;align-items:center;margin:4px 0 6px"><h2 style="font-size:17px">历史对局</h2>${(()=>{const d=backupAge();return db.games.length&&(d==null||d>=7)?`<button class="ghost bad mbOnly" data-do="dl">${d==null?"还没备份":d+" 天没备份"}·下载</button>`:"";})()}<div class="btns"><button class="ghost" data-do="impGame">导入对局</button><button class="ghost" data-do="exAll">导出全部对局</button><button class="ghost" data-do="migAll">全部迁移导出</button><button class="ghost" data-do="dl">下载备份</button><button class="ghost" data-do="impAll">全部导入</button></div></div>`;
   h+=db.games.length?db.games.slice().reverse().map(x=>{const col={W:"var(--win)",L:"var(--loss)",D:"var(--draw)"};const r0=x.rounds[0]||{};
     const hand=(r0.hm!=null&&r0.ho!=null)?`首局手牌 ${r0.hm}:${r0.ho}`:(x.diff!=null?`牌差 ${x.diff>0?"+":""}${x.diff}`:"");
     return `<div class="item"><div class="gems">${x.rounds.map(r=>`<i class="gem" style="--c:${col[r.res]}"></i>`).join("")}</div>
     <div class="meta"><b>${x.res} vs ${FN[x.fac]||x.fac}</b>　${x.date}<br>${esc(x.deckName)}　${x.coin||"?"}手　${hand}　${x.log.length} 步</div>
     <button class="ghost" data-reopen="${x.id}">修改</button><button class="ghost" data-ex="${x.id}" title="纯代码（牌用官方编号），可导回">导出</button><button class="ghost" data-exr="${x.id}" title="中文可读版，带逐步比分和偏差报告">报告</button><button class="x" data-delg="${x.id}" aria-label="删除">×</button></div>`;}).join(""):`<p class="note">还没有对局，从上面开始第一局。</p>`;
   $("#tab-match").innerHTML=h;const sd=$("#sDeck");if(sd)sd.onchange=e=>{setup.deck=+e.target.value;};return;}
  ensureIds(g);
  const d=deckById(g.deck);const cur=g.cur;const o=outcome(g.rounds);const vr=VR();const editing=ui.vr!=null;
  const nR=Math.max(g.rounds.length+(o?0:1),1);
  h+=`<div class="sheet"><div class="live-head"><h2>${esc(g.deckName)} vs ${FN[g.fac]}</h2>${g.ver&&g.ver.build!==BUILD?`<small class="note" title="开这局时的版本">构建 ${esc(g.ver.build)} 开局</small>`:""}<span class="btns" style="margin:0"><button class="ghost pcOnly" data-do="keysHelp" title="电脑快捷键">快捷键 ?</button><button class="ghost" data-do="abort">放弃</button></span></div>${g.t0&&!o?`<div class="clock" id="clock"></div>`:""}
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
      h+=`<div class="sheet eng"><div class="score"><b class="sm">${me}</b><span>:</span><b class="so">${op}</b>${cal}</div>${coinUsed?`<p class="note coins">金币　我方 <b>${cm}</b>　对方 <b>${co}</b></p>`:""}<p class="note coins">手牌（推算）　我方 <b>${S.E.s.sides.me.handCount}</b>　对方 <b>${S.E.s.sides.op.handCount}</b></p>${extraLine(S.E)}
        ${S.warns.length?`<details><summary class="note">引擎提示 ${S.warns.length} 条</summary>${S.warns.map(w=>`<div class="warn">${w.fix?`<button class="ghost" data-fixtgt="${w.id}">补目标</button>`:""}${w.step?`<button class="ghost" data-fixstep="${esc(JSON.stringify(w.step))}">补上</button>`:""}${esc(logText(entry(w.id)||{}).slice(0,24))}：${esc(w.m)}</div>`).join("")}</details>`:""}
        ${um.length?`<p class="note">未建模：${um.map(([n,k])=>esc(n)+(k>1?"×"+k:"")).join("、")}</p>`:""}
        <div class="btns" style="margin-top:6px"><button class="ghost" data-do="realScore">录入真实比分</button></div></div>`;
      const DR=devReport(g,vr,S);if(DR)h+=`<details class="sheet" ${DR.bad?"open":""}><summary><b>偏差报告</b>${DR.n?`　<span class="note">${DR.bad?"有偏差":"一致"}（核对点 ${DR.n} 个）</span>`:""}</summary>${DR.html}</details>`;}
    const hz=S&&S.E&&S.E.s.hazards;
    const fxTags=(s,r)=>hz?["m","r"].filter(w=>w===r&&hz[s][w]).map(w=>`<span class="fxtag">${esc(hz[s][w].kind)} ${hz[s][w].turns===Infinity?"":hz[s][w].turns}</span>`).join(""):F.filter(x=>x.side===s&&(x.row===r||x.row==="all")).map(x=>`<span class="fxtag">${esc(x.c)}${x.dur?" "+x.dur:""}</span>`).join("");
    const unitFace=n=>{const c=BY[n];return `${c&&c.art?`<img src="${ART(c.art)}" alt="" loading="lazy" onerror="this.remove()">`:""}${c&&c.t==="单位"&&c.pw!=="-"?`<span class="upw">${c.pw}</span>`:""}<span class="un">${esc(n)}</span>`;};
const unitFaceU=u=>{const e=u.eu;if(!e)return unitFace(u.n);const c=BY[u.n];const st=e.status||{};
      const cls=e.power>e.base?"up":e.power<e.base?"dn":"";
      const marks=[st.shield?"盾":"",st.vitality?"活"+st.vitality:"",st.bleed?"伤"+st.bleed:"",st.lock?"锁":"",st.poison?"毒":"",st.veil?"遮":"",st.resilience?"坚":"",
        st.spying?"潜":"",st.ambush?"伏":"",st.bounty?"赏":"",e.timer!=null?"计"+e.timer:"",e.def.cooldown!=null&&e.cd>0?"冷"+e.cd:"",e.def.order&&e.def.cooldown==null&&((e.def.charges!=null?e.def.charges:1)+(e.bonusCharges||0))!==1?"充"+Math.max(0,(e.def.charges!=null?e.def.charges:1)+(e.bonusCharges||0)-e.orderUsed):"",e.pat!=null?"耐"+e.pat:"",e.vars&&e.vars.count!=null?"倒"+e.vars.count:"",st.immune&&!e.def.status?.immune?"免":""].filter(Boolean).join(" ");
      return `${c&&c.art?`<img src="${ART(c.art)}" alt="" loading="lazy" onerror="this.remove()">`:""}${e.def.type!=="artifact"&&!e.isTactic?`<span class="upw ${cls}">${e.power}</span>`:""}${e.armor?`<span class="uar">${e.armor}</span>`:""}${e.unmodeled&&!e.isTactic?`<span class="unm">?</span>`:""}${marks?`<span class="ust">${marks}</span>`:""}<span class="un">${esc(u.n)}</span>`;};
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
          <button class="ghost" data-do="eInsert">在这之前插入</button><button class="ghost" data-do="eVt">录屏时间${entry(step.id)?.vt?" "+esc(entry(step.id).vt):""}</button><button class="ghost bad" data-do="eDel">删除</button><button class="ghost" data-do="flowCancel">关闭</button></div>`;}}
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
        // 只有先手方有战术牌（不算粮草）；先后手没记时两边都列出
        const fp=g.coin==="先"?"me":g.coin==="后"?"op":null;
        h+=`<div class="btns" style="margin-top:8px">${fp==="me"?bm:fp==="op"?bo:ui.who==="op"?bo+bm:bm+bo}</div>${fp?`<p class="note">只有先手方（${sideN(fp)}）有战术牌。</p>`:""}`;}
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
      else if(ui.act==="adj"){h+=`<div class="btns" style="margin-top:8px"><button class="ghost" data-coinfix="me">修正我方金币</button><button class="ghost" data-coinfix="op">修正对方金币</button><button class="ghost" data-handfix="me">修正我方手牌</button><button class="ghost" data-handfix="op">修正对方手牌</button></div><p class="note" style="margin:10px 0 4px">点要修正的单位。输入 +2 / -3 按增益或伤害结算（会过护盾、护甲），输入 7 直接设成 7；-盾 去掉护盾，+盾 加上，甲3 设护甲。对面刚落地的单位会记成它的落地战力。</p>${lanes("pick")}`;}
      else if(ui.act==="kill"){h+=`<p class="note" style="margin:10px 0 4px">点被摧毁的单位：</p>${lanes("pick")}`;}
      else if(ui.act==="note"){const pre=db.notePresets||NOTE_PRESETS;
        h+=`<p class="note" style="margin:10px 0 4px">点一下直接记（记在当前这一手）：</p><div class="btns" style="flex-wrap:wrap">${pre.map(t=>`<button class="ghost" data-qnote="${esc(t)}">${esc(t)}</button>`).join("")}<button class="ghost" data-do="editPresets">编辑常用</button></div>
        <div class="row"><input id="noteIn" placeholder="其他内容，例如：对方洗回 2 张牌 / 录屏 12:30" autocomplete="off"></div><button class="primary" data-do="noteRec">记录备注</button>`;}
      else h+=`<div class="row"><button class="primary" data-do="${ui.act}">${ui.who==="me"?"记录：我停牌":"记录：对方停牌"}</button></div>`;
      if(!["order","move","kill"].includes(ui.act))h+=`<details class="row mbOnly" ${ui.showBoard?"open":""} id="bdet"><summary class="note">场面（根据记录推算）</summary>${lanes("none")}</details>`;
      h+=`</div>`;
    }
    const lg=g.log.map((x,i)=>[x,i]).filter(([x])=>x.r===vr);
    h+=`<div class="sheet"><div class="btns" style="justify-content:space-between;align-items:center"><span class="lab" style="margin:0">第${vr+1}局记录 · 点一条可修改</span><span class="btns" style="margin:0"><small class="note" style="align-self:center">录屏</small><input id="vtIn" class="vt" placeholder="mm:ss" value="${esc(g.vtCur||"")}" autocomplete="off" title="复盘录屏时填当前录屏时间，之后的记录都会带上（快捷键 R）"><button class="ghost" data-do="goNote">＋备注</button><button class="ghost" data-do="undo" ${lg.length?"":"disabled"}>↶ 撤销上一步</button></span></div>
     <div class="log">${lg.length?lg.slice().reverse().map(([x,i])=>{const st=S&&S.steps&&S.steps[x.id];return `<div class="${x.who} ${ui.insertBefore===x.id?"ins":""}"><button class="le" data-edit="${x.id}">${st?`<small class="lmeta">${stepLabel(st)} · ${st.me}:${st.op}${x.vt?" · 录屏 "+esc(x.vt):x.t!=null?" · "+fmt(x.t):""}</small>`:""}${esc(logText(x).slice(2))}</button></div>`;}).join(""):`<p class="note">这一局还没有记录。</p>`}</div></div>`;
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
  {const vi=$("#vtIn");if(vi)vi.onchange=()=>{const v=normVt(vi.value);if(v===false){toast("录屏时间格式：分:秒，例如 12:30");return;}db.live.vtCur=v||undefined;vi.value=v||"";persist();toast(v?"之后的记录带上录屏 "+v:"已清除录屏时间");};}
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
  h+=`<p class="note mbOnly" style="text-align:center;margin-top:12px">${esc(verText())}</p>`;
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
  if(D.ex){copyOut("对局代码",GwentCodec.encodeGame(db.games.find(x=>x.id==D.ex)));return;}
  if(D.exr){copyOut("对局报告",gameCode(db.games.find(x=>x.id==D.exr)));return;}
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
      db.live={id:Date.now(),tacCard:true,ver:{build:BUILD,data:dataVer()},date:new Date().toISOString().slice(0,10),deck:d.id,deckName:d.name,myF:d.f,leader:d.leader,fac:setup.fac,coin:setup.coin,rounds:[],cur:0,pend:{res:null,me:"",op:"",hm:null,ho:null},diff:null,opLeader:null,hand:!!db.handPref,t0:Date.now(),rt0:Date.now(),lastT:Date.now(),log:[],stuck:[],note:""};
      ui.who=setup.coin==="后"?"op":"me";ui.act="play";ui.q="";setup.fac=null;setup.coin=null;persist();rMatch();},
    endRound(){const p=g.pend;if(!p.res)return toast("选一下本局结果");if(p.hm==null&&g.hand)p.hm=myHand(g).length;ui.vr=null;const now=Date.now();g.rounds.push({res:p.res,me:p.me,op:p.op,hm:p.hm??null,ho:p.ho??null,sec:g.rt0?Math.round((now-g.rt0)/1000):null});g.rt0=now;g.lastT=now;
      if(g.rounds.length===1)g.diff=(p.hm!=null&&p.ho!=null)?p.hm-p.ho:null;g.pend={res:null,me:"",op:"",hm:null,ho:null};g.cur=g.rounds.length;
      if(!outcome(g.rounds)){ui.who=g.rounds[g.rounds.length-1].res==="W"?"op":"me";toast(`进入第${g.cur+1}局`);}persist();rMatch();window.scrollTo(0,0);},
    undoRound(){const r=g.rounds.pop();g.cur=g.rounds.length;g.pend={res:r.res,me:r.me,op:r.op,hm:r.hm,ho:r.ho};persist();rMatch();},
    finish(){ui.vr=null;ui.flow=null;ui.insertBefore=null;const o=outcome(g.rounds);const {pend,cur,...rest}=g;db.games.push({...rest,res:o.res});db.live=null;persist();render();toast("已保存");
      // 记完一局：超过 7 天没备份就提醒下载
      const d=backupAge();if(d==null||d>=7)setTimeout(()=>{if(confirm("已保存。"+(d==null?"还没有备份过":"距上次备份 "+d+" 天")+"，现在下载一份备份文件吗？"))downloadBackup();},300);},
    abort(){if(!confirm("放弃这局记录？已记的步骤会丢失。"))return;db.live=null;persist();render();},
    exAll(){if(!db.games.length)return toast("还没有对局");copyOut("全部对局代码",db.games.map(g=>GwentCodec.encodeGame(g)).join("\n\n"));},
    impGame(){openDlg("导入对局","粘贴对局代码（#GWLOG v2 开头，可以多局）。带的卡组找不到同名同内容的会新建。","","导入",txt=>{const n=importGames(txt);if(n)$("#dlg").close();},{paste:true,auto:/^#GWLOG v2/});},
    backup(){copyOut("完整备份",JSON.stringify(db));},
    migAll(){copyOut("全部迁移导出",migText(),markBackup);},
    impAll(){const fi=$("#fileIn");fi.onchange=async()=>{const f=fi.files[0];if(!f)return;$("#dlgX").value=await f.text();fi.value="";};
      openDlg("全部导入","粘贴“全部迁移导出”的内容（点“点击粘贴”），或选择下载的备份文件。会替换这个浏览器里现有的全部数据。","","导入并替换",txt=>{let d;try{d=parseAll(txt);}catch(err){return toast("内容格式不对");}
        const n=d&&d.games?d.games.length:0,k=d&&d.decks?d.decks.length:0;
        if(!confirm(`导入 ${k} 个卡组、${n} 局对局${d&&d.live?"和 1 局进行中的对局":""}，替换现有数据（现有 ${db.decks.length} 个卡组、${db.games.length} 局）？`))return;
        if(!importObj(d))return toast("内容格式不对");persist();$("#dlg").close();ui.deckSel=db.decks[0]?.id;setup.deck=ui.deckSel;ui.statA=db.decks[0]?.id;ui.statB=db.decks[db.decks.length-1]?.id;render();toast("已导入");},{paste:true,file:true,auto:/^(#GWMIG|\{)/});},
    dl(){downloadBackup();},
    importOld(){importData(ui.oldData);ui.oldData=null;},
    restore(){const fi=$("#fileIn");fi.onchange=async()=>{const f=fi.files[0];if(!f)return;$("#dlgX").value=await f.text();fi.value="";};
      openDlg("恢复备份","点下面「选择文件」载入下载的备份，或者直接粘贴备份内容。旧版对局簿的备份也可以导入。","","导入",txt=>{try{const d=JSON.parse(txt);
        if(!importObj(d))throw 0;persist();$("#dlg").close();render();toast("已导入");}catch(err){toast("备份内容格式不对");}},{paste:true,file:true,auto:/^\{/});},
    newDeck(){const d={id:db.nextId++,name:"新卡组",f:"NR",leader:"",tactic:"",cards:{}};db.decks.push(d);ui.deckSel=d.id;persist();rDeck();},
    dupDeck(){const s=deckById(ui.deckSel);if(!s)return;const d={...JSON.parse(JSON.stringify(s)),id:db.nextId++,name:s.name+" 副本"};db.decks.push(d);ui.deckSel=d.id;persist();rDeck();toast("已复制，改好后记得改名");},
    delDeck(){if(db.decks.length<2)return toast("至少保留一个卡组");if(!confirm("删除这个卡组？对局记录会保留。"))return;db.decks=db.decks.filter(x=>x.id!=ui.deckSel);ui.deckSel=db.decks[0].id;persist();rDeck();},
    exDeck(){copyOut("卡组代码",GwentCodec.encodeDeck(deckById(ui.deckSel)));},
    impDeck(){openDlg("导入卡组","粘贴导出的卡组代码，或者每行写一张牌（例如「2× 科德温骑士」或「科德温骑士 x2」）。第一行可写卡组名。","","导入",txt=>{
      {const d2=GwentCodec.decodeDeck(txt);if(d2){const miss=Object.keys(d2.cards).filter(n=>!BY[n]);d2.id=db.nextId++;db.decks.push(d2);ui.deckSel=d2.id;persist();$("#dlg").close();rDeck();toast(miss.length?"有 "+miss.length+" 张没找到："+miss.slice(0,3).join("、"):"已导入");return;}}
      const lines=txt.split("\n").map(s=>s.trim()).filter(Boolean);const d={id:db.nextId++,name:"导入的卡组",f:"NR",leader:"",tactic:"",cards:{}};const miss=[];
      lines.forEach((l,idx)=>{let m;if((m=l.match(/^【昆特卡组】(.+)/))){d.name=m[1];return;}
        if((m=l.match(/领袖：([^｜]+)/)))d.leader=m[1]==="未选"?"":m[1];if((m=l.match(/战术：([^｜]+)/)))d.tactic=m[1]==="未填"?"":m[1];
        if((m=l.match(/阵营：([^｜]+)/))){const f=Object.keys(FN).find(k=>FN[k]===m[1]);if(f)d.f=f;return;}
        if(/^张数/.test(l))return;
        let k=1,n=l;if((m=l.match(/^(\d)\s*[×xX*]\s*(.+?)(（.*）)?$/))){k=+m[1];n=m[2];}else if((m=l.match(/^(.+?)\s*[×xX*]\s*(\d)$/))){n=m[1];k=+m[2];}
        n=n.trim();if(BY[n]){if(!isLeader(BY[n]))d.cards[n]=(d.cards[n]||0)+k;else d.leader=n;}else if(idx===0&&!d.name.startsWith("【"))d.name=n;else miss.push(n);});
      const fs=Object.keys(d.cards).map(n=>BY[n].f).filter(f=>f!=="NE");if(fs.length)d.f=fs[0];
      db.decks.push(d);ui.deckSel=d.id;persist();$("#dlg").close();rDeck();toast(miss.length?"有 "+miss.length+" 张没找到："+miss.slice(0,3).join("、"):"已导入");},{paste:true,auto:/^(【昆特卡组】|#GWDECK v2)/});},
    deckOwned(){ui.deckOwned=!ui.deckOwned;rDeck();},
    collOwned(){ui.collOwned=!ui.collOwned;rColl();},
    cfilClear(){ui.cfil={pv:[],rar:[],col:[],ser:[],t:[],kw:[]};rColl();},
    collCount(){ui.collMode="count";rColl();},collInfo(){ui.collMode="info";rColl();},
    exColl(){copyOut("牌库代码",GwentCodec.encodeColl(db.owned));},
    addCard(){if(ui.collF==="ALL")return toast("先选一个阵营");openDlg("新增卡牌","数据库里没有的牌，加到「"+FN[ui.collF]+"」。每行一张：名称 | 金或铜 | 单位/特殊/神器 | 粮草 | 战力 | 效果（战力、效果可省略）","","添加",txt=>{
      let ok=0;const bad=[];txt.split("\n").map(s=>s.trim()).filter(Boolean).forEach(l=>{const p=l.split(/\s*[|｜]\s*/);const [n,col,tp,pv,pw,...tx]=p;
        if(!n||!["金","铜"].includes(col)||!["单位","特殊","神器"].includes(tp)||isNaN(+pv)){bad.push(l);return;}if(BY[n]){bad.push(n+"（已存在）");return;}
        (db.custom=db.custom||[]).push({n,f:ui.collF,col,t:tp,pv:+pv,pw:pw||"-",tx:tx.join(" | ")});ok++;});
      addCustom();applyEdits();persist();$("#dlg").close();rColl();toast(`已添加 ${ok} 张`+(bad.length?`，${bad.length} 行格式不对`:""));},{paste:true});},
    impColl(){openDlg("批量导入牌库","粘贴牌库代码（#GWCOLL v2），或每行、用顿号逗号分隔写牌名，可带张数（例如「科德温骑士×2」）。导入的牌会加到现有牌库里，已有的取较大张数。","","导入",txt=>{
      {const o2=GwentCodec.decodeColl(txt);if(o2){let ok=0;const miss=[];for(const[n,k]of Object.entries(o2)){const c=BY[n];if(!c){miss.push(n);continue;}db.owned[n]=Math.max(db.owned[n]||0,Math.min(k,maxCopy(c)));ok++;}
        persist();$("#dlg").close();rColl();toast(`导入 ${ok} 张`+(miss.length?`，${miss.length} 张没找到`:""));return;}}
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
  const hist=typeof GwentPatches!=="undefined"?GwentPatches.history(c.n):[];
  $("#cdEn").textContent=(c.txe?"游戏当前英文描述（数值以这个为准，上面的中文描述可能是旧版本）：\n"+c.txe:"")+(hist.length?(c.txe?"\n\n":"")+"平衡改动：\n"+hist.map(h=>h.date+" "+[h.pw?"战力 "+h.pw.join("→"):"",h.pv?"粮草 "+h.pv.join("→"):"",h.tx||h.txe?"效果改动":"",h.note||""].filter(Boolean).join("，")).join("\n"):"");
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
