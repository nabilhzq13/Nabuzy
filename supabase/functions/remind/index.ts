// remind: sends Nabuzy's reminders from your Supabase project. pg_cron calls
// it every minute (see ../../reminders.sql). It reads each phone that has
// reminders on, that account's synced timetable, ticks, assignments and
// choices, and JAKIM's prayer times for its zone, then sends whatever has come
// due, each reminder once. Nabuzy calls it too, with {test: true} and the
// user's own sign-in, to send a test to that one phone.
//
// One file, with no imports. Verify JWT is off: the cron's call carries no
// key, and a test checks its sign-in itself. The key pair it signs with is in
// the locked table push_vapid (see ../../nabuzy.sql), or in the secrets
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY if they're ever set.

// ---------- time ----------
// A "minute" counts from the Unix epoch in the account's own time zone (tz,
// minutes east of UTC, synced from the phone), so its day is floor(m / 1440)
// and its time of day m % 1440.
const minuteOf = (ms: number, tz: number): number => Math.floor(ms / 60000) + tz;
const dateKey = (day: number): string => new Date(day * 86400000).toISOString().slice(0, 10);
// Monday is 0, as in Nabuzy. 1 January 1970 was a Thursday.
const weekday = (day: number): number => (day + 3) % 7;
const ofDay = (m: number): number => ((m % 1440) + 1440) % 1440;
// 4pm, 4:19pm: a time the way Nabuzy writes it.
function fmt(m: number): string {
  m = ofDay(m);
  const h = Math.floor(m / 60), mm = m % 60;
  return (h % 12 || 12) + (mm ? ":" + String(mm).padStart(2, "0") : "") + (h < 12 ? "am" : "pm");
}
function toMin(s: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? ""));
  return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
}
// "2026-10-30T23:59" as a minute in the account's own time.
function localMinute(s: unknown): number | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(String(s ?? ""));
  if (!m) return null;
  const day = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  return day * 1440 + +m[4] * 60 + +m[5];
}

// ---------- choices ----------
// The synced "reminders" doc. Leads are minutes ahead; quiet hours run from
// qfrom to qto in minutes of the day, across midnight when qfrom > qto. subuh
// lets Subuh through quiet hours.
type Prefs = {
  blocks: boolean; due: boolean; pray: boolean; late: boolean;
  plead: number; blead: number; qfrom: number; qto: number; subuh: boolean; tz: number;
};
const DEFAULTS: Prefs = { blocks: true, due: true, pray: true, late: true, plead: 0, blead: 10, qfrom: 0, qto: 420, subuh: false, tz: 480 };
function prefsOf(v: unknown): Prefs {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>, p = { ...DEFAULTS };
  for (const k of ["blocks", "due", "pray", "late", "subuh"] as const) if (typeof o[k] === "boolean") p[k] = o[k] as boolean;
  for (const k of ["plead", "blead"] as const) {
    const n = o[k];
    if (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 120) p[k] = n as number;
  }
  for (const k of ["qfrom", "qto"] as const) {
    const n = o[k];
    if (Number.isInteger(n) && (n as number) >= 0 && (n as number) < 1440) p[k] = n as number;
  }
  if (Number.isInteger(o.tz) && Math.abs(o.tz as number) <= 840) p.tz = o.tz as number;
  return p;
}
function quiet(p: Prefs, m: number): boolean {
  m = ofDay(m);
  return p.qfrom < p.qto ? m >= p.qfrom && m < p.qto : p.qfrom > p.qto ? m >= p.qfrom || m < p.qto : false;
}
// Where a reminder lands. Inside quiet hours it's dropped, unless the thing
// it's about falls outside them: then it comes the minute they end.
function placed(p: Prefs, at: number, anchor: number, pass: boolean): number | null {
  if (pass || !quiet(p, at)) return at;
  if (quiet(p, anchor)) return null;
  let end = Math.floor(at / 1440) * 1440 + p.qto;
  if (end <= at) end += 1440;
  return end <= anchor ? end : null;
}

