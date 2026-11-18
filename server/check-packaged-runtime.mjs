import {mkdtempSync,symlinkSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';
import {prepareRelease} from './prepare-release.mjs';
import {RUNTIME_VERSION} from './lib/runtime-version.mjs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve,basename,sep} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'mt-package-'));
try{
 const release=join(directory,'release'),manifest=prepareRelease(release);
 assert.equal(manifest.runtime_version,RUNTIME_VERSION);
 assert.match(manifest.release_tag,/^beta-[a-f0-9]{16}$/);
 assert.ok(manifest.files.some(f=>f.path==='server/lib/request-owner.mjs'));
 assert.ok(manifest.files.some(f=>f.path==='mixtouring-hifi/assets/desktop-ui.js'));
 assert.ok(manifest.files.every(f=>!/(^|\/)(?:\.env[^/]*|\.state|logs|node_modules|design)(\/|$)/.test(f.path)));
 assert.throws(()=>prepareRelease(release),'不覆盖已有发布目录');
 symlinkSync(resolve('server/node_modules'),join(release,'server/node_modules'),'junction');
 for(const script of ['check-public-http.mjs','check-user-isolation.mjs'])execFileSync(process.execPath,[join(release,'server',script)],{cwd:release,env:{...process.env,MT_LLM_USAGE_LOG:join(directory,'usage.jsonl')},stdio:'pipe',timeout:30000,windowsHide:true});
 console.log('✓ 正式发布打包、文件哈希、敏感目录排除、独立目录HTTP与双用户隔离');
}finally{
 if(resolve(directory).startsWith(resolve(tmpdir())+sep)&&basename(directory).startsWith('mt-package-'))rmSync(directory,{recursive:true,force:true});
}
