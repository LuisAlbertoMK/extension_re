const shim = require('D:/extension_ser/tests/shim.cjs');
const { base, rect } = require('D:/extension_ser/tests/frames.cjs');
const W=1600,H=900;
function multiFrame(){const {d}=base(W,H,11);[[60,200],[180,200]].forEach(([x,y])=>{rect(d,W,x,y,30,30,245,245,245);rect(d,W,x+9,y+9,12,12,190,45,40);});rect(d,W,400,300,44,44,250,250,250);rect(d,W,414,314,12,12,220,190,40);return{w:W,h:H,data:d};}
let dialogOpen=false;
let scans=0;
const T=shim.load('resources.js','{ start, stop, CFG, stats, dbg: () => ({running,status,lastError}) }',(sb)=>{sb.__SRToolkit={show(){},register(){},hasOverlay:()=>false,captureClean(){scans++;if(dialogOpen){const {d}=base(W,H,6);[[420,380],[620,380],[420,460],[620,460]].forEach(([x,y])=>rect(d,W,x,y,100,30,250,250,250));shim.CUR={w:W,h:H,data:d};return Promise.resolve({dataUrl:'shot'});}shim.CUR=multiFrame();return Promise.resolve({dataUrl:'shot'});},input:{moveTo:async()=>{},click:async()=>true,get position(){return{x:800,y:450};}}};});
Object.assign(T.CFG,{cycMin:60000,cycMax:60000,gapMin:0,gapMax:0,selMin:0,selMax:0,option:0});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const main=async()=>{
  T.start();
  await wait(2000);
  console.log('after 2s: scans',scans,'chosen',T.stats.chosen,'meat',T.stats.meat,'gold',T.stats.gold,'running',T.dbg().running,'err',T.dbg().lastError);
  T.stop();
  await wait(100);
  console.log('FINAL meat',T.stats.meat,'gold',T.stats.gold,'scans',scans);
  process.exit(0);
};
main();
