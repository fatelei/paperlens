import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wordEvidence,joinCandidates,detailBoxes,isCode,detailRequired} from '../frontend/dist/detail-correction.mjs';
test('document evidence repairs split words but keeps genuine hyphens and SQL',()=>{
 const words=wordEvidence(['Postgres timestamp pushdowns time-series high-scale','Post-gres times-tamp push-down']);
 assert.equal(joinCandidates('A Post-gres times-tamp uses push-down.',words),'A Postgres timestamp uses pushdown.');
 assert.equal(joinCandidates('time-series high-scale data',words),null);
 assert.equal(joinCandidates('SELECT a-b FROM t;',words),null);
});
test('high score does not suppress suspicious words or figure/code inspection',()=>{
 const words=wordEvidence(['Postgres']);
 assert.equal(detailRequired({text:'Post-gres',category:'text',score:.99},words),true);
 assert.equal(isCode('SELECT loc region, COUNT(errormsg) FROM data;'),true);
 assert.equal(detailRequired({text:'0 50 100',layoutLabel:'figure',category:'text'},words),true);
});
test('small isolated zero and SQL punctuation survive pixel segmentation',()=>{
 const w=300,h=160,p=new Uint8ClampedArray(w*h*4).fill(255);
 const rect=(x,y,a,b)=>{for(let j=y;j<y+b;j++)for(let i=x;i<x+a;i++){let k=(j*w+i)*4;p[k]=p[k+1]=p[k+2]=0}};
 for(const x of [10,22,34,55,70])rect(x,10,7,12);rect(45,21,2,2);rect(64,23,6,1);
 // Axis and a separate zero glyph below it; no synthetic zero may be inferred.
 rect(10,90,250,1);rect(10,90,1,30);rect(8,130,7,12);
 const boxes=detailBoxes(w,h,p,{figure:true});
 for(const point of [[45,21],[64,23],[10,135]])assert.ok(boxes.some(b=>point[0]>=b[0]&&point[0]<b[2]&&point[1]>=b[1]&&point[1]<b[3]));
 assert.ok(boxes.every(b=>b[2]>b[0]&&b[3]>b[1]));
});
import {auditDetails,effectiveResult} from '../frontend/dist/correction.mjs';
test('detail conflicts keep high-score regions pending; manual text wins over late refinements',async()=>{
 const r={text:'SELECT loc region FROM t;',originalText:'SELECT loc region FROM t;',category:'text',revision:1,bbox:[0,0,100,30],score:.99,verdict:'scored'};
 await auditDetails(r,{refine:async()=>({accepted:false,reason:'punctuation conflict'})});assert.equal(effectiveResult(r).verdict,'unverified');
 await auditDetails(r,{version:2,refine:async()=>{r.manualEdited=true;r.text='manual';return{accepted:true,text:'overwritten',score:.99,verdict:'scored'}}});assert.equal(effectiveResult(r).text,'manual');
});
test('verified detail replacement is exported without modifying raw OCR',async()=>{
 const r={text:'COUNT(errormsg)',originalText:'COUNT(errormsg)',revision:1,bbox:[0,0,100,30],score:.2,verdict:'scored'};
 await auditDetails(r,{refine:async()=>({accepted:true,text:'COUNT(error_msg)',score:.98,verdict:'scored',parts:[{text:'COUNT(error_msg)',score:.98}]})});
 assert.equal(r.text,'COUNT(errormsg)');assert.equal(effectiveResult(r).text,'COUNT(error_msg)');assert.equal(effectiveResult(r).score,.98);
});
import {patchVerifiedDetails,detailVersion} from '../frontend/dist/detail-correction.mjs';
test('SQL patch repairs verified identifiers but never guesses decimal points',()=>{
 const part=text=>({text,score:.99,verdict:'scored'});
 assert.equal(patchVerifiedDetails('SELECT loc region, COUNT(errormsg) FROM data;',[part('SELECT loc.region, COUNT(error_msg) FROM data;')]),'SELECT loc.region, COUNT(error_msg) FROM data;');
 assert.equal(patchVerifiedDetails('SELECT x FROM data WHERE n > 12;',[part('SELECT x FROM data WHERE n > 1.2;')]),'SELECT x FROM data WHERE n > 12;');
 assert.notEqual(detailVersion(new Set(['word']),.9),detailVersion(new Set(['word','new']),.9));
});
test('temporary detail failure can be retried',async()=>{const r={text:'x',revision:1,bbox:[0,0,10,10]};await auditDetails(r,{refine:async()=>{throw Error('offline')}});await auditDetails(r,{refine:async()=>({accepted:true,text:'ok',score:.99,verdict:'scored'})});assert.equal(effectiveResult(r).text,'ok')});
import {needsReview} from '../frontend/dist/state.mjs';
test('partial detail repair never borrows an old high score',async()=>{const r={text:'SELECT loc region FROM t;',revision:1,bbox:[0,0,100,40],score:.99,verdict:'scored'};await auditDetails(r,{refine:async()=>({text:'SELECT loc.region FROM t;',score:.98,verdict:'scored',accepted:true,partial:true})});assert.equal(needsReview(r),true);assert.match(effectiveResult(r).text,/loc\.region/)});
