const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];

let bridge=null;
try{bridge=window.Android||null}catch(e){bridge=null}

function safeGet(key,fallback=''){
  try{return localStorage.getItem(key)||fallback}catch(e){return fallback}
}

const state={
  conversations:[],
  projects:[],
  expandedProject:null,
  conversationId:null,
  modelId:safeGet('ai.modelId'),
  modelSource:safeGet('ai.modelSource'),
  reasoningLevel:safeGet('ai.reasoningLevel','标准'),
  nickname:safeGet('group.nickname','我'),
  deviceId:safeGet('group.deviceId'),
  account:{id:safeGet('account.id')||uid(),name:(safeGet('account.name')||safeGet('group.nickname')||'我')},
  sending:false,
  shared:false,
  serverModels:[],
  clientApi:null,
};

const sidebar=$('#sidebar'),backdrop=$('#sidebarBackdrop'),toast=$('#toast');
const messagesEl=$('#messages'),promptInput=$('#promptInput'),sendButton=$('#sendButton');
const modelPopover=$('#modelPopover'),reasoningPopover=$('#reasoningPopover');
const actionSheet=$('#actionSheet');
const apiBanner=$('#apiBanner');
const settingsBackdrop=$('#settingsBackdrop');
const sheetScrim=$('#sheetScrim');
if(!state.deviceId){
  state.deviceId=uid();
  try{localStorage.setItem('group.deviceId',state.deviceId)}catch(e){}
}
if(!safeGet('account.id')){
  try{localStorage.setItem('account.id',state.account.id)}catch(e){}
}

function showToast(text){
  toast.textContent=text;toast.classList.add('show');
  clearTimeout(showToast.t);showToast.t=setTimeout(()=>toast.classList.remove('show'),1700);
}
function escapeHTML(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function timeOf(iso){try{return new Date(iso).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}catch{return ''}}
function scrollBottom(smooth=true){requestAnimationFrame(()=>window.scrollTo({top:document.body.scrollHeight,behavior:smooth?'smooth':'auto'}))}
function loadJSON(key,fallback=null){try{return JSON.parse(localStorage.getItem(key)||'null')??fallback}catch{return fallback}}
function saveJSON(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch(e){}}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8)}
function nowISO(){return new Date().toISOString()}

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