// ---------- JAKIM's timetable ----------
// e-Solat writes dates with Malay month names: 01-Mac-2026, 15-Ogos-2026.
const MON: Record<string, number> = {
  jan: 1, feb: 2, mac: 3, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, ogo: 8, aug: 8,
  sep: 9, okt: 10, oct: 10, nov: 11, dis: 12, dec: 12,
};
type Years = Record<string, Record<string, number[]>>;
// e-Solat's reply as {year: {"MM-DD": [fajr, syuruk, dhuhr, asr, maghrib, isha]}},
// minutes from midnight. A day whose times don't run in order is left out.
function parseTakwim(j: unknown): Years {
  const years: Years = {}, list = (j && (j as { prayerTime?: unknown }).prayerTime) || [];
  for (const x of Array.isArray(list) ? list : []) {
    const [d, mo, y] = String(x?.date || "").split("-"), m = MON[String(mo || "").slice(0, 3).toLowerCase()];
    if (!m || !+d || !/^\d{4}$/.test(y || "")) continue;
    const t = [x.fajr, x.syuruk, x.dhuhr, x.asr, x.maghrib, x.isha].map((s: unknown) => {
      const p = String(s || "").split(":");
      return p.length > 1 ? +p[0] * 60 + +p[1] : NaN;
    });
    if (t.some((v, i) => isNaN(v) || (i > 0 && v <= t[i - 1]))) continue;
    (years[y] ||= {})[String(m).padStart(2, "0") + "-" + String(+d).padStart(2, "0")] = t;
  }
  return years;
}
// A day's six times. A year JAKIM hasn't published yet borrows the same date
// from the year before, which lands within a minute or two.
function timesFor(years: Years, day: number): number[] | null {
  const k = dateKey(day), y = k.slice(0, 4), md = k.slice(5), last = years[String(+y - 1)];
  return years[y]?.[md] ?? last?.[md] ?? (md === "02-29" ? last?.["02-28"] ?? null : null);
}

// ---------- what's due ----------
type Block = { id: string; activity: string; start: string; mins: number; days: number[]; details?: string };
type Task = { id: string; kind?: string; title: string; course?: string; due?: string; done?: number };
type Account = {
  prefs: Prefs; solatOn: boolean; blocks: Block[]; tasks: Task[];
  done: Record<string, string[]>;                  // ticked blocks by date
  solat: Record<string, Record<string, string>>;   // prayer records by prayer day
  times: (day: number) => number[] | null;
};
type Note = {
  key: string; at: number; title: string; body: string;
  tab: "today" | "solat" | "due"; topic: string; ttl: number;
};
const IDS = ["subuh", "zohor", "asar", "maghrib", "isyak"];
const NAMES = ["Subuh", "Zohor", "Asar", "Maghrib", "Isyak"];
// Each prayer's time runs from one of JAKIM's six times to the next prayer's:
// Subuh to syuruk, Zohor to Asar and so on, and Isyak to the next Subuh.
const FROM = [0, 2, 3, 4, 5], TO = [1, 3, 4, 5, 6];
const UNTIL = ["syuruk", "Asar", "Maghrib", "Isyak", "Subuh"];
// How long before a prayer's time ends the "running out" reminder comes.
const LATE = 30;

