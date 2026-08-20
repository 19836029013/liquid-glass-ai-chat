const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];

let bridge=null;
try{bridge=window.Android||null}catch(e){bridge=null}
function safeGet(key,fallback=''){
  try{return localStorage.getItem(key)||fallback}catch(e){return fallback}
}

const state={
  conversations:[],
  conversationId:null,
  modelId:safeGet('ai.modelId'),
  modelSource:safeGet('ai.modelSource'),
  reasoningLevel:safeGet('ai.reasoningLevel','标准'),
  sending:false,
  clientApi:null,
};

const sidebar=$('#sidebar'),backdrop=$('#sidebarBackdrop'),toast=$('#toast');
const messagesEl=$('#messages'),promptInput=$('#promptInput'),sendButton=$('#sendButton');
const modelPopover=$('#modelPopover'),reasoningPopover=$('#reasoningPopover');
const apiBanner=$('#apiBanner');
const settingsBackdrop=$('#settingsBackdrop');

function showToast(text){
  toast.textContent=text;toast.classList.add('show');
  clearTimeout(showToast.t);showToast.t=setTimeout(()=>toast.classList.remove('show'),1700);
}
function escapeHTML(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function timeOf(iso){try{return new Date(iso).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}catch{return ''}}
function scrollBottom(smooth=true){requestAnimationFrame(()=>window.scrollTo({top:document.body.scrollHeight,behavior:smooth?'smooth':'auto'}))}
function loadJSON(key,fallback=null){try{return JSON.parse(localStorage.getItem(key)||'null')??fallback}catch{return fallback}}
function saveJSON(key,value){localStorage.setItem(key,JSON.stringify(value))}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8)}
function nowISO(){return new Date().toISOString()}

/* ---------- content normalization (v3 fix) ---------- */
function decodeJsonishString(input){
  const s=String(input??'');
  const t=s.trim();
  if(!t)return '';
  if((t.startsWith('{')&&t.endsWith('}'))||(t.startsWith('[')&&t.endsWith(']'))){
    try{
      const parsed=JSON.parse(t);
      if(parsed!==input)return normalizeText(parsed);
    }catch{}
  }
  const matches=[...t.matchAll(/\{\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}/g)];
  if(matches.length){
    return matches.map(m=>{
      try{return JSON.parse(`"${m[1]}"`)}catch{return m[1]}
    }).join('');
  }
  return s;
}
function normalizeText(value){
  if(value==null)return '';
  if(typeof value==='string')return decodeJsonishString(value);
  if(Array.isArray(value))return value.map(normalizeText).join('');
  if(typeof value==='object'){
    for(const k of ['text','output_text','content']){
      if(k in value){const t=normalizeText(value[k]);if(t)return t}
    }
    for(const k of ['delta','message']){
      if(k in value){const t=normalizeText(value[k]);if(t)return t}
    }
  }
  return '';
}
function normalizeModelList(value){
  const raw=Array.isArray(value)?value:String(value||'').split(/[\n,，;；]+/);
  const seen=new Set(),out=[];
  for(const item of raw){
    const id=String(item||'').trim();
    if(!id||seen.has(id)||looksLikeApiKey(id))continue;
    seen.add(id);out.push(id);
  }
  return out.slice(0,200);
}
function looksLikeApiKey(value){
  const s=String(value||'').trim().toLowerCase();
  return s.startsWith('sk-')||s.startsWith('bearer ')||/^key[-_:]/.test(s);
}
function sanitizeReasoningParameter(value,models=[]){
  const raw=String(value||'').trim();
  if(!raw)return '';
  const knownModels=normalizeModelList(models);
  if(knownModels.includes(raw))return '';
  if(/^(deepseek|gpt|claude|gemini|luna|opus|qwen|glm|kimi)[-_]/i.test(raw))return '';
  return raw;
}
(function migrateBrokenModelState(){
  const raw=loadJSON('ai.clientApi',null);
  if(!raw)return;
  const apiKey=String(raw.api_key||'').trim();
  const model=String(raw.model||'').trim();
  if(model&&(model===apiKey||looksLikeApiKey(model))){
    raw.model='';
    raw.models=normalizeModelList(raw.models||[]);
    saveClientApi(raw);
    localStorage.removeItem('ai.modelId');
    localStorage.setItem('ai.modelSource','local');
    state.modelId='';
    state.modelSource='local';
  }
})();

