import { scorePair, explainScore, fmtUSD } from './scorer.js';
const DS = 'https://api.dexscreener.com';

const PRESETS = {
  spicy: {
    chains:['solana','base'],
    filters:{minLiquidityUSD:3000,minVolumeH24:2000,minTxnsH24Buys:5,minTxnsH24Sells:3,maxPairAgeHours:120,fdvMin:0,fdvMax:8000000,includeLowActivity:true},
    weights:{liquidity:0.2,volumeH24:0.2,momentum5m:0.35,age:0.15,fdvFit:0.1},
    display:{topN:30}
  },
  balanced: {
    chains:['solana','base'],
    filters:{minLiquidityUSD:8000,minVolumeH24:5000,minTxnsH24Buys:10,minTxnsH24Sells:5,maxPairAgeHours:72,fdvMin:100000,fdvMax:5000000,includeLowActivity:false},
    weights:{liquidity:0.25,volumeH24:0.25,momentum5m:0.25,age:0.15,fdvFit:0.1},
    display:{topN:25}
  },
  safe: {
    chains:['solana','base'],
    filters:{minLiquidityUSD:20000,minVolumeH24:15000,minTxnsH24Buys:25,minTxnsH24Sells:12,maxPairAgeHours:48,fdvMin:200000,fdvMax:3000000,includeLowActivity:false},
    weights:{liquidity:0.3,volumeH24:0.3,momentum5m:0.15,age:0.15,fdvFit:0.1},
    display:{topN:20}
  }
};

let settings = loadSettings() || structuredClone(PRESETS.balanced);
let lastResults = [];
let deferredPrompt = null;

// PWA install
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e; document.getElementById('installBtn').hidden = false;
});
document.getElementById('installBtn')?.addEventListener('click', async () => {
  if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; document.getElementById('installBtn').hidden = true;
});

// Quick controls
const presetSelect = document.getElementById('presetSelect');
const includeLowActivity = document.getElementById('includeLowActivity');
const chips = [...document.querySelectorAll('.chip')];

// Advanced
const adv = document.getElementById('advancedPanel');
document.getElementById('advancedBtn').addEventListener('click', ()=> adv.classList.toggle('hidden'));
document.getElementById('advancedClose').addEventListener('click', ()=> adv.classList.add('hidden'));
document.getElementById('resetBtn').addEventListener('click', ()=> { settings = structuredClone(PRESETS.balanced); saveSettings(settings); applyUI(); });
document.getElementById('saveBtn').addEventListener('click', ()=> { readAdvancedIntoSettings(); saveSettings(settings); adv.classList.add('hidden'); });

// Main buttons
document.getElementById('refreshBtn').addEventListener('click', runScan);
document.getElementById('exportBtn').addEventListener('click', exportCSV);
document.getElementById('analyzeBtn').addEventListener('click', analyzeAddress);

applyUI();

presetSelect.addEventListener('change', ()=> {
  const p = presetSelect.value; settings = structuredClone(PRESETS[p]); saveSettings(settings); applyUI(); runScan();
});
includeLowActivity.addEventListener('change', ()=> {
  settings.filters.includeLowActivity = includeLowActivity.checked; saveSettings(settings);
});
chips.forEach(btn => {
  btn.addEventListener('click', ()=> {
    btn.classList.toggle('active');
    const val = btn.dataset.chain;
    settings.chains = chips.filter(c=>c.classList.contains('active')).map(c=>c.dataset.chain);
    if (!settings.chains.length) { btn.classList.add('active'); settings.chains=[val]; }
    saveSettings(settings);
  });
});

