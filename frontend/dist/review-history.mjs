// Store references and revision guards, never old text: undo must preserve edits.
export function recordReview(doc,pageIndex,r){
 doc.reviewHistory=[...(doc.reviewHistory||[]),{pageIndex,regionId:r.id,revision:r.revision}].slice(-100);
}
export function lastReview(doc){
 if(!doc)return null;
 for(let i=(doc.reviewHistory?.length||0)-1;i>=0;i--){
  const entry=doc.reviewHistory[i],page=doc.pages[entry.pageIndex];
  const regionIndex=page?.regions.findIndex(r=>r.id===entry.regionId)??-1,r=page?.regions[regionIndex];
  if(r&&!r.aggregate&&r.reviewed&&r.revision===entry.revision)return {historyIndex:i,pageIndex:entry.pageIndex,regionIndex,region:r};
 }return null;
}
export function undoLastReview(doc){
 const last=lastReview(doc);if(!last)return null;
 doc.reviewHistory.splice(last.historyIndex);
 last.region.reviewed=false;last.region.reviewReopened=true;last.region.revision=(last.region.revision||0)+1;
 return last;
}
