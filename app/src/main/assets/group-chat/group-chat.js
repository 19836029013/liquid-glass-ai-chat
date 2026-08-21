(() => {
  const $ = (q, root=document) => root.querySelector(q);
  const $$ = (q, root=document) => [...root.querySelectorAll(q)];

  let bridge=null;
  try{bridge=window.Android||null}catch(e){bridge=null}

  function safeGet(key,fallback=''){try{return localStorage.getItem(key)||fallback}catch(e){return fallback}}
  function loadJSON(key,fallback=null){try{return JSON.parse(localStorage.getItem(key)||'null')??fallback}catch{return fallback}}
  function saveJSON(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch(e){}}
  function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8)}
  function nowISO(){return new Date().toISOString()}
  function escapeHtml(s=''){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
  function normalizeText(v){
    if(v==null)return '';
    if(typeof v==='string')return v;
    if(Array.isArray(v))return v.map(normalizeText).join('');
    if(typeof v==='object'){
      for(const k of ['text','content','output_text']){if(k in v){const t=normalizeText(v[k]);if(t)return t}}
    }
    return '';
  }
  function timeOf(iso){
    try{return new Date(iso).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})}catch{return ''}
  }
  function initials(name){return String(name||'访客').trim().slice(0,2)}
  function showToast(text){
    const t=$('#toast');
    t.textContent=text;
    t.hidden=false;
    clearTimeout(showToast._timer);
    showToast._timer=setTimeout(()=>t.hidden=true,1800);
  }

  const COLORS=['#7594b7','#8aa58b','#b48d9a','#9a8db9','#b79974','#7fa7a2'];
  function colorFor(name){
    let h=0;
    for(const ch of String(name))h=(h*31+ch.codePointAt(0))>>>0;
    return COLORS[h%COLORS.length];
  }

  /* ---------- real state ---------- */
  const convId=new URLSearchParams(location.search).get('conv')||'';
  let conversations=[];
  let projects=[];
  function loadConversations(){
    let raw='';
    try{if(bridge&&bridge.getState)raw=bridge.getState()||''}catch(e){}
    if(!raw)raw=localStorage.getItem('lgchat_convs')||'';
    if(raw&&raw.trim()){
      try{
        const p=JSON.parse(raw);
        conversations=Array.isArray(p)?p:(p.conversations||[]);
        projects=(p&&p.projects)||[];
      }catch(e){conversations=[]}
    }
    if(!Array.isArray(conversations))conversations=[];
  }
  let saveTimer=null;
  function saveConversations(){
    const json=JSON.stringify({conversations,projects});
    try{localStorage.setItem('lgchat_convs',json)}catch(e){}
    if(bridge&&bridge.saveState){
      clearTimeout(saveTimer);
      saveTimer=setTimeout(()=>{try{bridge.saveState(json)}catch(e){}},400);
    }
  }
  let isDraft=false;
  let draftConv=null;
  {
    const d=loadJSON('lgchat_draft',null);
    if(d&&d.id===convId&&!conversations.some(c=>c.id===convId)){
      draftConv=d;
      isDraft=true;
    }
  }
  function conv(){
    if(isDraft)return draftConv;
    return conversations.find(c=>c.id===convId)||null;
  }
  function commit(){
    if(isDraft&&draftConv){
      conversations.push(draftConv);
      isDraft=false;
      try{localStorage.removeItem('lgchat_draft')}catch(e){}
      saveConversations();
    }
  }
  window.addEventListener('pagehide',()=>{
    if(isDraft&&draftConv&&(!draftConv.messages||!draftConv.messages.length)){
      try{localStorage.removeItem('lgchat_draft')}catch(e){}
    }
  });
  const account={
    id:safeGet('account.id')||uid(),
    name:safeGet('account.name')||safeGet('group.nickname')||'我',
  };
  if(!safeGet('account.id')){try{localStorage.setItem('account.id',account.id)}catch(e){}}
  let mentionIntent=false;

  function readClientApi(){
    try{
      if(bridge&&bridge.getConfig){
        const raw=bridge.getConfig();
        if(raw&&raw.trim()){
          const c=JSON.parse(raw);
          if(c.apiBase||c.apiKey||c.model){
            return {base_url:String(c.apiBase||'').trim().replace(/\/+$/,''),api_key:String(c.apiKey||'').trim(),model:String(c.model||'').trim(),reasoning_parameter:String(c.reasoningParam||'').trim(),models:Array.isArray(c.models)?c.models:[]};
          }
        }
      }
    }catch(e){}
    const local=loadJSON('ai.clientApi',null);
    if(local)return {...local,models:Array.isArray(local.models)?local.models:[]};
    return null;
  }
  function getModelIds(){
    const cfg=readClientApi();
    if(!cfg)return [];
    const out=[cfg.model,...(cfg.models||[])];
    return [...new Set(out.filter(Boolean))];
  }

  const state={
    model:safeGet('ai.modelId')||(readClientApi()&&readClientApi().model)||'deepseek-chat',
    reasoning:safeGet('ai.reasoningLevel')||'标准',
    sending:false,
  };

  /* ---------- sync (ntfy long-poll) ---------- */
  const SYNC_BASE='https://ntfy.sh';
  async function pushSync(){
    const c=conv();
    if(!c||!c.syncUrl)return;
    c.updatedAt=Date.now();
    try{
      await fetch(c.syncUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});
    }catch(e){}
  }
  function adoptRemoteMessage(last){
    const c=conv();
    if(!c||!last)return false;
    let remote=null;
    if(last&&typeof last==='object'&&last.message){try{remote=JSON.parse(last.message)}catch(e){}}
    else if(typeof last==='string'){try{remote=JSON.parse(last)}catch(e){}}
    if(!remote||!Array.isArray(remote.messages))return false;
    const localUpdated=Number(c.updatedAt||0);
    const remoteUpdated=Number(remote.updatedAt||0);
    const remoteHasMore=remote.messages.length>c.messages.length;
    if(!(remoteUpdated>localUpdated||remoteHasMore))return false;
    const before=c.messages.length;
    c.title=remote.title||c.title;
    c.messages=remote.messages;
    c.members=remote.members||c.members;
    c.updatedAt=remoteUpdated||Date.now();
    const lastMsg=remote.messages[remote.messages.length-1];
    if(lastMsg&&lastMsg.role==='user'&&lastMsg.authorName&&lastMsg.authorName!==account.name&&c.notifiedId!==lastMsg.id){
      if(bridge&&bridge.notifyGroupMessage){
        bridge.notifyGroupMessage(String(lastMsg.authorName),String(normalizeText(lastMsg.content)).slice(0,120));
      }
    }
    c.notifiedId=lastMsg?lastMsg.id:null;
    c.syncSince=last.id||c.syncSince;
    saveConversations();
    if(remote.messages.length>before)showToast('收到新消息');
    renderAll();
    return true;
  }
  async function fetchRecent(){
    const c=conv();
    if(!c||!c.syncUrl)return;
    try{
      const res=await fetch(c.syncUrl+'/json');
      if(!res.ok)return;
      const arr=await res.json();
      if(Array.isArray(arr)&&arr.length)adoptRemoteMessage(arr[arr.length-1]);
    }catch(e){}
  }
  async function watchGroup(){
    const c=conv();
    if(!c||!c.syncUrl||c._watching)return;
    c._watching=true;
    while(conv()&&c.group&&c.syncUrl){
      try{
        const url=c.syncUrl+(c.syncSince?'?poll=1&since='+c.syncSince:'');
        const res=await fetch(url);
        if(res.ok){
          const arr=await res.json();
          if(Array.isArray(arr)&&arr.length)adoptRemoteMessage(arr[arr.length-1]);
        }
      }catch(e){}
      await new Promise(r=>setTimeout(r,3000));
    }
  }

  /* ---------- render ---------- */
  function otherMembers(){
    const c=conv();
    return (c&&c.members||[]).filter(m=>m.id!=='friend'&&m.id!==account.id);
  }
  function renderMembers(){
    const c=conv();
    const members=(c&&c.members||[]).filter(m=>m.id!=='friend');
    const humans=members.length||1;
    $('#memberCount').textContent=`${humans} 人 · 1 个 AI`;
    $('#avatarStack').innerHTML=members.slice(0,4).map(m=>{
      const isSelf=m.id===account.id;
      return `<div class="member-avatar" style="background:${colorFor(m.name||'成员')}">${escapeHtml(initials(m.name||'成员'))}${isSelf?'<i class="self-dot"></i>':''}</div>`;
    }).join('');
    $('#memberNames').textContent=members.map(m=>m.name+(m.id===account.id?'（我）':'')).join('、')||'等待成员加入';
    const others=members.filter(m=>m.id!==account.id);
    $('#memberGrid').innerHTML=others.length
      ? others.map(m=>`
          <div class="member-card">
            <div class="member-avatar" style="background:${colorFor(m.name||'成员')}">${escapeHtml(initials(m.name||'成员'))}</div>
            <strong>${escapeHtml(m.name||'成员')}</strong>
            <small>已加入</small>
          </div>`).join('')
      : '<div class="member-empty">还没有其他成员加入，点下方邀请朋友</div>';
  }
  function decorateMentions(text){
    return escapeHtml(text).replaceAll('@AI','<span class="mention">@AI</span>').replaceAll('\n','<br>');
  }
  function renderMessages(){
    const c=conv();
    const msgs=c&&c.messages||[];
    $('#messageList').innerHTML=msgs.map(m=>{
      if(m.role==='assistant'){
        return `
          <article class="message ai" data-mid="${m.id}">
            <div class="message-avatar ai">✦</div>
            <div class="message-body">
              <div class="message-name"><span>AI 助手</span><span class="model-chip">${escapeHtml(m.model||state.model)}</span></div>
              <div class="bubble">${decorateMentions(normalizeText(m.content))||'<span class="typing-spark">✦</span>'}</div>
              <div class="message-meta">${timeOf(m.created_at)}</div>
            </div>
          </article>`;
      }
      const mine=m.authorId===account.id;
      const nameRow=mine?'':`<div class="message-name"><span>${escapeHtml(m.authorName||'成员')}</span></div>`;
      return `
        <article class="message ${mine?'mine':''}" data-mid="${m.id}">
          <div class="message-avatar" style="background:${colorFor(m.authorName||'成员')}">${escapeHtml(initials(m.authorName||'成员'))}</div>
          <div class="message-body">
            ${nameRow}
            <div class="bubble">${decorateMentions(normalizeText(m.content))}</div>
            <div class="message-meta">${timeOf(m.created_at)} ${mine?'<span class="checks">✓✓</span>':''}</div>
          </div>
        </article>`;
    }).join('')||'<div class="ai-status">还没有消息，发一条试试；@AI 可以让英子参与讨论</div>';
    requestAnimationFrame(()=>{const s=$('#chatScroll');s.scrollTop=s.scrollHeight});
  }
  function renderAll(){
    const c=conv();
    if(!c)return;
    $('#groupTitle').textContent=c.title||'群聊';
    renderMembers();
    renderMessages();
    $('#modelValue').textContent=state.model;
    $('#reasoningValue').textContent=state.reasoning;
  }

  /* ---------- sheets ---------- */
  function openSheet(id){
    $('#sheetScrim').hidden=false;
    $$('.bottom-sheet').forEach(s=>s.hidden=true);
    $(id).hidden=false;
  }
  function closeSheets(){
    $('#sheetScrim').hidden=true;
    $$('.bottom-sheet').forEach(s=>s.hidden=true);
  }
  function renderModelOptions(){
    const models=getModelIds();
    $('#modelOptions').innerHTML=models.map(id=>`
      <button class="sheet-option ${id===state.model?'active':''}" data-model="${id}">
        <span class="sheet-option-icon">${id===state.model?'✓':'◇'}</span>
        <span><strong>${escapeHtml(id)}</strong><small>来自你的 API 模型列表</small></span>
        <span class="sheet-check">${id===state.model?'✓':''}</span>
      </button>
    `).join('')||'<div class="member-empty">暂无模型，请先在设置里查询模型</div>';
    $$('[data-model]').forEach(btn=>btn.addEventListener('click',()=>{
      state.model=btn.dataset.model;
      localStorage.setItem('ai.modelId',state.model);
      $('#modelValue').textContent=state.model;
      renderModelOptions();
      closeSheets();
    }));
  }
  function renderReasoningOptions(){
    const levels=['简洁','标准','深入','最高'];
    $('#reasoningOptions').innerHTML=levels.map(id=>`
      <button class="sheet-option ${id===state.reasoning?'active':''}" data-reasoning="${id}">
        <span class="sheet-option-icon">${id===state.reasoning?'✓':'✦'}</span>
        <span><strong>${id}</strong><small>思考等级</small></span>
        <span class="sheet-check">${id===state.reasoning?'✓':''}</span>
      </button>
    `).join('');
    $$('[data-reasoning]').forEach(btn=>btn.addEventListener('click',()=>{
      state.reasoning=btn.dataset.reasoning;
      localStorage.setItem('ai.reasoningLevel',state.reasoning);
      $('#reasoningValue').textContent=state.reasoning;
      renderReasoningOptions();
      closeSheets();
    }));
  }
  function renderInvite(){
    const c=conv();
    if(!c)return;
    commit();
    if(!c.syncUrl){
      c.syncUrl=SYNC_BASE+'/whale-girl-'+uid().slice(0,10);
      saveConversations();
      pushSync();
    }
    const topic=c.syncUrl.replace(/\/+$/,'').split('/').pop();
    $('#inviteLink').textContent='yingzi://join/'+topic;
  }

  /* ---------- composer / send ---------- */
  function autosize(){
    const el=$('#messageInput');
    el.style.height='auto';
    el.style.height=Math.min(120,el.scrollHeight)+'px';
  }
  function insertMention(){
    const input=$('#messageInput');
    const prefix=input.value&&!input.value.endsWith(' ')?' ':'';
    input.value+=prefix+'@AI ';
    mentionIntent=true;
    input.focus();
    autosize();
  }
  function asksAI(text){
    if(mentionIntent)return true;
    return /@\s*(ai|英子|起飞|deepseek|ds|机器人|助手)/i.test(text||'');
  }

  let pendingStream=null;
  function apiUrl(cfg){return (cfg.base_url||'https://api.deepseek.com').replace(/\/+$/,'')+'/chat/completions'}
  function buildPayload(cfg,messages){
    const payload={model:cfg.model,messages,stream:true};
    const isV4=(cfg.base_url||'').toLowerCase().includes('api.deepseek.com')&&String(cfg.model||'').toLowerCase().startsWith('deepseek-v4');
    if(isV4){
      if(state.reasoning==='简洁')payload.thinking={type:'disabled'};
      else{payload.thinking={type:'enabled'};payload.reasoning_effort=state.reasoning==='最高'?'max':'high'}
    }else if(cfg.reasoning_parameter){
      const map={'简洁':'low','标准':'medium','深入':'high','最高':'high'};
      payload[cfg.reasoning_parameter]=map[state.reasoning]||'medium';
    }
    return payload;
  }
  function streamChat(cfg,messages,handlers){
    return new Promise((resolve,reject)=>{
      if(bridge&&bridge.streamChat){
        pendingStream={resolve,reject,handlers};
        bridge.streamChat(JSON.stringify({url:apiUrl(cfg),apiKey:cfg.api_key,payload:buildPayload(cfg,messages)}));
      }else{
        reject(new Error('原生桥接不可用'));
      }
    });
  }
  function handleEvent(name,data){
    if(typeof data==='string'){try{data=JSON.parse(data)}catch(e){data={}}}
    if(name==='error'&&pendingStream){const p=pendingStream;pendingStream=null;p.reject(new Error((data&&data.message)||'请求失败'));return}
    if(name==='done'&&pendingStream){const p=pendingStream;pendingStream=null;try{if(p.handlers.done)p.handlers.done()}catch(e){}p.resolve();return}
    if(pendingStream&&pendingStream.handlers&&pendingStream.handlers[name]){
      let payload=data;
      if(name==='delta')payload=(data&&data.text)||'';
      try{pendingStream.handlers[name](payload)}catch(e){}
    }
  }
  window.AndroidEvents={onEvent:handleEvent};

  async function sendMessage(){
    const c=conv();
    if(!c)return;
    const input=$('#messageInput');
    const text=input.value.trim();
    if(!text)return;
    commit();
    const cfg=readClientApi();
    try{
      if(!c.syncUrl){
        c.syncUrl=SYNC_BASE+'/whale-girl-'+uid().slice(0,10);
        saveConversations();
        watchGroup();
      }
    }catch(e){}
    const mentions=asksAI(text)?[{type:'ai',target_id:'ai'}]:[];
    const userMsg={id:uid(),role:'user',content:text,authorId:account.id,authorName:account.name,mentions,created_at:nowISO()};
    try{
      if(!c.members||!Array.isArray(c.members))c.members=[];
      if(!c.members.some(m=>m.id===account.id))c.members.push({id:account.id,name:account.name});
      const member=c.members.find(m=>m.id===account.id);
      if(member)member.name=account.name;
      c.messages.push(userMsg);
    }catch(e){
      showToast('发送失败：'+(e.message||'未知错误'));
      return;
    }
    input.value='';mentionIntent=false;autosize();
    try{saveConversations()}catch(e){}
    renderAll();
    showToast('已发送');
    try{await fetchRecent()}catch(e){}
    try{await pushSync()}catch(e){}
    if(!mentions.length||!cfg)return;
    const assistantMsg={id:uid(),role:'assistant',content:'',model:state.model,created_at:nowISO()};
    c.messages.push(assistantMsg);
    $('#typingIndicator').hidden=false;
    renderMessages();
    state.sending=true;
    const history=c.messages.filter(m=>m!==assistantMsg&&m.content)
      .map(m=>({role:m.role,content:normalizeText(m.content)}));
    try{
      await streamChat({...cfg,model:state.model},history,{
        delta(t){
          assistantMsg.content+=t;
          const turn=$(`[data-mid="${assistantMsg.id}"]`);
          const bubble=turn&&$('.bubble',turn);
          if(bubble)bubble.innerHTML=decorateMentions(normalizeText(assistantMsg.content));
          const s=$('#chatScroll');s.scrollTop=s.scrollHeight;
        },
        done(){},
      });
    }catch(e){
      assistantMsg.content=assistantMsg.content||'（生成失败：'+(e.message||'未知错误')+'）';
      showToast(e.message||'生成失败');
    }finally{
      assistantMsg.created_at=nowISO();
      state.sending=false;
      $('#typingIndicator').hidden=true;
      saveConversations();
      renderAll();
      await pushSync();
    }
  }

  /* ---------- events ---------- */
  $('#menuButton').addEventListener('click',()=>{location.href='../index.html'});
  $('#groupInfoButton').addEventListener('click',()=>{renderMembers();openSheet('#memberSheet')});
  $('#memberDetailsButton').addEventListener('click',()=>{renderMembers();openSheet('#memberSheet')});
  $('#inviteButton').addEventListener('click',()=>{renderInvite();openSheet('#inviteSheet')});
  $('#copyInviteButton').addEventListener('click',()=>{
    const link=$('#inviteLink').textContent;
    const fallback=()=>{const ta=document.createElement('textarea');ta.value=link;document.body.appendChild(ta);ta.select();try{document.execCommand('copy')}catch(e){}ta.remove();showToast('已复制邀请链接')};
    if(navigator.clipboard)navigator.clipboard.writeText(link).then(()=>showToast('已复制邀请链接')).catch(fallback);
    else fallback();
  });
  $('#modelSelector').addEventListener('click',()=>{renderModelOptions();openSheet('#modelSheet')});
  $('#reasoningSelector').addEventListener('click',()=>{renderReasoningOptions();openSheet('#reasoningSheet')});
  $('#mentionAiButton').addEventListener('click',insertMention);
  $('#sendButton').addEventListener('click',sendMessage);
  $('#messageInput').addEventListener('input',autosize);
  $('#messageInput').addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}
  });
  $('#sheetScrim').addEventListener('click',closeSheets);
  $$('[data-close-sheet]').forEach(b=>b.addEventListener('click',closeSheets));

  /* ---------- boot ---------- */
  loadConversations();
  if(!conv()){
    showToast('群聊不存在');
    setTimeout(()=>{location.href='../index.html'},1200);
    return;
  }
  renderAll();
  watchGroup();
})();
