// Split only across near-white gutters. Every source pixel belongs to one child.
export function splitRaster(width,height,rgba,maxDepth=2,allowColumns=true){
 const cut=(b,depth)=>{
  if(!depth||b[2]-b[0]<100||b[3]-b[1]<60)return [b];
  for(const axis of (allowColumns?[0,1]:[1])){
   const start=b[axis],end=b[axis+2],span=end-start,other=1-axis;
   if(span<(axis===0?220:100))continue;
   const lo=b[other]+Math.max(3,Math.round((b[other+2]-b[other])*.035)),hi=b[other+2]-Math.max(3,Math.round((b[other+2]-b[other])*.035));
   let run=null,best=null;
   for(let p=Math.ceil(start+span*(axis===0?.2:.1));p<Math.floor(end-span*(axis===0?.2:.06));p++){
    let ink=0;for(let q=lo;q<hi;q++){const x=axis===0?p:q,y=axis===0?q:p,k=(y*width+x)*4;if((rgba[k]+rgba[k+1]+rgba[k+2])/3<185)ink++}
    if(ink<=Math.max(1,(hi-lo)*.008)){if(run===null)run=p}else if(run!==null){if(!best||p-run>best[1]-best[0])best=[run,p];run=null}
   }
   if(best&&best[1]-best[0]>=Math.max(4,span*.008)){
    const mid=Math.round((best[0]+best[1])/2),a=[...b],c=[...b];a[axis+2]=mid;c[axis]=mid;
    return [...cut(a,depth-1),...cut(c,depth-1)];
   }
  }return[b];
 };return cut([0,0,width,height],maxDepth);
}
