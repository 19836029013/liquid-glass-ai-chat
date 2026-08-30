(() => {
  const $ = (q, root=document) => root.querySelector(q);
  const $$ = (q, root=document) => [...root.querySelectorAll(q)];

  let bridge=null;
  try{bridge=window.AndroidRemote||window.Android||null}catch(e){bridge=null}

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
  const queryParams=new URLSearchParams(location.search);
  const convId=queryParams.get('conv')||'';
  const previewMode=queryParams.get('preview')==='1';
  let conversations=[];
  let projects=[];
  const GROUP_STORAGE_KEY='dsh.group.conversations.v1';
  function loadConversations(){
    let raw='';
    try{raw=localStorage.getItem(GROUP_STORAGE_KEY)||''}catch(e){}
    // Migrate only group records from the pre-shell store. API credentials and
    // ordinary chats never enter this payload.
    if(!raw){
      try{
        const legacy=JSON.parse(localStorage.getItem('lgchat_convs')||'null');
        const legacyGroups=(Array.isArray(legacy)?legacy:(legacy&&legacy.conversations)||[]).filter(c=>c&&c.group);
        if(legacyGroups.length){
          raw=JSON.stringify({conversations:legacyGroups,projects:[]});
          localStorage.setItem(GROUP_STORAGE_KEY,raw);
        }
      }catch(e){}
    }
    if(raw&&raw.trim()){
      try{
        const p=JSON.parse(raw);
        conversations=(Array.isArray(p)?p:(p&&p.conversations)||[]).filter(c=>c&&c.group);
        projects=(p&&p.projects)||[];
      }catch(e){conversations=[]}
    }
    if(!Array.isArray(conversations))conversations=[];
  }
  let saveTimer=null;
  function saveConversations(){
    const json=JSON.stringify({conversations,projects});
    try{localStorage.setItem(GROUP_STORAGE_KEY,json)}catch(e){}
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
  function notifyShell(type,detail={}){try{if(window.parent&&window.parent!==window)window.parent.postMessage({type,...detail},'*')}catch(e){}}
  function setSyncConfig(base,token){
    const clean=String(base||'').trim().replace(/\/+$/,'');
    if(clean)try{localStorage.setItem('sync.serverBase',clean)}catch(e){}
    if(token!=null)try{localStorage.setItem('sync.serverToken',String(token||'').trim())}catch(e){}
    return clean;
  }
  window.addEventListener('message',e=>{
    const data=e&&e.data;
    if(!data||data.type!=='dsh-sync-config')return;
    const base=setSyncConfig(data.base||'',data.token||'');
    const c=conv();
    if(c&&c.group){
      const topic=topicFromSyncUrl(c.syncUrl||'');
      if(base&&topic){c.syncUrl=base+'/api/'+encodeURIComponent(topic);c.syncWs=wsUrlFromBase(base,topic);saveConversations();watchGroup();}
      else if(!base){c.syncUrl='';c.syncWs='';saveConversations();}
    }
  });
  function parseJoinLink(raw){
    const value=String(raw||'').trim();
    if(!value)return null;
    try{
      const normalized=value.startsWith('yingzi://')?value.replace(/^yingzi:\/\//,'https://'):value;
      const u=new URL(normalized);
      const path=u.pathname.split('/').filter(Boolean);
      const topic=decodeURIComponent(path[path.length-1]||u.hostname||'');
      const params=u.searchParams;
      return {topic,base:params.get('server')||'',token:params.get('key')||''};
    }catch(e){
      const match=value.match(/join\/([^?&#]+)/i);
      return match?{topic:decodeURIComponent(match[1]),base:'',token:''}:null;
    }
  }
  function createGroupConversation(){
    const title=String(window.prompt('群聊名称','项目讨论群')||'').trim();
    if(!title)return;
    const base=setSyncConfig(window.prompt('同步服务器地址',getSyncBase())||getSyncBase(),window.prompt('同步密钥（可留空）',getSyncToken()));
    if(!base){showToast('请填写同步服务器地址');return;}
    const id='group-'+uid();
    const item={id,title,group:true,messages:[],members:[{id:account.id,name:account.name}],created_at:nowISO(),updatedAt:Date.now()};
    conversations.unshift(item);isDraft=false;draftConv=null;saveConversations();
    location.href='index.html?conv='+encodeURIComponent(id);
  }
  function joinGroupConversation(rawValue=''){
    const parsed=parseJoinLink(rawValue||window.prompt('粘贴群聊邀请链接','')||'');
    if(!parsed||!parsed.topic){showToast('邀请链接无效');return;}
    const base=setSyncConfig(parsed.base||getSyncBase(),parsed.token||getSyncToken());
    if(!base){showToast('邀请链接缺少服务器地址');return;}
    const existing=conversations.find(c=>c.group&&topicFromSyncUrl(c.syncUrl||'')===parsed.topic);
    const item=existing||{id:'group-'+parsed.topic+'-'+uid().slice(-5),title:'群聊',group:true,messages:[],members:[],created_at:nowISO(),updatedAt:Date.now()};
    item.syncUrl=base+'/api/'+encodeURIComponent(parsed.topic);item.syncWs=wsUrlFromBase(base,parsed.topic);
    if(!item.members.some(m=>m.id===account.id))item.members.push({id:account.id,name:account.name});
    if(!existing)conversations.unshift(item);saveConversations();
    location.href='index.html?conv='+encodeURIComponent(item.id);
  }
  window.handleGroupJoinLink=joinGroupConversation;

  function readClientApi(){
    try{
      if(bridge&&bridge.getApiConfig){
        const raw=bridge.getApiConfig();
        if(raw&&raw.trim()){
          const c=JSON.parse(raw);
          if(c.base_url||c.api_key||c.model){
            const remembered=loadJSON('deepseek.chat.api.models.v1',[]);
            return {base_url:String(c.base_url||'').trim().replace(/\/+$/,''),api_key:String(c.api_key||'').trim(),model:String(c.model||'').trim(),reasoning_parameter:String(c.reasoning_parameter||'').trim(),models:[...(Array.isArray(c.models)?c.models:[]),...(Array.isArray(remembered)?remembered:[])],effort:String(c.effort||'auto')};
          }
        }
      }
    }catch(e){}
    const local=loadJSON('deepseek.chat.api.v1',null)||loadJSON('ai.clientApi',null);
    if(local){
      const remembered=loadJSON('deepseek.chat.api.models.v1',[]);
      return {...local,models:[...(Array.isArray(local.models)?local.models:[]),...(Array.isArray(remembered)?remembered:[])]};
    }
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
    reasoning:safeGet('ai.reasoningLevel')||(({high:'深入',max:'最高'}[(readClientApi()||{}).effort]||'自动')),
    sending:false,
  };
  function persistClientSelection(){
    const cfg=readClientApi();
    if(!cfg)return;
    cfg.model=state.model;
    cfg.effort=state.reasoning==='最高'?'max':state.reasoning==='深入'?'high':state.reasoning==='简洁'?'low':'auto';
    try{localStorage.setItem('deepseek.chat.api.v1',JSON.stringify(cfg));bridge&&bridge.saveApiConfig&&bridge.saveApiConfig(JSON.stringify(cfg))}catch(e){}
  }

  /* ---------- sync (self-hosted server + WebSocket) ---------- */
  function getSyncBase(){
    const v=(safeGet('sync.serverBase')||'').trim().replace(/\/+$/,'');
    return v;
  }
  function getSyncToken(){return (safeGet('sync.serverToken')||'').trim()}
  function syncHeaders(){const token=getSyncToken();return token?{'X-Sync-Token':token}:{}}
  function wsUrlFromBase(base,topic){
    const b=String(base||'').replace(/\/+$/,'');
    const proto=/^https:\/\//i.test(b)?'wss://':'ws://';
    const token=getSyncToken();
    const qs=token?'?key='+encodeURIComponent(token):'';
    return proto+b.replace(/^https?:\/\//i,'')+'/ws/'+encodeURIComponent(topic)+qs;
  }
  function topicFromSyncUrl(u){return String(u||'').split('/').filter(Boolean).pop()||''}
  function baseFromSyncUrl(u){
    const m=String(u||'').match(/^(https?:\/\/[^/]+)\//i);
    return m?m[1]:'';
  }
  function normalizeSync(c){
    if(!c||!c.group)return;
    const base=getSyncBase()||baseFromSyncUrl(String(c.syncUrl||''));
    const old=String(c.syncUrl||'');
    if(old&&!c.syncWs){
      c.syncWs=wsUrlFromBase(base||baseFromSyncUrl(old),topicFromSyncUrl(old));
    }
    if(base&&/^https:\/\/ntfy\.sh\//i.test(old)){
      const topic=topicFromSyncUrl(old);
      c.syncUrl=base+'/api/'+encodeURIComponent(topic);
      c.syncWs=wsUrlFromBase(base,topic);
    }
    if(base&&old&&!/^https:\/\/ntfy\.sh\//i.test(old)){
      const topic=topicFromSyncUrl(old);
      if(topic){
        c.syncUrl=base+'/api/'+encodeURIComponent(topic);
        c.syncWs=wsUrlFromBase(base,topic);
      }
    }
    if(/^https:\/\/ntfy\.sh\//i.test(old)&&!base){
      c.syncUrl='';
      c.syncWs='';
    }
  }
  function ensureSyncUrl(c){
    normalizeSync(c);
    if(c.syncUrl)return c.syncUrl;
    const base=getSyncBase();
    if(!base){
      showToast('请先在设置里填写群聊服务器地址');
      return '';
    }
    const topic='whale-girl-'+uid().slice(0,10);
    c.syncUrl=base+'/api/'+encodeURIComponent(topic);
    c.syncWs=wsUrlFromBase(base,topic);
    saveConversations();
    watchGroup();
    return c.syncUrl;
  }
  async function pushSync(){
    const c=conv();
    if(!c||!c.group)return false;
    normalizeSync(c);
    if(!c.syncUrl)return false;
    c.updatedAt=Date.now();
    try{
      const res=await fetch(c.syncUrl,{method:'POST',headers:{'Content-Type':'application/json',...syncHeaders()},body:JSON.stringify(c)});
      return !!res.ok;
    }catch(e){}
    return false;
  }
  function mergeRemoteMessages(localMessages,remoteMessages){
    const byId=new Map();
    const list=[];
    const add=(message,remote=false)=>{
      if(!message||typeof message!=='object')return;
      const key=String(message.id||[message.role,message.content,message.created_at].join('|'));
      const prior=byId.get(key);
      if(!prior){const copy={...message};byId.set(key,copy);list.push(copy);return}
      const localPending=!remote&&prior.status==='sending';
      Object.assign(prior,message);
      if(localPending&&!message.status)prior.status='sending';
    };
    (Array.isArray(localMessages)?localMessages:[]).forEach(m=>add(m,false));
    (Array.isArray(remoteMessages)?remoteMessages:[]).forEach(m=>add(m,true));
    list.sort((a,b)=>Number(a.serverSeq||0)-Number(b.serverSeq||0)||String(a.created_at||a.createdAt||'').localeCompare(String(b.created_at||b.createdAt||'')));
    return list;
  }
  function adoptRemoteMessage(remote){
    const c=conv();
    if(!c||!remote||!Array.isArray(remote.messages))return false;
    const localUpdated=Number(c.updatedAt||0);
    const remoteUpdated=Number(remote.updatedAt||0);
    const beforeIds=new Set((c.messages||[]).map(m=>String(m.id||'')));
    const beforeCount=(c.messages||[]).length;
    c.title=remote.title||c.title;
    c.messages=mergeRemoteMessages(c.messages,remote.messages);
    if(Array.isArray(remote.members)){
      const members=new Map((c.members||[]).map(m=>[String(m.id||m.name),m]));
      remote.members.forEach(m=>{if(m&&typeof m==='object'){const key=String(m.id||m.name);members.set(key,{...(members.get(key)||{}),...m})}});
      c.members=[...members.values()];
    }
    c.updatedAt=Math.max(localUpdated,remoteUpdated);
    c.syncUrl=c.syncUrl||remote.syncUrl;
    if(remote.syncWs)c.syncWs=remote.syncWs;
    const lastMsg=c.messages[c.messages.length-1];
    if(lastMsg&&lastMsg.role==='user'&&lastMsg.authorName&&lastMsg.authorName!==account.name&&c.notifiedId!==lastMsg.id){
      if(bridge&&bridge.notifyGroupMessage){
        bridge.notifyGroupMessage(String(lastMsg.authorName),String(normalizeText(lastMsg.content)).slice(0,120));
      }
    }
    c.notifiedId=lastMsg?lastMsg.id:null;
    saveConversations();
    const hasNew=c.messages.some(m=>m.id&&!beforeIds.has(String(m.id)));
    if(hasNew||c.messages.length>beforeCount)showToast('收到新消息');
    renderAll();
    return hasNew||c.messages.length!==beforeCount||remoteUpdated>localUpdated;
  }
  async function fetchRecent(){
    const c=conv();
    if(!c||!c.syncUrl)return;
    normalizeSync(c);
    if(!c.syncUrl)return;
    try{
      const res=await fetch(c.syncUrl,{headers:syncHeaders()});
      if(!res.ok)return;
      const j=await res.json();
      if(j&&j.conv)adoptRemoteMessage(j.conv);
    }catch(e){}
  }
  function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
  async function watchGroup(){
    const c=conv();
    if(!c||c._watching)return;
    normalizeSync(c);
    if(!c.syncWs){c._watching=false;return}
    c._watching=true;
    let reconnectAttempt=0;
    while(conv()&&c.group&&c.syncWs){
      let ws=null;
      try{ws=new WebSocket(c.syncWs)}catch(e){ws=null}
      if(!ws){reconnectAttempt++;await sleep(Math.min(15000,1000*2**Math.min(reconnectAttempt,4)));continue}
      c._ws=ws;
      ws.onopen=()=>{reconnectAttempt=0;showToast('群聊已连接')};
      const closed=new Promise(resolve=>{
        ws.onclose=()=>resolve();
        ws.onerror=()=>{try{ws.close()}catch(e){}resolve()};
      });
      ws.onmessage=(ev)=>{
        try{
          const j=JSON.parse(ev.data);
          if(j&&j.type==='state'&&j.conv)adoptRemoteMessage(j.conv);
        }catch(e){}
      };
      await closed;
      reconnectAttempt++;
      await sleep(Math.min(15000,1000*2**Math.min(reconnectAttempt,4)));
    }
    c._watching=false;
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
    $('#memberCount').textContent=`${humans} 位成员`;
    // The selected visual reference shows a compact strip of all members;
    // keep up to six circles before falling back to a small overflow badge.
    const visibleMembers=members.slice(0,6);
    const overflow=members.length-visibleMembers.length;
    $('#avatarStack').innerHTML=visibleMembers.map(m=>{
      const isSelf=m.id===account.id;
      return `<div class="member-avatar" style="background:${colorFor(m.name||'成员')}">${escapeHtml(initials(m.name||'成员'))}${isSelf?'<i class="self-dot"></i>':''}</div>`;
    }).join('')+(overflow>0?`<div class="member-more">+${overflow}</div>`:'');
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
    if(card&&card.dataset.url){
      try{if(bridge&&bridge.openUrl){bridge.openUrl(card.dataset.url)}else{window.open(card.dataset.url,'_blank')}}catch(e){}
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
      if(!c.syncUrl)ensureSyncUrl(c);
      if(msg.attachment&&msg.attachment.local){
        if(!pendingFile)throw new Error('附件内容已失效，请重新选择文件后再重试');
        const remote=await uploadAttachment(c,pendingFile);
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
    $('#groupLanding').hidden=true;
    $('#chatScroll').hidden=false;
    document.querySelector('.composer').hidden=false;
    $('#memberStrip').hidden=false;
    $('#groupTitle').textContent=c.title||'群聊';
    renderMembers();
    renderMessages();
    $('#modelValue').textContent=state.model;
    $('#reasoningValue').textContent=state.reasoning;
    const storedProgress=Number(c.contextProgress ?? c.context_percent ?? 0)||0;
    const progress=Math.max(0,Math.min(100,storedProgress||estimateContextProgress(c)));
    const ring=$('#contextRing');
    if(ring)ring.style.setProperty('--progress',progress+'%');
    const ringValue=$('#contextRingValue');
    if(ringValue)ringValue.textContent=progress+'%';
  }
  function renderLanding(){
    $('#groupLanding').hidden=false;
    $('#chatScroll').hidden=true;
    document.querySelector('.composer').hidden=true;
    $('#memberStrip').hidden=true;
    $('#groupTitle').textContent='群聊';
    $('#memberCount').textContent='';
  }
  function makePreviewConversation(){
    const now=Date.now();
    return {id:'preview-group',title:'项目讨论群',group:true,contextProgress:30,members:[
      {id:'p1',name:'张伟'},{id:'p2',name:'李娜'},{id:'p3',name:'王磊'},{id:'p4',name:'赵敏'},{id:account.id,name:account.name||'你'},{id:'p6',name:'陈晨'}
    ],messages:[
      {id:'pm1',role:'user',authorId:'p1',authorName:'张伟',content:'大家好，今天我们同步一下项目进度和下一步计划。',created_at:new Date(now-240000).toISOString()},
      {id:'pm2',role:'user',authorId:'p2',authorName:'李娜',content:'好的，我先汇报下设计稿的最新进展。',created_at:new Date(now-180000).toISOString()},
      {id:'pm3',role:'user',authorId:'p3',authorName:'王磊',content:'我这边后端接口已经完成了 80%，预计明天可以联调。',created_at:new Date(now-120000).toISOString()},
      {id:'pm4',role:'user',authorId:account.id,authorName:account.name||'你',content:'收到，辛苦大家了！有问题随时在群里沟通～',created_at:new Date(now-60000).toISOString()}
    ],updatedAt:now};
  }
  function estimateContextProgress(c){
    const chars=(c&&Array.isArray(c.messages)?c.messages:[]).reduce((sum,m)=>sum+normalizeText(m&&m.content).length,0);
    // DeepSeek chat context is measured approximately from UTF-8 text. The
    // ring is deliberately conservative until the provider returns usage.
    return Math.max(0,Math.min(99,Math.round(chars/4/65536*100)));
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
      persistClientSelection();
      $('#modelValue').textContent=state.model;
      renderModelOptions();
      closeSheets();
    }));
  }
  function renderReasoningOptions(){
    const levels=['自动','简洁','标准','深入','最高'];
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
      persistClientSelection();
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
      if(!ensureSyncUrl(c))return;
      pushSync();
    }
    const topic=topicFromSyncUrl(c.syncUrl);
    const serverBase=getSyncBase();
    const token=getSyncToken();
    $('#inviteLink').textContent='yingzi://join/'+topic+(serverBase?'?server='+encodeURIComponent(serverBase):'')+(serverBase&&token?'&key='+encodeURIComponent(token):'');
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
    if(!c.syncUrl)ensureSyncUrl(c);
    normalizeSync(c);
    if(!file||typeof file!=='object')throw new Error('附件内容为空');
    const endpoint=String(c.syncUrl||'').replace(/\/+$/,'')+'/attachments';
    const res=await fetch(endpoint,{
      method:'PUT',
      headers:{'Content-Type':file.type||'application/octet-stream','Filename':file.name,...syncHeaders()},
      body:file,
    });
    if(!res.ok)throw new Error('上传失败 HTTP '+res.status);
    const j=await res.json();
    const att=j.attachment||{};
    let url=att.url||'';
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
  let pendingComplete=null;
  function apiUrl(cfg){return (cfg.base_url||'https://api.deepseek.com').replace(/\/+$/,'')+'/chat/completions'}
  function buildPayload(cfg,messages){
    const payload={model:cfg.model,messages,stream:true};
    const isV4=(cfg.base_url||'').toLowerCase().includes('api.deepseek.com')&&String(cfg.model||'').toLowerCase().startsWith('deepseek-v4');
    if(isV4){
      if(state.reasoning==='简洁')payload.thinking={type:'disabled'};
      else{payload.thinking={type:'enabled'};payload.reasoning_effort=state.reasoning==='最高'?'max':'high'}
      }else if(cfg.reasoning_parameter){
      const map={'自动':'medium','简洁':'low','标准':'medium','深入':'high','最高':'high'};
      payload[cfg.reasoning_parameter]=map[state.reasoning]||'medium';
    }
    return payload;
  }
  function streamChat(cfg,messages,handlers){
    return new Promise((resolve,reject)=>{
      if(bridge&&bridge.streamChat){
        pendingStream={resolve,reject,handlers};
        bridge.streamChat(JSON.stringify({target:'group',url:apiUrl(cfg),apiKey:cfg.api_key,payload:buildPayload(cfg,messages)}));
      }else{
        reject(new Error('原生桥接不可用'));
      }
    });
  }
  function completeChat(cfg,messages){
    return new Promise((resolve,reject)=>{
      if(bridge&&bridge.completeChat){
        pendingComplete={resolve,reject};
        bridge.completeChat(JSON.stringify({target:'group',url:(cfg.base_url||'').replace(/\/+$/,'')+'/chat/completions',apiKey:cfg.api_key,payload:{model:cfg.model,messages,stream:false}}));
      }else{
        reject(new Error('原生桥接不可用'));
      }
    });
  }
  function imageMessageContent(message){
    const content=[{type:'text',text:normalizeText(message.content)||'请看这张图片。'}];
    content.push({type:'image_url',image_url:{url:message.attachment.url}});
    return content;
  }
  async function buildGroupHistory(c,assistantMsg){
    const out=[];
    const imageMsgs=c.messages.filter(m=>m.attachment&&String(m.attachment.type||'').startsWith('image/'));
    const recentImages=new Set(imageMsgs.slice(-3).map(m=>m.id));
    for(const m of c.messages){
      if(m===assistantMsg)continue;
      if(m.attachment&&String(m.attachment.type||'').startsWith('image/')&&recentImages.has(m.id)){
        out.push({role:m.role,content:imageMessageContent(m)});
      }else if(m.content){
        out.push({role:m.role,content:normalizeText(m.content)});
      }
    }
    return out;
  }
  function handleEvent(name,data){
    if(typeof data==='string'){try{data=JSON.parse(data)}catch(e){data={}}}
    if(name==='complete'&&pendingComplete){const p=pendingComplete;pendingComplete=null;p.resolve((data&&data.text)||'');return}
    if(name==='error'){
      const msg=(data&&data.message)||'请求失败';
      if(pendingStream){const p=pendingStream;pendingStream=null;p.reject(new Error(msg));return}
      if(pendingComplete){const p=pendingComplete;pendingComplete=null;p.reject(new Error(msg));return}
      return;
    }
    if(name==='done'&&pendingStream){const p=pendingStream;pendingStream=null;try{if(p.handlers.done)p.handlers.done()}catch(e){}p.resolve();return}
    if(pendingStream&&pendingStream.handlers&&pendingStream.handlers[name]){
      let payload=data;
      if(name==='delta')payload=(data&&data.text)||'';
      try{pendingStream.handlers[name](payload)}catch(e){}
    }
  }
  window.AndroidEvents={onEvent:handleEvent};
  window.DeepSeekEvents={onEvent:handleEvent};

  async function sendMessage(){
    const c=conv();
    if(!c)return;
    const input=$('#messageInput');
    const text=input.value.trim();
    if(!text&&!pendingFile)return;
    commit();
    const cfg=readClientApi();
    try{
      if(!c.syncUrl)ensureSyncUrl(c);
    }catch(e){}
    const mentions=buildMentions(text);
    const fileToUpload=pendingFile;
    let attachment=null;
    if(fileToUpload){
      attachment={url:pendingPreviewUrl||'',localUrl:pendingPreviewUrl||'',type:fileToUpload.type||'',name:fileToUpload.name||'file',size:fileToUpload.size||0,local:true};
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
          const remote=await uploadAttachment(c,fileToUpload);
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
    if(!mentions.length)return;
    if(!cfg){showToast('请先在设置中配置 API');return;}
    if(!cfg.api_key){showToast('请先在设置中配置 API Key');return;}
    const assistantMsg={id:uid(),role:'assistant',content:'',model:state.model,authorId:'ai',authorName:'AI 助手',status:'sending',created_at:nowISO()};
    c.messages.push(assistantMsg);
    $('#typingIndicator').hidden=false;
    renderMessages();
    state.sending=true;
    const hasImages=c.messages.some(m=>m.attachment&&String(m.attachment.type||'').startsWith('image/'));
    const history=await buildGroupHistory(c,assistantMsg);
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
      assistantMsg.status='error';
      showToast(e.message||'生成失败');
    }finally{
      assistantMsg.created_at=nowISO();
      if(assistantMsg.status==='sending')assistantMsg.status='sent';
      state.sending=false;
      $('#typingIndicator').hidden=true;
      saveConversations();
      renderAll();
      await pushSync();
    }
  }

  /* ---------- events ---------- */
  /* ---------- local sidebar ---------- */
  const gSidebar=$('#sidebar'),gBackdrop=$('#sidebarBackdrop');
  function gOpenSidebar(){
    loadConversations();
    gSidebar.classList.add('open');
    gSidebar.setAttribute('aria-hidden','false');
    gBackdrop.classList.add('show');
    document.body.classList.add('sidebar-open');
    try{renderGSidebar()}catch(e){}
    return;
  }
  function gCloseSidebar(){
    gSidebar.classList.remove('open');
    gSidebar.setAttribute('aria-hidden','true');
    gBackdrop.classList.remove('show');
    document.body.classList.remove('sidebar-open');
  }
  window.handleSystemBack=()=>{
    if(!$('#sheetScrim').hidden){closeSheets();return true}
    if(gSidebar.classList.contains('open')){gCloseSidebar();return true}
    if(!$('#attachMenu').hidden){$('#attachMenu').hidden=true;return true}
    if(!$('#stickerPanel').hidden){$('#stickerPanel').hidden=true;return true}
    return false;
  };
  function gHistoryButton(c,isGroup){
    const b=document.createElement('button');
    b.className='side-item chat-history'+(c.id===convId?' current':'');
    b.innerHTML=`<span>${c.pinned?'⌖':'◷'}</span><span>${escapeHtml(c.title)}</span>`;
    b.addEventListener('click',()=>{
      if(isGroup)location.href='index.html?conv='+encodeURIComponent(c.id);
      else location.href='../index.html?open='+encodeURIComponent(c.id);
    });
    return b;
  }
  function renderGSidebar(){
    const pinned=$('#pinnedChatList'),recent=$('#recentChatList'),groups=$('#groupChatList'),projects=$('#projectList');
    pinned.innerHTML='';recent.innerHTML='';groups.innerHTML='';projects.innerHTML='';
    $('#sidebarModelLabel').textContent=state.model;
    conversations.filter(c=>!c.group&&!c.projectId)
      .sort((a,b)=>((b.pinned?1:0)-(a.pinned?1:0))||((b.created_at||'').localeCompare(a.created_at||'')))
      .forEach(c=>(c.pinned?pinned:recent).appendChild(gHistoryButton(c,false)));
    conversations.filter(c=>c.group).forEach(c=>groups.appendChild(gHistoryButton(c,true)));
    [...projects].forEach(p=>{
      const d=document.createElement('div');
      d.className='side-subhead';
      d.textContent=p.title+'（'+conversations.filter(c=>c.projectId===p.id).length+'）';
      projects.appendChild(d);
    });
    if(!groups.children.length)groups.innerHTML='<div class="empty-history">暂无群聊</div>';
    if(!pinned.children.length)pinned.innerHTML='<div class="empty-history">暂无置顶</div>';
    if(!recent.children.length)recent.innerHTML='<div class="empty-history">暂无最近</div>';
  }
  document.addEventListener('click',e=>{if(e.target.closest('#menuButton')){e.preventDefault();gOpenSidebar()}});
  gBackdrop.addEventListener('click',gCloseSidebar);
  $$('[data-sidebar-close]').forEach(b=>b.addEventListener('click',gCloseSidebar));
  $('#sidebarSettings').addEventListener('click',()=>{gCloseSidebar();notifyShell('dsh-group-open-shell-settings')});
  $('#newGroupButton').addEventListener('click',createGroupConversation);
  $('#joinGroupButton').addEventListener('click',joinGroupConversation);
  $('#landingNewGroupButton').addEventListener('click',createGroupConversation);
  $('#landingJoinGroupButton').addEventListener('click',joinGroupConversation);
  $('#sidebarSearch').addEventListener('input',e=>{
    const q=String(e.target.value||'').trim().toLowerCase();
    $$('.chat-history',gSidebar).forEach(item=>{item.hidden=!!q&&!(item.textContent||'').toLowerCase().includes(q)});
  });
  $('#groupInfoButton').addEventListener('click',()=>{renderMembers();openSheet('#memberSheet')});
  $('#memberDetailsButton').addEventListener('click',()=>{renderMembers();openSheet('#memberSheet')});
  $('#contextButton').addEventListener('click',()=>{
    const c=conv();
    const progress=Math.max(0,Math.min(100,Number(c&&c.contextProgress||0)||estimateContextProgress(c)));
    showToast(`上下文已使用 ${progress}%`);
  });
  $('#groupMenuButton').addEventListener('click',()=>{renderMembers();openSheet('#memberSheet')});
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
        <button type="button" id="stickerClose">收起</button>
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
    $('#stickerClose').addEventListener('click',()=>{panel.hidden=true});
    panel.querySelectorAll('[data-emoji]').forEach(b=>b.addEventListener('click',()=>{
      const input=$('#messageInput');
      input.value+=(input.value&&!input.value.endsWith(' ')?' ':'')+b.dataset.emoji;
      mentionIntent=false;
      input.focus();
      autosize();
    }));
    panel.querySelectorAll('[data-sticker]').forEach(img=>img.addEventListener('click',()=>{
      const s=loadStickers().find(x=>x.id===img.dataset.sticker);
      if(!s)return;
      fetch(s.url).then(r=>r.blob()).then(blob=>{
        const file=new File([blob],'sticker.png',{type:'image/png'});
        panel.hidden=true;
        pickAttachment(file);
      }).catch(()=>showToast('贴纸读取失败'));
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
    if(previewMode){
      draftConv=makePreviewConversation();
      isDraft=true;
      renderAll();
      return;
    }
    const first=conversations.find(c=>c&&c.group);
    if(first){location.replace('index.html?conv='+encodeURIComponent(first.id));return;}
    renderLanding();
  }else{
    renderAll();
    watchGroup();
  }
})();