function looksLikeApiKey(value){
  const s=String(value||'').trim().toLowerCase();
  return s.startsWith('sk-')||s.startsWith('bearer ')||/^key[-_:]/.test(s);
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

function sanitizeReasoningParameter(value,models=[]){
  const raw=String(value||'').trim();
  if(!raw)return '';
  const knownModels=normalizeModelList(models);
  if(knownModels.includes(raw))return '';
  if(/^(deepseek|gpt|claude|gemini|luna|opus|qwen|glm|kimi)[-_]/i.test(raw))return '';
  return raw;
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
function saveClientApi(cfg){
  saveJSON('ai.clientApi',cfg);
  try{
    if(bridge&&bridge.saveConfig){
      bridge.saveConfig(JSON.stringify({apiBase:cfg.base_url,apiKey:cfg.api_key,model:cfg.model,reasoningParam:cfg.reasoning_parameter||'',models:normalizeModelList(cfg.models||[])}));
    }
  }catch(e){}
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
function getClientApi(){
  const clean=getStoredClientApiRaw();
  return clean&&clean.base_url&&clean.api_key&&clean.model?clean:null;
}
function clientModelIds(){
  const cfg=getStoredClientApiRaw();
  if(!cfg)return [];
  return normalizeModelList([cfg.model,...(cfg.models||[])]);
}
function isConfigured(){return !!getClientApi()}
function updateApiBanner(){
  const configured=isConfigured();
  apiBanner.hidden=configured;
  apiBanner.classList.toggle('force-hidden',configured);
  apiBanner.setAttribute('aria-hidden',configured?'true':'false');
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

/* ---------- local conversations ---------- */
function loadConversations(){
  let raw='';
  try{if(bridge&&bridge.getState)raw=bridge.getState()||''}catch(e){}
  if(!raw)raw=localStorage.getItem('lgchat_convs')||'';
  if(raw&&raw.trim()){
    try{
      const parsed=JSON.parse(raw);
      if(Array.isArray(parsed)){
        state.conversations=parsed;
        state.projects=[];
      }else{
        state.conversations=parsed.conversations||[];
        state.projects=parsed.projects||[];
      }
    }catch(e){state.conversations=[];state.projects=[]}
  }
  if(!Array.isArray(state.conversations))state.conversations=[];
  if(!Array.isArray(state.projects))state.projects=[];
}
let saveTimer=null;
function saveConversations(){
  const json=JSON.stringify({conversations:state.conversations,projects:state.projects});
  try{localStorage.setItem('lgchat_convs',json)}catch(e){}
  if(bridge&&bridge.saveState){
    clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>{try{bridge.saveState(json)}catch(e){}},400);
  }
}
function currentConversation(){return state.conversations.find(c=>c.id===state.conversationId)||null}
function newConversation(){
  const c={id:uid(),title:'新对话',pinned:false,projectId:state.expandedProject||null,created_at:nowISO(),messages:[]};
  state.conversations.push(c);
  state.conversationId=c.id;
  saveConversations();
  return c;
}

/* ---------- sidebar / swipe ---------- */
function openSidebar(){sidebar.classList.add('open');sidebar.setAttribute('aria-hidden','false');backdrop.classList.add('show');document.body.classList.add('sidebar-open')}
function closeSidebar(){sidebar.classList.remove('open');sidebar.setAttribute('aria-hidden','true');backdrop.classList.remove('show');document.body.classList.remove('sidebar-open')}
$('#menuButton').addEventListener('click',openSidebar);
backdrop.addEventListener('click',closeSidebar);
$$('[data-sidebar-close]').forEach(b=>b.addEventListener('click',closeSidebar));

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

/* ---------- rendering ---------- */
function modelDisplayName(message){
  const raw=String(message?.model||state.modelId||'AI').trim();
  return raw||'AI';
}
function reasoningMiniBlock(message){
  const summary=normalizeText(message.reasoning_summary||'').trim();
  const ready=Boolean(summary);
  const stateText=message.streaming?'等待摘要':(ready?'已完成':'无摘要');
  return `<div class="reasoning-mini-window ${ready?'ready':'waiting'}">
    <button class="reasoning-toggle" data-reasoning-toggle ${ready?'':'disabled'} aria-expanded="false">
      <span class="reasoning-mini-icon">✺</span>
      <span class="reasoning-mini-copy">
        <strong>深度思考</strong>
        <small class="reasoning-state">${stateText}</small>
      </span>
      <span class="chevron">${ready?'⌄':'·'}</span>
    </button>
    <div class="reasoning-panel" data-reasoning-panel>
      <div class="reasoning-scroll">${escapeHTML(summary).replace(/\n/g,'<br>')}</div>
    </div>
  </div>`;
}
function actions(message){
  return `<div class="message-actions" aria-label="消息操作">
    <button data-action="copy" data-mid="${message.id}" title="复制"><span class="action-icon">▢</span><span>复制</span></button>
    <button data-action="regen" data-mid="${message.id}" title="重新生成"><span class="action-icon">↻</span><span>重新生成</span></button>
    <button data-action="share" data-mid="${message.id}" title="分享"><span class="action-icon">⇧</span><span>分享</span></button>
    <button data-action="branch" data-mid="${message.id}" title="创建分支"><span class="action-icon">⑂</span><span>创建分支</span></button>
  </div>`;
}
function messageHTML(message){
  const content=normalizeText(message.content);
  if(message.role==='user'){
    const conv=currentConversation();
    const author=conv&&conv.group&&message.authorName
      ? `<div class="user-author" style="color:${message.authorColor||'#2f7c69'}">${escapeHTML(message.authorName)}</div>`
      : '';
    return `<div class="turn turn-user" data-message-id="${message.id}">
      <div class="user-bubble">
        ${author}
        <p>${escapeHTML(content).replace(/\n/g,'<br>')}</p>
        <div class="meta user-meta">${timeOf(message.created_at)} <span class="checks">✓✓</span></div>
      </div>
    </div>`;
  }
  const model=escapeHTML(modelDisplayName(message));
  return `<div class="turn turn-assistant" data-message-id="${message.id}">
    <div class="assistant-stack">
      ${reasoningMiniBlock(message)}
      <div class="assistant-bubble">
        <div class="assistant-message-head">
          <span class="assistant-model"><span class="assistant-model-mark">✦</span><span>${model}</span></span>
          <span class="assistant-time">${timeOf(message.created_at)}</span>
        </div>
        <p>${escapeHTML(content).replace(/\n/g,'<br>')}</p>
      </div>
      ${state.shared?'':actions(message)}
    </div>
  </div>`;
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
  $$('.turn-user',root).forEach(turn=>{
    if(turn.dataset.msgBound)return;turn.dataset.msgBound='1';
    turn.addEventListener('click',()=>{
      const conv=currentConversation();
      if(conv)editUserMessage(turn.dataset.messageId,turn,conv);
    });
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

/* ---------- model / reasoning sheets ---------- */
function chooseModel(id,source){
  state.modelId=id;
  state.modelSource=source;
  localStorage.setItem('ai.modelId',id);
  localStorage.setItem('ai.modelSource',source);
  $('#modelLabel').textContent=id||'选择模型';
  $('#sidebarModelLabel').textContent=id||'未选择模型';
  closePopovers();
}
function rebuildModelMenu(){
  modelPopover.innerHTML=`
    <div class="sheet-head">
      <div>
        <span class="sheet-kicker">模型</span>
        <strong>选择模型</strong>
      </div>
      <button class="sheet-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="sheet-list" id="modelSheetList"></div>`;
  const list=$('#modelSheetList',modelPopover);
  const entries=[];
  clientModelIds().forEach(id=>entries.push({id,source:'local',available:true,label:id}));
  const seen=new Set();
  for(const m of entries){
    const key=`${m.source}:${m.id}`;
    if(seen.has(key))continue;
    seen.add(key);
    const b=document.createElement('button');
    b.className='sheet-option';
    b.disabled=!m.available;
    b.title=m.id;
    b.innerHTML=`
      <span class="sheet-option-icon">${m.id===state.modelId?'✓':'◇'}</span>
      <span class="sheet-option-copy">
        <strong>${escapeHTML(m.label)}</strong>
        <small>来自当前 API</small>
      </span>
      ${m.id===state.modelId&&m.source===state.modelSource?'<span class="sheet-check">✓</span>':''}
    `;
    if(m.id===state.modelId&&m.source===state.modelSource)b.classList.add('current-model');
    b.addEventListener('click',()=>chooseModel(m.id,m.source));
    list.appendChild(b);
  }
  if(!entries.some(e=>e.available)){
    list.innerHTML='<div class="sheet-empty">暂无可用模型<br><small>请先在设置中填写 API 地址和 Key，并查询模型。</small></div>';
  }
  $('.sheet-close',modelPopover)?.addEventListener('click',closePopovers);
  const currentValid=entries.some(e=>e.available&&e.id===state.modelId&&e.source===state.modelSource);
  if(!currentValid){
    const preferred=entries.find(e=>e.available&&e.source==='local')||entries.find(e=>e.available);
    if(preferred){
      state.modelId=preferred.id;
      state.modelSource=preferred.source;
      localStorage.setItem('ai.modelId',preferred.id);
      localStorage.setItem('ai.modelSource',preferred.source);
      $('#modelLabel').textContent=preferred.id;
      $('#sidebarModelLabel').textContent=preferred.id;
    }else{
      $('#modelLabel').textContent='选择模型';
      $('#sidebarModelLabel').textContent='未选择模型';
      state.modelId='';
      state.modelSource='';
    }
  }else{
    $('#modelLabel').textContent=state.modelId;
    $('#sidebarModelLabel').textContent=state.modelId;
  }
}
function loadConfig(){
  state.clientApi=getClientApi();
  reasoningPopover.innerHTML=`
    <div class="sheet-head">
      <div>
        <span class="sheet-kicker">推理</span>
        <strong>思考等级</strong>
      </div>
      <button class="sheet-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="sheet-list" id="reasoningSheetList"></div>`;
  const descriptions={
    '简洁':'更快返回，适合简单问答',
    '标准':'速度与深度平衡',
    '深入':'更充分的分析与推理',
    '最高':'适合复杂任务，耗时更长',
  };
  const list=$('#reasoningSheetList',reasoningPopover);
  ['简洁','标准','深入','最高'].forEach(level=>{
    const b=document.createElement('button');
    b.className='sheet-option';
    if(level===state.reasoningLevel)b.classList.add('current-model');
    b.innerHTML=`
      <span class="sheet-option-icon">${level===state.reasoningLevel?'✓':'✺'}</span>
      <span class="sheet-option-copy">
        <strong>${escapeHTML(level)}</strong>
        <small>${descriptions[level]||''}</small>
      </span>
      ${level===state.reasoningLevel?'<span class="sheet-check">✓</span>':''}
    `;
    b.addEventListener('click',()=>{
      state.reasoningLevel=level;
      localStorage.setItem('ai.reasoningLevel',level);
      $('#reasoningLabel').textContent=level;
      closePopovers();
    });
    list.appendChild(b);
  });
  $('.sheet-close',reasoningPopover)?.addEventListener('click',closePopovers);
  $('#reasoningLabel').textContent=state.reasoningLevel;
  rebuildModelMenu();
  updateApiBanner();
}

function closePopovers(except=null){
  [modelPopover,reasoningPopover,actionSheet].forEach(p=>{
    if(p!==except)p.classList.remove('show');
  });
  const anyOpen=[modelPopover,reasoningPopover,actionSheet].some(p=>p.classList.contains('show'));
  sheetScrim.hidden=!anyOpen;
  document.body.classList.toggle('sheet-open',anyOpen);
}
function openSheet(popover){
  closePopovers(popover);
  popover.classList.add('show');
  sheetScrim.hidden=false;
  document.body.classList.add('sheet-open');
}
$('#modelSelect').addEventListener('click',e=>{
  e.stopPropagation();
  if(modelPopover.classList.contains('show'))closePopovers();
  else openSheet(modelPopover);
});
$('#reasoningSelect').addEventListener('click',e=>{
  e.stopPropagation();
  if(reasoningPopover.classList.contains('show'))closePopovers();
  else openSheet(reasoningPopover);
});
sheetScrim.addEventListener('click',closePopovers);
document.addEventListener('keydown',e=>{if(e.key==='Escape')closePopovers()});

let scrollSettleTimer=null;
document.addEventListener('scroll',()=>{
  document.body.classList.add('is-scrolling');
  clearTimeout(scrollSettleTimer);
  scrollSettleTimer=setTimeout(()=>document.body.classList.remove('is-scrolling'),160);
},{passive:true});

/* ---------- history / sidebar ---------- */
function updateTopTitle(title){
  const btn=$('#topModelButton');
  const label=$('#topModelLabel');
  if(!btn||!label)return;
  const text=String(title||'').trim()||'新对话';
  label.textContent=text;
  requestAnimationFrame(()=>{
    const wrap=label.parentElement;
    const over=wrap&&label.scrollWidth>wrap.clientWidth+2;
    btn.classList.toggle('marquee',!!over);
    if(over){
      label.innerHTML='';
      const a=document.createElement('span');
      a.className='pill-text';
      a.textContent=text;
      label.appendChild(a);
      label.appendChild(a.cloneNode(true));
    }
  });
}
let rowMenuEl=null;
let lastMenuAnchor=null;
function positionRowMenu(){
  if(!rowMenuEl||!lastMenuAnchor)return;
  const r=lastMenuAnchor.getBoundingClientRect();
  const mw=rowMenuEl.offsetWidth||230;
  const mh=rowMenuEl.offsetHeight||200;
  let left=Math.max(8,Math.min(r.left,mw+8<window.innerWidth?window.innerWidth-mw-8:8));
  let top=r.bottom+6;
  if(top+mh>window.innerHeight-8)top=Math.max(8,r.top-mh-6);
  rowMenuEl.style.left=left+'px';
  rowMenuEl.style.top=top+'px';
}
function closeRowMenu(){
  if(rowMenuEl){rowMenuEl.remove();rowMenuEl=null}
}
function showRowMenu(id,anchor){
  closeRowMenu();
  lastMenuAnchor=anchor;
  const conv=state.conversations.find(c=>c.id===id);
  if(!conv)return;
  const menu=document.createElement('div');
  menu.className='row-menu glass';
  const groupItem=conv.group?`<button class="row-menu-item" data-act="sharegroup"><span class="row-menu-item-icon">⇄</span><span class="row-menu-label">分享群聊链接</span></button>`:'';
  menu.innerHTML=`
    <button class="row-menu-item" data-act="rename"><span class="row-menu-item-icon">✎</span><span class="row-menu-label">重命名对话</span></button>
    <button class="row-menu-item" data-act="pin"><span class="row-menu-item-icon">⌖</span><span class="row-menu-label">${conv.pinned?'取消置顶':'置顶对话'}</span></button>
    <button class="row-menu-item" data-act="move"><span class="row-menu-item-icon">▣</span><span class="row-menu-label">移动到项目</span></button>
    ${groupItem}
    <button class="row-menu-item danger" data-act="delete"><span class="row-menu-item-icon">×</span><span class="row-menu-label">删除对话</span></button>`;
  document.body.appendChild(menu);
  rowMenuEl=menu;
  positionRowMenu();
  menu.addEventListener('click',e=>{
    const btn=e.target.closest('.row-menu-item');
    if(!btn)return;
    const act=btn.dataset.act;
    if(act==='rename'){
      showRenameInMenu(conv);
    }else if(act==='pin'){
      conv.pinned=!conv.pinned;
      saveConversations();renderHistory();closeRowMenu();
      showToast(conv.pinned?'已置顶':'已取消置顶');
    }else if(act==='move'){
      showMoveInMenu(conv);
    }else if(act==='sharegroup'){
      shareGroup(conv);
    }else if(act==='delete'){
      if(menu.dataset.armed!=='1'){
        menu.dataset.armed='1';
        btn.querySelector('.row-menu-label').textContent='确认删除？再点一次';
        return;
      }
      state.conversations=state.conversations.filter(c=>c.id!==conv.id);
      if(state.conversationId===conv.id){
        state.conversationId=null;
        messagesEl.innerHTML='';
        $('#greeting').textContent='你好，今天想聊点什么？';
        updateTopTitle('新对话');
      }
      saveConversations();renderHistory();renderProjects();closeRowMenu();
      showToast('对话已删除');
    }
  });
  setTimeout(()=>{
    document.addEventListener('pointerdown',e=>{
      if(rowMenuEl&&!rowMenuEl.contains(e.target))closeRowMenu();
    },{once:true,capture:true});
  },0);
}
function showRenameInMenu(conv){
  if(!rowMenuEl)return;
  rowMenuEl.innerHTML=`
    <div class="row-menu-title">重命名对话</div>
    <input class="row-menu-input" maxlength="30" value="${escapeHTML(conv.title||'')}" />
    <div class="row-menu-actions">
      <button class="row-menu-btn" data-cancel>取消</button>
      <button class="row-menu-btn primary" data-ok>确定</button>
    </div>`;
  positionRowMenu();
  const input=rowMenuEl.querySelector('input');
  input.focus();
  input.select();
  const done=()=>{
    const name=input.value.trim();
    if(name){
      conv.title=name;
      saveConversations();renderHistory();
      if(state.conversationId===conv.id){
        $('#greeting').textContent=conv.title;
        updateTopTitle(conv.title);
      }
    }
    closeRowMenu();
    showToast(name?'已重命名':'名称未修改');
  };
  rowMenuEl.querySelector('[data-ok]').addEventListener('click',done);
  rowMenuEl.querySelector('[data-cancel]').addEventListener('click',closeRowMenu);
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){e.preventDefault();done()}
    if(e.key==='Escape'){e.preventDefault();closeRowMenu()}
  });
}
function showMoveInMenu(conv){
  if(!rowMenuEl)return;
  rowMenuEl.innerHTML=`
    <div class="row-menu-title">移动到项目</div>
    <button class="row-menu-item" data-pid=""><span class="row-menu-item-icon">${!conv.projectId?'✓':'◇'}</span>无项目（全部对话）</button>
    ${state.projects.map(p=>`<button class="row-menu-item" data-pid="${p.id}"><span class="row-menu-item-icon">${conv.projectId===p.id?'✓':'▣'}</span>${escapeHTML(p.title)}</button>`).join('')}
    <button class="row-menu-item" data-back><span class="row-menu-item-icon">←</span>返回</button>`;
  positionRowMenu();
  rowMenuEl.querySelectorAll('[data-pid]').forEach(b=>{
    b.addEventListener('click',()=>{
      const pid=b.dataset.pid||null;
      conv.projectId=pid;
      saveConversations();renderHistory();renderProjects();closeRowMenu();
      showToast(pid?'已移动到项目':'已移出项目');
    });
  });
  rowMenuEl.querySelector('[data-back]').addEventListener('click',()=>showRowMenu(conv.id,lastMenuAnchor));
}
function showUserMenu(id,turn){
  if(!turn)return;
  closeRowMenu();
  const conv=currentConversation();
  if(!conv)return;
  const menu=document.createElement('div');
  menu.className='row-menu glass';
  menu.innerHTML=`
    <button class="row-menu-item" data-act="copy"><span class="row-menu-item-icon">▢</span>复制消息</button>
    <button class="row-menu-item" data-act="edit"><span class="row-menu-item-icon">✎</span>编辑消息</button>`;
  document.body.appendChild(menu);
  rowMenuEl=menu;
  lastMenuAnchor=turn;
  positionRowMenu();
  menu.addEventListener('click',e=>{
    const btn=e.target.closest('.row-menu-item');
    if(!btn)return;
    const act=btn.dataset.act;
    if(act==='copy'){
      const msg=conv.messages.find(m=>m.id===id);
      copyText(msg?normalizeText(msg.content):'');
      closeRowMenu();
    }else if(act==='edit'){
      closeRowMenu();
      editUserMessage(id,turn,conv);
    }
  });
  setTimeout(()=>{
    document.addEventListener('pointerdown',e=>{
      if(rowMenuEl&&!rowMenuEl.contains(e.target))closeRowMenu();
    },{once:true,capture:true});
  },0);
}
function editUserMessage(id,turn,conv){
  const msg=conv.messages.find(m=>m.id===id);
  const p=turn&&$('.user-bubble p',turn);
  if(!msg||!p)return;
  turn.classList.add('editing');
  const ta=document.createElement('textarea');
  ta.className='user-edit-area';
  ta.value=normalizeText(msg.content);
  const actions=document.createElement('div');
  actions.className='user-edit-actions';
  actions.innerHTML=`<button class="cancel" data-copy>复制</button><button class="cancel" data-cancel>取消</button><button class="save" data-save>保存</button>`;
  const wrap=document.createElement('div');
  wrap.appendChild(ta);
  wrap.appendChild(actions);
  p.replaceWith(wrap);
  const autoGrow=()=>{
    ta.style.height='auto';
    ta.style.height=ta.scrollHeight+'px';
  };
  ta.addEventListener('input',autoGrow);
  autoGrow();
  ta.focus();
  const exit=()=>{
    turn.classList.remove('editing');
    renderMessages(conv.messages);
  };
  const done=()=>{
    const text=ta.value.trim();
    turn.classList.remove('editing');
    if(text&&text!==normalizeText(msg.content)){
      msg.content=text;
      const idx=conv.messages.findIndex(m=>m.id===id);
      if(idx>=0)conv.messages=conv.messages.slice(0,idx+1);
      if(conv.title==='新对话'||conv.title===normalizeText(msg.content).slice(0,18))conv.title=text.slice(0,18);
      saveConversations();
      renderMessages(conv.messages);
      if(state.conversationId===conv.id){
        $('#greeting').textContent=conv.title;
        updateTopTitle(conv.title);
      }
      if(conv.group)pushSync(conv);
      showToast('消息已更新');
    }else{
      renderMessages(conv.messages);
    }
  };
  actions.querySelector('[data-copy]').addEventListener('click',()=>{
    copyText(normalizeText(msg.content));
  });
  actions.querySelector('[data-save]').addEventListener('click',done);
  actions.querySelector('[data-cancel]').addEventListener('click',exit);
  ta.addEventListener('keydown',e=>{
    if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();done()}
    if(e.key==='Escape'){e.preventDefault();exit()}
  });
}
function historyButton(c){
  const row=document.createElement('div');
  row.className='chat-history-row';
  row.dataset.title=(c.title||'').toLowerCase();
  const b=document.createElement('button');
  b.className='side-item chat-history'+(c.id===state.conversationId?' current':'');
  let countBadge='';
  if(c.group){
    const ids=new Set((c.members||[]).map(m=>m.id));
    (c.messages||[]).forEach(m=>{if(m.role==='user'&&m.authorId)ids.add(m.authorId)});
    countBadge=`<small class="group-count">👥 ${ids.size}</small>`;
  }
  b.innerHTML=`<span>${c.pinned?'⌖':'◷'}</span><span>${escapeHTML(c.title)}</span>${countBadge}`;
  b.addEventListener('click',()=>loadConversation(c.id));
  const more=document.createElement('button');
  more.className='history-more';
  more.textContent='⋯';
  more.dataset.more=c.id;
  more.setAttribute('aria-label','对话操作');
  more.addEventListener('click',e=>{e.stopPropagation();showRowMenu(c.id,more)});
  row.appendChild(b);
  row.appendChild(more);
  return row;
}
function renderHistory(){
  const pinned=$('#pinnedChatList'),recent=$('#recentChatList'),groupList=$('#groupChatList');
  pinned.innerHTML='';recent.innerHTML='';groupList.innerHTML='';
  const list=state.conversations.filter(c=>!c.projectId&&!c.group);
  [...list].sort((a,b)=>((b.pinned?1:0)-(a.pinned?1:0))||((b.created_at||'').localeCompare(a.created_at||''))).forEach(c=>(c.pinned?pinned:recent).appendChild(historyButton(c)));
  const groups=state.conversations.filter(c=>c.group);
  [...groups].sort((a,b)=>((b.pinned?1:0)-(a.pinned?1:0))||((b.created_at||'').localeCompare(a.created_at||''))).forEach(c=>groupList.appendChild(historyButton(c)));
  if(!pinned.children.length)pinned.innerHTML='<div class="empty-history">暂无置顶对话</div>';
  if(!recent.children.length)recent.innerHTML='<div class="empty-history">暂无最近对话</div>';
  if(!groupList.children.length)groupList.innerHTML='<div class="empty-history">暂无群聊 · 点下方新建</div>';
  const q=String($('#sidebarSearch').value||'').trim().toLowerCase();
  $$('.chat-history-row').forEach(row=>{
    row.hidden=!!q&&!(row.dataset.title||'').includes(q);
  });
}
function renderProjects(){
  const list=$('#projectList');
  if(!list)return;
  list.innerHTML='';
  state.projects.forEach(p=>{
    const expanded=state.expandedProject===p.id;
    const b=document.createElement('button');
    b.className='side-item project-item'+(expanded?' current':'');
    const count=state.conversations.filter(c=>c.projectId===p.id).length;
    b.innerHTML=`<span class="project-chevron">${expanded?'▾':'▸'}</span><span class="project-icon">▣</span><span>${escapeHTML(p.title)}</span><small class="project-count">${count}</small>`;
    b.addEventListener('click',()=>{
      state.expandedProject=expanded?null:p.id;
      renderProjects();
    });
    list.appendChild(b);
    if(expanded){
      const children=document.createElement('div');
      children.className='project-children';
      const add=document.createElement('button');
      add.className='side-item project-new-chat';
      add.innerHTML=`<span class="plus-small">＋</span><span>在此项目新建对话</span>`;
      add.addEventListener('click',()=>{
        state.expandedProject=p.id;
        const conv=newConversation();
        loadConversation(conv.id);
        renderProjects();
        showToast('已新建项目对话');
      });
      children.appendChild(add);
      const items=state.conversations.filter(c=>c.projectId===p.id)
        .sort((a,b)=>((b.pinned?1:0)-(a.pinned?1:0))||((b.created_at||'').localeCompare(a.created_at||'')));
      items.forEach(c=>{
        const row=historyButton(c);
        row.classList.add('in-project');
        children.appendChild(row);
      });
      if(!items.length){
        const empty=document.createElement('div');
        empty.className='empty-projects';
        empty.textContent='暂无对话';
        children.appendChild(empty);
      }
      list.appendChild(children);
    }
  });
  if(!state.projects.length){
    const empty=document.createElement('div');
    empty.className='empty-projects';
    empty.textContent='暂无项目 · 点上方新建';
    list.appendChild(empty);
  }
}
function startNewProject(){
  const btn=$('#addProjectButton');
  btn.hidden=true;
  const wrap=$('#projectList');
  const input=document.createElement('input');
  input.className='history-edit-input project-name-input';
  input.placeholder='项目名称，回车确认';
  input.maxLength=30;
  wrap.prepend(input);
  input.focus();
  let done=false;
  const finish=()=>{
    if(done)return;done=true;
    const name=input.value.trim();
    input.remove();
    btn.hidden=false;
    if(name){
      const p={id:uid(),title:name,created_at:nowISO()};
      state.projects.push(p);
      state.expandedProject=p.id;
      saveConversations();
      renderProjects();
      renderHistory();
      showToast(`已创建项目「${name}」`);
    }
  };
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){e.preventDefault();finish()}
    if(e.key==='Escape'){e.preventDefault();finish()}
  });
  input.addEventListener('blur',finish);
}
let actionTargetId=null;
let deleteArmed=false;
function openActionSheet(id){
  actionTargetId=id;
  deleteArmed=false;
  closeSidebar();
  const conv=state.conversations.find(c=>c.id===id);
  if(!conv)return;
  actionSheet.innerHTML=`
    <div class="sheet-head">
      <div><span class="sheet-kicker">对话</span><strong>${escapeHTML(conv.title||'对话')}</strong></div>
      <button class="sheet-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="sheet-list" id="actionSheetList"></div>`;
  const list=$('#actionSheetList',actionSheet);
  const options=[
    {label:'重命名对话',icon:'✎',action:'rename'},
    {label:conv.pinned?'取消置顶':'置顶对话',icon:'⌖',action:'pin'},
    {label:'移动到项目',icon:'▣',action:'move'},
    {label:'删除对话',icon:'×',action:'delete',danger:true},
  ];
  options.forEach(opt=>{
    const b=document.createElement('button');
    b.className='sheet-option'+(opt.danger?' danger':'');
    b.innerHTML=`<span class="sheet-option-icon">${opt.icon}</span><span class="sheet-option-copy"><strong>${opt.label}</strong></span>`;
    b.addEventListener('click',()=>handleActionOption(opt.action,conv));
    list.appendChild(b);
  });
  $('.sheet-close',actionSheet)?.addEventListener('click',closePopovers);
  openSheet(actionSheet);
}
function handleActionOption(action,conv){
  if(action==='rename'){
    closePopovers();
    startRenameConversation(conv.id);
  }else if(action==='pin'){
    conv.pinned=!conv.pinned;
    saveConversations();
    renderHistory();
    closePopovers();
    showToast(conv.pinned?'已置顶':'已取消置顶');
  }else if(action==='move'){
    showMoveProjectSheet(conv);
  }else if(action==='delete'){
    if(!deleteArmed){
      deleteArmed=true;
      const confirmBtn=$('#actionSheetList .danger');
      const strong=confirmBtn&&$('strong',confirmBtn);
      if(strong)strong.textContent='确认删除？再次点击';
      return;
    }
    state.conversations=state.conversations.filter(c=>c.id!==conv.id);
    if(state.conversationId===conv.id){
      state.conversationId=null;
      messagesEl.innerHTML='';
      $('#greeting').textContent='你好，今天想聊点什么？';
    }
    saveConversations();
    renderHistory();
    renderProjects();
    closePopovers();
    showToast('对话已删除');
  }
}
function showMoveProjectSheet(conv){
  actionSheet.innerHTML=`
    <div class="sheet-head">
      <div><span class="sheet-kicker">移动</span><strong>选择项目</strong></div>
      <button class="sheet-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="sheet-list" id="actionSheetList"></div>`;
  const list=$('#actionSheetList',actionSheet);
  const none=document.createElement('button');
  none.className='sheet-option'+(!conv.projectId?' current-model':'');
  none.innerHTML=`<span class="sheet-option-icon">${!conv.projectId?'✓':'◇'}</span><span class="sheet-option-copy"><strong>无项目（全部对话）</strong></span>`;
  none.addEventListener('click',()=>{
    conv.projectId=null;
    saveConversations();renderHistory();renderProjects();closePopovers();
    showToast('已移动到全部对话');
  });
  list.appendChild(none);
  state.projects.forEach(p=>{
    const b=document.createElement('button');
    b.className='sheet-option'+(conv.projectId===p.id?' current-model':'');
    b.innerHTML=`<span class="sheet-option-icon">${conv.projectId===p.id?'✓':'▣'}</span><span class="sheet-option-copy"><strong>${escapeHTML(p.title)}</strong></span>`;
    b.addEventListener('click',()=>{
      conv.projectId=p.id;
      saveConversations();renderHistory();renderProjects();closePopovers();
      showToast(`已移动到「${p.title}」`);
    });
    list.appendChild(b);
  });
  if(!state.projects.length){
    const empty=document.createElement('div');
    empty.className='sheet-empty';
    empty.innerHTML='暂无项目<br><small>先点侧栏“新建项目”创建。</small>';
    list.appendChild(empty);
  }
  $('.sheet-close',actionSheet)?.addEventListener('click',closePopovers);
}
function startRenameConversation(id){
  const conv=state.conversations.find(c=>c.id===id);
  if(!conv)return;
  const more=document.querySelector(`[data-more="${id}"]`);
  const rowEl=more&&more.closest('.chat-history-row');
  const titleSpan=rowEl&&rowEl.querySelector('.chat-history span:last-child');
  if(!titleSpan)return;
  const input=document.createElement('input');
  input.className='history-edit-input';
  input.value=conv.title||'';
  input.maxLength=30;
  titleSpan.replaceWith(input);
  input.focus();
  input.select();
  let done=false;
  const finish=()=>{
    if(done)return;done=true;
    const name=input.value.trim();
    if(name)conv.title=name;
    saveConversations();
    renderHistory();
    if(state.conversationId===conv.id)$('#greeting').textContent=conv.title||'对话';
    updateTopTitle(conv.title||'对话');
    showToast(name?'已重命名':'名称未修改');
  };
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){e.preventDefault();finish()}
    if(e.key==='Escape'){e.preventDefault();finish()}
  });
  input.addEventListener('blur',finish);
}
function loadConversation(id){
  const conv=state.conversations.find(c=>c.id===id);if(!conv)return;
  state.conversationId=id;
  $('#greeting').textContent=conv.title||'对话';
  updateTopTitle(conv.title||'对话');
  toggleGroupUi(conv);
  renderMessages(conv.messages||[]);
  closeSidebar();
  renderHistory();
  scrollBottom(false);
}
function newChat(){
  state.conversationId=null;
  messagesEl.innerHTML='';
  $('#greeting').textContent='你好，今天想聊点什么？';
  updateTopTitle('新对话');
  toggleGroupUi(null);
  promptInput.value='';promptInput.focus();
  closeSidebar();renderHistory();showToast('新建对话');
}
$('#newChatButton').addEventListener('click',newChat);
$('#sidebarSearch')?.addEventListener('input',e=>{
  const q=String(e.target.value||'').trim().toLowerCase();
  $$('.chat-history-row').forEach(row=>{
    row.hidden=!!q&&!(row.dataset.title||'').includes(q);
  });
});
$('#addProjectButton').addEventListener('click',startNewProject);