// Everything that comes due in the `span` minutes up to and including `now`
// (the account's own minute). A run that comes a minute or two late still
// sends; tick() makes sure nothing goes twice. Anything ticked or handed in
// is left alone.
function due(now: number, a: Account, span = 3): Note[] {
  const out: Note[] = [], p = a.prefs, today = Math.floor(now / 1440);
  const take = (n: Omit<Note, "at" | "ttl">, at: number | null, until: number) => {
    if (at !== null && at <= now && at > now - span)
      out.push({ ...n, at, ttl: Math.max(60, Math.min(7200, (until - now) * 60)) });
  };
  for (let day = today - 1; day <= today + 1; day++) {
    const dk = dateKey(day);
    if (p.blocks) for (const b of a.blocks) {
      const s = toMin(b.start);
      if (s === null || !Array.isArray(b.days) || b.days.indexOf(weekday(day)) < 0) continue;
      if ((a.done[dk] || []).indexOf(b.id) >= 0) continue;
      const start = day * 1440 + s, end = start + (+b.mins || 0), left = start - now;
      take({
        key: `b:${dk}:${b.id}:${b.start}`, tab: "today", topic: "block",
        title: left > 0 ? `${b.activity} in ${left} min` : `${b.activity} starts now`,
        body: fmt(start) + "–" + fmt(end) + (b.details ? ". " + String(b.details).slice(0, 160) : ""),
      }, placed(p, start - p.blead, start, false), start + 10);
    }
    const t = a.solatOn ? a.times(day) : null;
    if (!t || !(p.pray || p.late)) continue;
    const next = a.times(day + 1);
    for (let i = 0; i < 5; i++) {
      if (a.solat[dk]?.[IDS[i]]) continue;
      const start = day * 1440 + t[FROM[i]], end = i < 4 ? day * 1440 + t[TO[i]] : (day + 1) * 1440 + (next || t)[0];
      const pass = i === 0 && p.subuh, until = `${UNTIL[i]} at ${fmt(end)}`;
      if (p.pray) {
        const left = start - now;
        take({
          key: `p:${dk}:${IDS[i]}`, tab: "solat", topic: "prayer",
          title: left > 0 ? `${NAMES[i]} in ${left} min` : `${NAMES[i]} · ${fmt(start)}`,
          body: left > 0 ? `At ${fmt(start)}, until ${until}.` : `Time for ${NAMES[i]}. It lasts until ${until}.`,
        }, placed(p, start - p.plead, start, pass), end);
      }
      if (p.late && end - LATE > start) {
        take({
          key: `l:${dk}:${IDS[i]}`, tab: "solat", topic: "prayer",
          title: `${NAMES[i]} ends at ${fmt(end)}`,
          body: `${end - now} minutes left, and it isn't ticked on Solat yet.`,
        }, placed(p, end - LATE, end, pass), end);
      }
    }
  }
  // Deadlines, exams and quizzes: a day before, and an hour before, unless
  // it's ticked off. An assignment is due; an exam or a quiz starts.
  if (p.due) for (const t of a.tasks) {
    const at = localMinute(t.due);
    if (at === null || t.done) continue;
    const test = t.kind === "exam" || t.kind === "quiz", kind = t.kind === "exam" ? "Exam" : "Quiz";
    const what = String(t.title || (test ? kind : "Assignment")).slice(0, 80), course = t.course ? String(t.course).slice(0, 30) + " · " : "";
    take({
      key: `d:${t.id}:${t.due}:day`, tab: "due", topic: "due",
      title: test ? `${kind} tomorrow: ${what}` : `${what} is due tomorrow`,
      body: test ? `${course}Starts at ${fmt(at)}.` : `${course}Due at ${fmt(at)}. Still to hand in.`,
    }, placed(p, at - 1440, at, false), at);
    take({
      key: `d:${t.id}:${t.due}:hour`, tab: "due", topic: "due",
      title: test ? `${kind} in an hour: ${what}` : `${what} is due in an hour`,
      body: test ? `${course}Starts at ${fmt(at)}.` : `${course}Due at ${fmt(at)}.`,
    }, placed(p, at - 60, at, false), at);
  }
  return out;
}