async function runScan(){
  const toast = document.getElementById('toast');
  try{
    setToast('Fetching boosted tokens…');
    const boosted = await fetchJSON(`${DS}/token-boosts/latest/v1`);
    const chosen = boosted.filter(b => settings.chains.includes(b.chainId));
    const grouped = {};
    for (const t of chosen) (grouped[t.chainId] ??= []).push(t.tokenAddress);
    const collected = [];
    for (const [chainId, addrs] of Object.entries(grouped)){
      for (let i=0;i<addrs.length;i+=30){
        const slice = addrs.slice(i,i+30);
        const pools = await fetchJSON(`${DS}/tokens/v1/${encodeURIComponent(chainId)}/${slice.join(',')}`);
        collected.push(...(pools||[]));
      }
    }
    const filtered = collected.filter(passFilters).map(p => ({...p,_score: scorePair(p, settings), _why: explainScore(p, settings)}))
      .sort((a,b)=> (b._score-a._score) || (tx5(b)-tx5(a))).slice(0, settings.display.topN);
    lastResults = filtered;
    renderCards(filtered);
    document.getElementById('lastRun').textContent = 'Last run: ' + new Date().toLocaleTimeString();
    setTimeout(()=> toast.classList.add('hidden'), 800);
  }catch(e){
    setToast('Error. Try again.'); console.error(e);
  }
}

async function analyzeAddress(){
  const q = document.getElementById('addrInput').value.trim();
  if (!q) return;
  setToast('Analyzing…');
  const res = await fetchJSON(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`);
  const pairs = Array.isArray(res?.pairs) ? res.pairs : [];
  if (!pairs.length) { setToast('No data for that address'); return; }
  const best = pairs.slice().sort((a,b)=> (usd(b?.liquidity?.usd) - usd(a?.liquidity?.usd)))[0];
  const scored = { ...best, _score: scorePair(best, settings), _why: explainScore(best, settings) };
  lastResults = [scored, ...lastResults].slice(0, settings.display.topN);
  renderCards(lastResults, true);
  setTimeout(()=> document.getElementById('toast').classList.add('hidden'), 800);
}

function passFilters(p){
  const f = settings.filters;
  const liq = usd(p?.liquidity?.usd);
  const vol = usd(p?.volume?.h24);
  const b24 = +(p?.txns?.h24?.buys ?? 0);
  const s24 = +(p?.txns?.h24?.sells ?? 0);
  const ageH = p?.pairCreatedAt ? (Date.now() - p.pairCreatedAt)/36e5 : 1e9;
  const fdv = +(p?.fdv ?? NaN);
  if (liq < f.minLiquidityUSD) return false;
  if (vol < f.minVolumeH24) return false;
  if (b24 < f.minTxnsH24Buys) return false;
  if (s24 < f.minTxnsH24Sells) return false;
  if (f.maxPairAgeHours && ageH > f.maxPairAgeHours) return false;
  if (!isNaN(fdv)) {
    if (f.fdvMin != null && fdv < f.fdvMin) return false;
    if (f.fdvMax != null && fdv > f.fdvMax) return false;
  }
  const t5 = tx5(p);
  if (!f.includeLowActivity && t5 < 5) return false;
  return true;
}

function renderCards(items, replace=false){
  const cards = document.getElementById('cards');
  if (replace) cards.innerHTML = '';
  if (!items.length){ cards.innerHTML = '<div class="meta">No candidates. Tap Refresh or choose a looser preset.</div>'; return; }
  cards.innerHTML='';
  for (const p of items){
    const div = document.createElement('div'); div.className='card';
    const title = `${sym(p)} • ${chain(p)} • ${dex(p)}`;
    const age = p?.pairCreatedAt ? ageStr((Date.now()-p.pairCreatedAt)/36e5) : '—';
    const liq = fmtUSD(usd(p?.liquidity?.usd));
    const fdv = fmtUSD(num(p?.fdv));
    const mc  = fmtUSD(num(p?.marketCap));
    const vol = fmtUSD(usd(p?.volume?.h24));
    const t5  = String(tx5(p));
    const t24 = String(tx24(p));
    const url = p?.url || (p?.pairAddress ? `https://dexscreener.com/${p.chainId || p.chain}/${p.pairAddress}` : '#');
    const isSol = (p?.chainId || p?.chain) === 'solana';
    const baseAddr = p?.baseToken?.address || '';
    const pairAddr = p?.pairAddress || '';
    const rugLink = isSol && baseAddr ? `https://rugcheck.xyz/tokens/${baseAddr}` : (isSol && pairAddr ? `https://rugcheck.xyz/amm?lp=${pairAddr}` : null);
    const bird = isSol && baseAddr ? `https://birdeye.so/token/${baseAddr}?chain=solana` : null;
    const dexTools = isSol && pairAddr ? `https://www.dextools.io/app/en/solana/pair-explorer/${pairAddr}` : null;
    const gecko = isSol && pairAddr ? `https://www.geckoterminal.com/solana/pools/${pairAddr}` : null;
    const whyLis = (p._why || []).map(w => `<li>${escapeHtml(w)}</li>`).join('');
    div.innerHTML = `
      <div class="head"><strong>${escapeHtml(title)}</strong><span class="badge">Score ${p._score}</span></div>
      <div class="meta">Age ${age}</div>
      <div class="grid">
        <div><span class="label">Liquidity</span> ${liq}</div>
        <div><span class="label">FDV</span> ${fdv}</div>
        <div><span class="label">MC</span> ${mc}</div>
        <div><span class="label">Vol 24h</span> ${vol}</div>
        <div><span class="label">Tx 5m</span> ${t5}</div>
        <div><span class="label">Tx 24h</span> ${t24}</div>
      </div>
      <details><summary>Why?</summary><ul>${whyLis}</ul></details>
      <div class="linkrow">
        <a class="btn" href="${url}" target="_blank" rel="noopener">DexScreener</a>
        ${rugLink ? `<a class="btn" href="${rugLink}" target="_blank" rel="noopener">RugCheck</a>` : ''}
        ${bird ? `<a class="btn" href="${bird}" target="_blank" rel="noopener">Birdeye</a>` : ''}
        ${dexTools ? `<a class="btn" href="${dexTools}" target="_blank" rel="noopener">DexTools</a>` : ''}
        ${gecko ? `<a class="btn" href="${gecko}" target="_blank" rel="noopener">GeckoTerminal</a>` : ''}
      </div>`;
    cards.appendChild(div);
  }
}

