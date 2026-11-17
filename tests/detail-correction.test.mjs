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
import {supportedJoin} from '../frontend/dist/detail-correction.mjs';
test('independent reread must support joins without deleting genuine in-line hyphens',()=>{
 assert.equal(supportedJoin('Please resign the contract.',[{text:'Please re-sign the contract.'}]),false);
 assert.equal(supportedJoin('A Postgres extension.',[{text:'A Post-'},{text:'gres extension.'}]),true);
 assert.equal(supportedJoin('A Postgres extension.',[{text:'A Postgres extension. Unexpected text'}]),false);
});
import {currentProof} from '../frontend/dist/proofread.mjs';
test('corrected export retains review warning for partial high-score SQL repairs',async()=>{
 const r={id:'sql',auto:true,text:'SELECT loc region FROM t;',originalText:'SELECT loc region FROM t;',revision:1,bbox:[0,0,100,40],score:.99,verdict:'scored'};
 await auditDetails(r,{refine:async()=>({text:'SELECT loc.region FROM t;',score:.98,verdict:'scored',accepted:true,partial:true})});
 const p={width:100,height:40,regions:[{aggregate:true,text:r.text},r],scanAudit:{status:'complete'},reference:{status:'unavailable'}};
 const proof=currentProof(p);assert.equal(proof.status,'partial');assert.equal(proof.unresolved,1);assert.match(proof.text,/loc\.region/);
});
import {joinReread,sqlPunctuationCandidates,patchVerifiedScales} from '../frontend/dist/detail-correction.mjs';
test('physical line joins preserve genuine hyphens while repairing split words',()=>{const words=wordEvidence(['timestamp high-scale pushdowns']);assert.equal(joinReread([{text:'a times-'},{text:'tamp in high-'},{text:'scale data'}],words),'a timestamp in high-scale data')});
test('SQL punctuation hypotheses require an existing alias and image verification downstream',()=>{assert.deepEqual(sqlPunctuationCandidates('SELECT loc region, AVG(bus.speed) FROM bus','WHERE loc.city = 1'),['SELECT loc.region, AVG(bus.speed) FROM bus']);assert.deepEqual(sqlPunctuationCandidates('SELECT name FROM data','WHERE data.id = 1'),[])});
test('scales are copied only from matching verified image rows, never extrapolated',()=>{const p={bbox:[0,0,100,10],text:'0 50 100 150 200 250',score:.99,verdict:'scored'},s='50 100 150 200 250';assert.equal(patchVerifiedScales(s,[p]),p.text);assert.equal(patchVerifiedScales(s,[{...p,score:.5}]),s);assert.equal(patchVerifiedScales(s+'\n'+s,[p]),s+'\n'+s);assert.equal(patchVerifiedScales(s+'\n'+s,[p,{...p,bbox:[200,0,300,10]}]),p.text+'\n'+p.text)});

test('token verification cannot authorize punctuation elsewhere in its line',()=>{assert.equal(patchVerifiedDetails('SELECT goodname,badname FROM t',[{text:'SELECT good_name,bad_name FROM t',tokenEvidence:{text:'good_name'},score:.99,verdict:'scored'}]),'SELECT good_name,badname FROM t')});
test('chart evidence already present or duplicated cannot repair another chart',()=>{const p={bbox:[0,0,100,10],text:'0 50 100 150',score:.99,verdict:'scored'},s='50 100 150 200';assert.equal(patchVerifiedScales('50 100 150 200\n0 50 100 150 200',[{...p,text:'0 50 100 150 200'}]),'50 100 150 200\n0 50 100 150 200');assert.equal(patchVerifiedScales(s+'\n'+s,[{...p,text:'0 '+s},{...p,text:'0 '+s}]),s+'\n'+s)});
test('single line glyphs survive component filtering',()=>{const p=new Uint8Array(100*30*4).fill(255);for(let y=8;y<20;y++)for(let x=10;x<18;x++){const i=(y*100+x)*4;p[i]=p[i+1]=p[i+2]=0}assert.equal(detailBoxes(100,30,p).length,1)});
