const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/app.js','utf8').replace(/^init\(\);$/m,'');
function page() {
  const elements = new Map();
  let contexts=0;
  const pending=[];
  class Context {
    constructor() { contexts++; this.destination={}; this.audioWorklet={addModule:async()=>{}}; }
    resume(){ return new Promise(resolve=>pending.push(resolve)); }
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
    close(){}
  }
  class Socket {static OPEN=1;constructor(){this.readyState=0;}close(){this.readyState=3;}send(){} }
  const ctx=vm.createContext({
    console,Int16Array,ArrayBuffer,Date,performance,Promise,
    document:{getElementById(id){if(!elements.has(id))elements.set(id,{value:'',classList:{add(){},remove(){}}});return elements.get(id);}},
    AudioContext:Context,AudioWorkletNode:class{constructor(){this.port={postMessage(){}};}connect(){}},
    WebSocket:Socket, location:{protocol:'http:',host:'localhost'},
    navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[]}),enumerateDevices:async()=>[]}},
    setInterval(){return 1;},clearInterval(){},
  });
  vm.runInContext(source,ctx);
  vm.runInContext('logEvent=()=>{};',ctx);
  return {ctx,pending,contexts:()=>contexts};
}

test('late messages from a previous socket cannot stop the new conversation',async()=>{
  const p=page();
  let starting=vm.runInContext("start('mic')",p.ctx);p.pending.shift()();await starting;
  vm.runInContext('globalThis.oldSocket=run.ws;stop();',p.ctx);
  starting=vm.runInContext("start('mic')",p.ctx);p.pending.shift()();await starting;
  vm.runInContext(`
    const current=run;
    oldSocket.onmessage({data:JSON.stringify({type:'agent.error',message:'old call failed'})});
    if(run!==current)throw new Error('late message stopped the new call');
  `,p.ctx);
});

test('late open from a previous socket cannot start another upstream call',async()=>{
  const p=page();
  let starting=vm.runInContext("start('mic')",p.ctx);p.pending.shift()();await starting;
  vm.runInContext('globalThis.oldSocket=run.ws;stop();',p.ctx);
  starting=vm.runInContext("start('mic')",p.ctx);p.pending.shift()();await starting;
  vm.runInContext(`
    let sent=0;
    oldSocket.send=()=>sent++;
    oldSocket.onopen();
    if(sent!==0)throw new Error('stale socket sent a new start');
  `,p.ctx);
});
test('an old sample end cannot start the new call shutdown timer',()=>{
  const p=page();
  vm.runInContext(`
    let ended=0;
    finishWhenQuiet=()=>ended++;
    const oldSource={connect(){},start(){}};
    run={source:oldSource,capture:{},mode:'sample'};
    begin();
    run={mode:'mic'};
    oldSource.onended();
    if(ended!==0)throw new Error('old sample started a new call timer');
  `,p.ctx);
});
