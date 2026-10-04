const CACHE='price-guard-v41',ASSETS=['./','index.html','styles.css?v=33','app.js?v=51','pricing-policy.js','pricing-status.js','dashboard-freshness.js','merchant-view.js','merchant-image-evidence.js','procurement-view.js','merchant-records.js','merchant-config.js','merchant-status.js','sync-handoff.js','owned-offers.js','match-memory.js','shop-profile.js','durable-state.js','build-version.js','favicon.svg','manifest.webmanifest?v=24'];
self.addEventListener('install',event=>event.waitUntil(Promise.all([caches.open(CACHE).then(cache=>cache.addAll(ASSETS)),self.skipWaiting()])));
self.addEventListener('activate',event=>event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))),self.clients.claim()])));
self.addEventListener('message',event=>{if(event.data==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).pathname.includes('/data/'))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy))}return response;
  }).catch(()=>caches.match(event.request)));
});