/* ---------- composer ---------- */
promptInput.addEventListener('input',()=>{promptInput.style.height='auto';promptInput.style.height=Math.min(promptInput.scrollHeight,145)+'px'});
promptInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});
sendButton.addEventListener('click',sendMessage);

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
    if(r.ok){const j=await r.json();models=normalizeModelList((j.data||[]).map(m=>m&&m.id?m.id:m))}
  }catch(e){}
  if(!models.length){
    const r=await fetch(apiUrl(cfg),{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.api_key},body:JSON.stringify({model:cfg.model,messages:[{role:'user',content:'ping'}],max_tokens:1,stream:false})});
    if(!r.ok){let msg='请求失败';try{const j=await r.json();msg=(j.error&&(j.error.message||j.error.code))||msg}catch(e){}throw new Error(msg)}
  }
  return {ok:true,message:models.length?`连接成功 · 检测到 ${models.length} 个模型`:'连接成功',models};
}
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

/* ---------- chat ---------- */
function buildHistory(conv,skipMsg){
  const out=[];
  for(const m of conv.messages){
    if(m===skipMsg||!m.content)continue;
    out.push({role:m.role,content:normalizeText(m.content)});
  }
  return out;
}
async function runStream(conv,assistantMsg,userText,cfg,existingTurn){
  const msgs=buildHistory(conv,assistantMsg);
  const turn=existingTurn||appendTempAssistant(assistantMsg);
  const p0=$('.assistant-bubble p',turn);
  if(p0&&existingTurn)p0.classList.add('streaming-caret');
  let finalText='';
  let reasoningText='';
  try{
    await streamChat(cfg,msgs,{
      delta(t){
        finalText+=t;
        const p=$('.assistant-bubble p',turn);
        if(p)p.insertAdjacentText('beforeend',t);
        scrollBottom(false);
      },
      reasoning(t){
        reasoningText+=t;
        if(reasoningText.length>30000)reasoningText=reasoningText.slice(0,30000);
        const rp=$('.reasoning-scroll',turn);
        if(rp)rp.textContent=reasoningText;
        const rs=$('.reasoning-state',turn);
        if(rs)rs.textContent='思考中…';
        const rt=$('[data-reasoning-toggle]',turn);
        if(rt&&reasoningText)rt.disabled=false;
        scrollBottom(false);
      },
      done(){},
    });
  }finally{
    const p=$('.assistant-bubble p',turn);
    if(p)p.classList.remove('streaming-caret');
  }
  assistantMsg.content=normalizeText(finalText).trim();
  if(reasoningText)assistantMsg.reasoning_summary=reasoningText;
  assistantMsg.created_at=nowISO();
  if(!assistantMsg.content)throw new Error('模型没有返回内容');
  const turn2=existingTurn||$(`[data-message-id="${assistantMsg.id}"]`);
  const stateEl=turn2&&$('.reasoning-state',turn2);
  if(stateEl&&stateEl.textContent==='等待摘要')stateEl.textContent='无摘要';
}
async function sendMessage(){
  if(state.sending||state.shared)return;
  const text=promptInput.value.trim();if(!text){showToast('请输入消息');return}
  const cfg=getClientApi();
  if(!cfg){openSettings('api');showToast('请先配置 AI 接口');return}
  let conv=currentConversation();
  if(!conv)conv=newConversation();
  if(conv.group){
    await pullSync(conv);
    if(!conv.syncUrl){
      try{await createSyncBlob(conv)}catch(e){showToast('群聊同步不可用，仅本机使用')}
    }
    upsertMember(conv);
  }
  const userMsg={id:uid(),role:'user',content:text,created_at:nowISO()};
  if(conv.group){
    userMsg.authorId=state.account.id;
    userMsg.authorName=state.account.name;
  }
  if(conv.group&&!isMentionAI(text,cfg)){
    conv.messages.push(userMsg);
    promptInput.value='';promptInput.style.height='auto';
    messagesEl.insertAdjacentHTML('beforeend',messageHTML(userMsg));
    scrollBottom();
    saveConversations();renderHistory();
    pushSync(conv);
    showToast('已发送到群聊');
    return;
  }
  const assistantMsg={id:uid(),role:'assistant',content:'',model:state.modelId||cfg.model,created_at:nowISO(),streaming:true};
  conv.messages.push(userMsg,assistantMsg);
  if(conv.title==='新对话')conv.title=text.slice(0,18);
  updateTopTitle(conv.title);
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
    assistantMsg.streaming=false;
    state.sending=false;sendButton.disabled=false;
    saveConversations();renderHistory();
    if(state.conversationId===conv.id){renderMessages(conv.messages);scrollBottom(false)}
    if(conv.group)pushSync(conv);
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
    assistant.content='';
    assistant.reasoning_summary=null;
    assistant.streaming=true;
    saveConversations();renderMessages(conv.messages);
    const existingTurn=$(`[data-message-id="${mid}"]`);
    const reasoningState=existingTurn&&$('.reasoning-state',existingTurn);
    const reasoningShell=existingTurn&&$('.reasoning-mini-window',existingTurn);
    if(reasoningState)reasoningState.textContent='生成中';
    if(reasoningShell){
      reasoningShell.classList.remove('ready');
      reasoningShell.classList.add('waiting');
    }
    state.sending=true;sendButton.disabled=true;
    try{
      await runStream(conv,assistant,userText,cfg,existingTurn);
    }catch(e){
      if(!assistant.content)assistant.content='（生成失败：'+(e.message||'未知错误')+'）';
      showToast(e.message||'生成失败');
    }finally{
      assistant.streaming=false;
      state.sending=false;sendButton.disabled=false;
      saveConversations();renderHistory();
      if(state.conversationId===conv.id){renderMessages(conv.messages);scrollBottom(false)}
      if(conv.group)pushSync(conv);
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
    shareAsCard(conv,conv.messages[idx]);
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
function wrapCanvasText(ctx,text,maxWidth){
  const paragraphs=String(text||'').split('\n');
  const lines=[];
  for(const p of paragraphs){
    if(!p){lines.push('');continue}
    let line='';
    for(const ch of p){
      const test=line+ch;
      if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=ch}
      else line=test;
    }
    lines.push(line);
  }
  return lines;
}
function roundRect(ctx,x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}
function buildShareCard(conv,assistantMsg){
  const W=1000,PAD=52,LINE_H=50;
  const userIdx=conv.messages.indexOf(assistantMsg);
  let userMsg=null;
  for(let i=userIdx-1;i>=0;i--){
    if(conv.messages[i].role==='user'){userMsg=conv.messages[i];break}
  }
  const userText=normalizeText(userMsg?userMsg.content:'');
  const asstText=normalizeText(assistantMsg.content);
  const canvas=document.createElement('canvas');
  const ctx=canvas.getContext('2d');
  ctx.font='30px "PingFang SC","Microsoft YaHei",sans-serif';
  const userLines=userMsg?wrapCanvasText(ctx,userText,W-PAD*2-64):[];
  const asstLines=wrapCanvasText(ctx,asstText,W-PAD*2-64);
  const headerH=150;
  const userBlockH=userMsg?(40+userLines.length*LINE_H+44):0;
  const asstHeadH=50;
  const asstBlockH=36+asstHeadH+asstLines.length*LINE_H+44;
  const footerH=90;
  const H=headerH+userBlockH+asstBlockH+footerH;
  canvas.width=W;canvas.height=H;
  const bg=ctx.createLinearGradient(0,0,W,H);
  bg.addColorStop(0,'#eef5f4');
  bg.addColorStop(1,'#d9e8e6');
  ctx.fillStyle=bg;
  ctx.fillRect(0,0,W,H);
  ctx.fillStyle='rgba(139,200,184,.35)';
  roundRect(ctx,0,0,W,headerH,0);
  ctx.fill();
  ctx.textAlign='left';
  ctx.fillStyle='#1d3a33';
  ctx.font='700 44px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('✦ 英子起飞',PAD,86);
  ctx.font='26px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillStyle='#4d6b63';
  const model=modelDisplayName(assistantMsg);
  let dateStr='';
  try{dateStr=new Date(assistantMsg.created_at||Date.now()).toLocaleString('zh-CN',{hour12:false})}catch(e){}
  ctx.fillText(`${model} · ${dateStr}`,PAD,124);
  let y=headerH+34;
  if(userMsg){
    const bw=W-PAD*2,bh=userLines.length*LINE_H+64;
    ctx.fillStyle='rgba(215,241,233,.92)';
    roundRect(ctx,PAD,y,bw,bh,34);
    ctx.fill();
    ctx.fillStyle='#1c3a33';
    ctx.font='30px "PingFang SC","Microsoft YaHei",sans-serif';
    let ty=y+50;
    userLines.forEach(l=>{ctx.fillText(l,PAD+32,ty);ty+=LINE_H});
    y+=bh+26;
  }
  const bw=W-PAD*2,bh=asstBlockH;
  ctx.fillStyle='rgba(255,255,255,.94)';
  roundRect(ctx,PAD,y,bw,bh,34);
  ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,.95)';
  ctx.lineWidth=2;
  roundRect(ctx,PAD,y,bw,bh,34);
  ctx.stroke();
  ctx.fillStyle='#2a3f46';
  ctx.font='700 28px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('✦ '+model,PAD+32,y+40);
  ctx.fillStyle='#344b43';
  ctx.font='30px "PingFang SC","Microsoft YaHei",sans-serif';
  let ty2=y+40+asstHeadH;
  asstLines.forEach(l=>{ctx.fillText(l,PAD+32,ty2);ty2+=LINE_H});
  ctx.textAlign='center';
  ctx.fillStyle='#5b6f6a';
  ctx.font='24px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText('—— 来自 英子起飞 AI 聊天 ——',W/2,H-34);
  return canvas.toDataURL('image/png');
}
function shareAsCard(conv,assistantMsg){
  const text=`【${conv.title||'对话'}】\n${normalizeText(assistantMsg.content)}`;
  try{
    const dataUrl=buildShareCard(conv,assistantMsg);
    if(bridge&&bridge.shareImage){
      bridge.shareImage(dataUrl,String(conv.title||'对话'),text);
    }else if(navigator.share){
      navigator.share({text}).catch(()=>{});
    }else{
      copyText(text);
    }
  }catch(e){
    shareText(text);
  }
}