// ---------- Web Push ----------
// RFC 8291 to encrypt and RFC 8292 to sign, with WebCrypto alone.
const te = new TextEncoder();
function b64u(b: Uint8Array): string {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
function cat(...a: Uint8Array[]): Uint8Array {
  const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of a) { o.set(x, i); i += x.length; }
  return o;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
// Only these push services are sent to, so a row can't point the function at
// some other address.
const PUSH_HOST = /^https:\/\/([a-z0-9-]+\.)*(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)\//;
// The message as one aes128gcm record that only the phone holding the
// subscription's private key (p256dh) and secret (auth) can open.
async function encrypt(plain: Uint8Array, p256dh: Uint8Array, auth: Uint8Array): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const me = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const myPub = new Uint8Array(await crypto.subtle.exportKey("raw", me.publicKey));
  const them = await crypto.subtle.importKey("raw", p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: them }, me.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(te.encode("WebPush: info\0"), p256dh, myPub), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (here the only) record; no padding.
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(plain, new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = myPub.length;
  return cat(head, myPub, ct);
}
function vapidKey(d: string, pub: string): Promise<CryptoKey> {
  const p = unb64u(pub);
  return crypto.subtle.importKey("jwk",
    { kty: "EC", crv: "P-256", d, x: b64u(p.slice(1, 33)), y: b64u(p.slice(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
// Whether d really is the public key's other half: something signed with one
// has to check out with the other.
async function keysMatch(key: CryptoKey, pub: string): Promise<boolean> {
  const v = await crypto.subtle.importKey("raw", unb64u(pub), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const msg = te.encode("Nabuzy"), sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, msg);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, v, sig, msg);
}
// Apple refuses a token whose subject isn't a URL or mailto:, whose audience
// isn't the push service's origin, or that runs more than a day.
async function vapidJwt(key: CryptoKey, aud: string, sub: string, exp: number): Promise<string> {
  const part = (o: object) => b64u(te.encode(JSON.stringify(o)));
  const head = part({ typ: "JWT", alg: "ES256" }) + "." + part({ aud, exp, sub });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(head)));
  return head + "." + b64u(sig);
}

// ---------- the function ----------
// Who's sending, for the push services. Apple wants a URL or a mailto: here.
const SUBJECT = "https://nabilhzq13.github.io/Nabuzy/";
const BASE = Deno.env.get("SUPABASE_URL")!;
function named(v: string): string | undefined {
  try { return JSON.parse(Deno.env.get(v) || "{}").default; } catch { return undefined; }
}
// The secret key reads past row level security. The publishable one is only
// used to ask Auth whose sign-in a test came with.
const SECRET = named("SUPABASE_SECRET_KEYS") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PUBLIC = named("SUPABASE_PUBLISHABLE_KEYS") || Deno.env.get("SUPABASE_ANON_KEY") || SECRET;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Sub = { endpoint: string; user_id: string; p256dh: string; auth: string };
type Token = { aud: string; jwt: string; exp: number; kid: string };
type Signer = { d: string; pub: string; key: CryptoKey; kid: string };
type Push = Pick<Note, "key" | "title" | "body" | "tab" | "topic" | "ttl">;
// deno-lint-ignore no-explicit-any
type Doc = any;

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, Doc>;

// PostgREST as the secret key. An sb_secret_ key goes in apikey alone; a
// legacy service_role key is a JWT, so it goes in Authorization as well.
async function db(path: string, method = "GET", body?: unknown, prefer?: string): Promise<Doc> {
  const h: Record<string, string> = { apikey: SECRET, "Content-Type": "application/json" };
  if (!SECRET.startsWith("sb_")) h.Authorization = "Bearer " + SECRET;
  if (prefer) h.Prefer = prefer;
  const r = await fetch(BASE + "/rest/v1/" + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path.split("?")[0]}: ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

// Why there's no key: a missing or empty secret, or one saved under a name
// that's nearly right. Only names that mention VAPID are ever given.
function whyNoKey(): string {
  let env: Record<string, string> = {};
  try { env = Deno.env.toObject(); } catch { return "the function can't read its secrets"; }
  const want = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"].filter((k) => !(env[k] || "").trim());
  const near = Object.keys(env).filter((k) => /vapid/i.test(k) && want.indexOf(k) < 0 && k !== "VAPID_PUBLIC_KEY" && k !== "VAPID_PRIVATE_KEY");
  return want.join(" and ") + (want.length > 1 ? " are" : " is") + " missing" +
    (near.length ? "; there's a secret called " + near.map((k) => JSON.stringify(k)).join(" and ") + ", but the names have to match exactly" : "");
}

// The key pair: the function's secrets if they're set, otherwise the row in
// push_vapid, a table only the secret key can read.
async function keyPair(): Promise<{ d: string; pub: string }> {
  const d = (Deno.env.get("VAPID_PRIVATE_KEY") || "").trim(), pub = (Deno.env.get("VAPID_PUBLIC_KEY") || "").trim();
  if (d && pub) return { d, pub };
  try {
    const row = (await db("push_vapid?select=public_key,private_key&limit=1"))[0];
    if (row) return { d: String(row.private_key || "").trim(), pub: String(row.public_key || "").trim() };
  } catch { /* no table: the secrets are the only place */ }
  return { d: "", pub: "" };
}

// The signing key, checked against the public half before anything is sent,
// so a mistyped key says so instead of failing at Apple.
let signer: Signer | null = null;
async function vapid(): Promise<Signer | null> {
  const { d, pub } = await keyPair();
  if (!d || !pub) return null;
  if (signer?.d === d && signer.pub === pub) return signer;
  let key: CryptoKey | null = null;
  try {
    key = await vapidKey(d, pub);
    if (!(await keysMatch(key, pub))) key = null;
  } catch { key = null; }
  if (!key) throw new Error("The private key isn't the other half of the public one. Check push_vapid, or the VAPID secrets.");
  const kid = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(d)))).slice(0, 12);
  return (signer = { d, pub, key, kid });
}

// Apple asks for the signed token to change at most once an hour, so each push
// service's token is kept in push_tokens and reused until it has less than six
// of its twelve hours left.
async function token(aud: string, v: Signer, kept: Map<string, Token>): Promise<string> {
  const now = Math.floor(Date.now() / 1000), t = kept.get(aud);
  if (t && t.kid === v.kid && t.exp - now > 6 * 3600) return t.jwt;
  const exp = now + 12 * 3600, fresh = { aud, kid: v.kid, exp, jwt: await vapidJwt(v.key, aud, SUBJECT, exp) };
  kept.set(aud, fresh);
  await db("push_tokens?on_conflict=aud", "POST", fresh, "resolution=merge-duplicates,return=minimal");
  return fresh.jwt;
}
async function tokens(): Promise<Map<string, Token>> {
  return new Map((await db("push_tokens?select=aud,jwt,exp,kid")).map((t: Token) => [t.aud, t]));
}

// One reminder to one phone. A subscription the push service says is gone
// (404, 410) is removed; otherwise the outcome is kept on its row, where
// Settings shows a refusal.
async function send(s: Sub, n: Push, v: Signer, kept: Map<string, Token>): Promise<{ status: number; why: string }> {
  if (!PUSH_HOST.test(s.endpoint)) return { status: 0, why: "not a push service" };
  let status = 0, why = "";
  try {
    const body = await encrypt(te.encode(JSON.stringify({ title: n.title, body: n.body, tab: n.tab, tag: n.key })), unb64u(s.p256dh), unb64u(s.auth));
    const r = await fetch(s.endpoint, {
      method: "POST", body, signal: AbortSignal.timeout(10000),
      headers: {
        TTL: String(n.ttl), Urgency: "high", Topic: n.topic,
        "Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm",
        Authorization: `vapid t=${await token(new URL(s.endpoint).origin, v, kept)}, k=${v.pub}`,
      },
    });
    status = r.status;
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      try { why = JSON.parse(t).reason || t; } catch { why = t; }
      why = String(why).trim();
    }
  } catch (e) { why = String((e as Error)?.message || e); }
  const row = "push_subs?endpoint=eq." + encodeURIComponent(s.endpoint), ok = status >= 200 && status < 300;
  await (status === 404 || status === 410
    ? db(row, "DELETE", undefined, "return=minimal")
    : db(row, "PATCH", ok ? { ok_at: new Date().toISOString(), err: null } : { err: ((status ? status + " " : "") + (why || "no answer")).slice(0, 280) }, "return=minimal")
  ).catch((e) => console.error(e));
  console.log(n.key, new URL(s.endpoint).host, status, why.slice(0, 120));
  return { status, why };
}

