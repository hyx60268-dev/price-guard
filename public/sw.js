const CACHE='price-guard-v15',ASSETS=['./','index.html','styles.css?v=15','app.js?v=15','favicon.svg','manifest.webmanifest?v=15'];
self.addEventListener('install',event=>event.waitUntil(Promise.all([caches.open(CACHE).then(cache=>cache.addAll(ASSETS)),self.skipWaiting()])));
self.addEventListener('activate',event=>event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))),self.clients.claim()])));
self.addEventListener('message',event=>{if(event.data==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).pathname.includes('/data/'))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy))}return response;
  }).catch(()=>caches.match(event.request)));
});
