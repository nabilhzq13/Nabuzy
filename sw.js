/* Nabuzy — offline cache, and the reminders your own Supabase pushes.
   Bump CACHE when you change any file, so phones pick the new version up. */
var CACHE = "nabuzy-v1";
var FILES = [
  "./",
  "./index.html",
  "./fonts/inter-latin.woff2",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", function (ev) {
  ev.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Straight from the network, not the browser's own cache, so a new
      // version never goes out with an older copy of one of its files.
      return c.addAll(FILES.map(function (f) { return new Request(f, { cache: "reload" }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      // Only Nabuzy's own: other apps on the same github.io address, Break
      // among them, keep theirs.
      return Promise.all(keys.map(function (k) {
        return k !== CACHE && k.indexOf("nabuzy-") === 0 ? caches.delete(k) : null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (ev) {
  var req = ev.request;
  if (req.method !== "GET") return;
  // Prayer times come from JAKIM and sync from your Supabase; the app keeps those itself.
  if (new URL(req.url).origin !== self.location.origin) return;

  // Navigations: the network first, so a new version shows up straight away.
  // On a weak signal the cached copy opens after three seconds rather than
  // waiting on a connection that may never answer. Only a good answer is kept,
  // so an error page can never become the copy that opens offline.
  if (req.mode === "navigate") {
    var net = fetch(req).then(function (res) {
      if (res.ok) {
        var copy = res.clone();
        ev.waitUntil(caches.open(CACHE).then(function (c) { return c.put("./index.html", copy); }));
      }
      return res;
    });
    ev.waitUntil(net.catch(function () {}));
    ev.respondWith(new Promise(function (resolve) {
      var sent = false;
      function send(res) { if (res && !sent) { sent = true; resolve(res); } }
      function shell() {
        return caches.match("./index.html").then(function (hit) { return hit || caches.match("./"); });
      }
      var slow = setTimeout(function () { shell().then(send); }, 3000);
      net.then(function (res) {
        clearTimeout(slow);
        if (res.ok) send(res);
        else shell().then(function (hit) { send(hit || res); });
      }, function () {
        clearTimeout(slow);
        shell().then(function (hit) { send(hit || Response.error()); });
      });
    }));
    return;
  }

  // Everything else: cache first, it is all static.
  ev.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === "basic") {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});

// Reminders, sent by your own Supabase (supabase/functions/remind). Each one
// is shown straight away, since iOS takes push away from a web app that gets
// one without showing it.
self.addEventListener("push", function (ev) {
  var d = {};
  try { d = ev.data ? ev.data.json() : {}; } catch (e) { d = { body: ev.data ? ev.data.text() : "" }; }
  ev.waitUntil(self.registration.showNotification(d.title || "Nabuzy", {
    body: d.body || "",
    tag: d.tag || undefined,
    icon: "icon-192.png",
    data: { tab: d.tab === "solat" || d.tab === "due" ? d.tab : "today" }
  }));
});

// A tapped reminder opens Nabuzy on its tab: Solat for a prayer, Due for a
// deadline, Today for a block. If Nabuzy is already open it switches there.
self.addEventListener("notificationclick", function (ev) {
  var tab = ev.notification.data && ev.notification.data.tab || "today",
      url = new URL("./?tab=" + tab, self.registration.scope).href;
  ev.notification.close();
  ev.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && "focus" in c) {
        c.postMessage({ tab: tab });
        return c.focus().catch(function () { return self.clients.openWindow(url); });
      }
    }
    return self.clients.openWindow(url);
  }));
});