/* Streaming transport normalizer: buffers split JSON wrappers like {"text":"你"} and emits pure text. */
class StreamingTextNormalizer{
  constructor(){this.buffer='';this.wrapperMode=false}
  feed(chunk){
    if(!chunk)return [];
    if(this.wrapperMode){this.buffer+=chunk;return this.drainWrapper()}
    if(this.buffer){this.buffer+=chunk;return this.resolveProbe()}
    const stripped=chunk.replace(/^\s+/,'');
    if(stripped.startsWith('{')||stripped.startsWith('[')){
      this.buffer=chunk;
      return this.resolveProbe();
    }
    return [chunk];
  }
  resolveProbe(){
    const stripped=this.buffer.replace(/^\s+/,'');
    if(/^\{\s*"(?:text|content|output_text)"\s*:/.test(stripped)||/^\[\s*\{\s*"(?:text|content|output_text)"\s*:/.test(stripped)){
      this.wrapperMode=true;
      return this.drainWrapper();
    }
    const m=/^\{\s*"([^"]+)"\s*:/.exec(stripped);
    if(m&&!['text','content','output_text'].includes(m[1])){
      const raw=this.buffer;this.buffer='';return [raw];
    }
    if(this.buffer.length>96){
      const raw=this.buffer;this.buffer='';return [raw];
    }
    return [];
  }
  drainWrapper(){
    const out=[];
    while(this.buffer){
      const leading=this.buffer.length-this.buffer.replace(/^\s+/,'').length;
      if(leading){
        this.buffer=this.buffer.slice(leading);
        if(!this.buffer)break;
      }
      if(!this.buffer.startsWith('{')&&!this.buffer.startsWith('[')){
        const raw=this.buffer;this.buffer='';this.wrapperMode=false;
        if(raw)out.push(raw);
        break;
      }
      const end=firstJsonEnd(this.buffer);
      if(end<0)break;
      const rawValue=this.buffer.slice(0,end);
      this.buffer=this.buffer.slice(end);
      try{
        const value=JSON.parse(rawValue);
        const text=normalizeText(value);
        if(text)out.push(text);
        else if(rawValue)out.push(rawValue);
      }catch(e){
        if(rawValue)out.push(rawValue);
      }
    }
    return out;
  }
  finish(){
    if(!this.buffer)return [];
    const raw=this.buffer;this.buffer='';
    try{
      const text=normalizeText(JSON.parse(raw));
      if(text)return [text];
    }catch(e){}
    return [raw];
  }
}
function firstJsonEnd(s){
  let i=0;
  while(i<s.length&&/\s/.test(s[i]))i++;
  if(s[i]!=='{'&&s[i]!=='[')return -1;
  const stack=[];let inStr=false,esc=false;
  for(let j=i;j<s.length;j++){
    const c=s[j];
    if(inStr){
      if(esc)esc=false;
      else if(c==='\\')esc=true;
      else if(c==='"')inStr=false;
      continue;
    }
    if(c==='"'){inStr=true;continue}
    if(c==='{'||c==='[')stack.push(c);
    else if(c==='}'||c===']'){
      const open=stack.pop();
      if((c==='}'&&open!=='{')||(c===']'&&open!=='['))return -1;
      if(!stack.length)return j+1;
    }
  }
  return -1;
}

/* ---------- API config (local, mirrored to native storage) ---------- */
function readClientApi(){
  try{
    if(bridge&&bridge.getConfig){
      const raw=bridge.getConfig();
      if(raw&&raw.trim()){
        const c=JSON.parse(raw);
        if(c.apiBase||c.apiKey||c.model){
          return {base_url:String(c.apiBase||'').trim().replace(/\/+$/,''),api_key:String(c.apiKey||'').trim(),model:String(c.model||'').trim(),reasoning_parameter:String(c.reasoningParam||'').trim(),models:normalizeModelList(c.models||[])};
        }
      }
    }
  }catch(e){}
  const local=loadJSON('ai.clientApi',null);
  return local?{...local,models:normalizeModelList(local.models||[])}:null;
}
function getClientApi(){
  const clean=getStoredClientApiRaw();
  return clean&&clean.base_url&&clean.api_key&&clean.model?clean:null;
}
function getStoredClientApiRaw(){
  const cfg=readClientApi();
  if(!cfg)return null;
  const apiKey=String(cfg.api_key||'').trim();
  let model=String(cfg.model||'').trim();
  if(!model||model===apiKey||looksLikeApiKey(model))model='';
  return {
    base_url:String(cfg.base_url||'').trim().replace(/\/+$/,''),
    api_key:apiKey,
    model,
    reasoning_parameter:String(cfg.reasoning_parameter||'').trim(),
    models:normalizeModelList(cfg.models||[]),
  };
}
function saveClientApi(cfg){
  saveJSON('ai.clientApi',cfg);
  try{
    if(bridge&&bridge.saveConfig){
      bridge.saveConfig(JSON.stringify({apiBase:cfg.base_url,apiKey:cfg.api_key,model:cfg.model,reasoningParam:cfg.reasoning_parameter,models:normalizeModelList(cfg.models||[])}));
    }
  }catch(e){}
}
function clientModelIds(){
  const cfg=getStoredClientApiRaw();if(!cfg)return [];
  return normalizeModelList([cfg.model,...(cfg.models||[])]);
}
function isConfigured(){return !!getClientApi()}
function updateApiBanner(){
  const configured=isConfigured();
  apiBanner.hidden=configured;
  apiBanner.classList.toggle('force-hidden',configured);
  apiBanner.setAttribute('aria-hidden',configured?'true':'false');
}

/* ---------- local conversations ---------- */
function loadConversations(){
  let raw='';
  try{if(bridge&&bridge.getState)raw=bridge.getState()||''}catch(e){}
  if(!raw)raw=localStorage.getItem('lgchat_convs')||'';
  if(raw&&raw.trim()){try{state.conversations=JSON.parse(raw)}catch(e){state.conversations=[]}}
  if(!Array.isArray(state.conversations))state.conversations=[];
}
let saveTimer=null;
function saveConversations(){
  const json=JSON.stringify(state.conversations);
  try{localStorage.setItem('lgchat_convs',json)}catch(e){}
  if(bridge&&bridge.saveState){
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>{try{bridge.saveState(json)}catch(e){}},400);
  }
}
function currentConversation(){return state.conversations.find(c=>c.id===state.conversationId)||null}
function newConversation(){
  const c={id:uid(),title:'新对话',pinned:false,created_at:nowISO(),messages:[]};
  state.conversations.push(c);
  state.conversationId=c.id;
  saveConversations();
  return c;
}

/* ---------- rendering ---------- */
function reasoningBlock(message){
  const summary=message.reasoning_summary||'';
  return `<button class="reasoning-toggle" data-reasoning-toggle ${summary?'':'disabled'} aria-expanded="false"><span>✺</span><span>深度思考</span><span class="chevron">⌄</span></button>
  <div class="reasoning-panel" data-reasoning-panel><div class="reasoning-scroll">${escapeHTML(summary).replace(/\n/g,'<br>')}</div></div>`;
}
function actions(message){return `<div class="message-actions">
  <button data-action="copy" data-mid="${message.id}">▢ <span>复制</span></button>
  <button data-action="regen" data-mid="${message.id}">↻ <span>重新生成</span></button>
  <button data-action="share" data-mid="${message.id}">⇧ <span>分享</span></button>
  <button data-action="branch" data-mid="${message.id}">⑂ <span>创建分支</span></button>
</div>`}
function messageHTML(message){
  const content=normalizeText(message.content);
  if(message.role==='user')return `<div class="turn turn-user" data-message-id="${message.id}"><div class="user-bubble"><p>${escapeHTML(content).replace(/\n/g,'<br>')}</p><div class="meta user-meta">${timeOf(message.created_at)} <span class="checks">✓✓</span></div></div></div>`;
  return `<div class="turn turn-assistant" data-message-id="${message.id}"><div class="assistant-avatar">✦</div><div class="assistant-stack">${reasoningBlock(message)}<div class="assistant-bubble"><p>${escapeHTML(content).replace(/\n/g,'<br>')}</p><div class="meta">${timeOf(message.created_at)}</div></div>${actions(message)}</div></div>`;
}
function bindMessageInteractions(root=messagesEl){
  $$('[data-reasoning-toggle]',root).forEach(toggle=>{
    if(toggle.dataset.bound)return;toggle.dataset.bound='1';
    toggle.addEventListener('click',()=>{
      if(toggle.disabled)return;
      const panel=toggle.nextElementSibling,next=!panel.classList.contains('open');
      panel.classList.toggle('open',next);toggle.classList.toggle('open',next);toggle.setAttribute('aria-expanded',String(next));$('.chevron',toggle).textContent=next?'⌃':'⌄';
    });
  });
  $$('[data-action]',root).forEach(btn=>{
    if(btn.dataset.bound)return;btn.dataset.bound='1';btn.addEventListener('click',()=>handleAction(btn.dataset.action,btn.dataset.mid));
  });
}
function renderMessages(items){messagesEl.innerHTML=items.map(messageHTML).join('');bindMessageInteractions()}
function appendTempAssistant(msg){
  messagesEl.insertAdjacentHTML('beforeend',messageHTML(msg));
  const turn=$(`[data-message-id="${msg.id}"]`);
  const p=$('.assistant-bubble p',turn);
  if(p)p.classList.add('streaming-caret');
  bindMessageInteractions(turn);
  return turn;
}

/* ---------- sidebar / history ---------- */
function historyButton(c){
  const b=document.createElement('button');b.className='side-item chat-history'+(c.id===state.conversationId?' current':'');
  b.innerHTML=`<span>${c.pinned?'⌖':'◷'}</span><span>${escapeHTML(c.title)}</span>`;b.addEventListener('click',()=>loadConversation(c.id));return b;
}
function renderHistory(){
  const pinned=$('#pinnedChatList'),recent=$('#recentChatList');
  pinned.innerHTML='';recent.innerHTML='';
  [...state.conversations].sort((a,b)=>((b.pinned?1:0)-(a.pinned?1:0))||((b.created_at||'').localeCompare(a.created_at||''))).forEach(c=>(c.pinned?pinned:recent).appendChild(historyButton(c)));
  if(!pinned.children.length)pinned.innerHTML='<div class="empty-history">暂无置顶聊天</div>';
  if(!recent.children.length)recent.innerHTML='<div class="empty-history">暂无最近聊天</div>';
}
function loadConversation(id){
  const conv=state.conversations.find(c=>c.id===id);if(!conv)return;
  state.conversationId=id;
  $('#greeting').textContent=conv.title||'对话';
  renderMessages(conv.messages||[]);
  closeSidebar();renderHistory();scrollBottom(false);
}
function newChat(){
  state.conversationId=null;
  messagesEl.innerHTML='';
  $('#greeting').textContent='你好，今天想聊点什么？';
  promptInput.value='';promptInput.focus();
  closeSidebar();renderHistory();showToast('新建对话');
}

/* ---------- sidebar / swipe ---------- */
function openSidebar(){sidebar.classList.add('open');sidebar.setAttribute('aria-hidden','false');backdrop.classList.add('show')}
function closeSidebar(){sidebar.classList.remove('open');sidebar.setAttribute('aria-hidden','true');backdrop.classList.remove('show')}
$('#menuButton').addEventListener('click',openSidebar);
backdrop.addEventListener('click',closeSidebar);
$$('[data-sidebar-close]').forEach(b=>b.addEventListener('click',closeSidebar));
$('#newChatButton').addEventListener('click',newChat);
$('#addProjectButton').addEventListener('click',()=>showToast('项目功能等待后续接入'));

let swipeStart=null;
function beginSwipe(x,y,pointer='touch'){
  if(document.body.classList.contains('settings-open')||!settingsBackdrop.hidden){
    swipeStart=null;
    return;
  }
  const open=sidebar.classList.contains('open');
  if(open||x<=Math.max(90,window.innerWidth*.55))swipeStart={x,y,open,pointer};
}
function endSwipe(x,y){
  if(document.body.classList.contains('settings-open')||!settingsBackdrop.hidden){
    swipeStart=null;
    return;
  }
  if(!swipeStart)return;
  const dx=x-swipeStart.x,dy=y-swipeStart.y;
  if(Math.abs(dx)>72&&Math.abs(dx)>Math.abs(dy)*1.15){
    if(!swipeStart.open&&dx>0)openSidebar();
    if(swipeStart.open&&dx<0)closeSidebar();
  }
  swipeStart=null;
}
document.addEventListener('touchstart',e=>{if(e.touches.length===1)beginSwipe(e.touches[0].clientX,e.touches[0].clientY,'touch')},{passive:true});
document.addEventListener('touchend',e=>{if(e.changedTouches.length)endSwipe(e.changedTouches[0].clientX,e.changedTouches[0].clientY)},{passive:true});
document.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse')beginSwipe(e.clientX,e.clientY,'mouse')},{passive:true});
document.addEventListener('pointerup',e=>{if(swipeStart?.pointer==='mouse')endSwipe(e.clientX,e.clientY)},{passive:true});

/* ---------- model / reasoning menus ---------- */
function chooseModel(id,source){
  state.modelId=id;state.modelSource=source;
  localStorage.setItem('ai.modelId',id);localStorage.setItem('ai.modelSource',source);
  $('#modelLabel').textContent=id||'选择模型';closePopovers();
}
function rebuildModelMenu(){
  modelPopover.innerHTML='';
  const entries=[];
  if(isConfigured()){
    clientModelIds().forEach(id=>entries.push({id,source:'local',available:true,label:id}));
  }
  const seen=new Set();
  for(const m of entries){
    const key=`${m.source}:${m.id}`;if(seen.has(key))continue;seen.add(key);
    const b=document.createElement('button');b.textContent=m.label;b.title=m.id;b.disabled=!m.available;
    if(m.id===state.modelId&&m.source===state.modelSource)b.classList.add('current-model');
    b.addEventListener('click',()=>chooseModel(m.id,m.source));modelPopover.appendChild(b);
  }
  if(!entries.length){
    const b=document.createElement('button');b.textContent='先配置 AI 接口';b.disabled=true;modelPopover.appendChild(b);
    const s=document.createElement('button');s.textContent='⚙ 去设置';s.addEventListener('click',()=>{closePopovers();openSettings('api')});modelPopover.appendChild(s);
  }
  const currentValid=entries.some(e=>e.available&&e.id===state.modelId&&e.source===state.modelSource);
  if(!currentValid){
    const preferred=entries.find(e=>e.available);
    if(preferred)chooseModel(preferred.id,preferred.source);else{$('#modelLabel').textContent='选择模型';state.modelId='';state.modelSource=''}
  }else $('#modelLabel').textContent=state.modelId;
}
function loadConfig(){
  state.clientApi=getClientApi();
  reasoningPopover.innerHTML='';
  ['简洁','标准','深入','最高'].forEach(level=>{
    const b=document.createElement('button');b.textContent=level;b.addEventListener('click',()=>{state.reasoningLevel=level;localStorage.setItem('ai.reasoningLevel',level);$('#reasoningLabel').textContent=level;closePopovers()});reasoningPopover.appendChild(b);
  });
  $('#reasoningLabel').textContent=state.reasoningLevel;
  rebuildModelMenu();updateApiBanner();
}
function closePopovers(except){[modelPopover,reasoningPopover].forEach(p=>{if(p!==except)p.classList.remove('show')})}
$('#modelSelect').addEventListener('click',e=>{e.stopPropagation();const o=!modelPopover.classList.contains('show');closePopovers(modelPopover);modelPopover.classList.toggle('show',o)});
$('#reasoningSelect').addEventListener('click',e=>{e.stopPropagation();const o=!reasoningPopover.classList.contains('show');closePopovers(reasoningPopover);reasoningPopover.classList.toggle('show',o)});
document.addEventListener('click',()=>closePopovers());

/* ---------- streaming (native bridge first, fetch fallback) ---------- */
let pendingStream=null,pendingComplete=null,pendingTest=null,pendingQuery=null;
function apiUrl(cfg){return (cfg.base_url||'https://api.deepseek.com').replace(/\/+$/,'')+'/chat/completions'}
function extractContent(v){
  if(typeof v==='string')return v;
  if(Array.isArray(v))return v.map(i=>typeof i==='string'?i:((i&&(i.text||i.content))||'')).join('');
  return '';
}
function buildPayload(cfg,messages){
  const payload={model:cfg.model,messages,stream:true};
  const isDeepseekV4=(cfg.base_url||'').toLowerCase().includes('api.deepseek.com')&&String(cfg.model||'').toLowerCase().startsWith('deepseek-v4');
  if(isDeepseekV4){
    if(state.reasoningLevel==='简洁'){
      payload.thinking={type:'disabled'};
    }else{
      payload.thinking={type:'enabled'};
      payload.reasoning_effort=state.reasoningLevel==='最高'?'max':'high';
    }
  }else if(cfg.reasoning_parameter){
    const map={'简洁':'low','标准':'medium','深入':'high','最高':'high'};
    payload[cfg.reasoning_parameter]=map[state.reasoningLevel]||'medium';
  }
  return payload;
}
function streamChat(cfg,messages,handlers){
  return new Promise((resolve,reject)=>{
    if(bridge&&bridge.streamChat){
      pendingStream={resolve,reject,handlers};
      bridge.streamChat(JSON.stringify({url:apiUrl(cfg),apiKey:cfg.api_key,payload:buildPayload(cfg,messages)}));
      return;
    }
    fetchStream(cfg,messages,handlers).then(resolve,reject);
  });
}
function completeChat(cfg,messages){
  return new Promise((resolve,reject)=>{
    if(bridge&&bridge.completeChat){
      pendingComplete={resolve,reject};
      bridge.completeChat(JSON.stringify({url:apiUrl(cfg),apiKey:cfg.api_key,payload:{model:cfg.model,messages,stream:false}}));
      return;
    }
    fetchComplete(cfg,messages).then(resolve,reject);
  });
}
function testApi(cfg){
  return new Promise((resolve,reject)=>{
    if(bridge&&bridge.testApi){
      pendingTest={resolve,reject};
      bridge.testApi(JSON.stringify({base_url:cfg.base_url,api_key:cfg.api_key,model:cfg.model}));
      return;
    }
    fetchTest(cfg).then(resolve,reject);
  });
}
function queryModels(cfg){
  return new Promise((resolve,reject)=>{
    if(bridge&&bridge.queryModels){
      pendingQuery={resolve,reject};
      bridge.queryModels(JSON.stringify({base_url:cfg.base_url,api_key:cfg.api_key}));
      return;
    }
    fetchQueryModels(cfg).then(resolve,reject);
  });
}
function handleEvent(name,data){
  if(typeof data==='string'){
    try{data=JSON.parse(data)}catch(e){data={}}
  }
  if(name==='models'&&pendingQuery){
    const p=pendingQuery;pendingQuery=null;
    if(data&&data.ok)p.resolve(data);else p.reject(new Error((data&&data.message)||'模型查询失败'));
    return;
  }
  if(name==='test'&&pendingTest){
    const p=pendingTest;pendingTest=null;
    if(data&&data.ok)p.resolve(data);else p.reject(new Error((data&&data.message)||'连接失败'));
    return;
  }
  if(name==='error'){
    const msg=(data&&data.message)||'请求失败';
    if(pendingStream){const p=pendingStream;pendingStream=null;p.reject(new Error(msg));return}
    if(pendingComplete){const p=pendingComplete;pendingComplete=null;p.reject(new Error(msg));return}
    return;
  }
  if(name==='done'&&pendingStream){
    const p=pendingStream;pendingStream=null;
    try{if(p.handlers&&p.handlers.done)p.handlers.done()}catch(e){}
    p.resolve();
    return;
  }
  if(name==='complete'&&pendingComplete){
    const p=pendingComplete;pendingComplete=null;
    p.resolve((data&&data.text)||'');
    return;
  }
  if(pendingStream&&pendingStream.handlers&&pendingStream.handlers[name]){
    let payload=data;
    if(name==='delta'||name==='reasoning')payload=(data&&data.text)||'';
    try{pendingStream.handlers[name](payload)}catch(e){}
  }
}
window.AndroidEvents={onEvent:handleEvent};

async function fetchQueryModels(cfg){
  let base=(cfg.base_url||'').trim().replace(/\/+$/,'');
  base=base.replace(/\/v1\/chat\/completions$/i,'').replace(/\/chat\/completions$/i,'').replace(/\/v1beta$/i,'').replace(/\/v1$/i,'');
  let models=[];
  for(const path of ['/models','/v1/models']){
    try{
      const r=await fetch(base+path,{headers:{'Authorization':'Bearer '+cfg.api_key}});
      if(r.ok){
        const j=await r.json();
        models=normalizeModelList((j.data||[]).map(m=>m&&m.id?m.id:m));
        if(models.length)break;
      }
    }catch(e){}
  }
  if(!models.length)throw new Error('接口没有返回可用模型');
  return {ok:true,models,message:`找到 ${models.length} 个模型`};
}

async function fetchStream(cfg,messages,handlers){
  const res=await fetch(apiUrl(cfg),{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.api_key},body:JSON.stringify(buildPayload(cfg,messages))});
  if(!res.ok){let msg='请求失败';try{const j=await res.json();msg=(j.error&&(j.error.message||j.error.code))||msg}catch(e){}throw new Error(msg)}
  const reader=res.body.getReader(),decoder=new TextDecoder();let buf='';
  while(true){
    const {value,done}=await reader.read();if(done)break;
    buf+=decoder.decode(value,{stream:true});let idx;
    while((idx=buf.indexOf('\n'))>=0){
      const line=buf.slice(0,idx).trim();buf=buf.slice(idx+1);
      if(!line.startsWith('data:'))continue;
      const raw=line.slice(5).trim();
      if(raw==='[DONE]'){if(handlers.done)handlers.done();return}
      try{
        const j=JSON.parse(raw),delta=(j.choices&&j.choices[0]&&j.choices[0].delta)||{};
        const t=extractContent(delta.content);if(t&&handlers.delta)handlers.delta(t);
        const r=extractContent(delta.reasoning_content);if(r&&handlers.reasoning)handlers.reasoning(r);
      }catch(e){}
    }
  }
  if(handlers.done)handlers.done();
}
async function fetchComplete(cfg,messages){
  const res=await fetch(apiUrl(cfg),{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.api_key},body:JSON.stringify({model:cfg.model,messages,stream:false})});
  if(!res.ok){let msg='请求失败';try{const j=await res.json();msg=(j.error&&(j.error.message||j.error.code))||msg}catch(e){}throw new Error(msg)}
  const j=await res.json(),msg=j.choices&&j.choices[0]&&j.choices[0].message;
  return msg?extractContent(msg.content):'';
}
async function fetchTest(cfg){
  let models=[];
  try{
    const r=await fetch(cfg.base_url.replace(/\/+$/,'')+'/models',{headers:{'Authorization':'Bearer '+cfg.api_key}});
    if(r.ok){
      const j=await r.json();
      models=normalizeModelList((j.data||[]).map(m=>m.id||m));
    }
  }catch(e){}
  if(!models.length){
    const r=await fetch(apiUrl(cfg),{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.api_key},body:JSON.stringify({model:cfg.model,messages:[{role:'user',content:'ping'}],max_tokens:1,stream:false})});
    if(!r.ok){let msg='请求失败';try{const j=await r.json();msg=(j.error&&(j.error.message||j.error.code))||msg}catch(e){}throw new Error(msg)}
  }
  return {ok:true,message:models.length?`连接成功 · 检测到 ${models.length} 个模型`:'连接成功',models};
}

