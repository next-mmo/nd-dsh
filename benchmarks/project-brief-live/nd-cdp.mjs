import WebSocket from 'ws'
export async function connectNd({endpoint='http://127.0.0.1:9222',requestTimeoutMs=120000}={}){
 const targets=await (await fetch(endpoint+'/json/list',{signal:AbortSignal.timeout(5000)})).json()
 const target=targets.find(t=>t.url.startsWith('http://localhost:5173/') && !t.url.includes('/launcher'))
 if(!target)throw new Error('ND main renderer unavailable')
 const ws=new WebSocket(target.webSocketDebuggerUrl)
 await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej)})
 let seq=0;const pending=new Map()
 const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error)}pending.clear()}
 ws.on('close',()=>fail(new Error('ND observer connection closed')))
 ws.on('error',fail)
 ws.on('message',b=>{const m=JSON.parse(b);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result)}})
 const send=(method,params={})=>{const id=++seq;return new Promise((resolve,reject)=>{if(ws.readyState!==WebSocket.OPEN)return reject(new Error('ND observer connection unavailable'));const timer=setTimeout(()=>{pending.delete(id);reject(new Error('ND observer request timed out'))},requestTimeoutMs);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}),error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error)}})})}
 return {close:()=>ws.close(),send,async evaluate(expression){const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value}}
}
if(process.argv[2]==='close'){
 const c=await connectNd();await c.evaluate('window.close()').catch(()=>{});c.close()
}
if(process.argv[2]==='preflight'){
 const c=await connectNd();try{console.log(JSON.stringify(await c.evaluate(`(async()=>{const h=await window.ndDsh.harness.status();const p=await window.ndDsh.providers.list();return {state:h.state,provider:h.provider,model:h.model,credentialAvailable:p.find(x=>x.id===h.provider)?.hasApiKey}})()`)))}finally{c.close()}
}
if(process.argv[2]==='inspect'){
 const c=await connectNd()
 try{console.log(JSON.stringify(await c.evaluate(`(async()=>{const a=window.ndDsh;const h=await a.harness.status();return {url:location.href,snapshot:document.body.innerText.slice(0,6500),workspace:await a.workspace.state(),harness:{state:h.state,provider:h.provider,model:h.model,error:h.error},engines:await a.engines.list(),apiKeys:Object.keys(a),extensionKeys:Object.keys(a.ndExtensions),storage:Object.fromEntries(Object.entries(localStorage).filter(([k])=>/engine|model|permission/.test(k)))} })()`),null,2))}finally{c.close()}
}
