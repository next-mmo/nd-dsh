import subprocess, tempfile, pathlib, json, time, urllib.request, urllib.error, zipfile, io, re, os, signal
root=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory() as temp:
    work=pathlib.Path(temp); binary=work/'nd-cloud'
    subprocess.run(['go','build','-o',str(binary),'.'],cwd=root,check=True,stdout=subprocess.DEVNULL)
    db=work/'private'/'state.json'
    def cmd(*args):
        c=subprocess.run([str(binary),*args,'-data',str(db)],text=True,capture_output=True)
        if c.returncode: raise RuntimeError(c.stderr)
        return c.stdout
    owner=re.search(r'ndp_[a-zA-Z0-9_-]+',cmd('bootstrap','-tenant','company','-name','Pilot','-subject','owner')).group(0)
    # Windows terminate() is a hard kill that strands the cooperative writer
    # lock; CTRL_BREAK reaches Go's os.Interrupt handler for a graceful stop.
    popen_kw={'creationflags':subprocess.CREATE_NEW_PROCESS_GROUP} if os.name=='nt' else {}
    def stop(proc):
        proc.send_signal(signal.CTRL_BREAK_EVENT if os.name=='nt' else signal.SIGTERM)
        proc.wait(timeout=5)
    proc=subprocess.Popen([str(binary),'serve','-data',str(db),'-addr','127.0.0.1:18787'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,**popen_kw)
    def request(method,path,token,body=None,content_type='application/json'):
        if body is not None and not isinstance(body,bytes):body=json.dumps(body).encode()
        req=urllib.request.Request('http://127.0.0.1:18787'+path,data=body,method=method,headers={'Authorization':'Bearer '+token,'Content-Type':content_type,'X-ND-Source-Filename':'pos.zip'})
        try:
            with urllib.request.urlopen(req,timeout=2) as r: return r.status,json.load(r)
        except urllib.error.HTTPError as e:
            return e.code,json.load(e)
    try:
        for i in range(50):
            try:
                request('GET','/v1/me',owner)
                break
            except Exception:time.sleep(.1)
        status,project=request('POST','/v1/tenants/company/projects',owner,{'name':'POS'});assert status==201,project
        base='/v1/projects/'+project['id']
        buf=io.BytesIO()
        with zipfile.ZipFile(buf,'w') as z:z.writestr('docs/policy.md','# Policy v1\n')
        status,source=request('POST',base+'/sources/zip',owner,buf.getvalue(),'application/zip');assert status==201,source
        status,spec=request('POST',base+'/specs',owner,{'source_snapshot_id':source['id'],'source_path':'docs/policy.md','title':'Policy','body':'Approved by manager'});assert status==201,spec
        status,data=request('GET',base+'/specs',owner);assert status==200 and len(data['specs'])==1
        status,denied=request('POST',base+'/specs/'+spec['id']+'/approve',owner,{'expected_revision':1});assert status==403,denied
        print('HTTP: owner creates project, imports safe source, drafts spec; self-approval forbidden: PASS')
        # Serve process holds the writer lock; operator cannot mutate concurrently.
        concurrent=subprocess.run([str(binary),'grant','-data',str(db),'-tenant','company','-subject','test','-projects',project['id']],capture_output=True,text=True)
        assert concurrent.returncode!=0 and 'locked' in concurrent.stderr,concurrent.stderr
        print('HTTP: second operator writer blocked during server session: PASS')
    finally:
        stop(proc)
    # Once stopped, issue a separate reviewer then restart and approve.
    c=subprocess.run([str(binary),'grant','-data',str(db),'-tenant','company','-subject','reviewer','-role','reviewer','-projects',project['id']],capture_output=True,text=True)
    assert c.returncode==0,c.stderr
    reviewer=re.search(r'ndp_[a-zA-Z0-9_-]+',c.stdout).group(0)
    proc=subprocess.Popen([str(binary),'serve','-data',str(db),'-addr','127.0.0.1:18787'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,**popen_kw)
    try:
        for i in range(50):
            try:
                status,approved=request('POST',base+'/specs/'+spec['id']+'/approve',reviewer,{'expected_revision':1})
                if status==200:break
            except Exception:time.sleep(.1)
        assert status==200,approved
        print('HTTP: restarted server, different reviewer approves exact spec revision: PASS')
    finally:stop(proc)
    backup=work/'secure.nd.json'
    env=dict(os.environ,ND_CLOUD_BACKUP_PASSPHRASE='safe long passphrase for test only')
    secure=subprocess.run([str(binary),'backup-encrypted','-data',str(db),'-out',str(backup)],capture_output=True,text=True,env=env)
    assert secure.returncode==0,secure.stderr
    restored=work/'restored'/'state.json'
    secure=subprocess.run([str(binary),'restore-encrypted','-data',str(restored),'-from',str(backup)],capture_output=True,text=True,env=env)
    assert secure.returncode==0,secure.stderr
    raw=restored.read_text();assert '"schema_version": 4' in raw and '"approved"' in raw and owner not in raw
    print('CLI: authenticated encrypted backup, restore, schema v4 and reviewed spec persisted: PASS')