// JAKIM's timetable per zone, as {year: days} for this year and last. A zone's
// year is fetched from e-Solat the first time it's needed and then kept; a year
// e-Solat can't give yet is tried again after six hours.
async function timetables(zones: string[], year: number): Promise<Map<string, Years>> {
  const out = new Map<string, Years>();
  if (!zones.length) return out;
  const rows = await db(`prayer_times?select=zone,year,days,fetched_at&zone=in.(${zones.join(",")})&year=in.(${year - 1},${year})`);
  const keep = (z: string, y: string | number, days: Record<string, number[]>) => {
    const o = out.get(z) || {};
    o[String(y)] = days;
    out.set(z, o);
  };
  for (const r of rows) if (r.days) keep(r.zone, r.year, r.days);
  for (const z of zones) {
    const tried = rows.find((r: Doc) => r.zone === z && r.year === year);
    if (tried && (tried.days || Date.now() - Date.parse(tried.fetched_at) < 6 * 3600e3)) continue;
    let years: Years = {};
    try {
      const r = await fetch(`https://www.e-solat.gov.my/index.php?r=esolatApi/takwimsolat&period=year&zone=${z}`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) years = parseTakwim(await r.json());
      else console.log("e-Solat", z, r.status);
    } catch (e) { console.log("e-Solat", z, String(e)); }
    const at = new Date().toISOString(), got = Object.keys(years).filter((y) => Object.keys(years[y]).length >= 28);
    const put: Doc[] = got.map((y) => ({ zone: z, year: +y, days: years[y], fetched_at: at }));
    if (got.indexOf(String(year)) < 0) put.push({ zone: z, year, days: null, fetched_at: at });   // remember the miss
    await db("prayer_times?on_conflict=zone,year", "POST", put, "resolution=merge-duplicates,return=minimal");
    for (const y of got) keep(z, y, years[y]);
  }
  return out;
}