function exportCSV(){
  if (!lastResults.length){ setToast('Nothing to export'); return; }
  const headers = ['score','chain','dex','base_symbol','base_address','quote_symbol','quote_address','liquidity_usd','fdv','marketcap','volume_24h','tx_5m','tx_24h','pair_age_h','pair_url'];
  const rows = [headers];
  for (const p of lastResults){
    rows.push([p._score, chain(p), dex(p), safe(p?.baseToken?.symbol), safe(p?.baseToken?.address), safe(p?.quoteToken?.symbol), safe(p?.quoteToken?.address), usd(p?.liquidity?.usd), num(p?.fdv), num(p?.marketCap), usd(p?.volume?.h24), tx5(p), tx24(p), p?.pairCreatedAt ? ((Date.now()-p.pairCreatedAt)/36e5).toFixed(2) : '', p?.url || (p?.pairAddress ? `https://dexscreener.com/${p.chainId || p.chain}/${p.pairAddress}` : '') ]);
  }
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download = 'meme-spotter.csv'; document.body.appendChild(a); a.click(); a.remove();
}

function applyUI(){
  // chips
  const set = new Set(settings.chains);
  document.querySelectorAll('.chip').forEach(ch => ch.classList.toggle('active', set.has(ch.dataset.chain)));
  // preset guess
  const p = JSON.stringify({...settings, notifications:undefined});
  if (p === JSON.stringify(PRESETS.spicy)) presetSelect.value = 'spicy';
  else if (p === JSON.stringify(PRESETS.safe)) presetSelect.value = 'safe';
  else presetSelect.value = 'balanced';
  includeLowActivity.checked = !!settings.filters.includeLowActivity;
  // advanced
  setVal('minLiquidityUSD', settings.filters.minLiquidityUSD);
  setVal('minVolumeH24', settings.filters.minVolumeH24);
  setVal('minTxnsH24Buys', settings.filters.minTxnsH24Buys);
  setVal('minTxnsH24Sells', settings.filters.minTxnsH24Sells);
  setVal('maxPairAgeHours', settings.filters.maxPairAgeHours);
  setVal('fdvMin', settings.filters.fdvMin);
  setVal('fdvMax', settings.filters.fdvMax);
  setVal('topN', settings.display.topN);
  setVal('wLiq', settings.weights.liquidity);
  setVal('wVol', settings.weights.volumeH24);
  setVal('wMom', settings.weights.momentum5m);
  setVal('wAge', settings.weights.age);
  setVal('wFdv', settings.weights.fdvFit);
}

