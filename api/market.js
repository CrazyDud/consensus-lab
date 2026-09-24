const COINBASE='https://api.exchange.coinbase.com';
const KRAKEN='https://api.kraken.com/0/public';

function send(res,status,body){
  res.status(status);
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.send(JSON.stringify(body));
}

async function coinbase(){
  const end=Math.floor(Date.now()/1000),start=end-299*300;
  const headers={'User-Agent':'consensus-lab/0.3'};
  const [cr,tr]=await Promise.all([
    fetch(`${COINBASE}/products/BTC-USD/candles?granularity=300&start=${new Date(start*1000).toISOString()}&end=${new Date(end*1000).toISOString()}`,{headers}),
    fetch(`${COINBASE}/products/BTC-USD/ticker`,{headers})
  ]);
  if(!cr.ok||!tr.ok)throw new Error(`Coinbase HTTP ${cr.status}/${tr.status}`);
  const candles=await cr.json(),ticker=await tr.json();
  if(!Array.isArray(candles)||candles.length<70||!ticker?.price)throw new Error('Coinbase returned incomplete market data');
  return{provider:'coinbase',candles,ticker};
}

async function kraken(){
  const [or,tr]=await Promise.all([
    fetch(`${KRAKEN}/OHLC?pair=XBTUSD&interval=5`),
    fetch(`${KRAKEN}/Ticker?pair=XBTUSD`)
  ]);
  if(!or.ok||!tr.ok)throw new Error(`Kraken HTTP ${or.status}/${tr.status}`);
  const o=await or.json(),t=await tr.json();
  if(o.error?.length||t.error?.length)throw new Error('Kraken API error');
  const oKey=Object.keys(o.result||{}).find(k=>k!=='last'),tKey=Object.keys(t.result||{})[0];
  const rows=(o.result?.[oKey]||[]).slice(-300),tk=t.result?.[tKey];
  if(rows.length<70||!tk)throw new Error('Kraken returned incomplete market data');
  const candles=rows.map(r=>[Number(r[0]),Number(r[3]),Number(r[2]),Number(r[1]),Number(r[4]),Number(r[6])]);
  const ticker={price:String(tk.c?.[0]),bid:String(tk.b?.[0]),ask:String(tk.a?.[0]),time:new Date().toISOString()};
  return{provider:'kraken',candles,ticker};
}

export default async function handler(req,res){
  if(req.method!=='GET')return send(res,405,{error:'Method not allowed'});
  try{
    const data=await coinbase();
    return send(res,200,{...data,serverTime:new Date().toISOString()});
  }catch(primaryError){
    try{
      const data=await kraken();
      return send(res,200,{...data,serverTime:new Date().toISOString(),fallback:true,primaryError:primaryError.message});
    }catch(fallbackError){
      return send(res,502,{error:'Both public market-data providers are unavailable',coinbase:primaryError.message,kraken:fallbackError.message});
    }
  }
}