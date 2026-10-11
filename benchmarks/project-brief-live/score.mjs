import {spawn,spawnSync} from 'node:child_process'
import {readFile,writeFile,mkdir,mkdtemp,rename,symlink,unlink} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
import {connectNd} from './nd-cdp.mjs'
const base=resolve('scratch/project-brief-benchmark'),side=process.argv[2]
if(!['nd','gpt'].includes(side))throw new Error('Expected nd or gpt')
const id=side+'-project-brief',name=side==='nd'?'ND Project Brief':'GPT Project Brief'
const dir=join(base,side+'-workspace','extension'),server=join(dir,'mcp-server.mjs')
const start=performance.now(),checks=[]
async function check(group,label,points,fn){try{await fn();checks.push({group,label,points,passed:true})}catch(e){checks.push({group,label,points,passed:false,error:e.message})}}
function assert(ok,message){if(!ok)throw new Error(message)}
const exec=(args,cwd)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',shell:false});if(r.status!==0)throw new Error(r.stderr||'Git failed');return r.stdout}
const fixture=await mkdtemp(join(base,side+'-verify-'))
await mkdir(join(fixture,'.project-brief'))
await writeFile(join(fixture,'.gitignore'),'.project-brief/\n')
for(const f of ['modified space.txt','delete.txt','old name.txt','សួស្តី.txt'])await writeFile(join(fixture,f),'baseline\n')
exec(['init','-q'],fixture);exec(['add','.'],fixture)
exec(['-c','user.name=Benchmark','-c','user.email=benchmark@example.invalid','commit','-qm','Frozen verification input'],fixture)
await writeFile(join(fixture,'modified space.txt'),'changed\n')
await writeFile(join(fixture,'សួស្តី.txt'),'changed Unicode\n')
await unlink(join(fixture,'delete.txt'));exec(['mv','old name.txt','renamed space.txt'],fixture)
await writeFile(join(fixture,'new file.txt'),'new\n');exec(['add','new file.txt'],fixture)
await writeFile(join(fixture,'untracked.txt'),'untracked\n')
const taskFile=join(fixture,'.project-brief','tasks.json')
const tasks=[{id:'T1',title:'Implement login',status:'open'},{id:'T2',title:'Payment dependency',status:'blocked'},{id:'T3',title:'Build dashboard',status:'in_progress'},{id:'T4',title:'Finished setup',status:'done'}]
await writeFile(taskFile,JSON.stringify(tasks))
class Mcp{
 constructor(args=[],cwd=fixture){this.seq=0;this.pending=new Map();this.noise=[];this.errors='';this.buf='';this.child=spawn(process.execPath,[server,...args],{cwd,shell:false,stdio:['pipe','pipe','pipe']});this.child.stdout.on('data',b=>{this.buf+=b;let n;while((n=this.buf.indexOf('\n'))>=0){const line=this.buf.slice(0,n);this.buf=this.buf.slice(n+1);if(!line.trim())continue;try{const m=JSON.parse(line);assert(m.jsonrpc==='2.0','Invalid RPC');const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message||'RPC error')):p.resolve(m.result)}}catch(e){this.noise.push(line)}}});this.child.stderr.on('data',b=>this.errors+=b);this.child.on('error',e=>{for(const p of this.pending.values())p.reject(e)});this.child.on('exit',code=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Server exited '+code))}this.pending.clear()})}
 request(method,params={}){const id=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('RPC deadline exceeded'))},8000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})}
 tool(name,args={}){return this.request('tools/call',{name,arguments:args})}
 raw(line){this.child.stdin.write(line+'\n')}
 close(){this.child.stdin.end();this.child.kill()}
}
function text(result){return result?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||''}
// CommonMark backslash escapes preserve rendered punctuation; compare content,
// not one producer's Markdown spelling. Normalize all ASCII punctuation escapes.
function visibleMarkdown(result){return text(result).replace(/\\([\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E])/g,'$1')}
function data(result){assert(!result?.isError,'MCP tool returned error: '+text(result));return JSON.parse(text(result))}
let client,all,manifest
await check('packaging','Native manifest validates and has correct identity',5,async()=>{manifest=JSON.parse(await readFile(join(dir,'nd-extension.json'),'utf8'));assert(manifest.id===id,'Wrong package ID');const r=spawnSync(process.execPath,['scripts/validate-nd-extension.mjs',dir],{cwd:resolve('.'),encoding:'utf8'});assert(r.status===0,(r.stdout+r.stderr).trim());assert(manifest.name===name,'Wrong visible name')})
await check('packaging','Real executable, documentation, and MCP registration template',5,async()=>{await readFile(server);const legacy=JSON.parse(await readFile(join(dir,'nd-extension.example.json'),'utf8'));assert(legacy.id===id&&legacy.surface==='mcp'&&legacy.runtime?.kind==='mcp-stdio','Invalid MCP registration template');await readFile(join(dir,'README.md'))})
await check('packaging','Installs in actual ND through existing package API',5,async()=>{const c=await connectNd();try{await c.evaluate(`window.ndDsh.ndExtensions.installFromPath(${JSON.stringify(dir)})`)}finally{c.close()}})
try{client=new Mcp()
await check('protocol','Initialization and version handshake',4,async()=>{const r=await client.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'frozen-grader',version:'1'}});assert(r.protocolVersion==='2024-11-05'&&r.capabilities?.tools&&r.serverInfo?.name,'Invalid initialize response');client.raw(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}))})
await check('protocol','Ping',2,async()=>{const r=await client.request('ping');assert(r&&typeof r==='object','Invalid ping')})
await check('protocol','Both real tools advertised',3,async()=>{const r=await client.request('tools/list');assert(['project_brief','project_brief_export'].every(n=>r.tools?.some(t=>t.name===n&&t.inputSchema?.type==='object')),'Missing tool/schema')})
await check('protocol','Unknown tool and RPC method return explicit errors',2,async()=>{assert((await client.tool('nonexistent')).isError===true,'Unknown tool accepted');let rejected=false;try{await client.request('not/a/method')}catch{rejected=true}assert(rejected,'Unknown RPC method accepted')})
await check('protocol','Invalid filter returns explicit MCP error',2,async()=>{assert((await client.tool('project_brief',{filter:'unsupported'})).isError===true,'Invalid filter accepted')})
await check('protocol','Malformed line recovery and clean JSON stdout',2,async()=>{client.raw('{bad json');await client.request('ping');assert(client.noise.length===0,'Non-JSON stdout: '+client.noise.join('\n'))})
await check('git','Exact real Git statuses including spaces and Unicode',15,async()=>{all=data(await client.tool('project_brief'));assert(all.extensionId===id,'Missing/wrong output identity');const expected={'modified space.txt':'modified','សួស្តី.txt':'modified','delete.txt':'deleted','renamed space.txt':'renamed','new file.txt':'added','untracked.txt':'untracked'};for(const [p,s]of Object.entries(expected))assert(all.changes?.some(c=>c.path===p&&c.status===s),'Wrong status for '+p);assert(all.changes.length===6,'Unexpected changes count')})
await check('git','Rename old path is consumed without duplicate entries',5,async()=>{const d=all||data(await client.tool('project_brief'));assert(!d.changes.some(c=>c.path==='old name.txt'),'Old rename path reported separately');assert(new Set(d.changes.map(c=>c.path)).size===d.changes.length,'Duplicate changes')})
await check('tasks','Default non-done tasks and actual source evidence',5,async()=>{const d=all||data(await client.tool('project_brief'));assert(JSON.stringify(d.tasks.map(t=>t.id).sort())===JSON.stringify(['T1','T2','T3']),'Wrong default tasks');assert(d.tasks.every(t=>t.source==='.project-brief/tasks.json'),'Missing source evidence')})
await check('tasks','Changes/open/blocked filters',5,async()=>{const changes=data(await client.tool('project_brief',{filter:'changes'}));const open=data(await client.tool('project_brief',{filter:'open'}));const blocked=data(await client.tool('project_brief',{filter:'blocked'}));assert(changes.tasks.length===0&&changes.changes.length===6,'Changes filter wrong');assert(open.changes.length===0&&JSON.stringify(open.tasks.map(t=>t.id).sort())===JSON.stringify(['T1','T3']),'Open filter wrong');assert(blocked.changes.length===0&&blocked.tasks.length===1&&blocked.tasks[0].id==='T2','Blocked filter wrong')})
await check('tasks','Evidence-derived next actions with blocked task first',5,async()=>{const d=all||data(await client.tool('project_brief'));assert(Array.isArray(d.nextActions)&&d.nextActions.every(x=>typeof x==='string'),'Invalid next actions');assert(d.nextActions[0]?.includes('T2')||d.nextActions[0]?.includes('Payment dependency'),'Blocked task not first');assert(!d.nextActions.join(' ').includes('Finished setup'),'Done task suggested')})
await check('tasks','Missing and malformed task sources are honest',5,async()=>{await rename(taskFile,taskFile+'.saved');try{const missing=data(await client.tool('project_brief'));assert(missing.warnings?.length>0,'Missing task source has no warning');await writeFile(taskFile,'{broken');assert((await client.tool('project_brief')).isError===true,'Malformed task source treated as success');await writeFile(taskFile,JSON.stringify([{id:'X',title:'Invalid status',status:'magic'}]));assert((await client.tool('project_brief')).isError===true,'Invalid task status accepted')}finally{await unlink(taskFile).catch(()=>{});await rename(taskFile+'.saved',taskFile)}})
await check('safety','Tool arguments cannot switch bound workspace',5,async()=>{const other=await mkdtemp(join(base,'other-root-'));const r=await client.tool('project_brief',{root:other,workspace:other});if(!r.isError){const d=data(r);assert(resolve(d.workspace)===resolve(fixture),'Tool changed workspace');assert(d.tasks.some(t=>t.id==='T2'),'Read wrong tasks')}})
await check('safety','Escaping task-source junction is denied',5,async()=>{const outside=await mkdtemp(join(base,'outside-tasks-'));await writeFile(join(outside,'tasks.json'),JSON.stringify([{id:'SECRET-OUTSIDE',title:'Outside root',status:'open'}]));const src=join(fixture,'.project-brief'),backup=src+'-saved';await rename(src,backup);let linked=false;try{await symlink(outside,src,'junction');linked=true;const r=await client.tool('project_brief');assert(r.isError===true,'Escaping task directory accepted')}finally{if(linked)await unlink(src);await rename(backup,src)}})
await check('safety','Brief and export do not mutate Git or tasks',5,async()=>{const before=exec(['status','--porcelain=v1','-z','--untracked-files=all'],fixture);const hash=createHash('sha256').update(await readFile(taskFile)).digest('hex');await client.tool('project_brief');await client.tool('project_brief_export');assert(before===exec(['status','--porcelain=v1','-z','--untracked-files=all'],fixture),'Git worktree mutated');assert(hash===createHash('sha256').update(await readFile(taskFile)).digest('hex'),'Task source mutated')})
await check('export','Useful Markdown with identity, changes, tasks and actions',5,async()=>{const r=await client.tool('project_brief_export');assert(!r.isError,'Export error');const t=visibleMarkdown(r);for(const s of [name,'modified space.txt','T1','Payment dependency'])assert(t.includes(s),'Export missing '+s);assert(/^#+\s/m.test(text(r)),'No Markdown headings');assert(/next|action/i.test(t),'No next actions')})
await check('export','Fresh reads after edits without server restart',5,async()=>{const fresh=[...tasks,{id:'T5',title:'New task after refresh',status:'open'}];await writeFile(taskFile,JSON.stringify(fresh));await writeFile(join(fixture,'fresh.txt'),'fresh');const r=await client.tool('project_brief_export');assert(!r.isError&&visibleMarkdown(r).includes('T5')&&visibleMarkdown(r).includes('fresh.txt'),'Export stale');const d=data(await client.tool('project_brief'));assert(d.tasks.some(t=>t.id==='T5')&&d.changes.some(c=>c.path==='fresh.txt'),'Brief stale')})
await check('documentation','Documented on-demand install and real task source',5,async()=>{const doc=(await readFile(join(dir,'README.md'),'utf8')).replace(/\s+/g,' ');assert(doc.length>=400,'Documentation too short');assert(/MCP Servers|MCP server/i.test(doc)&&doc.includes('.project-brief/tasks.json')&&/workspace/i.test(doc)&&/absolute/i.test(doc)&&/trust/i.test(doc),'Setup documentation incomplete')})
}catch(e){checks.push({group:'fatal',label:'Executable grading failed',passed:false,points:0,error:e.message})}finally{client?.close()}
const result={scorerVersion:'1.1',correction:'Normalize valid Markdown punctuation escapes and documentation whitespace for both outputs; original scores and v1 scorer retained.',side,id,score:checks.filter(c=>c.passed).reduce((n,c)=>n+c.points,0),maxScore:100,passed:checks.every(c=>c.passed),checks,verificationWallMs:performance.now()-start,verifiedAt:new Date().toISOString(),fixture,artifact:dir,repairs:0}
await writeFile(join(base,side+'-score.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify(result,null,2))