// The minute's run.
async function tick() {
  const v = await vapid();
  if (!v) {
    console.log("waiting:", whyNoKey());
    return { waiting: "for the VAPID secrets: " + whyNoKey() };
  }
  const subs: Sub[] = (await db("push_subs?select=endpoint,user_id,p256dh,auth")).filter((s: Sub) => PUSH_HOST.test(s.endpoint));
  if (!subs.length) return { ok: true };
  const users = [...new Set(subs.map((s) => s.user_id))];
  const of = new Map<string, Record<string, Doc>>();
  for (const d of await db(`docs?select=user_id,key,value&key=in.(blocks,done,tasks,prefs,solat,solatSet,reminders)&user_id=in.(${users.join(",")})`)) {
    const o = of.get(d.user_id) || {};
    o[d.key] = d.value && d.value.v;
    of.set(d.user_id, o);
  }
  const solatOn = (u: string) => !!obj(of.get(u)?.prefs).solat;
  const zoneOf = (u: string): string => {
    const z = of.get(u)?.solatSet?.zone;
    return solatOn(u) && typeof z === "string" && /^[A-Z]{3}\d{2}$/.test(z) ? z : "";
  };
  const year = new Date().getUTCFullYear();
  const tt = await timetables([...new Set(users.map(zoneOf).filter(Boolean))], year);
  const list: { user: string; note: Note }[] = [];
  for (const u of users) {
    const d = of.get(u) || {}, years = tt.get(zoneOf(u)) || {}, prefs = prefsOf(d.reminders);
    for (const note of due(minuteOf(Date.now(), prefs.tz), {
      prefs, solatOn: !!zoneOf(u),
      blocks: Array.isArray(d.blocks) ? d.blocks : [], tasks: Array.isArray(d.tasks) ? d.tasks : [],
      done: obj(d.done), solat: obj(d.solat), times: (day) => timesFor(years, day),
    })) list.push({ user: u, note });
  }
  if (!list.length) return { ok: true };
  // Each reminder is claimed before it's sent, so a run that overlaps this one
  // finds it taken. One that no phone took, for a reason that may pass, is
  // handed back for the next minute's run to try.
  const claimed = new Set<string>(
    (await db("push_sent?on_conflict=user_id,event&select=user_id,event", "POST",
      list.map((x) => ({ user_id: x.user, event: x.note.key })), "resolution=ignore-duplicates,return=representation"))
      .map((c: Doc) => c.user_id + " " + c.event));
  const kept = await tokens();
  let sent = 0;
  for (const x of list) {
    if (!claimed.has(x.user + " " + x.note.key)) continue;
    const codes: number[] = [];
    for (const s of subs) if (s.user_id === x.user) codes.push((await send(s, x.note, v, kept)).status);
    if (codes.some((c) => c >= 200 && c < 300)) sent++;
    else if (codes.some((c) => c === 0 || c === 429 || c >= 500))
      await db(`push_sent?user_id=eq.${x.user}&event=eq.${encodeURIComponent(x.note.key)}`, "DELETE", undefined, "return=minimal");
  }
  return { ok: true, due: list.length, sent };
}