/* ---------- chat ---------- */
function buildHistory(conv,skipMsg){
  const out=[{role:'system',content:'你是一个可靠、清晰、友好的 AI 助手。优先直接解决用户问题。'}];
  for(const m of conv.messages){
    if(m===skipMsg||!m.content)continue;
    out.push({role:m.role,content:normalizeText(m.content)});
  }
  return out;
}
async function makeSummary(cfg,userText,answer){
  if(!cfg.api_key||!answer.trim())return '';
  const prompt=`请根据下面的用户问题和最终回答，用中文写一段 80-160 字左右的"思考摘要"。只概括回答采用了哪些高层次考虑、约束和依据；不要给逐步推理，不要声称泄露隐藏思维链。\n\n用户问题：${userText.slice(-3000)}\n\n最终回答：${answer.slice(-6000)}`;
  try{
    const text=await completeChat(cfg,[{role:'system',content:'你是一个简洁的摘要助手。'},{role:'user',content:prompt}]);
    return normalizeText(text).trim().slice(0,600);
  }catch(e){return ''}
}
async function runStream(conv,assistantMsg,userText,cfg,existingTurn){
  const msgs=buildHistory(conv,assistantMsg);
  const turn=existingTurn||appendTempAssistant(assistantMsg);
  const p0=$('.assistant-bubble p',turn);
  if(p0&&existingTurn)p0.classList.add('streaming-caret');
  let finalText='';
  const normalizer=new StreamingTextNormalizer();
  try{
    await streamChat(cfg,msgs,{
      delta(t){
        finalText+=t;
        const parts=normalizer.feed(t);
        if(!parts.length)return;
        const p=$('.assistant-bubble p',turn);
        parts.forEach(part=>{if(p)p.insertAdjacentText('beforeend',part)});
        scrollBottom();
      },
      reasoning(){},
      done(){},
    });
  }finally{
    const rest=normalizer.finish();
    if(rest.length){
      const p=$('.assistant-bubble p',turn);
      rest.forEach(part=>{if(p)p.insertAdjacentText('beforeend',part)});
    }
    const p=$('.assistant-bubble p',turn);
    if(p)p.classList.remove('streaming-caret');
  }
  assistantMsg.content=normalizeText(finalText).trim();
  assistantMsg.created_at=nowISO();
  if(!assistantMsg.content)throw new Error('模型没有返回内容');
  const summary=await makeSummary(cfg,userText,assistantMsg.content);
  if(summary)assistantMsg.reasoning_summary=summary;
}
async function sendMessage(){
  if(state.sending)return;
  const text=promptInput.value.trim();if(!text){showToast('请输入消息');return}
  const cfg=getClientApi();
  if(!cfg){openSettings('api');showToast('请先配置 AI 接口');return}
  let conv=currentConversation();
  if(!conv)conv=newConversation();
  const userMsg={id:uid(),role:'user',content:text,reasoning_summary:null,created_at:nowISO()};
  const assistantMsg={id:uid(),role:'assistant',content:'',reasoning_summary:null,created_at:nowISO()};
  conv.messages.push(userMsg,assistantMsg);
  if(conv.title==='新对话')conv.title=text.slice(0,18);
  promptInput.value='';promptInput.style.height='auto';
  messagesEl.insertAdjacentHTML('beforeend',messageHTML(userMsg));
  scrollBottom();
  saveConversations();renderHistory();
  state.sending=true;sendButton.disabled=true;
  try{
    await runStream(conv,assistantMsg,text,cfg);
  }catch(e){
    if(!assistantMsg.content)assistantMsg.content='（生成失败：'+(e.message||'未知错误')+'）';
    showToast(e.message||'生成失败');
  }finally{
    state.sending=false;sendButton.disabled=false;
    saveConversations();renderHistory();
    if(state.conversationId===conv.id){renderMessages(conv.messages);scrollBottom(false)}
  }
}
async function handleAction(action,mid){
  const conv=currentConversation();if(!conv)return;
  const idx=conv.messages.findIndex(m=>m.id===mid);if(idx<0)return;
  const turn=$(`[data-message-id="${mid}"]`);
  if(action==='copy'){
    const p=turn&&$('.assistant-bubble p',turn);
    copyText(p?p.innerText:'');
    return;
  }
  if(action==='regen'){
    if(state.sending)return;
    const cfg=getClientApi();
    if(!cfg){openSettings('api');showToast('请先配置 AI 接口');return}
    const assistant=conv.messages[idx];
    const userMsg=[...conv.messages.slice(0,idx)].reverse().find(m=>m.role==='user');
    const userText=userMsg?userMsg.content:'';
    assistant.content='';assistant.reasoning_summary=null;
    saveConversations();renderMessages(conv.messages);
    const existingTurn=$(`[data-message-id="${mid}"]`);
    state.sending=true;sendButton.disabled=true;
    try{
      await runStream(conv,assistant,userText,cfg,existingTurn);
    }catch(e){
      if(!assistant.content)assistant.content='（生成失败：'+(e.message||'未知错误')+'）';
      showToast(e.message||'生成失败');
    }finally{
      state.sending=false;sendButton.disabled=false;
      saveConversations();renderHistory();
      if(state.conversationId===conv.id){renderMessages(conv.messages);scrollBottom(false)}
    }
    return;
  }
  if(action==='branch'){
    const msgs=conv.messages.slice(0,idx+1).map(m=>({...m,id:uid(),created_at:nowISO()}));
    const nc={id:uid(),title:(conv.title||'对话')+' · 分支',pinned:false,created_at:nowISO(),messages:msgs};
    state.conversations.push(nc);
    saveConversations();
    loadConversation(nc.id);
    showToast('已创建聊天分支');
    return;
  }
  if(action==='share'){
    const parts=conv.messages.slice(0,idx+1).map(m=>`${m.role==='user'?'👤':'✦'} ${normalizeText(m.content)}`).join('\n\n');
    shareText(`【${conv.title||'对话'}】\n\n${parts}`);
  }
}
function copyText(text){
  const ok=()=>showToast('已复制');
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(ok).catch(()=>fallbackCopy(text));
  }else fallbackCopy(text);
  function fallbackCopy(t){
    const ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');ok()}catch(e){showToast('复制失败')}
    ta.remove();
  }
}
function shareText(text){
  if(navigator.share){navigator.share({text}).catch(()=>{})}
  else copyText(text);
}

