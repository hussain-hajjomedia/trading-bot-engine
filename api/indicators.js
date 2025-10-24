export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }
  const payload = req.body;
  try {
    const { symbol, exchangeSymbol, klines } = payload;
    function toNum(v){ return typeof v==='number' ? v : parseFloat(v); }
    function sma(v,p){const o=new Array(v.length).fill(null);if(p<=0)return o;let s=0;for(let i=0;i<v.length;i++){s+=v[i];if(i>=p)s-=v[i-p];if(i>=p-1)o[i]=s/p;}return o;}
    function ema(v,p){const o=new Array(v.length).fill(null);const k=2/(p+1);let prev=v[0];o[0]=prev;for(let i=1;i<v.length;i++){prev=(v[i]*k)+(prev*(1-k));o[i]=prev;}for(let i=0;i<p-1&&i<o.length;i++)o[i]=null;return o;}
    function rsi(v,p=14){const o=new Array(v.length).fill(null);let g=0,l=0;for(let i=1;i<=p&&i<v.length;i++){const c=v[i]-v[i-1];if(c>0)g+=c;else l+=-c;if(i===p){let avgG=g/p,avgL=l/p;const rs=avgL===0?100:avgG/avgL;o[i]=100-(100/(1+rs));var aG=avgG,aL=avgL;}}for(let i=p+1;i<v.length;i++){const c=v[i]-v[i-1];const G=Math.max(0,c),L=Math.max(0,-c);aG=((aG*(p-1))+G)/p;aL=((aL*(p-1))+L)/p;const rs=aL===0?100:aG/aL;o[i]=100-(100/(1+rs));}return o;}
    function macd(v,f=12,s=26,si=9){const eF=ema(v,f),eS=ema(v,s);const m=v.map((_,i)=>(eF[i]===null||eS[i]===null)?null:eF[i]-eS[i]);const sig=ema(m.map(x=>x??0),si);const h=m.map((x,i)=>(x===null||sig[i]===null)?null:x-sig[i]);return{macdLine:m,signalLine:sig,hist:h};}
    function tr(h,l,c){const r=[];for(let i=0;i<h.length;i++){if(i===0)r.push(h[i]-l[i]);else r.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));}return r;}
    function atr(h,l,c,p=14){const R=tr(h,l,c);const o=new Array(R.length).fill(null);let s=0;for(let i=0;i<R.length;i++){if(i<p){s+=R[i];if(i===p-1)o[i]=s/p;continue;}o[i]=((o[i-1]*(p-1))+R[i])/p;}return o;}
    function superT(h,l,c,p=10,m=3){const A=atr(h,l,c,p);const hl2=h.map((x,i)=>(x+l[i])/2);const u=hl2.map((x,i)=>x+m*(A[i]||0));const d=hl2.map((x,i)=>x-m*(A[i]||0));const fu=new Array(c.length).fill(null);const fl=new Array(c.length).fill(null);const st=new Array(c.length).fill(null);let dir=1;for(let i=0;i<c.length;i++){if(i===0){fu[i]=u[i];fl[i]=d[i];st[i]=null;continue;}fu[i]=(u[i]<fu[i-1]||c[i-1]>fu[i-1])?u[i]:fu[i-1];fl[i]=(d[i]>fl[i-1]||c[i-1]<fl[i-1])?d[i]:fl[i-1];if(st[i-1]===fu[i-1]){if(c[i]<fu[i]){st[i]=fu[i];dir=-1;}else{st[i]=fl[i];dir=1;}}else{if(c[i]>fl[i]){st[i]=fl[i];dir=1;}else{st[i]=fu[i];dir=-1;}}}return{st,dir};}

    const out={symbol,exchangeSymbol,timeframes:{}};
    for(const tf of Object.keys(klines)){
      const k=klines[tf];
      const o=k.map(c=>toNum(c.open)),h=k.map(c=>toNum(c.high)),l=k.map(c=>toNum(c.low)),cl=k.map(c=>toNum(c.close)),v=k.map(c=>toNum(c.volume));
      const sma50=sma(cl,50),ema9=ema(cl,9),rsi14=rsi(cl,14),mac=macd(cl,12,26,9),atr14=atr(h,l,cl,14),st=superT(h,l,cl,10,3);
      const i=cl.length-1;const last={open:o[i],high:h[i],low:l[i],close:cl[i],volume:v[i]};
      const sig=(mac.macdLine[i]>mac.signalLine[i]&&cl[i]>ema9[i]&&st.dir===1)?"BUY":(mac.macdLine[i]<mac.signalLine[i]&&cl[i]<ema9[i]&&st.dir===-1)?"SELL":"HOLD";
      out.timeframes[tf]={last,indicators:{sma50:sma50[i],ema9:ema9[i],rsi14:rsi14[i],macd:mac.macdLine[i],signal:mac.signalLine[i],hist:mac.hist[i],atr14:atr14[i]},signal:sig};
    }
    let votes={BUY:0,SELL:0,HOLD:0};for(const t in out.timeframes){votes[out.timeframes[t].signal]++;}
    let final_signal="HOLD";if(votes.BUY>1)final_signal="BUY";if(votes.SELL>1)final_signal="SELL";
    res.status(200).json({symbol,final_signal,votes,details:out});
  } catch(e){res.status(500).json({error:e.message});}
}