// "Send a test" in Settings: to the phone that asked, and only if it belongs to
// the account whose sign-in came with the request.
async function test(req: Request, endpoint: unknown) {
  const who = await fetch(BASE + "/auth/v1/user", { headers: { apikey: PUBLIC, Authorization: req.headers.get("Authorization") || "" } });
  const user = who.ok ? await who.json() : null;
  if (!user || typeof user.id !== "string") return json({ error: "Your sign-in has run out. Sign in again in Settings." }, 401);
  const v = await vapid();
  if (!v) return json({ error: "Your project can't use the key yet: " + whyNoKey() + ". Add them under Edge Functions, Secrets." }, 503);
  const subs: Sub[] = typeof endpoint === "string" && PUSH_HOST.test(endpoint)
    ? await db(`push_subs?select=endpoint,user_id,p256dh,auth&user_id=eq.${user.id}&endpoint=eq.${encodeURIComponent(endpoint)}`)
    : [];
  if (!subs.length) return json({ error: "This phone isn't signed up for reminders. Turn them off and on again." }, 404);
  const r = await send(subs[0], {
    key: "test", tab: "today", topic: "test", ttl: 300,
    title: "Reminders are on", body: "This is what they'll look like. Tap one to open Nabuzy.",
  }, v, await tokens());
  if (r.status >= 200 && r.status < 300) return json({ ok: true });
  // The push service no longer knows the phone, and send() has just let it go
  // here too, so the fix is for the phone to sign up again.
  if (r.status === 404 || r.status === 410) return json({ error: "This phone's sign-up for reminders has expired. Turn reminders on again." }, 410);
  return json({ error: r.status ? `The push service said ${r.status}${r.why ? " (" + r.why + ")" : ""}.` : "The push service didn't answer." }, 502);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Doc = {};
  try { body = await req.json(); } catch { /* the cron's body is {} */ }
  try {
    return body && body.test ? await test(req, body.endpoint) : json(await tick());
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
