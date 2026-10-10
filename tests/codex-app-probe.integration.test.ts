import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runProbe,
  PROBE_NAME,
  PROBE_PROMPT,
  PROBE_REPLY,
} from '../scripts/codex-app-probe.js';

const fixture = async (mode = 'ok') => {
  const root = await mkdtemp(join(tmpdir(), 'codex-app-probe-test-'));
  const script = join(root, 'server.mjs');
  const calls = join(root, 'calls.jsonl');
  const saved = join(root, 'thread.json');
  await writeFile(
    script,
    `
import {createInterface} from 'node:readline';
import {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
const root=${JSON.stringify(root)}, mode=${JSON.stringify(mode)};
const calls=${JSON.stringify(calls)}, saved=${JSON.stringify(saved)};
let thread;
if(existsSync(saved)) thread=JSON.parse(readFileSync(saved,'utf8'));
const send=(message)=>process.stdout.write(JSON.stringify(message)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);appendFileSync(calls,JSON.stringify(m)+'\\n');
  let result={};
  if(m.method==='initialized')return;
  if(m.method==='initialize')result={codexHome:root,userAgent:'fixture'};
  else if(m.method==='project/list') result={data:[{id:'project-1',name:'Fixture',roots:[{path:root}]}],nextCursor:null};
  else if(m.method==='thread/list') {
    let data=[{id:'current-task',name:'Codex App Server Task PoC',preview:${JSON.stringify(PROBE_NAME)}}];
    if(thread)data.push(thread);
    if(mode==='duplicate-title')data.push({id:'existing-probe',name:${JSON.stringify(PROBE_NAME)}});
    let nextCursor=null;
    if(mode==='paginated-duplicate'){
      if(m.params.cursor==='next')data=[{id:'existing-probe',name:${JSON.stringify(PROBE_NAME)}}];
      else nextCursor='next';
    }
    result={data,nextCursor};
  }
  else if(m.method==='thread/start') {
    thread={id:'thread-1',cwd:m.params.cwd,projectId:m.params.projectId,ephemeral:m.params.ephemeral,path:root+'/sessions/thread-1.jsonl',name:null,forkedFromId:null,parentThreadId:null,turns:[]};
    writeFileSync(saved,JSON.stringify(thread));
    if(mode==='lost-response')return;
    result={thread,model:'fixture',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}};
  }
  else if(m.method==='thread/name/set'){thread.name=m.params.name;writeFileSync(saved,JSON.stringify(thread));}
  else if(m.method==='turn/start') {
    const turn={id:'turn-1',status:'completed',error:null,items:[{type:'userMessage',content:m.params.input},{type:'agentMessage',text:${JSON.stringify(PROBE_REPLY)}}]};
    if(mode==='failed'){turn.status='failed';turn.error={message:'fixture failure'};}
    if(mode==='wrong-reply')turn.items[1].text='unexpected';
    if(mode==='tool')turn.items.push({type:'commandExecution'});
    thread.turns.push(turn);writeFileSync(saved,JSON.stringify(thread));
    // Complete before the response to exercise notification buffering.
    send({method:'turn/completed',params:{threadId:thread.id,turn}});
    result={turn:{id:turn.id,status:'inProgress'}};
  }
  else if(m.method==='thread/read')result={thread};
  else {send({id:m.id,error:{code:-32601,message:'Unknown method'}});return;}
  send({id:m.id,result});
});
`,
  );
  const options = {
    create: true,
    cwd: root,
    codexHome: root,
    journal: join(root, 'probe.jsonl'),
    executable: process.execPath,
    serverArgs: [script],
    timeoutMs: 5000,
  };
  return { root, calls, saved, options };
};

test('persistent fresh thread, read-only turn, independent read and rerun never creates twice', async () => {
  const f = await fixture();
  try {
    const report = await runProbe(f.options);
    assert.equal(report.verdict, 'UNVERIFIED');
    assert.equal(report.api, 'PASS');
    assert.equal(report.threadId, 'thread-1');
    assert.equal(report.reply, PROBE_REPLY);
    await assert.rejects(runProbe(f.options), /EEXIST/);
    const verify = await runProbe({ ...f.options, create: false });
    assert.equal(verify.turnCount, 1);
    const calls = (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      calls.filter((call) => call.method === 'thread/start').length,
      1,
    );
    assert.equal(
      calls.filter((call) => call.method === 'turn/start').length,
      1,
    );
    assert.ok(
      calls.every(
        (call) => !['thread/resume', 'thread/fork'].includes(call.method),
      ),
    );
    const start = calls.find((call) => call.method === 'thread/start');
    assert.deepEqual(start.params, {
      cwd: f.root,
      projectId: 'project-1',
      ephemeral: false,
      historyMode: 'legacy',
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    const turn = calls.find((call) => call.method === 'turn/start');
    assert.deepEqual(turn.params.input, [
      { type: 'text', text: PROBE_PROMPT, text_elements: [] },
    ]);
    assert.equal(turn.params.sandboxPolicy.type, 'readOnly');
    assert.equal(JSON.parse(await readFile(f.saved, 'utf8')).name, PROBE_NAME);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const mode of ['failed', 'wrong-reply', 'tool']) {
  test(`reject ${mode} without retrying the thread or prompt`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(runProbe(f.options));
      const journal = await readFile(f.options.journal, 'utf8');
      assert.ok(journal.includes('thread-1'));
      assert.ok(journal.includes('"verdict":"FAIL"'));
      await assert.rejects(runProbe(f.options), /EEXIST/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test('lost thread/start response retains intent and refuses replay', async () => {
  const f = await fixture('lost-response');
  try {
    await assert.rejects(
      runProbe({ ...f.options, timeoutMs: 400 }),
      /timed out/,
    );
    assert.ok((await readFile(f.options.journal, 'utf8')).includes('intent'));
    assert.equal(JSON.parse(await readFile(f.saved, 'utf8')).id, 'thread-1');
    await assert.rejects(runProbe(f.options), /EEXIST/);
    await assert.rejects(
      runProbe({ ...f.options, create: false }),
      /Expected an object/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('profile mismatch fails before creating any thread', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runProbe({ ...f.options, codexHome: join(f.root, 'other') }),
      /profile mismatch/,
    );
    assert.ok(!(await readFile(f.calls, 'utf8')).includes('thread/start'));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('concurrent create attempts share one durable claim', async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([
      runProbe(f.options),
      runProbe(f.options),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === 'rejected').length,
      1,
    );
    const calls = (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      calls.filter((call) => call.method === 'thread/start').length,
      1,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('server launch error is recorded and cannot be replayed', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runProbe({
        ...f.options,
        serverArgs: [join(f.root, 'missing-server.mjs')],
      }),
      /App Server closed/,
    );
    assert.ok(
      (await readFile(f.options.journal, 'utf8')).includes('"method":"error"'),
    );
    await assert.rejects(runProbe(f.options), /EEXIST/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const mode of ['duplicate-title', 'paginated-duplicate']) {
  test(`existing probe title (${mode}) stops before thread/start`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(runProbe(f.options), /A probe already exists/);
      const calls = await readFile(f.calls, 'utf8');
      assert.ok(!calls.includes('thread/start'));
      await assert.rejects(runProbe(f.options), /EEXIST/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}
