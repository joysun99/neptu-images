export const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cert-sync</title><style>
body{font:16px system-ui;max-width:900px;margin:32px auto;padding:0 20px;color:#142536;background:#f4f7fa}section{padding:20px;margin:16px 0;background:white;border:1px solid #d8e2ea;border-radius:12px}input,textarea,button{font:inherit;padding:10px;margin:6px 0;box-sizing:border-box}input,textarea{width:100%}button{cursor:pointer;background:#155e75;color:white;border:0;border-radius:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#506578}.hidden{display:none}</style>
<h1>cert-sync</h1><p>独立证书服务 · HTTP-01 · Leader / Follower</p>
<section><label>本节点管理 Token<input id="admin" type="password" autocomplete="off" placeholder="仅保留在当前页面内存"></label><button id="login">连接控制台</button><button id="logout">退出</button><p id="message" role="status"></p></section>
<main id="content" class="hidden"><section><h2>本节点</h2><pre id="state"></pre><button id="refresh">刷新</button></section>
<section><h2 id="domain-title">域名配置</h2><small>每行一个完整域名。域名与证书均单独管理；不支持通配符。Follower 只能取得 Leader 已授权的证书。</small><textarea id="domains" rows="5"></textarea><button id="save-domains">保存域名</button></section>
<section id="leader" class="hidden"><h2>Follower 加入与授权</h2><input id="node" placeholder="Follower nodeId，如 usg"><textarea id="grants" rows="3" placeholder="授权域名，每行一个"></textarea><input id="ttl" type="number" value="3600" min="60" max="86400"><button id="invite">创建一次性 Join Token</button><p>下方邀请包含秘密，仅通过受信任方式交给指定节点；过期或使用后不能用于新增节点。</p><textarea id="invitation-output" rows="8" readonly></textarea><h3>访问控制</h3><input id="client" placeholder="已加入的 Follower nodeId"><button id="grant-update">更新该节点域名授权</button><button id="revoke">撤销该节点</button></section>
<section id="follower" class="hidden"><h2>加入 Leader</h2><textarea id="invitation-input" rows="8" placeholder="粘贴 Leader 生成的邀请 JSON"></textarea><button id="join">使用 Join Token 加入</button><button id="sync">立即同步</button><small>已加入凭据保存在本节点私有状态目录，重建容器时必须保留该目录。</small></section></main>
<script src="/console/app.js" defer></script></html>`;
export const SCRIPT = String.raw`const $=id=>document.getElementById(id);let token='',snapshot;
const list=id=>$(id).value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
async function api(path,body){const r=await fetch('/admin/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',signal:AbortSignal.timeout(45000)});const data=await r.json();if(!r.ok)throw Error(data.error||'操作失败');return data;}
async function refresh(){snapshot=await api('state');$('content').classList.remove('hidden');$('leader').classList.toggle('hidden',snapshot.role!=='leader');$('follower').classList.toggle('hidden',snapshot.role!=='follower');$('domain-title').textContent=snapshot.role==='leader'?'需要申请和续期的域名':'需要消费的域名';$('domains').value=snapshot.domains.join('\n');$('state').textContent=JSON.stringify(snapshot,null,2);}
async function action(fn){try{$('message').textContent='处理中…';await fn();$('message').textContent='操作完成';}catch(e){$('message').textContent=e.message;}}
$('login').onclick=()=>action(async()=>{token=$('admin').value;$('admin').value='';await refresh();});
$('logout').onclick=()=>{token='';snapshot=undefined;$('content').classList.add('hidden');$('invitation-output').value='';$('invitation-input').value='';$('message').textContent='已退出';};
$('refresh').onclick=()=>action(refresh);
$('save-domains').onclick=()=>action(async()=>{await api('domains',{domains:list('domains'),revision:snapshot.revision});await refresh();});
$('invite').onclick=()=>action(async()=>{$('invitation-output').value=JSON.stringify(await api('invitations',{nodeId:$('node').value.trim(),domains:list('grants'),ttlSeconds:Number($('ttl').value)}),null,2);});
$('grant-update').onclick=()=>action(async()=>{await api('grants',{nodeId:$('client').value.trim(),domains:list('grants')});await refresh();});
$('revoke').onclick=()=>action(async()=>{if(confirm('确认撤销该节点的证书访问？')){await api('revoke',{nodeId:$('client').value.trim()});await refresh();}});
$('join').onclick=()=>action(async()=>{const invitation=JSON.parse($('invitation-input').value);await api('join',{invitation});$('invitation-input').value='';await refresh();});
$('sync').onclick=()=>action(async()=>{await api('sync',{});await refresh();});
`;
