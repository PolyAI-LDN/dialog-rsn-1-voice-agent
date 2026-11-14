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

test('sample completion sends the buffered final samples before silence',()=>{
  const {ctx}=page();
  vm.runInContext(`
    const sent=[];
    run={frame:new Int16Array(2400),fill:3,ws:{readyState:1,send(b){sent.push(new Int16Array(b).slice());}}};
    run.frame.set([100,200,300]);
    finishWhenQuiet();
    if(sent.length!==1)throw new Error('last partial frame was not sent');
    if(sent[0][0]!==100||sent[0][1]!==200||sent[0][2]!==300)throw new Error('audio samples changed');
    if(sent[0].slice(3).some(x=>x!==0))throw new Error('tail was not padded with silence');
    if(run.fill!==0)throw new Error('partial frame remains buffered');
  `,ctx);
});
