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
    if(!c||!c.syncUrl)return false;
    c.updatedAt=Date.now();
    try{
      await fetch(c.syncUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});
      return true;
    }catch(e){}
    return false;
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
    return escapeHtml(text).replace(/@[^\s@]+/g,'<span class="mention">$&</span>').replaceAll('\n','<br>');
  }
  function formatSize(n){
    if(!n)return '';
    if(n<1024)return n+' B';
    if(n<1024*1024)return (n/1024).toFixed(1)+' KB';
    return (n/1024/1024).toFixed(1)+' MB';
  }
  function renderMessages(){
    const c=conv();
    const msgs=c&&c.messages||[];
    $('#messageList').innerHTML=msgs.map(m=>{
      let bubbleContent=decorateMentions(normalizeText(m.content));
      if(m.attachment){
        const isImg=String(m.attachment.type||'').startsWith('image/');
        const imgSrc=m.attachment.localUrl||m.attachment.url||'';
        bubbleContent=isImg
          ? `<img class="attach-img" src="${escapeHtml(imgSrc)}" data-full="${escapeHtml(m.attachment.url||imgSrc)}" loading="lazy" alt="图片" />`
          : `<div class="file-card" data-url="${escapeHtml(m.attachment.url)}"><span class="file-icon">📄</span><span class="file-copy"><strong>${escapeHtml(m.attachment.name||'文件')}</strong><small>${formatSize(m.attachment.size)}</small></span></div>`;
      }
      if(m.role==='assistant'){
        return `
          <article class="message ai" data-mid="${m.id}">
            <div class="message-avatar ai">✦</div>
            <div class="message-body">
              <div class="message-name"><span>AI 助手</span><span class="model-chip">${escapeHtml(m.model||state.model)}</span></div>
              <div class="bubble">${bubbleContent||'<span class="typing-spark">✦</span>'}</div>
              <div class="message-meta">${timeOf(m.created_at)}</div>
            </div>
          </article>`;
      }
      const mine=m.authorId===account.id;
      let sendState='';
      if(mine){
        if(m.status==='sending')sendState='<span class="send-state sending">⟳</span>';
        else if(m.status==='error')sendState='<span class="send-state error" data-retry="'+m.id+'">!</span>';
        else sendState='<span class="checks">✓✓</span>';
      }
      const nameRow=mine?'':`<div class="message-name"><span>${escapeHtml(m.authorName||'成员')}</span></div>`;
      return `
        <article class="message ${mine?'mine':''}" data-mid="${m.id}">
          <div class="message-avatar" style="background:${colorFor(m.authorName||'成员')}">${escapeHtml(initials(m.authorName||'成员'))}</div>
          <div class="message-body">
            ${nameRow}
            <div class="bubble">${bubbleContent}</div>
            <div class="message-meta">${timeOf(m.created_at)} ${sendState}</div>
          </div>
        </article>`;
    }).join('')||'<div class="ai-status">还没有消息，发一条试试；@AI 可以让英子参与讨论</div>';
    requestAnimationFrame(()=>{const s=$('#chatScroll');s.scrollTop=s.scrollHeight});
  }
  document.addEventListener('click',e=>{
    const img=e.target.closest('.attach-img');
    if(img){
      $('#imageViewerImg').src=img.dataset.full||img.src;
      $('#imageViewer').hidden=false;
      return;
    }
    if(e.target.closest('#imageViewer')){
      $('#imageViewer').hidden=true;
      $('#imageViewerImg').src='';
      return;
    }
    const card=e.target.closest('.file-card');
    if(card&&card.dataset.url&&bridge&&bridge.openUrl){
      bridge.openUrl(card.dataset.url);
    }
    const retry=e.target.closest('[data-retry]');
    if(retry)retryMessage(retry.dataset.retry);
  });
  $('#imageViewerClose').addEventListener('click',()=>{$('#imageViewer').hidden=true;$('#imageViewerImg').src=''});
  async function retryMessage(id){
    const c=conv();
    if(!c)return;
    const msg=c.messages.find(m=>m.id===id);
    if(!msg||msg.role!=='user')return;
    msg.status='sending';
    renderMessages();
    try{
      if(!c.syncUrl){
        c.syncUrl=SYNC_BASE+'/whale-girl-'+uid().slice(0,10);
        saveConversations();
        watchGroup();
      }
      if(msg.attachment&&msg.attachment.local){
        const remote=await uploadAttachment(c,{name:msg.attachment.name,type:msg.attachment.type,size:msg.attachment.size});
        msg.attachment={...msg.attachment,url:remote.url,local:false};
        if(pendingPreviewUrl){try{URL.revokeObjectURL(pendingPreviewUrl)}catch(e){}}
        pendingPreviewUrl=null;
        pendingFile=null;
      }
      msg.status=(await pushSync())?'sent':'error';
    }catch(e){
      msg.status='error';
    }
    try{saveConversations()}catch(e){}
    renderAll();
    if(msg.status==='error')showToast('发送失败，点红色感叹号重试');
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
  function buildMentions(text){
    const m=[];
    if(mentionIntent||/@\s*(ai|英子|起飞|deepseek|ds|机器人|助手)/i.test(text||''))m.push({type:'ai',target_id:'ai'});
    otherMembers().forEach(x=>{
      const name=String(x.name||'');
      if(name&&new RegExp('@'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(text||'')){
        m.push({type:'member',target_id:x.id,name});
      }
    });
    return m;
  }
  function refreshMentionMenu(){
    const input=$('#messageInput');
    const v=input.value;
    const menu=$('#mentionMenu');
    const at=v.lastIndexOf('@');
    const typing=at>=0&&v.slice(at).trim()==='@';
    if(!typing){menu.hidden=true;return}
    const others=otherMembers();
    menu.innerHTML=`<button type="button" data-mention="ai"><span class="mention-avatar ai-avatar">✦</span><span><strong>@AI 助手</strong><small>只有 @AI 时 AI 才会参与回复</small></span></button>`
      +others.map(m=>`<button type="button" data-mention="${escapeHtml(m.id)}"><span class="mention-avatar" style="background:${colorFor(m.name||'成员')}">${escapeHtml(initials(m.name||'成员'))}</span><span><strong>@${escapeHtml(m.name||'成员')}</strong><small>@ 群友</small></span></button>`).join('');
    menu.hidden=false;
    menu.querySelectorAll('[data-mention]').forEach(b=>b.addEventListener('click',()=>{
      const id=b.dataset.mention;
      const name=id==='ai'?'AI':(others.find(x=>x.id===id)||{name:'群友'}).name;
      input.value=v.slice(0,at)+'@'+name+' ';
      if(id==='ai')mentionIntent=true;
      input.focus();
      autosize();
      menu.hidden=true;
    }));
  }
  async function uploadAttachment(c,file){
    if(!c.syncUrl){
      c.syncUrl=SYNC_BASE+'/whale-girl-'+uid().slice(0,10);
      saveConversations();
      watchGroup();
    }
    const res=await fetch(c.syncUrl,{
      method:'PUT',
      headers:{'Content-Type':file.type||'application/octet-stream','Filename':file.name},
      body:file,
    });
    if(!res.ok)throw new Error('上传失败 HTTP '+res.status);
    const j=await res.json();
    const att=j.attachment||{};
    let url=att.url||'';
    if(url.startsWith('/'))url=SYNC_BASE+url;
    return {url,type:file.type||'',name:file.name||'file',size:file.size||0};
  }
  let pendingFile=null;
  let pendingPreviewUrl=null;
  function renderAttachmentPreview(){
    const wrap=$('#attachPreview');
    if(!pendingFile){wrap.hidden=true;wrap.innerHTML='';return}
    const isImg=String(pendingFile.type||'').startsWith('image/');
    if(isImg&&!pendingPreviewUrl){
      try{pendingPreviewUrl=URL.createObjectURL(pendingFile)}catch(e){}
    }
    wrap.innerHTML=(isImg&&pendingPreviewUrl)
      ? `<img src="${pendingPreviewUrl}" alt="预览" /><button id="removeAttachment" type="button">×</button>`
      : `<div class="preview-file"><span class="file-icon">📄</span><span class="file-copy"><strong>${escapeHtml(pendingFile.name||'文件')}</strong><small>${formatSize(pendingFile.size)}</small></span><button id="removeAttachment" type="button">×</button></div>`;
    wrap.hidden=false;
    $('#removeAttachment').addEventListener('click',clearPendingAttachment);
  }
  function clearPendingAttachment(){
    if(pendingPreviewUrl){try{URL.revokeObjectURL(pendingPreviewUrl)}catch(e){}}
    pendingFile=null;
    pendingPreviewUrl=null;
    renderAttachmentPreview();
  }
  function pickAttachment(file){
    clearPendingAttachment();
    pendingFile=file;
    renderAttachmentPreview();
    $('#messageInput').focus();
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
    if(!text&&!pendingFile)return;
    commit();
    const cfg=readClientApi();
    try{
      if(!c.syncUrl){
        c.syncUrl=SYNC_BASE+'/whale-girl-'+uid().slice(0,10);
        saveConversations();
        watchGroup();
      }
    }catch(e){}
    const mentions=buildMentions(text);
    let attachment=null;
    if(pendingFile){
      attachment={url:pendingPreviewUrl||'',localUrl:pendingPreviewUrl||'',type:pendingFile.type||'',name:pendingFile.name||'file',size:pendingFile.size||0,local:true};
    }
    const userMsg={id:uid(),role:'user',content:text,authorId:account.id,authorName:account.name,mentions,attachment,status:'sending',created_at:nowISO()};
    if(pendingFile)$('#attachPreview').hidden=true;
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
    (async()=>{
      try{
        if(attachment&&attachment.local){
          const remote=await uploadAttachment(c,{name:attachment.name,type:attachment.type,size:attachment.size});
          userMsg.attachment={...attachment,url:remote.url,local:false};
          pendingPreviewUrl=null;
          pendingFile=null;
        }
        userMsg.status=(await pushSync())?'sent':'error';
      }catch(e){
        userMsg.status='error';
      }
      try{saveConversations()}catch(e){}
      renderAll();
      if(userMsg.status==='error')showToast('发送失败，点红色感叹号重试');
    })();
    if(!mentions.length||!cfg)return;
    const assistantMsg={id:uid(),role:'assistant',content:'',model:state.model,created_at:nowISO()};
    c.messages.push(assistantMsg);
    $('#typingIndicator').hidden=false;
    renderMessages();
    state.sending=true;
    const visionEnabled=safeGet('ai.visionEnabled','1')!=='0';
    const imageMsgs=c.messages.filter(m=>m.attachment&&String(m.attachment.type||'').startsWith('image/'));
    const recentImages=new Set(imageMsgs.slice(-3).map(m=>m.id));
    const history=[];
    let hasImageContext=false;
    c.messages.forEach(m=>{
      if(m===assistantMsg)return;
      if(m.attachment&&String(m.attachment.type||'').startsWith('image/')){
        if(visionEnabled&&recentImages.has(m.id)){
          history.push({role:'user',content:[{type:'image_url',image_url:{url:m.attachment.url}}]});
          hasImageContext=true;
        }
      }else if(m.content){
        history.push({role:m.role,content:normalizeText(m.content)});
      }
    });
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
      let hint=e.message||'生成失败';
      if(hasImageContext&&!/image/i.test(hint))hint+='；模型可能不支持图片，请在设置里切换视觉模型（千问/GLM）';
      showToast(hint);
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
  $('#menuButton').addEventListener('click',()=>{location.href='../index.html?openSidebar=1&conv='+encodeURIComponent(convId)});
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
  $('#plusButton').addEventListener('click',e=>{
    e.stopPropagation();
    const menu=$('#attachMenu');
    menu.hidden=!menu.hidden;
  });
  $('#attachImageOption').addEventListener('click',()=>{$('#attachMenu').hidden=true;$('#imageInput').click()});
  $('#attachFileOption').addEventListener('click',()=>{$('#attachMenu').hidden=true;$('#fileInput').click()});
  document.addEventListener('click',()=>{$('#attachMenu').hidden=true});

  /* ---------- emoji / sticker panel ---------- */
  const EMOJIS=['😀','😂','🤣','😊','😍','😘','😎','🤔','😅','😭','😡','👍','👎','👏','🙏','💪','❤️','🔥','🎉','✨','🤝','🍉'];
  function loadStickers(){try{return JSON.parse(localStorage.getItem('app.stickers')||'[]')}catch(e){return []}}
  function saveStickers(list){try{localStorage.setItem('app.stickers',JSON.stringify(list))}catch(e){}}
  let stickerManage=false;
  function renderStickerPanel(){
    const panel=$('#stickerPanel');
    const stickers=loadStickers();
    panel.innerHTML=`
      <div class="sticker-manage-bar">
        <button type="button" id="stickerAdd">＋ 添加贴纸</button>
        <button type="button" id="stickerManage">${stickerManage?'完成':'管理'}</button>
      </div>
      <div class="sticker-grid">
        ${EMOJIS.map(e=>`<button type="button" class="emoji-item" data-emoji="${e}">${e}</button>`).join('')}
        ${stickers.map(s=>`
          <span class="sticker-item-wrap">
            <img class="sticker-item" src="${s.url}" data-sticker="${s.id}" alt="贴纸" />
            ${stickerManage?`<button type="button" class="sticker-del" data-del="${s.id}">×</button>`:''}
          </span>`).join('')}
      </div>`;
    panel.hidden=false;
    $('#stickerAdd').addEventListener('click',()=>$('#stickerImageInput').click());
    $('#stickerManage').addEventListener('click',()=>{stickerManage=!stickerManage;renderStickerPanel()});
    panel.querySelectorAll('[data-emoji]').forEach(b=>b.addEventListener('click',()=>{
      panel.hidden=true;
      const input=$('#messageInput');
      input.value=b.dataset.emoji;
      mentionIntent=false;
      sendMessage();
    }));
    panel.querySelectorAll('[data-sticker]').forEach(img=>img.addEventListener('click',()=>{
      panel.hidden=true;
      sendStickerImage(img.dataset.sticker);
    }));
    panel.querySelectorAll('[data-del]').forEach(b=>b.addEventListener('click',()=>{
      const list=loadStickers().filter(s=>s.id!==b.dataset.del);
      saveStickers(list);
      renderStickerPanel();
    }));
  }
  function sendStickerImage(id){
    const s=loadStickers().find(x=>x.id===id);
    if(!s)return;
    fetch(s.url).then(r=>r.blob()).then(blob=>{
      const file=new File([blob],'sticker.png',{type:'image/png'});
      pickAttachment(file);
      sendMessage();
    }).catch(()=>showToast('贴纸读取失败'));
  }
  $('#emojiButton').addEventListener('click',e=>{
    e.stopPropagation();
    const panel=$('#stickerPanel');
    if(panel.hidden){renderStickerPanel()}else{panel.hidden=true}
  });
  document.addEventListener('click',e=>{const p=$('#stickerPanel');if(p&&!p.hidden&&!p.contains(e.target))p.hidden=true});
  $('#stickerImageInput').addEventListener('change',e=>{
    const f=e.target.files&&e.target.files[0];
    e.target.value='';
    if(!f)return;
    if(f.size>400*1024){showToast('贴纸建议小于 400KB');return}
    const reader=new FileReader();
    reader.onload=()=>{
      const list=loadStickers();
      if(list.length>=30){showToast('贴纸最多 30 个');return}
      list.push({id:uid(),url:reader.result,created_at:nowISO()});
      saveStickers(list);
      renderStickerPanel();
    };
    reader.readAsDataURL(f);
  });
  $('#imageInput').addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];e.target.value='';if(f)pickAttachment(f)});
  $('#fileInput').addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];e.target.value='';if(f)pickAttachment(f)});
  $('#sendButton').addEventListener('click',sendMessage);
  $('#messageInput').addEventListener('input',()=>{autosize();refreshMentionMenu()});
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