/* ---------- group chat sync (jsonblob relay, no account needed) ---------- */
const SYNC_BASE='https://ntfy.sh';
async function createSyncBlob(conv){
  const topic='whale-girl-'+uid().slice(0,10);
  conv.syncUrl=SYNC_BASE+'/'+topic;
  conv.updatedAt=Date.now();
  await pushSync(conv);
  saveConversations();
  watchGroup(conv);
}
async function pushSync(conv){
  if(!conv||!conv.group||!conv.syncUrl)return;
  conv.updatedAt=Date.now();
  try{
    const res=await fetch(conv.syncUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(conv)});
    if(!res.ok)throw new Error('HTTP '+res.status);
  }catch(e){}
}
function adoptRemoteMessage(conv,last){
  if(!last)return false;
  let remote=null;
  if(last&&typeof last==='object'&&last.message){
    try{remote=JSON.parse(last.message)}catch(e){}
  }else if(typeof last==='string'){
    try{remote=JSON.parse(last)}catch(e){}
  }
  if(!remote||!Array.isArray(remote.messages))return false;
  const localUpdated=Number(conv.updatedAt||0);
  const remoteUpdated=Number(remote.updatedAt||0);
  const remoteHasMore=remote.messages.length>conv.messages.length;
  if(!(remoteUpdated>localUpdated||remoteHasMore))return false;
  const before=conv.messages.length;
  conv.title=remote.title||conv.title;
  conv.messages=remote.messages;
  conv.members=remote.members||conv.members;
  conv.updatedAt=remoteUpdated||Date.now();
  conv.syncUrl=conv.syncUrl||remote.syncUrl;
  const lastMsg=remote.messages[remote.messages.length-1];
  if(lastMsg&&lastMsg.role==='user'&&lastMsg.authorName&&lastMsg.authorName!==state.account.name&&conv.notifiedId!==lastMsg.id){
    if(bridge&&bridge.notifyGroupMessage){
      bridge.notifyGroupMessage(String(lastMsg.authorName),String(normalizeText(lastMsg.content)).slice(0,120));
    }
  }
  conv.notifiedId=lastMsg?lastMsg.id:null;
  conv.syncSince=last.id||conv.syncSince;
  saveConversations();
  if(state.conversationId===conv.id){
    renderMessages(conv.messages);
    $('#greeting').textContent=conv.title;
    updateTopTitle(conv.title);
    scrollBottom(false);
    if(remote.messages.length>before)showToast('收到新消息');
  }
  renderHistory();
  return true;
}
async function pullSync(conv){
  if(!conv||!conv.group||!conv.syncUrl)return;
  try{
    const res=await fetchWithTimeout(conv.syncUrl+'/json',8000);
    if(!res.ok)return;
    const arr=await res.json();
    if(!Array.isArray(arr)||!arr.length)return;
    adoptRemoteMessage(conv,arr[arr.length-1]);
  }catch(e){}
}
async function watchGroup(conv){
  if(!conv||conv._watching)return;
  conv._watching=true;
  while(conv.group&&state.conversations.includes(conv)){
    try{
      const url=conv.syncUrl+(conv.syncSince?'?poll=1&since='+conv.syncSince:'');
      const res=await fetchWithTimeout(url,50000);
      if(res.ok){
        const arr=await res.json();
        if(Array.isArray(arr)&&arr.length){
          adoptRemoteMessage(conv,arr[arr.length-1]);
        }
      }
    }catch(e){}
    await new Promise(r=>setTimeout(r,3000));
  }
}
function newGroupChat(){
  const conv={id:uid(),title:'新群聊',pinned:false,projectId:null,group:true,members:[{id:state.account.id,name:state.account.name},{id:'friend',name:'朋友'}],messages:[],created_at:nowISO(),updatedAt:Date.now()};
  state.conversations.push(conv);
  state.conversationId=conv.id;
  $('#greeting').textContent='群聊';
  updateTopTitle('新群聊');
  toggleGroupUi(conv);
  renderMessages([]);
  renderHistory();
  closeSidebar();
  promptInput.focus();
  showToast('已创建群聊，点 ⋯ 可重命名');
}
$('#newGroupButton')?.addEventListener('click',newGroupChat);
function toggleGroupUi(conv){
  const btn=$('#mentionButton');
  const ta=$('#promptInput');
  const composer=$('#composer');
  const isGroup=!!(conv&&conv.group);
  if(btn)btn.hidden=!isGroup;
  if(composer)composer.classList.toggle('has-mention',isGroup);
  if(ta)ta.placeholder=isGroup?'输入消息… 输入 @AI 召唤回复':'输入消息…';
}
function isMentionAI(text,cfg){
  const s=String(text||'');
  if(/@\s*(ai|英子|起飞|deepseek|ds|机器人|助手)/i.test(s))return true;
  const m=(cfg&&cfg.model)||state.modelId||'';
  if(m&&s.toLowerCase().includes(m.toLowerCase()))return true;
  return false;
}
function upsertMember(conv){
  if(!conv.members)conv.members=[];
  const me=conv.members.find(m=>m.id===state.account.id);
  if(me)me.name=state.account.name;
  else conv.members.push({id:state.account.id,name:state.account.name});
}
function showGroupSettings(conv){
  closeRowMenu();
  const menu=document.createElement('div');
  menu.className='row-menu glass';
  const me=conv.members&&conv.members.find(m=>m.id===state.account.id);
  const other=conv.members&&conv.members.find(m=>m.id!==state.account.id);
  const memberIds=new Set((conv.members||[]).map(m=>m.id));
  (conv.messages||[]).forEach(m=>{if(m.role==='user'&&m.authorId)memberIds.add(m.authorId)});
  const hasOther=[...memberIds].some(id=>id!==state.account.id);
  const otherName=(other&&other.name)||'朋友';
  const memberLine=`<div class="join-status">群成员 ${memberIds.size} 人（${escapeHTML(state.account.name)}${hasOther?'、'+escapeHTML(otherName):''}）· ${hasOther?'朋友已加入':'等待朋友加入'}</div>`;
  menu.innerHTML=`
    <div class="row-menu-title">群设置</div>
    ${memberLine}
    <input class="row-menu-input g-name" placeholder="群名称" value="${escapeHTML(conv.title||'')}" />
    <input class="row-menu-input g-me" placeholder="我的昵称" value="${escapeHTML((me&&me.name)||state.nickname||'我')}" />
    <input class="row-menu-input g-other" placeholder="朋友昵称" value="${escapeHTML((other&&other.name)||'朋友')}" />
    <div class="row-menu-actions"><button class="row-menu-btn" data-cancel>取消</button><button class="row-menu-btn primary" data-ok>保存</button></div>`;
  document.body.appendChild(menu);
  rowMenuEl=menu;
  lastMenuAnchor=$('#topModelButton');
  positionRowMenu();
  const save=()=>{
    const name=menu.querySelector('.g-name').value.trim();
    const myName=menu.querySelector('.g-me').value.trim()||state.account.name||'我';
    const otherName=menu.querySelector('.g-other').value.trim()||'朋友';
    if(name)conv.title=name;
    if(!conv.members)conv.members=[];
    const meIdx=conv.members.findIndex(m=>m.id===state.account.id);
    if(meIdx>=0)conv.members[meIdx].name=myName;
    else conv.members.push({id:state.account.id,name:myName});
    const otherIdx=conv.members.findIndex(m=>m.id!==state.account.id);
    if(otherIdx>=0)conv.members[otherIdx].name=otherName;
    else conv.members.push({id:'friend',name:otherName});
    localStorage.setItem('group.nickname',myName);
    localStorage.setItem('account.name',myName);
    state.nickname=myName;
    state.account.name=myName;
    saveConversations();
    renderHistory();
    if(state.conversationId===conv.id){
      $('#greeting').textContent=conv.title;
      updateTopTitle(conv.title);
    }
    pushSync(conv);
    closeRowMenu();
    showToast('群设置已保存');
  };
  menu.querySelector('[data-ok]').addEventListener('click',save);
  menu.querySelector('[data-cancel]').addEventListener('click',closeRowMenu);
}
$('#mentionButton')?.addEventListener('click',()=>{
  promptInput.value=(promptInput.value?promptInput.value+' ':'')+'@AI ';
  promptInput.focus();
  promptInput.dispatchEvent(new Event('input'));
});
$('#topModelButton').addEventListener('click',()=>{
  const conv=currentConversation();
  if(conv&&conv.group)showGroupSettings(conv);
});
async function shareGroup(conv){
  if(!conv.syncUrl){
    try{await createSyncBlob(conv)}catch(e){showToast('同步不可用');closeRowMenu();return}
  }
  const topic=String(conv.syncUrl||'').replace(/\/+$/,'').split('/').pop();
  copyText('yingzi://join/'+topic);
  closeRowMenu();
  showToast('群聊专属链接已复制，朋友点击即可加入');
}
async function joinGroupByUrl(urlOrTopic){
  const raw=String(urlOrTopic||'').trim();
  const topic=raw.replace(/\/+$/,'').split('/').pop();
  if(!topic)throw new Error('链接无效');
  const syncUrl=SYNC_BASE+'/'+topic;
  const res=await fetch(syncUrl+'/json',{cache:'no-store'});
  if(!res.ok)throw new Error('HTTP '+res.status);
  const arr=await res.json();
  let remote=null;
  if(Array.isArray(arr)&&arr.length){
    const last=arr[arr.length-1];
    if(last&&typeof last==='object'&&last.message){
      try{remote=JSON.parse(last.message)}catch(e){}
    }else if(typeof last==='string'){
      try{remote=JSON.parse(last)}catch(e){}
    }
  }
  if(!remote&&Array.isArray(arr))remote={title:'新群聊',members:[],messages:[],updatedAt:Date.now()};
  if(!remote||!Array.isArray(remote.messages))throw new Error('不是有效的群聊');
  if(state.conversations.some(c=>c.id===remote.id))throw new Error('已加入该群聊');
  remote.syncUrl=syncUrl;
  remote.updatedAt=Date.now();
  remote.notifiedId=remote.messages.length?remote.messages[remote.messages.length-1].id:null;
  state.conversations.push(remote);
  state.conversationId=remote.id;
  saveConversations();
  renderHistory();
  upsertMember(remote);
  pushSync(remote);
  watchGroup(remote);
  $('#greeting').textContent=remote.title;
  updateTopTitle(remote.title);
  toggleGroupUi(remote);
  renderMessages(remote.messages||[]);
  return remote;
}
window.__autoJoinGroup=async function(topic){
  try{
    await joinGroupByUrl(topic);
    showToast('已加入群聊');
  }catch(e){
    showToast('加入失败：'+(e.message||'未知错误'));
  }
};
function promptJoinGroup(){
  closeRowMenu();
  const menu=document.createElement('div');
  menu.className='row-menu glass';
  menu.innerHTML=`<div class="row-menu-title">加入群聊</div><input class="row-menu-input" placeholder="粘贴群聊链接" /><div class="join-status"></div><div class="row-menu-actions"><button class="row-menu-btn" data-cancel>取消</button><button class="row-menu-btn primary" data-ok>加入</button></div>`;
  document.body.appendChild(menu);
  rowMenuEl=menu;
  lastMenuAnchor=$('#joinGroupButton');
  positionRowMenu();
  const input=menu.querySelector('input');
  const status=menu.querySelector('.join-status');
  input.focus();
  const join=async()=>{
    const url=input.value.trim();
    if(!url){status.textContent='请先粘贴群聊链接';return}
    status.textContent='正在加入…';
    try{
      await joinGroupByUrl(url);
      closeRowMenu();
      showToast('已加入群聊');
    }catch(e){
      status.textContent='加入失败：'+(e.message||'未知错误');
    }
  };
  menu.querySelector('[data-ok]').addEventListener('click',join);
  menu.querySelector('[data-cancel]').addEventListener('click',closeRowMenu);
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();join()}});
}
$('#joinGroupButton')?.addEventListener('click',promptJoinGroup);