function readAdvancedIntoSettings(){
  settings.filters.minLiquidityUSD = getNum('minLiquidityUSD', settings.filters.minLiquidityUSD);
  settings.filters.minVolumeH24 = getNum('minVolumeH24', settings.filters.minVolumeH24);
  settings.filters.minTxnsH24Buys = getNum('minTxnsH24Buys', settings.filters.minTxnsH24Buys);
  settings.filters.minTxnsH24Sells = getNum('minTxnsH24Sells', settings.filters.minTxnsH24Sells);
  settings.filters.maxPairAgeHours = getNum('maxPairAgeHours', settings.filters.maxPairAgeHours);
  settings.filters.fdvMin = getNumMaybe('fdvMin');
  settings.filters.fdvMax = getNumMaybe('fdvMax');
  settings.display.topN = getNum('topN', settings.display.topN);
  settings.weights.liquidity = getNum('wLiq', settings.weights.liquidity);
  settings.weights.volumeH24 = getNum('wVol', settings.weights.volumeH24);
  settings.weights.momentum5m = getNum('wMom', settings.weights.momentum5m);
  settings.weights.age = getNum('wAge', settings.weights.age);
  settings.weights.fdvFit = getNum('wFdv', settings.weights.fdvFit);
}

// utils
function fetchJSON(url){ return fetch(url,{cache:'no-store'}).then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }); }
function setToast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.remove('hidden'); }
function loadSettings(){ try{ const raw=localStorage.getItem('meme-spotter-simple'); return raw? JSON.parse(raw): null; }catch{ return null; } }
function saveSettings(s){ localStorage.setItem('meme-spotter-simple', JSON.stringify(s)); }
function setVal(id,v){ const el=document.getElementById(id); if(el) el.value = (v ?? ''); }
function getNum(id,d=0){ const v=parseFloat(document.getElementById(id).value); return isNaN(v)? d: v; }
function getNumMaybe(id){ const el=document.getElementById(id); if(!el.value) return null; const v=parseFloat(el.value); return isNaN(v)? null: v; }
function usd(x){ const n=Number(x); return isNaN(n)? 0: n; }
function num(x){ const n=Number(x); return isNaN(n)? 0: n; }
function tx5(p){ return (p?.txns?.m5?.buys ?? 0) + (p?.txns?.m5?.sells ?? 0); }
function tx24(p){ return (p?.txns?.h24?.buys ?? 0) + (p?.txns?.h24?.sells ?? 0); }
function chain(p){ return (p?.chainId || p?.chain || '').toUpperCase(); }
function dex(p){ return p?.dexId || ''; }
function sym(p){ return `${p?.baseToken?.symbol || '?'} / ${p?.quoteToken?.symbol || '?'}`; }
function ageStr(h){ if (h<1) return Math.max(1, Math.floor(h*60)) + 'm'; return h.toFixed(1)+'h'; }
function safe(x){ return (x==null?'':String(x)); }
function csvEscape(x){ const s=String(x==null?'':x); if(/[",\n]/.test(s)) return '"'+s.replace(/"/g,'""')+'"'; return s; }
function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',''':'&#39;'}[m])); }

// kick
runScan();