/* ---------- settings modal ---------- */
function populateApiModelSelect(selectedValue='',sourceModels=null){
  const select=$('#apiModel');
  if(!select)return;
  const cfg=getStoredClientApiRaw();
  const models=normalizeModelList(sourceModels??cfg?.models??[]);
  let selected=String(selectedValue||cfg?.model||'').trim();
  if(looksLikeApiKey(selected)||!models.includes(selected))selected=models[0]||'';
  select.innerHTML='';
  if(!models.length){
    const option=document.createElement('option');
    option.value='';
    option.textContent='先查询模型';
    option.disabled=true;
    option.selected=true;
    select.appendChild(option);
    select.disabled=true;
    return;
  }
  models.forEach(id=>{
    const option=document.createElement('option');
    option.value=id;
    option.textContent=id;
    option.selected=id===selected;
    select.appendChild(option);
  });
  select.disabled=false;
  select.value=selected||models[0];
}
function fillSettings(){
  const cfg=getStoredClientApiRaw()||{base_url:'https://api.deepseek.com',api_key:'',model:'',reasoning_parameter:'',models:[]};
  $('#apiBaseUrl').value=cfg.base_url||'';$('#apiKey').value=cfg.api_key||'';
  $('#apiReasoningParam').value=sanitizeReasoningParameter(cfg.reasoning_parameter||'',cfg.models||[]);
  populateApiModelSelect(cfg.model,cfg.models);
  const manifestInput=$('#apiUpdateManifest');
  if(manifestInput)manifestInput.value=localStorage.getItem('app.updateManifestUrl')||DEFAULT_UPDATE_MANIFEST;
  const modelsInput=$('#apiModels');
  if(modelsInput)modelsInput.value=(cfg.models||[]).join('\n');
  const ok=!!getClientApi();
  $('#apiStatus').textContent=ok?'已保存到当前设备':'';$('#apiStatus').className='settings-status'+(ok?' ok':'');
}
function openSettings(tab='api'){
  closeSidebar();
  swipeStart=null;
  fillSettings();settingsBackdrop.hidden=false;document.body.style.overflow='hidden';document.body.classList.add('settings-open');switchSettingsTab(tab);loadCurrentVersion();
}
function closeSettings(){settingsBackdrop.hidden=true;document.body.style.overflow='';document.body.classList.remove('settings-open')}
function switchSettingsTab(tab){
  $$('.settings-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));$$('.settings-panel').forEach(p=>p.classList.toggle('active',p.dataset.panel===tab));
}
window.__openSettings=openSettings;
$('#sidebarSettings').addEventListener('click',()=>{closeSidebar();openSettings('api')});
$('#bannerSettings').addEventListener('click',()=>openSettings('api'));
$('#settingsClose').addEventListener('click',closeSettings);
$('#settingsBack')?.addEventListener('click',closeSettings);
$('#fetchModelsButton')?.addEventListener('click',async()=>{
  const status=$('#apiStatus');
  const base_url=$('#apiBaseUrl').value.trim().replace(/\/+$/,'');
  const api_key=$('#apiKey').value.trim();
  if(!/^https?:\/\//i.test(base_url)){status.textContent='请先填写正确的 API 地址';status.className='settings-status error';showToast('请先填写正确的 API 地址');return}
  if(!api_key){status.textContent='请先填写 API Key';status.className='settings-status error';showToast('请先填写 API Key');return}
  const button=$('#fetchModelsButton');
  button.disabled=true;
  button.textContent='查询中…';
  status.textContent='正在读取模型列表…';status.className='settings-status';
  try{
    const res=await queryModels({base_url,api_key});
    const models=normalizeModelList(res.models||[]);
    if(!models.length)throw new Error('接口没有返回可用模型');
    $('#apiModels').value=models.join('\n');
    populateApiModelSelect('',models);
    status.textContent=`查询成功 · 找到 ${models.length} 个模型`;
    status.className='settings-status ok';
    showToast(`找到 ${models.length} 个模型`);
  }catch(e){
    populateApiModelSelect('',[]);
    status.textContent=e.message||'模型查询失败';
    status.className='settings-status error';
    showToast('查询失败：'+(e.message||'未知错误'));
  }finally{
    button.disabled=false;
    button.textContent='查询模型';
  }
});
$('#apiModels')?.addEventListener('input',()=>{
  const models=normalizeModelList($('#apiModels').value);
  populateApiModelSelect($('#apiModel')?.value||'',models);
});
function lockSettingsBackgroundGesture(event){
  if(settingsBackdrop.hidden)return;
  swipeStart=null;
  event.stopPropagation();
}
settingsBackdrop.addEventListener('touchstart',lockSettingsBackgroundGesture,{capture:true,passive:true});
settingsBackdrop.addEventListener('touchmove',lockSettingsBackgroundGesture,{capture:true,passive:true});
settingsBackdrop.addEventListener('pointerdown',lockSettingsBackgroundGesture,{capture:true,passive:true});
settingsBackdrop.addEventListener('click',e=>{if(e.target===settingsBackdrop)closeSettings()});
$$('.settings-tab').forEach(b=>b.addEventListener('click',()=>switchSettingsTab(b.dataset.tab)));
$('#toggleKey').addEventListener('click',()=>{
  const input=$('#apiKey'),show=input.type==='password';
  input.type=show?'text':'password';
  $('#toggleKey').textContent=show?'◌':'◉';
  $('#toggleKey').setAttribute('aria-label',show?'隐藏 API Key':'显示 API Key');
});
function settingsFormValue(){
  const models=normalizeModelList($('#apiModels').value);
  return {base_url:$('#apiBaseUrl').value.trim().replace(/\/+$/,''),api_key:$('#apiKey').value.trim(),model:$('#apiModel')?.value||'',reasoning_parameter:sanitizeReasoningParameter($('#apiReasoningParam').value,models),models};
}
function validateCfg(cfg){
  if(!/^https?:\/\//i.test(cfg.base_url))return 'API 地址格式不正确';
  if(!cfg.api_key)return '请填写 API Key';
  if(!cfg.model||looksLikeApiKey(cfg.model))return '请先查询并选择一个模型';
  return '';
}
$('#saveApiButton').addEventListener('click',()=>{
  const cfg=settingsFormValue();
  cfg.model=$('#apiModel')?.value||cfg.model;
  const err=validateCfg(cfg),status=$('#apiStatus');
  if(err){status.textContent=err;status.className='settings-status error';return}
  if(!cfg.models.includes(cfg.model))cfg.models=normalizeModelList([cfg.model,...cfg.models]);
  const manifestInput=$('#apiUpdateManifest');
  if(manifestInput)localStorage.setItem('app.updateManifestUrl',manifestInput.value.trim());
  saveClientApi(cfg);state.clientApi=cfg;
  state.modelId=cfg.model;state.modelSource='local';
  localStorage.setItem('ai.modelId',cfg.model);localStorage.setItem('ai.modelSource','local');
  rebuildModelMenu();updateApiBanner();
  apiBanner.hidden=true;apiBanner.classList.add('force-hidden');
  status.textContent=`已保存 · 默认模型 ${cfg.model}`;status.className='settings-status ok';
  showToast('API 与模型设置已保存');
  setTimeout(closeSettings,260);
});
$('#testApiButton').addEventListener('click',async()=>{
  const cfg=settingsFormValue(),err=validateCfg(cfg),status=$('#apiStatus');
  if(err){status.textContent=err;status.className='settings-status error';return}
  status.textContent='正在测试所选模型…';status.className='settings-status';$('#testApiButton').disabled=true;
  try{
    await testApi({base_url:cfg.base_url,api_key:cfg.api_key,model:cfg.model,reasoning_parameter:cfg.reasoning_parameter||''});
    status.textContent=`连接成功 · ${cfg.model} 可用`;status.className='settings-status ok';
    showToast('模型测试成功');
  }catch(e){
    status.textContent=e.message||'模型测试失败';status.className='settings-status error';
  }finally{$('#testApiButton').disabled=false}
});

/* ---------- v5 update check & install ---------- */
const APP_CURRENT_VERSION='2.5.6';
const DEFAULT_UPDATE_MANIFEST='https://raw.githubusercontent.com/19836029013/liquid-glass-ai-chat/main/update.json';
let availableUpdate=null;
let updateBusy=false;
let updateRetryDone=false;
function detectUpdatePlatform(){
  const ua=navigator.userAgent||'';
  if(/Android/i.test(ua))return 'android';
  if(/iPhone|iPad|iPod/i.test(ua))return 'ios';
  return 'web';
}
function compareVersions(a,b){
  const pa=String(a).split('.').map(Number),pb=String(b).split('.').map(Number);
  for(let i=0;i<Math.max(pa.length,pb.length);i++){
    const x=pa[i]||0,y=pb[i]||0;
    if(x!==y)return x>y?1:-1;
  }
  return 0;
}
function setUpdateButton({label='检查更新',mode='check',loading=false}={}){
  const btn=$('#checkUpdateButton');
  if(!btn)return;
  const labelEl=$('.button-label',btn);
  const iconEl=$('.button-icon',btn);
  if(labelEl)labelEl.textContent=label;
  btn.disabled=!!loading;
  btn.classList.toggle('update-ready',mode==='update');
  btn.classList.toggle('installing',loading);
  if(iconEl){
    iconEl.innerHTML=loading
      ? '<span class="button-spinner" aria-hidden="true"></span>'
      : (mode==='update'?'↓':'↻');
  }
}
function setUpdateProgress(percent,text=''){
  const wrap=$('#updateProgress'),bar=$('#updateProgressBar'),label=$('#updateProgressText');
  if(!wrap||!bar||!label)return;
  if(percent==null){
    wrap.hidden=true;
    bar.style.width='0%';
    label.textContent='';
    return;
  }
  wrap.hidden=false;
  const value=Math.max(0,Math.min(100,Number(percent)||0));
  bar.style.width=`${value}%`;
  label.textContent=text||`${Math.round(value)}%`;
}
function loadCurrentVersion(){
  const platform=detectUpdatePlatform();
  $('#currentVersionText').textContent=`当前版本 ${APP_CURRENT_VERSION}（${platform==='android'?'Android':platform}）`;
  const manifestUrl=(localStorage.getItem('app.updateManifestUrl')||'').trim()||DEFAULT_UPDATE_MANIFEST;
  $('#updateState').textContent=manifestUrl?'可检查在线更新':'未配置更新源';
  availableUpdate=null;
  updateRetryDone=false;
  setUpdateProgress(null);
  setUpdateButton({label:'检查更新'});
}
async function checkForUpdates(){
  if(updateBusy)return;
  updateBusy=true;
  availableUpdate=null;
  setUpdateProgress(null);
  setUpdateButton({label:'检查中…',loading:true});
  $('#updateState').textContent='正在检查更新…';
  try{
    const platform=detectUpdatePlatform();
    const manifestUrl=(localStorage.getItem('app.updateManifestUrl')||'').trim()||DEFAULT_UPDATE_MANIFEST;
    if(!manifestUrl){
      $('#updateState').textContent='未配置更新源 · 安装新版 APK 即可更新';
      setUpdateButton({label:'检查更新'});
      return;
    }
    const res=await fetch(manifestUrl,{cache:'no-store'});
    if(!res.ok)throw new Error('HTTP '+res.status);
    const j=await res.json();
    const remote=String(j.version||'').trim();
    const notes=String(j.notes||'');
    const platforms=j.platforms||{};
    const android=platforms.android||{};
    const ios=platforms.ios||{};
    const web=platforms.web||{};
    if(!remote)throw new Error('更新清单缺少 version');
    $('#currentVersionText').textContent=`当前版本 ${APP_CURRENT_VERSION}`;
    if(compareVersions(remote,APP_CURRENT_VERSION)>0){
      const downloadUrl=String(android.url||'').trim();
      const mirrorUrl=String(android.mirror_url||'').trim();
      const storeUrl=String(ios.store_url||'').trim();
      const webUrl=String(web.web_url||'').trim();
      if(!downloadUrl&&!mirrorUrl&&!storeUrl&&!webUrl)throw new Error('该版本没有配置更新地址');
      availableUpdate={
        platform,
        latest_version:remote,
        notes,
        download_url:downloadUrl,
        mirror_url:mirrorUrl,
        store_url:storeUrl,
        web_url:webUrl,
        sha256:String(android.sha256||'').trim(),
      };
      $('#updateState').textContent=`发现新版本 ${remote}${notes?' · '+notes:''}`;
      setUpdateButton({label:'立即更新',mode:'update'});
      pulseControl($('#checkUpdateButton'));
      showToast(`发现新版本 ${remote}`);
      return;
    }
    $('#updateState').textContent=`已是最新版本 · ${remote}`;
    setUpdateButton({label:'检查更新'});
    showToast('已经是最新版本');
  }catch(e){
    $('#updateState').textContent=e.message||'检查更新失败';
    setUpdateButton({label:'重新检查'});
  }finally{
    updateBusy=false;
  }
}
function hasAndroidNativeUpdater(){
  return !!(window.AndroidUpdater?.installApk);
}
function beginSoftProgress(){
  let value=5;
  setUpdateProgress(value,'正在准备更新…');
  const timer=setInterval(()=>{
    value=Math.min(88,value+Math.max(2,Math.round((90-value)*.08)));
    setUpdateProgress(value,value<70?'正在下载安装包…':'正在准备安装…');
    if(value>=88)clearInterval(timer);
  },420);
  return ()=>clearInterval(timer);
}
async function startUpdate(){
  if(updateBusy)return;
  if(!availableUpdate){
    await checkForUpdates();
    return;
  }
  const info=availableUpdate;
  const platform=info.platform||detectUpdatePlatform();
  const url=info.mirror_url||info.download_url||info.store_url||info.web_url;
  if(!url){
    showToast('该版本没有配置更新地址');
    return;
  }
  updateBusy=true;
  setUpdateButton({label:'正在更新…',mode:'update',loading:true});
  $('#updateState').textContent=`准备更新到 ${info.latest_version}`;
  const stopSoftProgress=beginSoftProgress();
  try{
    if(platform==='android'&&hasAndroidNativeUpdater()){
      window.AndroidUpdater.installApk(String(url),String(info.latest_version||''),String(info.sha256||''));
      setUpdateProgress(92,'等待系统安装');
      $('#updateState').textContent='已开始更新，请按系统提示完成安装';
      showToast('已开始更新');
      return;
    }
    if(platform==='ios'){
      if(window.NativeApp?.openStoreUpdate){
        window.NativeApp.openStoreUpdate(String(url));
      }else{
        openExternal(url);
      }
      setUpdateProgress(100,'已打开更新页面');
      $('#updateState').textContent='已打开 App Store / TestFlight';
      return;
    }
    setUpdateProgress(100,'开始下载');
    $('#updateState').textContent='已开始下载安装包';
    openExternal(url);
  }catch(e){
    $('#updateState').textContent=e.message||'更新启动失败';
    setUpdateProgress(null);
    showToast('更新启动失败');
  }finally{
    stopSoftProgress();
    updateBusy=false;
    if(availableUpdate)setUpdateButton({label:'立即更新',mode:'update'});
  }
}
$('#checkUpdateButton')?.addEventListener('click',async()=>{
  if(availableUpdate)await startUpdate();
  else await checkForUpdates();
});
function openExternal(url){
  try{if(bridge&&bridge.openUrl){bridge.openUrl(url);return}}catch(e){}
  window.open(url,'_blank');
}
window.addEventListener('native-update-state',event=>{
  const detail=event.detail||{};
  const progress=Number(detail.progress);
  if(Number.isFinite(progress))setUpdateProgress(progress,detail.message||'正在更新');
  if(detail.message)$('#updateState').textContent=detail.message;
  if(detail.state==='permission'){
    updateBusy=false;
    setUpdateButton({label:'继续更新',mode:'update'});
  }else if(detail.state==='error'){
    if(availableUpdate&&!updateRetryDone&&availableUpdate.mirror_url&&availableUpdate.download_url){
      updateRetryDone=true;
      setUpdateButton({label:'正在切换线路…',mode:'update',loading:true});
      $('#updateState').textContent='当前线路较慢，已自动切换官方线路';
      window.AndroidUpdater.installApk(String(availableUpdate.download_url),String(availableUpdate.latest_version||''),String(availableUpdate.sha256||''));
      return;
    }
    updateBusy=false;
    setUpdateButton({label:'重新更新',mode:'update'});
    showToast(detail.message||'更新失败');
  }else if(detail.state==='installing'){
    setUpdateButton({label:'等待安装',mode:'update',loading:true});
  }
});

/* ---------- v5 tactile / visual feedback ---------- */
function canVibrate(){
  return typeof navigator.vibrate==='function'&&!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
function lightHaptic(ms=7){
  try{if(canVibrate())navigator.vibrate(ms)}catch(e){}
}
function pulseControl(el){
  if(!el)return;
  el.classList.remove('success-pulse');
  void el.offsetWidth;
  el.classList.add('success-pulse');
  setTimeout(()=>el.classList.remove('success-pulse'),520);
}
function addRipple(el,event){
  if(!el||el.disabled)return;
  const rect=el.getBoundingClientRect();
  if(!rect.width||!rect.height)return;
  el.classList.add('feedback-control');
  const ripple=document.createElement('span');
  ripple.className='tap-ripple';
  ripple.style.left=`${event.clientX-rect.left}px`;
  ripple.style.top=`${event.clientY-rect.top}px`;
  el.appendChild(ripple);
  setTimeout(()=>ripple.remove(),520);
}
function bindInteractionFeedback(root=document){
  const selector='button,.select-control,.side-item,.choose-wallpaper,.reasoning-toggle';
  const nodes=[];
  if(root.matches?.(selector))nodes.push(root);
  root.querySelectorAll?.(selector).forEach(n=>nodes.push(n));
  nodes.forEach(el=>{
    if(el.dataset.feedbackBound)return;
    el.dataset.feedbackBound='1';
    el.addEventListener('pointerdown',event=>{
      if(el.disabled)return;
      el.classList.add('is-pressing');
      addRipple(el,event);
      lightHaptic();
    },{passive:true});
    const clear=()=>el.classList.remove('is-pressing');
    el.addEventListener('pointerup',clear,{passive:true});
    el.addEventListener('pointercancel',clear,{passive:true});
    el.addEventListener('pointerleave',clear,{passive:true});
  });
}
bindInteractionFeedback();
const interactionObserver=new MutationObserver(records=>{
  records.forEach(record=>{
    record.addedNodes.forEach(node=>{
      if(node.nodeType===1)bindInteractionFeedback(node);
    });
  });
});
interactionObserver.observe(document.body,{childList:true,subtree:true});

/* ---------- wallpaper & appearance ---------- */
const WALL_DB='ai-chat-assets',WALL_STORE='files',WALL_KEY='wallpaper';let wallpaperObjectURL=null;
function openWallDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(WALL_DB,1);req.onupgradeneeded=()=>req.result.createObjectStore(WALL_STORE);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function putWallpaper(blob){const db=await openWallDB();await new Promise((resolve,reject)=>{const tx=db.transaction(WALL_STORE,'readwrite');tx.objectStore(WALL_STORE).put(blob,WALL_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close()}
async function getWallpaper(){const db=await openWallDB();const blob=await new Promise((resolve,reject)=>{const tx=db.transaction(WALL_STORE,'readonly'),r=tx.objectStore(WALL_STORE).get(WALL_KEY);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error)});db.close();return blob}
async function deleteWallpaper(){const db=await openWallDB();await new Promise((resolve,reject)=>{const tx=db.transaction(WALL_STORE,'readwrite');tx.objectStore(WALL_STORE).delete(WALL_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close()}
function applyWallpaperBlob(blob){
  if(wallpaperObjectURL)URL.revokeObjectURL(wallpaperObjectURL);
  const preview=$('#wallpaperPreview');
  if(!blob){
    wallpaperObjectURL=null;
    $('#wallpaperLayer').style.backgroundImage='';
    if(preview)preview.style.backgroundImage='';
    return;
  }
  wallpaperObjectURL=URL.createObjectURL(blob);
  const image=`url("${wallpaperObjectURL}")`;
  $('#wallpaperLayer').style.backgroundImage=image;
  if(preview)preview.style.backgroundImage=image;
}
async function loadWallpaper(){try{applyWallpaperBlob(await getWallpaper())}catch{}}
$('#wallpaperInput').addEventListener('change',async e=>{
  const file=e.target.files?.[0];if(!file)return;
  if(!file.type.startsWith('image/')){showToast('请选择图片文件');return}
  try{await putWallpaper(file);applyWallpaperBlob(file);showToast('背景壁纸已更新')}catch{showToast('壁纸保存失败')}
});
$('#resetWallpaper').addEventListener('click',async()=>{try{await deleteWallpaper();applyWallpaperBlob(null);showToast('已恢复默认背景')}catch{}});
function applyAppearance(){
  const dim=Number(localStorage.getItem('appearance.dim')||8),glass=Number(localStorage.getItem('appearance.glass')||12);
  document.documentElement.style.setProperty('--wallpaper-dim',String(dim/100));
  document.documentElement.style.setProperty('--glass-a',String(glass/100));
  document.documentElement.style.setProperty('--glass-a-strong',String(Math.min(.52,glass/100+.06)));
  $('#wallpaperDim').value=dim;$('#dimOutput').textContent=`${dim}%`;
  $('#glassOpacity').value=glass;$('#glassOutput').textContent=`${glass}%`;
}
$('#wallpaperDim').addEventListener('input',e=>{const v=Number(e.target.value);localStorage.setItem('appearance.dim',String(v));document.documentElement.style.setProperty('--wallpaper-dim',String(v/100));$('#dimOutput').textContent=`${v}%`});
$('#glassOpacity').addEventListener('input',e=>{const v=Number(e.target.value);localStorage.setItem('appearance.glass',String(v));document.documentElement.style.setProperty('--glass-a',String(v/100));document.documentElement.style.setProperty('--glass-a-strong',String(Math.min(.52,v/100+.06)));$('#glassOutput').textContent=`${v}%`});

/* ---------- composer ---------- */
promptInput.addEventListener('input',()=>{promptInput.style.height='auto';promptInput.style.height=Math.min(promptInput.scrollHeight,145)+'px'});
promptInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});
sendButton.addEventListener('click',sendMessage);

/* ---------- init ---------- */
(async function init(){
  applyAppearance();
  loadWallpaper();
  loadConversations();
  loadConfig();
  renderHistory();
  if(state.conversations.length)loadConversation(state.conversations[0].id);
  else newChat();
})();

window.addEventListener('storage',e=>{
  if(e.key==='ai.clientApi'){state.clientApi=getClientApi();rebuildModelMenu();updateApiBanner()}
});
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden){state.clientApi=getClientApi();rebuildModelMenu();updateApiBanner()}
});
