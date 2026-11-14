import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const directory = path.resolve(process.argv[2] ?? 'public/browser-host');
const origin = 'http://127.0.0.1:43777';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.route(origin + '/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Hang probe</title>'});
    if (!url.pathname.startsWith('/browser-host/')) return route.fulfill({status:404});
    try {
      const relative = url.pathname.slice('/browser-host/'.length);
      const body = await readFile(path.join(directory, relative));
      const contentType = /\.m?js$/.test(relative) ? 'text/javascript' : relative.endsWith('.json') ? 'application/json' : relative.endsWith('.html') ? 'text/html' : relative.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      return route.fulfill({body,contentType});
    } catch { return route.fulfill({status:404}); }
  });
  const page = await context.newPage();
  page.on('console', message => console.log('browser:', message.text()));
  await page.goto(origin);
  console.log(JSON.stringify(await page.evaluate(async origin => {
    const manifest = await (await fetch('/browser-host/current.json')).json();
    const {BrowserHost} = await import(origin + manifest.base_url + manifest.entry);
    const originalBoot = BrowserHost.prototype.boot;
    BrowserHost.prototype.boot = function() {
      const file = this.installation.files.find(file => file.path === 'execution-worker.mjs');
      file.data = new TextEncoder().encode(new TextDecoder().decode(file.data).replace('let code = null;', "send({type:'probe_run_returned',run_id:runId,events,httpActive:httpActive.size}); let code = null;"));
      return originalBoot.call(this);
    };
    const hosts=[];
    const create = async () => { const host = await BrowserHost.create({backend:origin,owner:'hang-probe',browserId:crypto.randomUUID(),conversationId:crypto.randomUUID(),workspaceId:crypto.randomUUID(),allowedOrigins:[]}); hosts.push(host); return host; };
    const frames=[];
    const watch = host => { const receive=host.receiveExecution.bind(host); host.receiveExecution=data=>{frames.push({type:data.type,run_id:data.run_id,id:data.id,code:data.code,events:data.events?.map(event => Object.hasOwn(event, 'Exit') ? { Exit: event.Exit } : { stdout_bytes: event.Stdout?.length, stderr_bytes: event.Stderr?.length }),httpActive:data.httpActive}); receive(data);}; };
    const command = async(host, text) => {
      const launch=await host.execute({method:'shell_launch',params:{command:text,output_bytes:4096}});
      const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(Error('test observation deadline')),5000);
      let waitError;
      try { await host.execute({method:'process_wait',params:{handle:launch.handle}},controller.signal); } catch(error){waitError=error.message;}
      finally {clearTimeout(timer);}
      const status=await host.execute({method:'process_status',params:{handle:launch.handle}});
      const output=await host.execute({method:'shell_read',params:{handle:launch.handle,from:null}});
      return {handle:launch.handle,status,output,waitError,httpRequests:host.httpRequests,pending:host.network.pending.size};
    };
    const quote=value=>"'"+value.replaceAll("'", "'\"'\"'")+"'";
    const asyncCode="import asyncio, js\nasync def main():\n    response = await js.fetch('https://example.com')\nasyncio.get_event_loop().run_until_complete(main())";
    const metadata='import pyodide, pyodide.http, pyodide.ffi; print("pyodide",getattr(pyodide,"__version__","?")); print("http",[x for x in dir(pyodide.http) if not x.startswith("_")]); print("ffi",[x for x in dir(pyodide.ffi) if not x.startswith("_")])';
    try {
      const host=await create();watch(host);
      const first=await command(host,'python3 -c '+quote(asyncCode));
      const second=await command(host,'python3 -c '+quote(metadata));
      let echo;try{echo=await command(host,'echo after-python');}catch(error){echo={error:error.message,code:error.code};}
      if(second.status.state==='running') await host.execute({method:'process_kill',params:{handle:second.handle,force:true}});
      const fresh=await create();watch(fresh);
      const cleanMetadata=await command(fresh,'python3 -c '+quote(metadata));
      const cleanEcho=await command(fresh,'echo fresh-ok');
      return {artifactHash:manifest.hash,first,second,echo,cleanMetadata,cleanEcho,frames};
    } finally {for(const host of hosts) await host.close();}
  },origin),null,2));
} finally {await browser.close();}