/* ---------- settings ---------- */
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
    option.selected=true;
    select.appendChild(option);
    select.disabled=true;
    return;
  }
  for(const id of models){
    const option=document.createElement('option');
    option.value=id;
    option.textContent=id;
    option.selected=id===selected;
    select.appendChild(option);
  }
  select.disabled=false;
  select.value=selected||models[0];
}
function fillSettings(){
  const cfg=getStoredClientApiRaw()||{base_url:'https://api.deepseek.com',api_key:'',model:'',reasoning_parameter:'',models:[]};
  $('#apiBaseUrl').value=cfg.base_url||'';
  $('#apiKey').value=cfg.api_key||'';
  $('#apiReasoningParam').value=sanitizeReasoningParameter(cfg.reasoning_parameter||'',cfg.models||[]);
  const nickInput=$('#apiNickname');
  if(nickInput)nickInput.value=state.account.name;
  const accountInput=$('#accountName');
  if(accountInput)accountInput.value=state.account.name;
  const accountStatus=$('#accountStatus');
  if(accountStatus)accountStatus.textContent=`账号 ID：${state.account.id.slice(0,10)}…（群聊中以此区分成员）`;
  $('#apiModels').value=(cfg.models||[]).join('\n');
  const manifestInput=$('#apiUpdateManifest');
  if(manifestInput)manifestInput.value=safeGet('app.updateManifestUrl',DEFAULT_UPDATE_MANIFEST);
  populateApiModelSelect(cfg.model,cfg.models);
  const ok=!!getClientApi();
  $('#apiStatus').textContent=ok?'已保存到当前设备':'';
  $('#apiStatus').className='settings-status'+(ok?' ok':'');
}
function openSettings(tab='api'){
  closeSidebar();
  swipeStart=null;
  fillSettings();
  settingsBackdrop.hidden=false;
  document.body.style.overflow='hidden';
  document.body.classList.add('settings-open');
  switchSettingsTab(tab);
  loadCurrentVersion();
}
function closeSettings(){
  settingsBackdrop.hidden=true;
  document.body.style.overflow='';
  document.body.classList.remove('settings-open');
}
function switchSettingsTab(tab){
  $$('.settings-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  $$('.settings-panel').forEach(p=>p.classList.toggle('active',p.dataset.panel===tab));
}
window.__openSettings=openSettings;
$('#sidebarSettings').addEventListener('click',()=>{closeSidebar();openSettings('api')});
$('#bannerSettings').addEventListener('click',()=>openSettings('api'));
$('#settingsClose').addEventListener('click',closeSettings);
function lockSettingsBackgroundGesture(event){
  if(settingsBackdrop.hidden)return;
  swipeStart=null;
  event.stopPropagation();
}
settingsBackdrop.addEventListener('touchstart',lockSettingsBackgroundGesture,{capture:true,passive:true});
settingsBackdrop.addEventListener('touchmove',lockSettingsBackgroundGesture,{capture:true,passive:true});
settingsBackdrop.addEventListener('pointerdown',lockSettingsBackgroundGesture,{capture:true,passive:true});
$('#fetchModelsButton')?.addEventListener('click',async()=>{
  const status=$('#apiStatus');
  const base_url=$('#apiBaseUrl').value.trim().replace(/\/+$/,'');
  const api_key=$('#apiKey').value.trim();
  if(!/^https?:\/\//i.test(base_url)){status.textContent='请先填写正确的 API 地址';status.className='settings-status error';showToast('请先填写正确的 API 地址');return}
  if(!api_key){status.textContent='请先填写 API Key';status.className='settings-status error';showToast('请先填写 API Key');return}
  const button=$('#fetchModelsButton');
  button.disabled=true;
  button.textContent='查询中…';
  status.textContent='正在读取模型列表…';
  status.className='settings-status';
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
settingsBackdrop.addEventListener('click',e=>{if(e.target===settingsBackdrop)closeSettings()});
$('#apiModels')?.addEventListener('input',()=>{
  const models=normalizeModelList($('#apiModels').value);
  populateApiModelSelect($('#apiModel')?.value||'',models);
});
$('#toggleKey').addEventListener('click',()=>{
  const input=$('#apiKey'),show=input.type==='password';
  input.type=show?'text':'password';
  $('#toggleKey').textContent=show?'隐藏':'显示';
  $('#toggleKey').setAttribute('aria-label',show?'隐藏 API Key':'显示 API Key');
});
$('#clearApiKey')?.addEventListener('click',()=>{
  const input=$('#apiKey');
  input.value='';
  input.type='password';
  $('#toggleKey').textContent='显示';
  $('#toggleKey').setAttribute('aria-label','显示 API Key');
  input.focus();
  showToast('API Key 已清空');
});
$('#apiKey')?.addEventListener('focus',()=>{
  try{$('#apiKey').select()}catch(e){}
});
function settingsFormValue(){
  const models=normalizeModelList($('#apiModels').value);
  return {
    base_url:$('#apiBaseUrl').value.trim().replace(/\/+$/,''),
    api_key:$('#apiKey').value.trim(),
    model:$('#apiModel')?.value||'',
    reasoning_parameter:sanitizeReasoningParameter($('#apiReasoningParam').value,models),
    models,
  };
}
function validateCfg(cfg){
  if(!/^https?:\/\//i.test(cfg.base_url))return 'API 地址格式不正确';
  if(!cfg.api_key)return '请填写 API Key';
  if(!cfg.model||looksLikeApiKey(cfg.model))return '请先查询并选择一个模型';
  return '';
}
$('#saveApiButton').addEventListener('click',()=>{
  const cfg=settingsFormValue();
  const err=validateCfg(cfg);
  const status=$('#apiStatus');
  if(err){status.textContent=err;status.className='settings-status error';return}
  if(!cfg.models.includes(cfg.model))cfg.models=normalizeModelList([cfg.model,...cfg.models]);
  const manifestInput=$('#apiUpdateManifest');
  if(manifestInput)localStorage.setItem('app.updateManifestUrl',manifestInput.value.trim());
  const nickInput=$('#apiNickname');
  if(nickInput){
    const nick=nickInput.value.trim()||'我';
    localStorage.setItem('group.nickname',nick);
    localStorage.setItem('account.name',nick);
    state.nickname=nick;
    state.account.name=nick;
  }
  saveClientApi(cfg);
  state.clientApi=cfg;
  state.modelId=cfg.model;
  state.modelSource='local';
  localStorage.setItem('ai.modelId',cfg.model);
  localStorage.setItem('ai.modelSource','local');
  rebuildModelMenu();
  updateApiBanner();
  apiBanner.hidden=true;
  apiBanner.classList.add('force-hidden');
  status.textContent=`已保存 · 默认模型 ${cfg.model}`;
  status.className='settings-status ok';
  showToast('API 与模型设置已保存');
  setTimeout(closeSettings,260);
});
$('#testApiButton').addEventListener('click',async()=>{
  const cfg=settingsFormValue();
  const err=validateCfg(cfg);
  const status=$('#apiStatus');
  if(err){status.textContent=err;status.className='settings-status error';return}
  status.textContent='正在测试所选模型…';
  status.className='settings-status';
  $('#testApiButton').disabled=true;
  try{
    await testApi({base_url:cfg.base_url,api_key:cfg.api_key,model:cfg.model,reasoning_parameter:cfg.reasoning_parameter||''});
    status.textContent=`连接成功 · ${cfg.model} 可用`;
    status.className='settings-status ok';
    showToast('模型测试成功');
  }catch(e){
    status.textContent=e.message||'模型测试失败';
    status.className='settings-status error';
  }finally{
    $('#testApiButton').disabled=false;
  }
});
$('#saveAccountButton')?.addEventListener('click',()=>{
  const input=$('#accountName');
  const status=$('#accountStatus');
  const name=(input&&input.value.trim())||state.account.name||'我';
  state.account.name=name;
  localStorage.setItem('account.name',name);
  localStorage.setItem('group.nickname',name);
  state.nickname=name;
  state.conversations.forEach(c=>{
    if(c.group&&c.members){
      const m=c.members.find(x=>x.id===state.account.id);
      if(m)m.name=name;
      pushSync(c);
    }
  });
  renderHistory();
  if(status){
    status.textContent=`用户名已保存：${name}`;
    status.className='settings-status ok';
  }
  showToast('用户名已保存');
});

/* ---------- update ---------- */
const APP_CURRENT_VERSION='2.8.7';
const DEFAULT_UPDATE_MANIFEST='https://raw.githubusercontent.com/19836029013/liquid-glass-ai-chat/main/update.json';
const MIRROR_PREFIXES=['https://gh-proxy.com/','https://ghfast.top/'];
let availableUpdate=null;
let updateBusy=false;
let updateRetryDone=false;
let updateUrlIndex=0;
let updateAttempts=0;
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
function fetchWithTimeout(url,ms=8000){
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),ms);
  return fetch(url,{cache:'no-store',signal:ctrl.signal}).finally(()=>clearTimeout(timer));
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
  const manifestUrl=(safeGet('app.updateManifestUrl')||'').trim()||DEFAULT_UPDATE_MANIFEST;
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
  updateRetryDone=false;
  setUpdateProgress(null);
  setUpdateButton({label:'检查中…',loading:true});
  $('#updateState').textContent='正在检查更新…';
  try{
    const platform=detectUpdatePlatform();
    const manifestUrl=(safeGet('app.updateManifestUrl')||'').trim()||DEFAULT_UPDATE_MANIFEST;
    if(!manifestUrl){
      $('#updateState').textContent='未配置更新源 · 安装新版 APK 即可更新';
      setUpdateButton({label:'检查更新'});
      return;
    }
    const sep=manifestUrl.includes('?')?'&':'?';
    const directUrl=manifestUrl+sep+'t='+Date.now();
    const urls=[directUrl,...MIRROR_PREFIXES.map(p=>p+directUrl)];
    let j=null;
    let lastErr=null;
    for(const u of urls){
      try{
        const res=await fetchWithTimeout(u,8000);
        if(!res.ok)throw new Error('HTTP '+res.status);
        j=await res.json();
        break;
      }catch(e){lastErr=e}
    }
    if(!j)throw lastErr||new Error('无法连接更新源');
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
  const base=info.download_url;
  const candidates=[base,...(base?MIRROR_PREFIXES.map(p=>p+base):[]),info.store_url,info.web_url].filter(Boolean);
  updateUrlIndex=0;
  updateAttempts=0;
  const url=candidates[0];
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
    if(availableUpdate&&updateAttempts<3){
      const base=availableUpdate.download_url;
      const candidates=[base,...(base?MIRROR_PREFIXES.map(p=>p+base):[]),availableUpdate.store_url,availableUpdate.web_url].filter(Boolean);
      if(candidates.length>1){
        updateAttempts+=1;
        updateUrlIndex=(updateUrlIndex+1)%candidates.length;
        setUpdateButton({label:'正在切换线路…',mode:'update',loading:true});
        $('#updateState').textContent=`线路异常，自动切换备用线路（${updateAttempts}/3）`;
        window.AndroidUpdater.installApk(String(candidates[updateUrlIndex]),String(availableUpdate.latest_version||''),String(availableUpdate.sha256||''));
        return;
      }
    }
    updateBusy=false;
    setUpdateButton({label:'重新更新',mode:'update'});
    showToast(detail.message||'更新失败');
  }else if(detail.state==='installing'){
    setUpdateButton({label:'等待安装',mode:'update',loading:true});
  }
});

/* ---------- wallpaper & appearance ---------- */
const WALL_DB='ai-chat-assets',WALL_STORE='files',WALL_KEY='wallpaper';let wallpaperObjectURL=null;
function openWallDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(WALL_DB,1);req.onupgradeneeded=()=>req.result.createObjectStore(WALL_STORE);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function putWallpaper(blob){const db=await openWallDB();await new Promise((resolve,reject)=>{const tx=db.transaction(WALL_STORE,'readwrite');tx.objectStore(WALL_STORE).put(blob,WALL_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close()}
async function getWallpaper(){const db=await openWallDB();const blob=await new Promise((resolve,reject)=>{const tx=db.transaction(WALL_STORE,'readonly'),r=tx.objectStore(WALL_STORE).get(WALL_KEY);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error)});db.close();return blob}
async function deleteWallpaper(){const db=await openWallDB();await new Promise((resolve,reject)=>{const tx=db.transaction(WALL_STORE,'readwrite');tx.objectStore(WALL_STORE).delete(WALL_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close()}
const WALLPAPER_PRESETS={
  dawn:'radial-gradient(circle at 72% 18%,rgba(255,232,198,.82),transparent 24%),linear-gradient(160deg,#9bbbd2 0%,#d8c3b7 48%,#e7b996 100%)',
  forest:'radial-gradient(circle at 55% 18%,rgba(213,238,205,.55),transparent 20%),linear-gradient(155deg,#789b83 0%,#385c50 52%,#1e3b36 100%)',
  night:'radial-gradient(circle at 68% 16%,rgba(142,166,233,.38),transparent 18%),linear-gradient(160deg,#182746 0%,#243d68 55%,#101b35 100%)',
  mountain:'radial-gradient(circle at 46% 22%,rgba(255,255,255,.38),transparent 18%),linear-gradient(155deg,#91afbc 0%,#6c8890 48%,#385e61 100%)',
  cloud:'radial-gradient(circle at 30% 20%,rgba(255,230,230,.88),transparent 28%),linear-gradient(155deg,#9fbdd5 0%,#d3b9c6 48%,#f1c5a8 100%)',
  mist:'radial-gradient(circle at 75% 22%,rgba(255,255,255,.58),transparent 22%),linear-gradient(160deg,#d7e5e7 0%,#b9ced0 52%,#82a9a8 100%)',
};
function markWallpaperPreset(name=''){
  $$('[data-wallpaper-preset]').forEach(btn=>{
    btn.classList.toggle('selected',btn.dataset.wallpaperPreset===name);
  });
}
function applyWallpaperPreset(name){
  const gradient=WALLPAPER_PRESETS[name]||'';
  const layer=$('#wallpaperLayer');
  const preview=$('#wallpaperPreview');
  if(wallpaperObjectURL){
    URL.revokeObjectURL(wallpaperObjectURL);
    wallpaperObjectURL=null;
  }
  layer.style.backgroundImage=gradient;
  if(preview)preview.style.backgroundImage=gradient;
  if(name){
    localStorage.setItem('appearance.preset',name);
  }else{
    localStorage.removeItem('appearance.preset');
  }
  markWallpaperPreset(name);
}
function applyWallpaperBlob(blob){
  if(wallpaperObjectURL)URL.revokeObjectURL(wallpaperObjectURL);
  const preview=$('#wallpaperPreview');
  if(!blob){
    wallpaperObjectURL=null;
    return false;
  }
  wallpaperObjectURL=URL.createObjectURL(blob);
  const image=`url("${wallpaperObjectURL}")`;
  $('#wallpaperLayer').style.backgroundImage=image;
  if(preview)preview.style.backgroundImage=image;
  localStorage.removeItem('appearance.preset');
  markWallpaperPreset('');
  return true;
}
async function loadWallpaper(){
  try{
    const blob=await getWallpaper();
    if(blob){
      applyWallpaperBlob(blob);
      return;
    }
    const preset=localStorage.getItem('appearance.preset')||'dawn';
    applyWallpaperPreset(preset);
  }catch{
    applyWallpaperPreset('dawn');
  }
}
$('#wallpaperInput').addEventListener('change',async e=>{
  const file=e.target.files?.[0];
  if(!file)return;
  if(!file.type.startsWith('image/')){showToast('请选择图片文件');return}
  try{
    await putWallpaper(file);
    applyWallpaperBlob(file);
    showToast('背景壁纸已更新');
  }catch{
    showToast('壁纸保存失败');
  }
});
$$('[data-wallpaper-preset]').forEach(btn=>{
  btn.addEventListener('click',async()=>{
    const preset=btn.dataset.wallpaperPreset;
    try{await deleteWallpaper()}catch(e){}
    applyWallpaperPreset(preset);
    showToast('壁纸已切换');
  });
});
$('#resetWallpaper').addEventListener('click',async()=>{
  try{await deleteWallpaper()}catch(e){}
  localStorage.removeItem('appearance.preset');
  applyWallpaperPreset('dawn');
  showToast('已恢复默认背景');
});
function applyAppearance(){
  const dim=Number(localStorage.getItem('appearance.dim')||8),glass=Number(localStorage.getItem('appearance.glass')||12);
  document.documentElement.style.setProperty('--wallpaper-dim',String(dim/100));
  document.documentElement.style.setProperty('--glass-a',String(glass/100));
  document.documentElement.style.setProperty('--glass-a-strong',String(Math.min(.52,glass/100+.06)));
  const overlay=$('#wallpaperOverlay');
  if(overlay)overlay.style.background=`rgba(228,236,240,${dim/100})`;
  $('#wallpaperDim').value=dim;$('#dimOutput').textContent=`${dim}%`;
  $('#glassOpacity').value=glass;$('#glassOutput').textContent=`${glass}%`;
}
$('#wallpaperDim').addEventListener('input',e=>{localStorage.setItem('appearance.dim',String(e.target.value));applyAppearance()});
$('#glassOpacity').addEventListener('input',e=>{localStorage.setItem('appearance.glass',String(e.target.value));applyAppearance()});

/* ---------- tactile feedback ---------- */
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
  const selector='button,.select-control,.side-item,.choose-wallpaper';
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

/* ---------- init ---------- */
(async function init(){
  applyAppearance();
  loadWallpaper();
  loadConversations();
  state.conversations.forEach(c=>{
    if(c.group&&c.syncUrl)watchGroup(c);
  });
  loadConfig();
  renderProjects();
  renderHistory();
  if(state.conversations.length)loadConversation(state.conversations[0].id);
  else newChat();
})();

window.addEventListener('storage',e=>{
  if(e.key==='ai.clientApi'){
    state.clientApi=getClientApi();
    rebuildModelMenu();
    updateApiBanner();
  }
});
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden){
    state.clientApi=getClientApi();
    rebuildModelMenu();
    updateApiBanner();
  }
});
