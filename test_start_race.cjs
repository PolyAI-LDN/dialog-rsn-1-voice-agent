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

test('two clicks while AudioContext resumes create only one conversation',async()=>{
  const p=page();
  const first=vm.runInContext("start('mic')",p.ctx);
  const second=vm.runInContext("start('mic')",p.ctx);
  assert.equal(p.contexts(),1);
  p.pending.forEach(resolve=>resolve());
  await Promise.all([first,second]);
});
