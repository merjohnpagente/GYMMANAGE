// ============================= DATA LAYER =============================
const KEY={users:'gms_users',members:'gms_members',payments:'gms_payments',sessions:'gms_sessions',plans:'gms_plans',attendance:'gms_attendance',walkins:'gms_walkins',loginAttempts:'gms_login_attempts',activityLog:'gms_activity_log',settings:'gms_settings',notifications:'gms_notifications',messages:'gms_messages',announcements:'gms_announcements'};
const PENDING_ARCHIVE_DAYS=7;
const QR_SCAN_DUP_WINDOW_MIN=30;
const DB={
  get:(k)=>{try{return JSON.parse(localStorage.getItem(k))||[];}catch{return[];}},
  getObj:(k)=>{try{const v=JSON.parse(localStorage.getItem(k));return(v&&typeof v==='object'&&!Array.isArray(v))?v:{};}catch{return{};}},
  set:(k,v)=>{localStorage.setItem(k,JSON.stringify(v));if(window.GMSFB&&GMSFB.enabled&&GMSFB.ready&&!GMSFB._applying)GMSFB.pushCollection(k,v);},
  getOne:(k,id)=>DB.get(k).find(x=>x.id===id)
};

// ============================= OOP DATA LAYER (Repository Pattern) =============================
// Every collection in localStorage is now accessed through a Repository instance instead of
// raw DB.get(KEY.x) / DB.set(KEY.x, ...) calls scattered through the app. This gives each
// entity a single owner of its persistence logic and a place to hang domain behaviour.
class Repository{
  constructor(storageKey){this.storageKey=storageKey;}
  all(){return DB.get(this.storageKey);}
  save(arr){DB.set(this.storageKey,arr);return arr;}
  one(id){return DB.getOne(this.storageKey,id);}
  add(item){const arr=this.all();arr.push(item);this.save(arr);return item;}
  update(id,patch){const arr=this.all();const i=arr.findIndex(x=>x.id===id);if(i>-1){arr[i]={...arr[i],...patch};this.save(arr);}return arr[i];}
  remove(id){const arr=this.all().filter(x=>x.id!==id);this.save(arr);return arr;}
  count(){return this.all().length;}
}
// A tiny repository for the login-attempts map, which is stored as an object, not an array.
// Entries carry a timestamp so lockouts expire automatically (prevents permanent self-DoS).
const LOGIN_LOCK_MS=15*60*1000;
// Account locks after this many failed login attempts within the lock window
const LOGIN_MAX_ATTEMPTS=7;
class AttemptTracker{
  constructor(storageKey){this.storageKey=storageKey;}
  all(){return DB.getObj(this.storageKey);}
  save(obj){DB.set(this.storageKey,obj);return obj;}
  get(username){const e=this.all()[username];if(!e||typeof e==='number')return 0;return(Date.now()-e.last)<LOGIN_LOCK_MS?e.count:0;}
  register(username){const a=this.all();const e=a[username];const fresh=(e&&typeof e==='object'&&(Date.now()-e.last)<LOGIN_LOCK_MS)?e.count:0;a[username]={count:fresh+1,last:Date.now()};this.save(a);return a[username].count;}
  reset(username){const a=this.all();delete a[username];this.save(a);}
}
const Users=new Repository(KEY.users);
const Members=new Repository(KEY.members);
const Payments=new Repository(KEY.payments);
const Sessions=new Repository(KEY.sessions);
const Plans=new Repository(KEY.plans);
const Attendance=new Repository(KEY.attendance);
const Walkins=new Repository(KEY.walkins);
const Notifications=new Repository(KEY.notifications);
const Messages=new Repository(KEY.messages);
const Announcements=new Repository(KEY.announcements);
// Shared anti-spam guard: every account-creation attempt (staff/trainer/member)
// consumes a slot. Max 5 attempts per 10 minutes per browser, then blocked.
const SIGNUP_RATE_LIMIT=5;
const SIGNUP_RATE_WINDOW_MS=10*60*1000;
function signupRateCheck(){
  const key='gms_signup_rate';
  let count=parseInt(localStorage.getItem(key)||'0',10);
  let first=parseInt(localStorage.getItem(key+'_t')||'0',10);
  const now=Date.now();
  if(!first||now-first>SIGNUP_RATE_WINDOW_MS){first=now;count=0;localStorage.setItem(key+'_t',String(now));}
  localStorage.setItem(key,String(count+1));
  return count>=SIGNUP_RATE_LIMIT;
}
function pushPendingPaymentNotif(member){
  const plan=member.planId?Plans.one(member.planId):null;
  const existing=Notifications.all().find(n=>n.memberId===member.id&&n.type==='pending_payment'&&n.status==='open');
  if(existing)return existing;
  const notif={id:'NTF-'+uid(),memberId:member.id,planId:member.planId||'',type:'pending_payment',status:'open',createdAt:member.createdAt||today()};
  Notifications.add(notif);
  return notif;
}
function resolveNotifsForMember(memberId){
  const all=Notifications.all();
  let changed=false;
  all.forEach(n=>{if(n.memberId===memberId&&n.status==='open'){n.status='resolved';changed=true;}});
  if(changed)Notifications.save(all);
}
function openPendingNotifs(){return Notifications.all().filter(n=>n.type==='pending_payment'&&n.status==='open');}
const ActivityLog=new Repository(KEY.activityLog);
const LoginAttempts=new AttemptTracker(KEY.loginAttempts);
const Settings=new Repository(KEY.settings);
function getWalkinFee(){return Number((Settings.one('walkin')||{}).fee)||100;}
function setWalkinFee(fee){Settings.save([{id:'walkin',fee:Number(fee)}]);}
function formatPeso(n){return Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function syncStaticWalkinPrice(){document.querySelectorAll('.js-walkin-price').forEach(el=>{el.textContent='₱'+getWalkinFee().toLocaleString()+'/day';});document.querySelectorAll('.js-walkin-price-prose').forEach(el=>{el.textContent='₱'+getWalkinFee().toLocaleString();});}

// ============================= DOMAIN / ENTITY CLASSES =============================
// Lightweight classes that wrap the plain data objects and carry the business rules that used
// to live inline inside render functions (e.g. computing a member's status from their expiry
// date). Plain objects from the repositories can be "upgraded" into these classes with wrap().
class GymUser{
  constructor(data){Object.assign(this,data);}
  get isLocked(){return this.status==='locked';}
  get isPending(){return this.status==='pending';}
  static wrap(data){return data?new GymUser(data):null;}
}
class Admin extends GymUser{}
class Staff extends GymUser{}
class TrainerAccount extends GymUser{
  get specializationList(){return this.specializations||[];}
  isAvailableOn(day){return (this.availableDays||[]).includes(day);}
}
class Plan{
  constructor(data){Object.assign(this,data);}
  get isUnlimited(){return this.sessions==='Unlimited';}
  priceLabel(){return '₱'+Number(this.price).toLocaleString();}
  static wrap(data){return data?new Plan(data):null;}
}
class Member{
  constructor(data){Object.assign(this,data);}
  get daysUntilExpiry(){return daysUntil(this.expiryDate);}
  // Single source of truth for a member's lifecycle state, replacing duplicated
  // expiry-comparison logic that used to be repeated across render functions.
  computeStatus(){
    if(this.status==='Archived')return'Archived';
    if(this.status==='pending_payment')return'pending_payment';
    const d=this.daysUntilExpiry;
    if(d<0)return'Expired';
    if(d<=3)return this.status==='Suspended'?'Suspended':'Expiring Soon';
    return this.status==='Suspended'?'Suspended':'Active';
  }
  refreshStatus(){this.status=this.computeStatus();return this.status;}
  static wrap(data){return data?new Member(data):null;}
}
class PaymentRecord{
  constructor(data){Object.assign(this,data);}
  get amountLabel(){return '₱'+Number(this.amount).toLocaleString();}
  static wrap(data){return data?new PaymentRecord(data):null;}
}

// ============================= AUTH SERVICE =============================
// Encapsulates the rules that used to live directly inside doLogin()/doRegister(): lockouts,
// pending approval, credential checks and session persistence. The old global functions below
// (doLogin, doRegister, getSession, ...) now simply delegate to this service so every existing
// onclick="..." handler in the HTML keeps working unchanged.
class AuthService{
  getSession(){try{return JSON.parse(sessionStorage.getItem('gms_session'));}catch{return null;}}
  setSession(u){sessionStorage.setItem('gms_session',JSON.stringify(u));}
  clearSession(){sessionStorage.removeItem('gms_session');}
  findByUsername(username){return Users.all().find(x=>x.username===username);}
// Returns {ok:true,user} or {ok:false,error}
  async login(username,password){
    if(!username||!password)return{ok:false,error:'Please fill in all required fields.'};
    if(LoginAttempts.get(username)>=LOGIN_MAX_ATTEMPTS)return{ok:false,error:'Account locked. Too many failed attempts — try again in 15 minutes.'};
    const found=this.findByUsername(username);
    if(found&&found.status==='locked')return{ok:false,error:'Account locked. Please contact the administrator.'};
    if(found&&found.status==='pending')return{ok:false,error:'Your account is pending admin approval. Please wait.'};
    // ---------- ONLINE (Firebase Auth) ----------
    if(window.GMSFB&&GMSFB.enabled){
      // Give the first Firestore snapshot a moment to arrive so this login is
      // validated against the CLOUD user list, not a possibly-empty local
      // cache (prevents a device from silently falling back to local accounts).
      if(GMSFB._lastCloud&&GMSFB._lastCloud.users===undefined&&typeof GMSFB.waitForSnap==='function'){
        await GMSFB.waitForSnap('users',2500);
      }
      if(found){
        const r=await GMSFB.signIn(GMSFB.authEmailFor(found),password);
        if(r.ok){LoginAttempts.reset(username);if(found.role==='admin')GMSFB.ensureSeededPlans();this.setSession(found);return{ok:true,user:found};}
        LoginAttempts.register(username);
        return{ok:false,error:r.error};
      }
      const member=Members.all().find(m=>m.username&&m.username.toLowerCase()===username.toLowerCase());
      if(member){
        if(member.status==='Archived')return{ok:false,error:'Your account has been archived. Please contact the front desk.'};
        const r=await GMSFB.signIn(GMSFB.authEmailFor(member),password);
        if(r.ok){
          LoginAttempts.reset(username);
          const sess={id:member.id,email:member.email||'',username:member.username,name:member.name,contact:member.contact,role:'member',memberId:member.id,status:member.status};
          this.setSession(sess);
          return{ok:true,user:sess};
        }
        LoginAttempts.register(username);
        return{ok:false,error:r.error};
      }
      LoginAttempts.register(username);
      // Built-in admin: the AUTH account lives in Firebase Authentication
      // (admin@fitcoregym.local). If it has never been created, the FIRST
      // admin login bootstraps it in the cloud with the password entered,
      // then self-heals the Firestore profile doc. From then on every device
      // authenticates the same cloud admin — never a device-local copy.
      if(username.toLowerCase()==='admin'){
        let admin=Users.all().find(x=>x.role==='admin'&&x.username.toLowerCase()==='admin');
        let r=admin?await GMSFB.signIn(GMSFB.authEmailFor(admin),password):await GMSFB.signIn(GMSFB.adminAuthEmail,password);
        // First-run bootstrap: create the admin identity in Firebase Auth
        // (only when it genuinely does not exist yet).
        if(!r.ok&&!admin){
          const notFound=r.code==='auth/user-not-found'||(r.code&&r.code.indexOf('user-not-found')>-1)||(r.code&&r.code.indexOf('invalid-credential')>-1);
          if(notFound){
            const cu=await GMSFB.createUserCreds(GMSFB.adminAuthEmail,password);
            GMSFB.secondarySignOut();
            if(cu.ok)r=await GMSFB.signIn(GMSFB.adminAuthEmail,password);
          }
        }
        if(r.ok){
          if(!admin){
            admin={id:'u1',name:'System Admin',username:'admin',authEmail:GMSFB.adminAuthEmail,role:'admin',status:'active',contact:'09150435696',createdAt:today()};
            Users.add(admin);
          }
          LoginAttempts.reset(username);
          GMSFB.ensureSeededPlans();
          this.setSession(admin);
          return{ok:true,user:admin};
        }
      }
      // ---------- CACHE-MISS FALLBACK ----------
      // Registration is cloud-only, so a freshly registered account may not
      // be in this device's local cache yet (Firestore denies reads before
      // anyone signs in). Validate directly against Firebase Auth using the
      // deterministic identity, then pull the profile from the live snapshot.
      const uname=username.toLowerCase();
      const synth=uname+'@fitcoregym.local';
      const finishFallback=async()=>{
        await GMSFB.waitForSnap('users',4000);
        await GMSFB.waitForSnap('members',4000);
        const u=Users.all().find(x=>(x.authEmail&&x.authEmail.toLowerCase()===synth)||(x.username&&x.username.toLowerCase()===uname&&x.role!=='member'));
        if(u){
          if(u.status==='pending'){GMSFB.signOut();return{ok:false,error:'Your account is pending admin approval. Please wait.'};}
          if(u.status==='locked'){GMSFB.signOut();return{ok:false,error:'Account locked. Please contact the administrator.'};}
          LoginAttempts.reset(username);
          if(u.role==='admin')GMSFB.ensureSeededPlans();
          this.setSession(u);
          return{ok:true,user:u};
        }
        const m=Members.all().find(x=>(x.authEmail&&x.authEmail.toLowerCase()===synth)||(x.username&&x.username.toLowerCase()===uname)||(x.email&&x.email.toLowerCase()===uname));
        if(m){
          if(m.status==='Archived'){GMSFB.signOut();return{ok:false,error:'Your account has been archived. Please contact the front desk.'};}
          LoginAttempts.reset(username);
          const sess={id:m.id,email:m.email||'',username:m.username,name:m.name,contact:m.contact,role:'member',memberId:m.id,status:m.status};
          this.setSession(sess);
          return{ok:true,user:sess};
        }
        GMSFB.signOut();
        return{ok:false,error:'Invalid username or password.'};
      };
      let fr=await GMSFB.signIn(synth,password);
      if(fr.ok)return await finishFallback();
      if(username.indexOf('@')>-1){
        fr=await GMSFB.signIn(uname,password);
        if(fr.ok)return await finishFallback();
      }
      LoginAttempts.register(username);
      return{ok:false,error:'Invalid username or password.'};
    }
    // ---------- ONLINE-ONLY ----------
    // There is no offline/local fallback anymore: every account lives in
    // Firebase. Without a cloud connection nobody can log in.
    return{ok:false,error:'No internet connection. FitCore runs live in the cloud — please connect to the internet and try again.'};
  }
  logout(){this.clearSession();}
  async register(role,payload){
    const users=Users.all();
    if(users.find(x=>x.username===payload.username))return{ok:false,error:'Username already taken. Please choose a different username.'};
    const status=role==='staff'?'pending':'active';
    const {password,...rest}=payload;
    // Sanitize free-text fields at write time (defense in depth against stored XSS)
    ['name','contact','username','coachName','bio'].forEach(k=>{if(typeof rest[k]==='string')rest[k]=sanitizeText(rest[k]);});
    const user={id:uid(),role,status,createdAt:today(),...rest};
    // ---------- CLOUD-ONLY REGISTRATION ----------
    // The profile doc is written straight to Firestore through the secondary
    // app's authenticated context. Nothing is stored in localStorage here —
    // every device (including this one) receives the record via the live
    // snapshot, so Firebase stays the single source of truth.
    if(!(window.GMSFB&&GMSFB.enabled)){
      if(window.GMSFB&&GMSFB.secondarySignOut)GMSFB.secondarySignOut();
      return{ok:false,error:'Registration requires an internet connection. Please connect to the internet and try again.'};
    }
    const authEmail=GMSFB.authEmailFor({username:payload.username});
    const r=await GMSFB.createUserCreds(authEmail,password);
    if(!r.ok){
      // Auth account may exist from an earlier attempt whose profile never
      // reached the cloud — recover by verifying the password on the SECONDARY
      // app (the context secSetDoc writes through).
      if(r.code==='auth/email-already-in-use'){
        const si=await GMSFB.secSignIn(authEmail,password);
        if(!si.ok)return{ok:false,error:'Username already taken. Please choose a different username.'};
      } else return{ok:false,error:r.error};
    }
    user.authEmail=authEmail;
    const wr=await GMSFB.secSetDoc('users',user);
    // Activity entry (same as member signup) so admins see the pending
    // registration in Reports even before approving it.
    if(wr&&wr.ok){
      const act={id:'ACT'+Date.now(),action:'Signup',category:role==='trainer'?'Trainer':'Staff',detail:rest.name||payload.username,extra:'ID: '+user.id+' | Awaiting admin approval',by:rest.name||payload.username,byUsername:payload.username,byRole:role,at:new Date().toISOString()};
      await GMSFB.secSetDoc('activitylog',act);
    }
    GMSFB.secondarySignOut();
    if(!wr||!wr.ok){
      // NEVER keep a cloud-bound registration as a local-only record — it
      // would be invisible to admins on other devices. Fail loudly instead.
      return{ok:false,error:'Registration could not reach the server. Please check your internet connection and try again.'};
    }
    return{ok:true,user};
  }
}
const Auth=new AuthService();

function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6);}
function nextId(key,prefix){
  const items=DB.get(key);
  const re=new RegExp('^'+prefix+'-0*(\\d+)$');
  let max=0;
  for(const it of items){
    if(!it||typeof it.id!=='string')continue;
    const m=it.id.match(re);
    if(m)max=Math.max(max,parseInt(m[1],10));
  }
  return `${prefix}-${(max+1).toString().padStart(4,'0')}`;
}
function nextMemberId(){const n=Members.all().filter(m=>m.status!=='Archived').length;return 'MEM-'+String(n+1).padStart(4,'0');}
function addDays(dateStr,days){const d=new Date(dateStr);d.setDate(d.getDate()+days);return d.toISOString().split('T')[0];}
function addMonths(dateStr,months){const d=new Date(dateStr);d.setMonth(d.getMonth()+months);return d.toISOString().split('T')[0];}
function today(){return new Date().toISOString().split('T')[0];}
function daysUntil(dateStr){const ms=new Date(dateStr)-new Date(today());return Math.ceil(ms/(1000*60*60*24));}
// Legacy demo-grade hash (FNV-1a 32-bit). Kept ONLY to verify/upgrade records hashed before the
// salted-SHA-256 upgrade; never used for new hashes.
function hashStr(str){
  let h=0x811c9dc5;
  for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,0x01000193);}
  return (h>>>0).toString(16).padStart(8,'0');
}
// ============================= CRYPTO (sync, browser-safe) =============================
// Pure-JS SHA-256 so password hashing and QR signatures work synchronously in the browser
// and in Node test harnesses. Standard FIPS-180-4 algorithm.
function sha256hex(msg){
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function rotr(x,n){return (x>>>n)|(x<<(32-n));}
  let H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const bytes=[];
  for(let i=0;i<msg.length;i++){
    const c=msg.charCodeAt(i);
    if(c<128)bytes.push(c);
    else if(c<2048)bytes.push(0xc0|(c>>6),0x80|(c&63));
    else bytes.push(0xe0|(c>>12),0x80|((c>>6)&63),0x80|(c&63));
  }
  const bitLen=bytes.length*8;
  bytes.push(0x80);
  while(bytes.length%64!==56)bytes.push(0);
  for(let i=7;i>=0;i--)bytes.push((bitLen/Math.pow(2,8*i))&255);
  for(let o=0;o<bytes.length;o+=64){
    const w=new Array(64);
    for(let i=0;i<16;i++)w[i]=(bytes[o+i*4]<<24)|(bytes[o+i*4+1]<<16)|(bytes[o+i*4+2]<<8)|bytes[o+i*4+3];
    for(let i=16;i<64;i++){
      const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);
      const s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);
      w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;
    }
    let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for(let i=0;i<64;i++){
      const S1=rotr(e,6)^rotr(e,11)^rotr(e,25);
      const ch=(e&f)^(~e&g);
      const t1=(h+S1+ch+K[i]+w[i])>>>0;
      const S0=rotr(a,2)^rotr(a,13)^rotr(a,22);
      const maj=(a&b)^(a&c)^(b&c);
      const t2=(S0+maj)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
  }
  return H.map(x=>x.toString(16).padStart(8,'0')).join('');
}
// Salted, iterated password hashing (h2$salt$digest). 1000 SHA-256 rounds with a per-user
// random salt: kills rainbow tables and cross-account correlation. Kept synchronous so the
// whole app (and tests) stays synchronous; a real deployment should use bcrypt/argon2 server-side.
const PW_ITER=1000;
function hashPassword(pw){
  const salt=Math.random().toString(36).slice(2,12)+Date.now().toString(36);
  let d=sha256hex(salt+'|'+pw);
  for(let i=0;i<PW_ITER-1;i++)d=sha256hex(d+salt);
  return 'h2$'+salt+'$'+d;
}
function verifyPassword(pw,stored){
  if(!stored||!pw)return false;
  if(stored.startsWith('h2$')){
    const parts=stored.split('$');
    if(parts.length!==3)return false;
    const salt=parts[1];
    let d=sha256hex(salt+'|'+pw);
    for(let i=0;i<PW_ITER-1;i++)d=sha256hex(d+salt);
    return d===parts[2];
  }
  if(stored.startsWith('h1$'))return stored==='h1$'+hashStr(pw+'::fitcore');
  return false;
}
function qrSig(memberId,dateStr,nonce,secret){
  return sha256hex(memberId+'|'+dateStr+'|'+nonce+'|'+secret).slice(0,16);
}
function getQrSecret(){
  const s=Settings.one('qr');
  if(s&&s.secret)return s.secret;
  const secret=sha256hex('fc-secret-'+Date.now()+'-'+Math.random()).slice(0,32);
  Settings.save([...Settings.all().filter(x=>x.id!=='qr'),{id:'qr',secret}]);
  return secret;
}
function newQrNonce(memberId){return sha256hex(memberId+'|'+Date.now()+'-'+Math.random()).slice(0,8);}
function getMemberNonce(memberId){
  const m=Members.one(memberId);
  if(!m)return'';
  if(!m.qrNonce){m.qrNonce=newQrNonce(memberId);Members.update(memberId,{qrNonce:m.qrNonce});}
  return m.qrNonce;
}
function qrTokenFor(memberId,dateStr){
  const d=dateStr||today();
  const sig=qrSig(memberId,d,getMemberNonce(memberId),getQrSecret());
  return 'FCG.'+memberId+'.'+d.replace(/-/g,'')+'.'+sig;
}
function parseQrToken(token){
  const parts=String(token||'').trim().split('.');
  if(parts.length!==4||parts[0]!=='FCG')return null;
  const memberId=parts[1],dateNum=parts[2],sig=parts[3];
  if(!/^\d{8}$/.test(dateNum))return null;
  const dateStr=dateNum.slice(0,4)+'-'+dateNum.slice(4,6)+'-'+dateNum.slice(6,8);
  const expected=qrSig(memberId,dateStr,getMemberNonce(memberId),getQrSecret());
  if(sig!==expected)return null;
  return{memberId,dateStr};
}
function renderQrTo(el,token,cell=5){
  if(!el)return;
  el.innerHTML='';
  try{
    const qr=qrcode(0,'M');
    qr.addData(token);
    qr.make();
    el.innerHTML=qr.createImgTag(cell,cell*2);
    const img=el.querySelector('img');
    if(img){img.style.imageRendering='pixelated';img.style.display='block';}
  }catch(e){el.innerHTML='<div style="color:var(--red);font-size:12px">QR generation failed</div>';}
}
function formatDate(dateStr){if(!dateStr)return'—';const d=new Date(dateStr);return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}
function formatDateTime(dateStr){if(!dateStr)return'—';const d=new Date(dateStr);return d.toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});}
function formatFullDate(dateStr){const d=new Date(dateStr);return d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});}

// ============================= XSS DEFENSE =============================
// Escape user-controlled strings before injecting into innerHTML. All data that flows
// from Members/Users/Payments/Walkins/Plans into HTML must pass through esc().
function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function onImagePick(input,urlField,previewId,clearId){
  const f=input.files&&input.files[0];
  if(!f)return;
  if(!/^image\//.test(f.type)){toast('Please select an image file.','error');return;}
  if(f.size>300000){toast('Please use an image smaller than 300KB.','error');return;}
  const r=new FileReader();
  r.onload=null;
  r.onload=function(ev){
    const data=ev.target.result;
    const u=document.getElementById(urlField);if(u)u.value=data;
    const p=document.getElementById(previewId);if(p){p.src=data;p.style.display='block';}
    const c=document.getElementById(clearId);if(c)c.style.display='inline-flex';
  };
  r.readAsDataURL(f);
  input.value='';
}
function removeImage(urlField,previewId,clearId){
  const u=document.getElementById(urlField);if(u)u.value='';
  const p=document.getElementById(previewId);if(p){p.src='';p.style.display='none';}
  const c=document.getElementById(clearId);if(c)c.style.display='none';
}
// Strip HTML-significant characters and control chars at WRITE time (defense in depth).
// Newlines/tabs are preserved so multi-line plan benefits and notes stay intact.
function sanitizeText(v){
  return String(v==null?'':v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/[<>]/g,'').trim();
}
// Upgrade records saved by pre-v14 seeds: convert plaintext staff passwords to salted hashes.
// Member h1$ (FNV) hashes are upgraded lazily on successful login (plaintext is never recoverable).
function migrateLegacyPasswords(){
  const users=Users.all();
  let changed=false;
  users.forEach(u=>{
    if(!u.passwordHash&&typeof u.password==='string'&&u.password){
      u.passwordHash=hashPassword(u.password);
      delete u.password;
      changed=true;
    }
  });
  if(changed)Users.save(users);
}

// ============================= SEED DATA =============================
function seedData(){
  // Online (Firebase) mode: cloud is the source of truth — start with a clean
  // local mirror and let onSnapshot listeners populate it. No local seeds.
  if(window.GMSFB&&GMSFB.enabled){GMSFB.bootstrapLocal();return;}
  if(localStorage.getItem('gms_seeded')==='13'){
    migrateLegacyPasswords();
    return;
  }
  // Clear all existing data for fresh start
  Object.values(KEY).forEach(k=>localStorage.removeItem(k));
  localStorage.removeItem('gms_login_attempts');
  LoginAttempts.save({});
  // Users — NONE. All accounts (admin/staff/trainer/member) live in Firebase
  // Authentication + the cloud database. There are no offline/local accounts
  // and no credentials anywhere in this source code.
  const users=[];
  Users.save(users);
  // Plans (keep default plans)
  const plans=[
    {id:'pl1',name:'Basic',price:500,duration:1,sessions:8,benefits:'Gym access\nLocker use',status:'Active'},
    {id:'pl2',name:'Standard',price:900,duration:1,sessions:16,benefits:'Gym access\nLocker use\n1 trainer session',status:'Active'},
    {id:'pl3',name:'Premium',price:1500,duration:3,sessions:'Unlimited',benefits:'Full access\nPriority trainer\nFree assessment',status:'Active'}
  ];
  Plans.save(plans);
  // Seed 5 members added by staff (Marie Santos)
  const t=today();
  const seedMembers=[
    {id:'MEM-0001',name:'Stephen Hugo',contact:'09171000001',age:'28',sex:'Male',planId:'pl2',startDate:addDays(t,-25),expiryDate:addDays(t,5),address:'',ecName:'',ecNum:'',notes:'',status:'Expiring Soon',createdAt:addDays(t,-25),createdBy:'Marie Santos',createdByUsername:'staff',createdByRole:'staff',bgCheckStatus:'Cleared',bgCheckDate:addDays(t,-25),bgCheckBy:'Marie Santos',bgCheckNotes:''},
    {id:'MEM-0002',name:'Mike Delavega',contact:'09171000002',age:'32',sex:'Male',planId:'pl1',startDate:addDays(t,-28),expiryDate:addDays(t,2),address:'',ecName:'',ecNum:'',notes:'',status:'Expiring Soon',createdAt:addDays(t,-28),createdBy:'Marie Santos',createdByUsername:'staff',createdByRole:'staff',bgCheckStatus:'Cleared',bgCheckDate:addDays(t,-28),bgCheckBy:'Marie Santos',bgCheckNotes:''},
    {id:'MEM-0003',name:'Christan Aranez',contact:'09171000003',age:'25',sex:'Male',planId:'pl3',startDate:addDays(t,-88),expiryDate:addDays(t,2),address:'',ecName:'',ecNum:'',notes:'',status:'Expiring Soon',createdAt:addDays(t,-88),createdBy:'Marie Santos',createdByUsername:'staff',createdByRole:'staff',bgCheckStatus:'Cleared',bgCheckDate:addDays(t,-88),bgCheckBy:'Marie Santos',bgCheckNotes:''},
    {id:'MEM-0004',name:'Sam Ervin Cuajor',contact:'09171000004',age:'30',sex:'Male',planId:'pl1',startDate:addDays(t,-30),expiryDate:addDays(t,-1),address:'',ecName:'',ecNum:'',notes:'',status:'Expired',createdAt:addDays(t,-30),createdBy:'Marie Santos',createdByUsername:'staff',createdByRole:'staff',bgCheckStatus:'Cleared',bgCheckDate:addDays(t,-30),bgCheckBy:'Marie Santos',bgCheckNotes:''},
    {id:'MEM-0005',name:'Janwell Nacario',contact:'09171000005',age:'27',sex:'Male',planId:'pl2',startDate:addDays(t,-29),expiryDate:addDays(t,1),address:'',ecName:'',ecNum:'',notes:'',status:'Expiring Soon',createdAt:addDays(t,-29),createdBy:'Marie Santos',createdByUsername:'staff',createdByRole:'staff',bgCheckStatus:'Cleared',bgCheckDate:addDays(t,-29),bgCheckBy:'Marie Santos',bgCheckNotes:''}
  ];
  // Seed initial payments for these members
  const seedPayments=[
    {id:'PAY-0001',memberId:'MEM-0001',memberName:'Stephen Hugo',planId:'pl2',planName:'Standard',amount:900,date:addDays(t,-25),newExpiry:addDays(t,5),method:'Cash',notes:'',recordedBy:'Marie Santos',recordedByUsername:'staff',status:'Paid',createdAt:addDays(t,-25)},
    {id:'PAY-0002',memberId:'MEM-0002',memberName:'Mike Delavega',planId:'pl1',planName:'Basic',amount:500,date:addDays(t,-28),newExpiry:addDays(t,2),method:'Cash',notes:'',recordedBy:'Marie Santos',recordedByUsername:'staff',status:'Paid',createdAt:addDays(t,-28)},
    {id:'PAY-0003',memberId:'MEM-0003',memberName:'Christan Aranez',planId:'pl3',planName:'Premium',amount:1500,date:addDays(t,-88),newExpiry:addDays(t,2),method:'GCash',notes:'',recordedBy:'Marie Santos',recordedByUsername:'staff',status:'Paid',createdAt:addDays(t,-88)},
    {id:'PAY-0004',memberId:'MEM-0004',memberName:'Sam Ervin Cuajor',planId:'pl1',planName:'Basic',amount:500,date:addDays(t,-30),newExpiry:addDays(t,-1),method:'Cash',notes:'',recordedBy:'Marie Santos',recordedByUsername:'staff',status:'Paid',createdAt:addDays(t,-30)},
    {id:'PAY-0005',memberId:'MEM-0005',memberName:'Janwell Nacario',planId:'pl2',planName:'Standard',amount:900,date:addDays(t,-29),newExpiry:addDays(t,1),method:'Cash',notes:'',recordedBy:'Marie Santos',recordedByUsername:'staff',status:'Paid',createdAt:addDays(t,-29)}
  ];
  Members.save(seedMembers);
  // Seed 1 self-registered member awaiting payment (demo of the new onboarding flow)
  const pendingMember={id:'MEM-0006',name:'Nicole Ramos',username:'nicole',contact:'09171000006',email:'nicole.ramos@example.com',passwordHash:hashPassword('member123'),planId:'pl2',status:'pending_payment',startDate:'',expiryDate:'',planStart:'',qrToken:'',age:'',sex:'',address:'',ecName:'',ecNum:'',notes:'',createdAt:addDays(t,-1),createdBy:'Self',createdByUsername:'',createdByRole:'member'};
  Members.add(pendingMember);
  pushPendingPaymentNotif(pendingMember);
  getQrSecret();
  Payments.save(seedPayments);
  Sessions.save([]);
  Walkins.save([]);
  Attendance.save([]);
  setWalkinFee(100);
  localStorage.setItem('gms_seeded','14');
}

// ============================= AUTH =============================
// These globals now delegate straight to the AuthService instance (Auth) defined above.
let currentUser=null;
function getSession(){return Auth.getSession();}
function setSession(u){Auth.setSession(u);}
function clearSession(){Auth.clearSession();}

function showLandingSection(section, linkEl) {
  const sections = ['home','features','explore','register','trainers','reviews'];
  sections.forEach(s => {
    const el = document.getElementById('landing' + s.charAt(0).toUpperCase() + s.slice(1));
    if(el) el.style.display = 'none';
  });
  const mq=document.querySelector('.marquee');if(mq)mq.style.display=section==='home'?'block':'none';
  const extraEl = document.getElementById('landingExploreExtra');
  if(extraEl) extraEl.style.display = 'none';
  const target = document.getElementById('landing' + section.charAt(0).toUpperCase() + section.slice(1));
  if(target) target.style.display = 'flex';
  if(section === 'explore' && extraEl) extraEl.style.display = 'block';
  if(section === 'explore') renderExplorePlans();
  if(section === 'trainers') renderTrainers();
  document.querySelectorAll('.ln-link').forEach(l => l.classList.remove('active'));
  if(linkEl) linkEl.classList.add('active');
  // Hide LOG IN button when already on the login/register section
  const ctaBtns = document.querySelectorAll('.ln-cta');
  ctaBtns.forEach(btn => { btn.style.display = section === 'register' ? 'none' : ''; });
  iconize(document);
  initReveals();
}
async function doLogin(){
  const u=document.getElementById('loginUser').value.trim();
  const p=document.getElementById('loginPass').value;
  const btn=document.querySelector('#loginForm .btn-primary');
  if(btn){btn.disabled=true;btn.textContent='Logging in…';}
  try{
    const result=await Auth.login(u,p);
    if(!result.ok){showLoginError(result.error);return;}
    currentUser=result.user;
    loadApp();
  }catch(e){
    console.error('[login]',e);
    showLoginError('Login failed. Please refresh the page (Ctrl+F5) and try again.');
  }finally{
    if(btn){btn.disabled=false;btn.textContent='Log In';}
  }
}

function confirmLogout(){
  if(currentUser){
    const roleMeta={
      admin:{label:'Admin',bg:'rgba(179,188,181,.2)',color:'var(--orange)'},
      staff:{label:'Staff',bg:'rgba(179,188,181,.2)',color:'#d7ddd8'},
      trainer:{label:'Trainer',bg:'rgba(127,250,136,.15)',color:'var(--green)'},
      member:{label:'Member',bg:'rgba(251,191,36,.15)',color:'var(--gold)'}
    };
    const rm=roleMeta[currentUser.role]||{label:currentUser.role,bg:'rgba(255,255,255,.1)',color:'var(--gray-300)'};
    openConfirm(
      'Confirm Logout',
      '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:8px 0"><div style="font-size:36px">🚪</div><div style="font-size:14px;color:var(--gray-300);text-align:center;line-height:1.6">You are logged in as <strong style="color:var(--white)">'+esc(currentUser.name)+'</strong> <span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:4px;background:'+rm.bg+';color:'+rm.color+';margin-left:6px;text-transform:uppercase">'+esc(rm.label)+'</span><br>Are you sure you want to log out?</div></div>',
      doLogout,
      '🚪 Yes, Log Out',
      'btn-danger'
    );
  } else {
    doLogout();
  }
}
function doLogout(){
  clearSession();currentUser=null;
  if(window.GMSFB&&GMSFB.enabled)GMSFB.signOut();
  if(_pendingPoll){clearInterval(_pendingPoll);_pendingPoll=null;}
  const pg=document.getElementById('pendingGate');if(pg)pg.style.display='none';
  document.getElementById('app').classList.remove('active');
  document.getElementById('loginPage').style.display='block';
  document.getElementById('landingNav').style.display='flex';
  showLandingSection('register', null);
  showLogin();
  document.getElementById('loginUser').value='';
  document.getElementById('loginPass').value='';
  document.getElementById('loginError').style.display='none';
}
function showLoginError(msg){const el=document.getElementById('loginError');el.textContent=msg;el.style.display='block';}
function resetRegisterForm(){
  ['regName','regContact','regUser','regPass','regPass2','regCoachName','regBio'].forEach(function(id){const el=document.getElementById(id);if(el)el.value='';});
  const roleEl=document.getElementById('regRole');if(roleEl)roleEl.value='';
  // Reset role cards
  ['roleCardStaff','roleCardTrainer','roleCardMember'].forEach(function(id){const c=document.getElementById(id);if(c){c.style.borderColor='rgba(255,255,255,.16)';c.style.background='var(--navy-700)';}});
  document.querySelectorAll('#regSpecGrid input[type=checkbox]').forEach(function(cb){cb.checked=false;});
  document.querySelectorAll('#regAvailDays input[type=checkbox]').forEach(function(cb){cb.checked=false;});
  const fromEl=document.getElementById('regAvailFrom');if(fromEl)fromEl.value='';
  const toEl=document.getElementById('regAvailTo');if(toEl)toEl.value='';
  const bars=['ps1','ps2','ps3'];bars.forEach(function(id){const b=document.getElementById(id);if(b)b.className='pw-strength-bar';});
  const lbl=document.getElementById('psLabel');if(lbl)lbl.textContent='';
  ['regPass','regPass2'].forEach(function(id){const el=document.getElementById(id);if(el)el.type='password';});
  ['regError','regError2','regError3','regSuccess','regSuccess3'].forEach(function(id){const el=document.getElementById(id);if(el)el.style.display='none';});
}
function selectRegRole(role){
  document.getElementById('regRole').value=role;
  const cards={staff:document.getElementById('roleCardStaff'),trainer:document.getElementById('roleCardTrainer'),member:document.getElementById('roleCardMember')};
  Object.keys(cards).forEach(r=>{
    const c=cards[r];
    if(c){c.style.borderColor=(r===role)?'var(--orange)':'rgba(255,255,255,.16)';c.style.background=(r===role)?'rgba(179,188,181,.1)':'var(--navy-700)';}
  });
  document.getElementById('regError').style.display='none';
}
function regStep1Next(){
  const role=document.getElementById('regRole').value;
  const err=document.getElementById('regError');
  if(!role){err.textContent='Please select Staff, Trainer or Member to continue.';err.style.display='block';return;}
  err.style.display='none';
  if(role==='member'){showRegTab('member');return;}
  document.getElementById('regStep1').style.display='none';
  document.getElementById('regStep2').style.display='block';
  const sub=document.getElementById('regStep2Sub');
  if(sub)sub.textContent=role==='trainer'?'Trainer Registration — Step 2 of 3':'Staff Registration — Step 2 of 2';
  const bar=document.getElementById('regStepBar2');
  if(bar)bar.style.background=role==='trainer'?'rgba(179,188,181,.3)':'var(--orange)';
  const btn=document.getElementById('regStep2Btn');
  if(btn)btn.textContent=role==='trainer'?'Next: Trainer Profile →':'Submit for Admin Approval';
}
function regGoStep1(){
  document.getElementById('regStep2').style.display='none';
  document.getElementById('regStep3').style.display='none';
  document.getElementById('regStep1').style.display='block';
}
function regGoStep2(){
  document.getElementById('regStep3').style.display='none';
  document.getElementById('regStep2').style.display='block';
}
function regStep2Next(){
  const role=document.getElementById('regRole').value;
  const name=document.getElementById('regName').value.trim();
  const contact=document.getElementById('regContact').value.trim();
  const user=document.getElementById('regUser').value.trim();
  const pass=document.getElementById('regPass').value;
  const pass2=document.getElementById('regPass2').value;
  const err=document.getElementById('regError2');
  err.style.display='none';
  if(!name||!contact||!user||!pass||!pass2){err.textContent='Please fill in all required fields.';err.style.display='block';return;}
  if(contact.replace(/\D/g,'').length<6){err.textContent='Please enter a valid contact number.';err.style.display='block';return;}
  if(pass.length<6){err.textContent='Password must be at least 6 characters.';err.style.display='block';return;}
  if(pass!==pass2){err.textContent='Passwords do not match.';err.style.display='block';return;}
  const users=Users.all();
  if(users.find(x=>x.username===user)){err.textContent='Username already taken. Please choose a different username.';err.style.display='block';return;}
  if(role==='trainer'){
    document.getElementById('regStep2').style.display='none';
    document.getElementById('regStep3').style.display='block';
  } else {
    doRegister();
  }
}
function showLogin(){document.getElementById('loginForm').style.display='block';document.getElementById('registerForm').style.display='none';document.getElementById('loginError').style.display='none';const ms=document.getElementById('memberSignup');if(ms)ms.style.display='none';const lc=document.getElementById('loginCard');if(lc)lc.style.display='block';}
function showRegister(){
  resetRegisterForm();
  document.getElementById('loginForm').style.display='none';
  showRegTab('staff');
}
function regGoMember(){
  showRegTab('member');
}
function showRegTab(tab){
  const isMember=tab==='member';
  const ms=document.getElementById('memberSignup');
  const rf=document.getElementById('registerForm');
  const lc=document.getElementById('loginCard');if(lc)lc.style.display=isMember?'none':'block';
  if(ms)ms.style.display=isMember?'block':'none';
  if(rf){
    rf.style.display=isMember?'none':'block';
    if(!isMember){
      document.getElementById('regStep1').style.display='block';
      document.getElementById('regStep2').style.display='none';
      document.getElementById('regStep3').style.display='none';
      const e=document.getElementById('regError');if(e)e.style.display='none';
    }
  }
  const le=document.getElementById('loginError');if(le)le.style.display='none';
  const re=document.getElementById('regError');if(re)re.style.display='none';
  if(isMember){
    resetMemberSignupForm();
    populateMsPlanSelect(_memberSignupPlanId);
    const e=document.getElementById('msError');if(e)e.style.display='none';
    const s=document.getElementById('msSuccess');if(s)s.style.display='none';
    iconize(document.getElementById('memberSignup'));
  }
}
// ============================= MEMBER SELF-SIGNUP (Guest → Member) =============================
let _memberSignupPlanId=null;let _msPlanPicked=null;
function populateMsPlanSelect(selectedId){
  const sel=document.getElementById('msPlanSelect');
  const opts=document.getElementById('msPlanOptions');
  if(!sel||!opts)return;
  if(!Plans.all().length&&window.GMSFB&&GMSFB.enabled&&typeof GMSFB.ensureSeededPlans==='function')GMSFB.ensureSeededPlans();
  const plans=Plans.all().filter(p=>p.status==='Active');
  sel.innerHTML=plans.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const pick=plans.find(p=>p.id===selectedId)?selectedId:(plans.length?plans[0].id:'');
  sel.value=pick;_msPlanPicked=pick;
  opts.innerHTML=plans.map(p=>{
    const price=Number(p.price).toLocaleString();
    const dur=p.duration===1?'1 month':p.duration+' months';
    const sess=p.sessions==='Unlimited'?'Unlimited sessions':p.sessions+' sessions';
    const feats=(p.benefits||p.perks||'').split(/\n|,/).map(b=>b.trim()).filter(Boolean).map(b=>`<span class="ms-plan-opt-feat">${esc(b)}</span>`).join('');
    const isSel=p.id===pick;
    return `<div class="ms-plan-opt${isSel?' selected':''}" id="msPlanOpt-${p.id}" onclick="pickMsPlan('${p.id}')">
      <div class="ms-plan-opt-head">
        <div>
          <div class="ms-plan-opt-name">${esc(p.name)}</div>
          <div class="ms-plan-opt-sub">${dur} · ${sess}</div>
        </div>
        <div class="ms-plan-opt-right">
          <div class="ms-plan-opt-price">₱${price}<span class="ms-plan-opt-per">${p.duration===1?'/mo':'/'+p.duration+'mo'}</span></div>
          <div class="ms-plan-opt-check">✓</div>
        </div>
      </div>
      ${isSel&&feats?`<div class="ms-plan-opt-feats">${feats}</div>`:''}
    </div>`;}).join('');
  updateMsPlanCard();
}
function pickMsPlan(planId){
  populateMsPlanSelect(planId);
}
function updateMsPlanCard(){
  const sel=document.getElementById('msPlanSelect');
  const plan=sel?Plans.one(sel.value):null;
  const nameEl=document.getElementById('msPlanName');if(nameEl)nameEl.textContent=plan?plan.name:'—';
  const priceEl=document.getElementById('msPlanPrice');if(priceEl)priceEl.textContent=plan?'₱'+Number(plan.price).toLocaleString()+(plan.duration===1?'/mo':'/'+plan.duration+'mo'):'—';
  const durEl=document.getElementById('msPlanDur');if(durEl)durEl.textContent=plan?(plan.duration+' month(s) · '+(plan.sessions==='Unlimited'?'Unlimited sessions':plan.sessions+' sessions')):'';
  const perksEl=document.getElementById('msPlanPerks');if(perksEl)perksEl.innerHTML=plan?(plan.benefits||plan.perks||'').split(/\n|,/).map(b=>b.trim()).filter(Boolean).map(b=>`<li>✓ ${b}</li>`).join(''):'';
}
function startMemberSignup(planId){
  _memberSignupPlanId=planId;
  showLandingSection('register', document.querySelector('.ln-cta'));
  showRegTab('member');
}
function msBackToLogin(){
  _memberSignupPlanId=null;
  showLogin();
}
function msStep1Next(){
  const sel=document.getElementById('msPlanSelect');
  const err=document.getElementById('msStep1Error');
  if(!_memberSignupPlanId&&!_msPlanPicked&&!(sel&&sel.value)){
    if(err){err.textContent='Please choose a plan to continue.';err.style.display='block';}
    return;
  }
  if(err)err.style.display='none';
  document.getElementById('msStep1').style.display='none';
  document.getElementById('msStep2').style.display='block';
}
function msStep2Next(){
  const name=document.getElementById('msName').value.trim();
  const contact=document.getElementById('msContact').value.trim();
  const email=document.getElementById('msEmail').value.trim();
  const err=document.getElementById('msStep2Error');
  if(err)err.style.display='none';
  if(!name||!contact||!email){if(err){err.textContent='Please fill in all required fields.';err.style.display='block';}return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){if(err){err.textContent='Please enter a valid email address.';err.style.display='block';}return;}
  if(!/^09\d{9}$/.test(contact.replace(/[\s-]/g,''))){if(err){err.textContent='Please enter a valid PH mobile number (e.g. 09171234567).';err.style.display='block';}return;}
  if(Members.all().find(m=>m.email&&m.email.toLowerCase()===email.toLowerCase())){if(err){err.textContent='Email already registered. Please log in instead.';err.style.display='block';}return;}
  document.getElementById('msStep2').style.display='none';
  document.getElementById('msStep3').style.display='block';
}
function msGoStep1(){
  document.getElementById('msStep2').style.display='none';
  document.getElementById('msStep3').style.display='none';
  document.getElementById('msStep1').style.display='block';
  const suc=document.getElementById('msSuccess');if(suc)suc.style.display='none';
  const e=document.getElementById('msError');if(e)e.style.display='none';
}
function msGoStep2(){
  document.getElementById('msStep3').style.display='none';
  document.getElementById('msStep2').style.display='block';
  const suc=document.getElementById('msSuccess');if(suc)suc.style.display='none';
  const e=document.getElementById('msError');if(e)e.style.display='none';
}
function resetMemberSignupForm(){
  ['msName','msUsername','msContact','msEmail','msPass','msPass2'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  ['mps1','mps2','mps3'].forEach(id=>{const b=document.getElementById(id);if(b)b.className='pw-strength-bar';});
  const lbl=document.getElementById('msPsLabel');if(lbl)lbl.textContent='';
  const pw=document.getElementById('msPwStrength');if(pw)pw.style.display='none';
  if(lbl)lbl.style.display='none';
  const s1=document.getElementById('msStep1');if(s1)s1.style.display='block';
  const s2=document.getElementById('msStep2');if(s2)s2.style.display='none';
  const s3=document.getElementById('msStep3');if(s3)s3.style.display='none';
  const done=document.getElementById('msDone');if(done)done.style.display='none';
  const se=document.getElementById('msStep1Error');if(se)se.style.display='none';
  const se2=document.getElementById('msStep2Error');if(se2)se2.style.display='none';
  const msuc=document.getElementById('msSuccess');if(msuc)msuc.style.display='none';
  const merr=document.getElementById('msError');if(merr)merr.style.display='none';
}
function updateMsStrength(val){
  const bars=[document.getElementById('mps1'),document.getElementById('mps2'),document.getElementById('mps3')];
  const lbl=document.getElementById('msPsLabel');
  const wrap=document.getElementById('msPwStrength');
  if(wrap)wrap.style.display=val?'flex':'none';
  if(lbl)lbl.style.display=val?'block':'none';
  bars.forEach(b=>{b.className='pw-strength-bar'});
  if(!val){if(lbl)lbl.textContent='';return;}
  let score=0;
  if(val.length>=6)score++;if(val.length>=10)score++;
  if(/[A-Z]/.test(val)&&/[0-9]/.test(val))score++;
  const levels=['weak','fair','strong'];
  const labels=['Weak','Fair','Strong'];
  for(let i=0;i<score;i++)bars[i].classList.add(levels[Math.min(score-1,2)]);
  lbl.textContent=labels[Math.min(score-1,2)]||'';
}
function msStep3Next(){
  const v=msValidateCredentials(document.getElementById('msError'));
  if(!v)return;
  submitMemberSignup();
}
function msValidateCredentials(err){
  const name=document.getElementById('msName').value.trim();
  const uname=document.getElementById('msUsername').value.trim();
  const contact=document.getElementById('msContact').value.trim();
  const email=document.getElementById('msEmail').value.trim();
  const pass=document.getElementById('msPass').value;
  const pass2=document.getElementById('msPass2').value;
  const fail=msg=>{if(err){err.textContent=msg;err.style.display='block';}return null;};
  if(!name||!uname||!contact||!email||!pass||!pass2)return fail('Please fill in all required fields.');
  if(!/^[a-zA-Z0-9._]{3,20}$/.test(uname))return fail('Username must be 3–20 characters (letters, numbers, dots, underscores only).');
  if(Members.all().find(m=>m.username&&m.username.toLowerCase()===uname.toLowerCase())||Users.all().find(u=>u.username&&u.username.toLowerCase()===uname.toLowerCase()))return fail('Username already taken. Please choose another.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return fail('Please enter a valid email address.');
  if(!/^09\d{9}$/.test(contact.replace(/[\s-]/g,'')))return fail('Please enter a valid PH mobile number (e.g. 09171234567).');
  if(pass.length<6)return fail('Password must be at least 6 characters.');
  if(pass!==pass2)return fail('Passwords do not match.');
  if(Members.all().find(m=>m.email&&m.email.toLowerCase()===email.toLowerCase()))return fail('Email already registered. Please log in instead.');
  const normContact=contact.replace(/[\s-]/g,'');
  if(Members.all().find(m=>m.contact===normContact))return fail('Phone number already registered. Please log in instead or use another number.');
  return{name,uname,contact:normContact,email,pass};
}
async function submitMemberSignup(){
  const err=document.getElementById('msError');
  if(signupRateCheck()){err.textContent='Too many sign-up attempts. Please wait a few minutes and try again.';err.style.display='block';return;}
  const sel=document.getElementById('msPlanSelect');
  const planId=_memberSignupPlanId||_msPlanPicked||(sel?sel.value:'');
  if(!planId){err.textContent='Please choose a plan first.';err.style.display='block';return;}
  const v=msValidateCredentials(err);
  if(!v)return;
  // ---------- CLOUD-ONLY REGISTRATION ----------
  // The member doc, the pending-payment notification and the activity entry
  // are written straight to Firestore through the secondary app's
  // authenticated context. Nothing is stored in localStorage here — the live
  // snapshot delivers the new member to every device, including this one.
  if(!(window.GMSFB&&GMSFB.enabled)){
    err.textContent='Registration requires an internet connection. Please connect to the internet and try again.';err.style.display='block';return;
  }
  // Auth identity = synthetic username email, so the account can log in with
  // its USERNAME on ANY device (the real email stays as contact info and as a
  // fallback login hint). The member doc keeps authEmail for the fast path.
  const authEmail=GMSFB.authEmailFor({username:v.uname});
  const r=await GMSFB.createUserCreds(authEmail,v.pass);
  if(!r.ok){
    if(r.code==='auth/email-already-in-use'){
      // Recover earlier half-finished signups: verify the password on the
      // SECONDARY app (the context secSetDoc writes through).
      const si=await GMSFB.secSignIn(authEmail,v.pass);
      if(!si.ok){err.textContent='Email already registered. Please log in instead.';err.style.display='block';return;}
    } else {err.textContent=r.error;err.style.display='block';return;}
  }
  const plan=planId?Plans.one(planId):null;
  // Collision-safe ID: the local cache may be empty on guest devices, so also
  // skip any ID that already exists in the cloud mirror.
  let id=nextMemberId();
  const cloudMembers=(window.GMSFB&&GMSFB._lastCloud&&GMSFB._lastCloud.members)||{};
  while(cloudMembers[id])id='MEM-'+String(parseInt(id.split('-')[1],10)+1).padStart(4,'0');
  const member={id,name:sanitizeText(v.name),username:v.uname,contact:v.contact,email:sanitizeText(v.email),planId,status:'pending_payment',startDate:'',expiryDate:'',planStart:'',qrToken:'',age:'',sex:'',address:'',ecName:'',ecNum:'',notes:'',createdAt:today(),createdBy:'Self',createdByUsername:v.uname,createdByRole:'member',bgCheckStatus:'Pending',bgCheckDate:'',bgCheckBy:'',bgCheckNotes:'',authEmail};
  const wr=await GMSFB.secSetDoc('members',member);
  if(!wr||!wr.ok){
    GMSFB.secondarySignOut();
    err.textContent='Registration could not reach the server. Please check your internet connection and try again.';err.style.display='block';return;
  }
  const notif={id:'NTF-'+uid(),memberId:member.id,planId:member.planId||'',type:'pending_payment',status:'open',createdAt:member.createdAt||today()};
  await GMSFB.secSetDoc('notifications',notif);
  const act={id:'ACT'+Date.now(),action:'Signup',category:'Member',detail:v.name,extra:'ID: '+id+' | Plan: '+(plan?plan.name:'')+' | Awaiting front-desk payment',by:v.name,byUsername:v.uname,byRole:'member',at:new Date().toISOString()};
  await GMSFB.secSetDoc('activitylog',act);
  GMSFB.secondarySignOut();
  _memberSignupPlanId=null;
  document.getElementById('msStep3').style.display='none';
  const done=document.getElementById('msDone');
  const msg=document.getElementById('msDoneMsg');
  if(msg)msg.textContent='Account registered! Please pay at the front desk (Cash or GCash) to activate your membership. You can log in once our staff confirms your payment.';
  if(done)done.style.display='block';
}
function onRegRoleChange(val){}
async function doRegister(){
  const role=document.getElementById('regRole').value;
  const rateErr=role==='trainer'?document.getElementById('regError3'):document.getElementById('regError2');
  if(rateErr&&signupRateCheck()){rateErr.textContent='Too many sign-up attempts. Please wait a few minutes and try again.';rateErr.style.display='block';return;}
  const name=document.getElementById('regName').value.trim();
  const contact=document.getElementById('regContact').value.trim();
  const user=document.getElementById('regUser').value.trim();
  const pass=document.getElementById('regPass').value;
  const dialCode=document.getElementById('phoneDialCode').textContent.trim();
  const fullContact=dialCode+contact.replace(/^0/,'');
  if(role==='admin'){return;}
  let trainerData={};
  if(role==='trainer'){
    const coachName=document.getElementById('regCoachName').value.trim();
    const specs=[...document.querySelectorAll('#regSpecGrid input[type=checkbox]:checked')].map(c=>c.value);
    const days=[...document.querySelectorAll('#regAvailDays input[type=checkbox]:checked')].map(c=>c.value);
    const from=document.getElementById('regAvailFrom').value;
    const to=document.getElementById('regAvailTo').value;
    const bio=document.getElementById('regBio').value.trim();
    const err3=document.getElementById('regError3');
    err3.style.display='none';
    if(!coachName){err3.textContent='Please enter a Coach/Display Name.';err3.style.display='block';return;}
    if(specs.length===0){err3.textContent='Please select at least one specialization.';err3.style.display='block';return;}
    if(days.length===0||!from||!to){err3.textContent='Please fill in your availability (days and hours).';err3.style.display='block';return;}
    trainerData={coachName,specializations:specs,availableDays:days,availableFrom:from,availableTo:to,bio};
  }
  const result=await Auth.register(role,{name,contact:fullContact,username:user,password:pass,...trainerData});
  if(!result.ok){
    const errId=role==='trainer'?'regError3':'regError2';
    const errEl=document.getElementById(errId);
    errEl.textContent=result.error;errEl.style.display='block';
    return;
  }
  const sucId=role==='trainer'?'regSuccess3':'regSuccess';
  const suc=document.getElementById(sucId);
  suc.textContent=role==='staff'?'Account submitted! Please wait for admin approval before logging in.':'Account created! Redirecting to login...';
  suc.style.display='block';
  const savedUser=user;const savedRole=role;
  resetRegisterForm();
  setTimeout(()=>{showLogin();if(savedRole!=='staff')document.getElementById('loginUser').value=savedUser;suc.style.display='none';},3000);
}
function togglePw(id,btn){
  const el=document.getElementById(id);
  const newType=el.type==='password'?'text':'password';
  el.type=newType;
  btn.innerHTML=newType==='password'?iconSvg('eye',16):iconSvg('eyeOff',16);
  // If toggling the main password field, sync confirm password too
  if(id==='regPass'||id==='msPass'){
    const el2=document.getElementById('regPass2');
    if(el2){
      el2.type=newType;
      const btn2=el2.closest('.input-wrap')&&el2.closest('.input-wrap').querySelector('.pw-toggle');
      if(btn2)btn2.innerHTML=newType==='password'?iconSvg('eye',16):iconSvg('eyeOff',16);
    }
  }
}
function updateStrength(val){
  const bars=[document.getElementById('ps1'),document.getElementById('ps2'),document.getElementById('ps3')];
  const lbl=document.getElementById('psLabel');
  bars.forEach(b=>{b.className='pw-strength-bar'});
  if(!val){lbl.textContent='';return;}
  let score=0;
  if(val.length>=6)score++;if(val.length>=10)score++;
  if(/[A-Z]/.test(val)&&/[0-9]/.test(val))score++;
  const levels=['weak','fair','strong'];
  const labels=['Weak','Fair','Strong'];
  for(let i=0;i<score;i++)bars[i].classList.add(levels[Math.min(score-1,2)]);
  lbl.textContent=labels[Math.min(score-1,2)]||'';
}

// ============================= APP LOAD =============================
let _pendingPoll=null;
function showPendingGate(mem){
  const archived=mem.status==='Archived';
  const plan=mem.planId?Plans.one(mem.planId):null;
  document.getElementById('loginPage').style.display='none';
  const nav=document.getElementById('landingNav');if(nav)nav.style.display='none';
  document.getElementById('app').classList.remove('active');
  const g=document.getElementById('pendingGate');
  if(g){
    const set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
    const ico=document.getElementById('pgIco');if(ico)ico.textContent=archived?'🗄':'⏳';
    const t=document.getElementById('pgTitle');if(t)t.textContent=archived?'Account Archived':'Payment Pending';
    const msg=document.getElementById('pgMsg');
    if(msg)msg.innerHTML=archived
      ?'Your sign-up was archived. Please visit the front desk to sign up again.'
      :'Your account is pending. Please visit the front desk to complete your payment (<strong>Cash</strong> or <strong>GCash</strong>) and activate your account.';
    const note=document.getElementById('pgNote');
    if(note)note.textContent=archived?'Visit the front desk to register again.':'Your QR code unlocks automatically once payment is confirmed.';
    set('pgName',mem.name);
    set('pgId',mem.id);
    set('pgPlanName',plan?plan.name:'—');
    set('pgPlanPrice',plan?'₱'+Number(plan.price).toLocaleString()+(plan.duration===1?'/mo':'/'+plan.duration+'mo'):'—');
    g.style.display='flex';
  }
  if(_pendingPoll)clearInterval(_pendingPoll);
  _pendingPoll=setInterval(()=>{
    const live=Members.one(mem.id);
    if(live&&live.status!=='pending_payment'&&live.status!=='Archived'){
      clearInterval(_pendingPoll);_pendingPoll=null;
      loadApp();
    }
  },5000);
}
function refreshCurrentPanel(){
  scanRenewals();updateHeroMemberCount();
  if(_lastPanel&&_lastPanel!=='scanner')renderPanel(_lastPanel);
  toast('Data refreshed.');
}
let _contentScrollTimer=null;
function initScrollRefresh(){
  const sc=document.querySelector('.content');
  const btn=document.getElementById('scrollRefreshBtn');
  if(!sc||!btn)return;
  sc.addEventListener('scroll',()=>{
    clearTimeout(_contentScrollTimer);
    _contentScrollTimer=setTimeout(()=>{btn.style.display=sc.scrollTop>150?'flex':'none';},120);
  });
}
function loadApp(){
  if(currentUser&&currentUser.role==='member'){
    const live=Members.one(currentUser.memberId||currentUser.id);
    if(live)currentUser={...currentUser,name:live.name,email:live.email,contact:live.contact,status:live.status};
    if(live&&(live.status==='pending_payment'||live.status==='Archived')){
      showPendingGate(live);
      return;
    }
  }
  if(currentUser&&currentUser.role!=='member'){
    // Re-validate staff/trainer/admin sessions against the Users table so demoted,
    // locked or deleted accounts lose access immediately on the next load.
    const live=Users.one(currentUser.id);
    if(!live||live.status==='locked'||live.status==='pending'){
      doLogout();
      return;
    }
    currentUser={...currentUser,...live};
  }
  document.getElementById('loginPage').style.display='none';
  document.getElementById('landingNav').style.display='none';
  document.getElementById('app').classList.add('active');
  const pg=document.getElementById('pendingGate');if(pg)pg.style.display='none';
  buildSidebar();
  renderTopbar();
  scanRenewals();
  updatePendingBadge();
  updateQueueBadge();
  updateMessageBadge();
  updateSyncWarning();
  initScrollRefresh();
  navigate('dashboard');
}
function buildSidebar(){
  const u=currentUser;
  const av=document.getElementById('sideUserAvatar');
  av.className='user-avatar avatar-'+u.role;
  setUserAvatar(av,u.name,userAvatarOf());
  document.getElementById('sideUserName').textContent=u.name;
  const rb=document.getElementById('sideUserRole');
  rb.className='role-badge rb-'+u.role;rb.textContent=u.role;
  const nav=document.getElementById('sideNav');
  const items=[
    {id:'dashboard',group:'Overview',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,label:'Dashboard',roles:['admin','staff','trainer','member']},
    {id:'myqr',group:'Membership',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><path d="M21 21h-3v-3h3z"/></svg>`,label:'My QR Code',roles:['member']},
    {id:'myattendance',group:'Membership',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,label:'My Attendance',roles:['member']},
    {id:'myMessages',group:'Support',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,label:'Messages',roles:['member'],badge:'myMsgBadge'},
    {id:'members',group:'Management',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,label:'Members',roles:['admin','staff']},
    {id:'history',group:'Management',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><polyline points="12 7 12 12 15 14"/></svg>`,label:'Member History',roles:['admin','staff']},
    {id:'queue',group:'Management',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,label:'Payment Queue',roles:['admin','staff'],badge:'queueBadge'},
    {id:'billing',group:'Management',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,label:'Billing & Payments',roles:['admin','staff']},
    {id:'walkin',group:'Management',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="M14 8H10l-2 6h2l1 5h2l1-5h2l-2-6z"/><path d="M9 14l-2 4"/><path d="M15 14l2 4"/></svg>`,label:'Walk-In',roles:['admin','staff']},
    {id:'schedule',group:'Operations',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,label:'Trainer Schedule',roles:['admin','staff','trainer']},
    {id:'myassigned',group:'Operations',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,label:'My Assigned Members',roles:['trainer']},
    {id:'scanner',group:'Operations',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/></svg>`,label:'QR Scanner',roles:['admin','staff']},
    {id:'notifications',group:'Management',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`,label:'Member Renewals',roles:['admin','staff'],badge:'notifBadge'},
    {id:'messages',group:'Management',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,label:'Member Messages',roles:['admin','staff'],badge:'msgBadge'},
    {id:'announcements',group:'Management',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h2l3 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M14 8a5 5 0 0 1 0 8"/><path d="M17.5 5.5a9 9 0 0 1 0 13"/></svg>`,label:'Announcements',roles:['admin','staff']},
    {id:'plans',group:'Management',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,label:'Membership Plans',roles:['admin','staff']},
    {id:'reports',group:'Operations',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,label:'Reports',roles:['admin','staff']},
    {id:'users',group:'Administration',icon:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,label:'User Management',roles:['admin'],badge:'pendingBadge'}
  ];
  const visible=items.filter(i=>i.roles.includes(u.role));
  const groups=[];
  visible.forEach(i=>{
    let g=groups.find(x=>x.name===i.group);
    if(!g){g={name:i.group,items:[]};groups.push(g);}
    g.items.push(i);
  });
  nav.innerHTML=groups.map((g,gi)=>`
    <div class="nav-group${gi===0?' first':''}">${g.name}</div>
    ${g.items.map(i=>`
      <div class="nav-item" id="nav-${i.id}" onclick="navigate('${i.id}')">
        <span class="nav-icon">${i.icon}</span> ${i.label}
        ${i.badge?`<span class="nav-badge" id="${i.badge}" style="display:none">0</span>`:''}
      </div>`).join('')}
  `).join('');
}
function renderTopbar(){
  const av=document.getElementById('topAvatar');
  av.className='user-avatar avatar-'+currentUser.role;
  setUserAvatar(av,currentUser.name,userAvatarOf());
  startClock();
}
let _clockInterval=null;
function startClock(){
  if(_clockInterval)clearInterval(_clockInterval);
  function tick(){
    const now=new Date();
    const timeStr=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true});
    const dateStr=now.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
    const el=document.getElementById('topDate');
    if(el)el.innerHTML=`<span class="live-dot"></span><span style="color:var(--white);font-weight:700;letter-spacing:1px;font-size:13px">${timeStr}</span> <span style="color:var(--gray-500);font-size:11px">${dateStr}</span>`;
  }
  tick();
  _clockInterval=setInterval(tick,1000);
}
let _lastPanel=null;
const PANEL_ROLES={myqr:['member'],myattendance:['member'],myMessages:['member'],members:['admin','staff'],history:['admin','staff'],queue:['admin','staff'],billing:['admin','staff'],walkin:['admin','staff'],schedule:['admin','staff','trainer'],scanner:['admin','staff'],notifications:['admin','staff'],messages:['admin','staff'],announcements:['admin','staff'],plans:['admin','staff'],reports:['admin','staff'],users:['admin'],myassigned:['trainer']};
function navigate(panel){
  if(currentUser&&PANEL_ROLES[panel]&&!PANEL_ROLES[panel].includes(currentUser.role)){toast('You do not have access to this section.','error');return;}
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const ni=document.getElementById('nav-'+panel);
  if(ni)ni.classList.add('active');
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  const titles={dashboard:'Dashboard',members:'Member Management',history:'Member History',billing:'Billing & Payments',walkin:'Walk-In Management',schedule:'Trainer Schedule',notifications:'Member Renewals',messages:'Member Messages',plans:'Membership Plans',reports:'Reports',users:'User Management',queue:'Payment Queue',scanner:'QR Scanner',myqr:'My QR Code',myattendance:'My Attendance',myassigned:'My Assigned Members',myMessages:'Message the Gym'};
  document.getElementById('pageTitle').textContent=titles[panel]||'';
  const panelEl=document.getElementById('panel'+capitalize(panel));
  if(panelEl)panelEl.classList.add('active');
  if(panel==='schedule'&&_lastPanel!=='schedule'&&currentUser&&currentUser.role==='trainer'){
    schedTrainerFilter=currentUser.id;
  }
  _lastPanel=panel;
  renderPanel(panel);
  if(panel!=='scanner')stopScanner();
}
function capitalize(s){return s.charAt(0).toUpperCase()+s.slice(1);}
function initials(name){return name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);}
function memberAvatarOf(){
  if(!currentUser||currentUser.role!=='member')return'';
  const m=Members.one(currentUser.memberId||currentUser.id);
  return(m&&m.avatar)?m.avatar:'';
}
function userAvatarOf(){
  const u=currentUser;
  if(!u)return '';
  if(u.role==='member')return memberAvatarOf();
  return u.avatar||'';
}
function setUserAvatar(el,name,avatar){
  if(!el)return;
  if(avatar){el.style.backgroundImage='url("'+avatar+'")';el.style.backgroundSize='cover';el.style.backgroundPosition='center';el.style.backgroundRepeat='no-repeat';el.textContent='';}
  else{el.style.backgroundImage='';el.textContent=initials(name);}
}

// ============================= TOAST =============================
function toast(msg,type='success'){
  const wrap=document.getElementById('toastWrap');
  const icons={success:'check',error:'x',info:'info'};
  const t=document.createElement('div');
  t.className=`toast ${type}`;
  t.innerHTML=`<span class="toast-icon">${iconSvg(icons[type],14)}</span><span>${esc(msg)}</span>`;
  wrap.appendChild(t);
  setTimeout(()=>{t.classList.add('removing');setTimeout(()=>t.remove(),300);},3000);
}

// ============================= SVG ICON ENGINE =============================
// Replaces emoji pictographs throughout the UI with crisp, modern line icons.
// Runs after every render so both static markup and JS-generated HTML get
// the same treatment. Icons scale with the surrounding font size.
const ICONS={
  search:`<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`,
  calendar:`<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>`,
  clipboard:`<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="15" y2="16"/>`,
  card:`<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>`,
  check:`<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`,
  x:`<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
  info:`<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>`,
  logout:`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>`,
  logIn:`<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>`,
  pencil:`<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>`,
  eye:`<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`,
  eyeOff:`<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`,
  receipt:`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>`,
  chart:`<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>`,
  trend:`<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>`,
  pen:`<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>`,
  printer:`<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>`,
  download:`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`,
  money:`<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>`,
  users:`<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  user:`<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
  dumbbell:`<path d="m6.5 6.5 11 11"/><path d="m21 21-1-1"/><path d="m3 3 1 1"/><path d="m18 22 4-4"/><path d="m2 6 4-4"/><path d="m3 10 7-7"/><path d="m14 21 7-7"/>`,
  monitor:`<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>`,
  userPlus:`<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>`,
  phone:`<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>`,
  trash:`<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>`,
  refresh:`<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>`,
  link:`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
  zap:`<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`,
  mapPin:`<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>`,
  mail:`<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>`,
  bell:`<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>`,
  warn:`<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  save:`<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>`,
  clock:`<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
  alarm:`<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="M22 6l-3-3"/><line x1="6" y1="19" x2="4" y2="21"/><line x1="18" y1="19" x2="20" y2="21"/>`,
  hourglass:`<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>`,
  running:`<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>`,
  lock:`<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
  unlock:`<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>`,
  flag:`<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>`,
  menu:`<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>`,
  file:`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>`,
  bulb:`<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/>`,
  gear:`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
  wave:`<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>`,
  ticket:`<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>`,
  star:`<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
  camera:`<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>`
};
// Keys use the base codepoint only (no variation selector) so both "⚠" and
// "⚠️" forms match; trailing U+FE0F is skipped by iconize().
const ICON_EMOJI={
  '🔍':'search','📅':'calendar','📋':'clipboard','💳':'card','✅':'check','🚪':'logout',
  '✏':'pencil','✎':'pencil','👁':'eye','🧾':'receipt','📊':'chart','📈':'trend','📝':'pen',
  '🖨':'printer','📥':'download','💰':'money','👥':'users','👤':'user','🏋':'dumbbell','🖥':'monitor',
  '🚶':'userPlus','📞':'phone','🗑':'trash','🔄':'refresh','🔗':'link','⚡':'zap','🔔':'bell',
  '⚠':'warn','💾':'save','🕐':'clock','🕓':'clock','⏰':'alarm','⏳':'hourglass',
  '🏃':'running',  '🔒':'lock','🔓':'unlock','🏁':'flag','☰':'menu','💡':'bulb','⚙':'gear','📄':'file',
  '🕒':'clock',
  '📍':'mapPin','✉':'mail',
  '✓':'check','✔':'check','✕':'x','🙈':'eyeOff','👋':'wave','🎟':'ticket','★':'star','✦':'star'
};
function iconSvg(name,size=16){
  const body=ICONS[name]||'';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-0.16em;flex-shrink:0;display:inline-block" aria-hidden="true">${body}</svg>`;
}
function _iconSvgNode(name,size){
  const div=document.createElement('div');
  div.innerHTML=iconSvg(name,size);
  return div.firstChild;
}
function iconize(root){
  if(!root)return;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null);
  const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
  nodes.forEach(node=>{
    const text=node.nodeValue;if(!text)return;
    let hit=false;
    for(const ch of text){if(ICON_EMOJI[ch]){hit=true;break;}}
    if(!hit)return;
    const parent=node.parentNode;if(!parent)return;
    const fs=parseFloat(getComputedStyle(parent).fontSize)||16;
    const size=Math.max(12,Math.min(40,Math.round(fs)));
    const frag=document.createDocumentFragment();let buf='';let wasIcon=false;
    for(const ch of text){
      const name=ICON_EMOJI[ch];
      if(name){
        if(buf){frag.appendChild(document.createTextNode(buf));buf='';}
        frag.appendChild(_iconSvgNode(name,size));
        wasIcon=true;
      } else {
        if(ch!=='\uFE0F'||!wasIcon)buf+=ch;
        wasIcon=false;
      }
    }
    if(buf)frag.appendChild(document.createTextNode(buf));
    parent.replaceChild(frag,node);
  });
}

// ============================= MODALS =============================
function openModal(id){document.getElementById(id).classList.add('open');iconize(document.getElementById(id));}
function closeModal(id){document.getElementById(id).classList.remove('open');}
let currentProfileId=null;
function openConfirm(title,msg,onOk,btnLabel='Delete',btnClass='btn-danger'){
  document.getElementById('confirmTitle').textContent=title;
  document.getElementById('confirmMsg').innerHTML=msg;
  const btn=document.getElementById('confirmOkBtn');
  btn.textContent=btnLabel;
  btn.className='btn-sm '+btnClass;
  btn.onclick=()=>{onOk();closeModal('confirmModal');};
  openModal('confirmModal');
}

// ============================= RENEWALS SCAN =============================
function scanRenewals(){
  const members=Members.all().filter(m=>m.status==='Active'||m.status==='Expiring Soon');
  const expiring=members.filter(m=>{const d=daysUntil(m.expiryDate);return d>=0&&d<=3;});
  // Update statuses
  const all=Members.all();
  all.forEach(m=>{
    if(m.status==='Archived')return;
    m.status=Member.wrap(m).computeStatus();
  });
  // Auto-archive unpaid sign-ups older than PENDING_ARCHIVE_DAYS
  const now=Date.now();
  all.forEach(m=>{
    if(m.status!=='pending_payment')return;
    const created=new Date(m.createdAt||now).getTime();
    if(now-created>PENDING_ARCHIVE_DAYS*86400000){
      m.status='Archived';
      resolveNotifsForMember(m.id);
    }
  });
  Members.save(all);
  const badge=document.getElementById('notifBadge');
  if(badge){const c=Members.all().filter(m=>m.status!=='Archived'&&(m.status==='Expiring Soon'||m.status==='Expired')&&!_dismissedIds.has(m.id)).length;badge.textContent=c;badge.style.display=c>0?'flex':'none';}
  updateQueueBadge();
}

// ============================= PENDING APPROVALS BADGE =============================
function updatePendingBadge(){
  if(!currentUser||currentUser.role!=='admin')return;
  const pending=Users.all().filter(u=>u.status==='pending').length;
  const badge=document.getElementById('pendingBadge');
  if(badge){badge.textContent=pending;badge.style.display=pending>0?'flex':'none';}
}

// ============================= CLOUD SYNC WARNING =============================
// Surfaces Firebase connectivity problems that would otherwise silently split
// devices onto separate localStorage databases (e.g. an admin who never sees a
// staff registration made on another device).
function ensureSyncWarnEl(){
  let el=document.getElementById('syncWarn');
  if(!el){el=document.createElement('div');el.id='syncWarn';el.className='sync-warn';document.body.appendChild(el);}
  return el;
}
function updateSyncWarning(){
  const el=ensureSyncWarnEl();
  if(!window.GMSFB||!GMSFB.enabled){
    el.className='sync-warn';
    el.innerHTML='⚠️ <strong>Offline mode.</strong> Data is saved on this device only — it will NOT appear on your other devices. Connect to the internet and refresh the page.';
    el.style.display='flex';
    return;
  }
  if(typeof GMSFB.degraded==='function'&&GMSFB.degraded()){
    el.className='sync-warn warn';
    el.innerHTML='⚠️ <strong>Cloud sync problem.</strong> This device may be showing outdated data — registrations and approvals from other devices may not appear here. Check your internet connection and refresh.';
    el.style.display='flex';
    return;
  }
  el.style.display='none';
}

// ============================= PANEL ROUTER =============================
function renderPanel(p){
  const map={dashboard:renderDashboard,members:renderMembers,history:renderHistory,billing:renderBilling,walkin:renderWalkin,schedule:renderSchedule,notifications:renderNotifications,renewed:renderRenewed,messages:renderMessages,announcements:renderAnnouncements,plans:renderPlans,reports:renderReports,users:renderUsers,queue:renderQueue,scanner:renderScanner,myqr:renderMyQr,myattendance:renderMyAttendance,myassigned:renderMyAssigned,myMessages:renderMyMessages};
  if(map[p])map[p]();
  iconize(document.getElementById('panel'+p.charAt(0).toUpperCase()+p.slice(1)));
}

// ======================================================================
// PANEL: DASHBOARD
// ======================================================================
function greet(){
  const h=new Date().getHours();
  if(h<12)return'Good Morning';if(h<18)return'Good Afternoon';return'Good Evening';
}
function dashHero(actions){
  const first=(currentUser.name||'Trainer').split(' ')[0];
  return`<div class="dash-hero">
    <div class="dh-left">
      <div class="dh-greet">${greet()}, <span>${first}</span> ${iconSvg('wave',18)}</div>
      <div class="dh-sub">${formatFullDate(today())} — here's what's happening at FitCore today.</div>
    </div>
    ${actions?`<div class="dh-actions">${actions}</div>`:''}
  </div>`;
}
function renderDashboard(){
  const el=document.getElementById('panelDashboard');
  const role=currentUser.role;
  if(role==='member'){el.innerHTML=buildMemberDashboard();refreshMyQr();}
  else if(role==='admin')el.innerHTML=buildAdminDashboard();
  else if(role==='staff')el.innerHTML=buildStaffDashboard();
  else el.innerHTML=buildTrainerDashboard();
}
function updateQueueBadge(){
  if(!currentUser||(currentUser.role!=='admin'&&currentUser.role!=='staff'))return;
  const pending=Members.all().filter(m=>m.status==='pending_payment').length;
  const badge=document.getElementById('queueBadge');
  if(badge){badge.textContent=pending;badge.style.display=pending>0?'flex':'none';}
}
function buildAdminDashboard(){
  const members=Members.all().filter(m=>m.status!=='Archived');
  const active=members.filter(m=>m.status==='Active'||m.status==='Expiring Soon');
  const expiring=members.filter(m=>{const d=daysUntil(m.expiryDate);return d>=0&&d<=7;});
  const payments=Payments.all();
  const thisMonth=new Date();
  const monthRev=payments.filter(p=>{const d=new Date(p.date);return d.getMonth()===thisMonth.getMonth()&&d.getFullYear()===thisMonth.getFullYear();}).reduce((a,p)=>a+Number(p.amount),0);
  const walkinThisMonth=Walkins.all().filter(w=>{const d=new Date(w.date);return d.getMonth()===thisMonth.getMonth()&&d.getFullYear()===thisMonth.getFullYear();});
  const walkinRevMonth=walkinThisMonth.reduce((a,w)=>a+Number(w.fee),0);
  const totalMonthRev=monthRev+walkinRevMonth;
  const pendingUsers=Users.all().filter(u=>u.status==='pending');
  const recent=payments.slice(-5).reverse();
  const revData=[];
  for(let i=5;i>=0;i--){
    const d=new Date();d.setMonth(d.getMonth()-i);
    const mn=d.toLocaleString('en-US',{month:'short'});
    const yr=d.getFullYear();const mo=d.getMonth();
    const rev=payments.filter(p=>{const pd=new Date(p.date);return pd.getMonth()===mo&&pd.getFullYear()===yr;}).reduce((a,p)=>a+Number(p.amount),0);
    revData.push({label:mn,value:rev});
  }
  const maxRev=Math.max(...revData.map(r=>r.value),100);
  const barW=40;const chartH=120;const gap=14;
  const bars=revData.map((r,i)=>{
    const bh=r.value>0?Math.max(4,(r.value/maxRev)*chartH):4;
    const x=i*(barW+gap)+10;const y=chartH-bh+20;
    return `<g>
      <rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="4" fill="url(#barGrad)"/>
      <text x="${x+barW/2}" y="${chartH+35}" text-anchor="middle" fill="#b3bcb5" font-size="10">${r.label}</text>
      ${r.value>0?`<text x="${x+barW/2}" y="${y-4}" text-anchor="middle" fill="#b3bcb5" font-size="9">₱${r.value>=1000?(r.value/1000).toFixed(1)+'k':r.value}</text>`:''}
    </g>`;}).join('');
  // Donut chart
  const plans=Plans.all();
  const planCounts={};
  members.forEach(m=>{if(!m.planId)return;const pl=plans.find(p=>p.id===m.planId);if(pl)planCounts[pl.name]=(planCounts[pl.name]||0)+1;});
  const total=Object.values(planCounts).reduce((a,b)=>a+b,0)||1;
  const colors=['#b3bcb5','#fbbf24','#7ffa88','#b3bcb5'];
  let angle=0;const donutPaths=[];const legend=[];
  Object.entries(planCounts).forEach(([name,count],i)=>{
    const pct=count/total;const slice=pct*2*Math.PI;
    const x1=50+40*Math.sin(angle);const y1=50-40*Math.cos(angle);
    const x2=50+40*Math.sin(angle+slice);const y2=50-40*Math.cos(angle+slice);
    const big=slice>Math.PI?1:0;
    if(count>0)donutPaths.push(`<path d="M50,50 L${x1},${y1} A40,40 0 ${big},1 ${x2},${y2} Z" fill="${colors[i%colors.length]}" opacity=".85"/>`);
    legend.push(`<div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#b3bcb5"><span style="width:10px;height:10px;border-radius:2px;background:${colors[i%colors.length]};flex-shrink:0"></span>${name}: ${count} (${Math.round(pct*100)}%)</div>`);
    angle+=slice;
  });
  return `
  ${dashHero(`<button class="btn-primary" style="display:inline-flex;align-items:center;gap:8px;width:auto" onclick="navigate('scanner')">${iconSvg('camera',16)} Open QR Scanner</button>
    <button class="btn-secondary" onclick="navigate('billing')">💳 Record Payment</button>
    ${pendingUsers.length?`<button class="btn-secondary" style="background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.3);color:var(--gold)" onclick="navigate('users')">⏳ ${pendingUsers.length} Pending Approval</button>`:''}`)}
  <div class="stats-grid">
    <div class="stat-card orange"><div class="stat-top"><div class="stat-label">Total Members</div><span class="stat-ico">👥</span></div><div class="stat-value">${members.length}</div><div class="stat-hint">Registered members</div></div>
    <div class="stat-card green"><div class="stat-top"><div class="stat-label">Active Members</div><span class="stat-ico">✅</span></div><div class="stat-value">${active.length}</div><div class="stat-hint">Current active</div></div>
    <div class="stat-card gold"><div class="stat-top"><div class="stat-label">Expiring Soon</div><span class="stat-ico">⏳</span></div><div class="stat-value">${expiring.length}</div><div class="stat-hint">Within 7 days</div></div>
    <div class="stat-card blue"><div class="stat-top"><div class="stat-label">Monthly Revenue</div><span class="stat-ico">💰</span></div><div class="stat-value" style="font-size:24px">₱${totalMonthRev.toLocaleString()}</div><div class="stat-hint">Memberships + ${walkinThisMonth.length} walk-ins</div></div>
  </div>
  <div class="charts-grid">
    <div class="chart-card">
      <div class="chart-title">Revenue — Last 6 Months</div>
      <svg viewBox="0 0 320 160" style="height:160px">
        <defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#b3bcb5"/><stop offset="100%" stop-color="#fbbf24"/></linearGradient></defs>
        ${bars}
      </svg>
    </div>
    <div class="chart-card">
      <div class="chart-title">Plan Distribution</div>
      <div style="display:flex;align-items:center;gap:20px">
        <svg viewBox="0 0 100 100" style="width:100px;height:100px;flex-shrink:0">
          ${donutPaths.join('')}
          <circle cx="50" cy="50" r="22" fill="#1b2542"/>
          <text x="50" y="54" text-anchor="middle" fill="#b3bcb5" font-size="11" font-weight="700">${total}</text>
        </svg>
        <div style="display:flex;flex-direction:column;gap:6px">${legend.join('')}</div>
      </div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div class="table-card">
      <div class="table-header"><h3>Recent Payments</h3></div>
      <table><thead><tr><th>Member</th><th>Plan</th><th>Amount</th><th>Date</th></tr></thead><tbody>
      ${recent.length?recent.map(p=>`<tr><td>${esc(p.memberName)}</td><td>${esc(p.planName)}</td><td style="color:var(--green)">₱${Number(p.amount).toLocaleString()}</td><td>${formatDate(p.date)}</td></tr>`).join(''):`<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">💳</div><p>No payments yet</p></div></td></tr>`}
      </tbody></table>
    </div>
    <div class="table-card">
      <div class="table-header"><h3>Expiring Memberships</h3></div>
      <table><thead><tr><th>Member</th><th>Plan</th><th>Expiry</th><th>Days Left</th></tr></thead><tbody>
      ${expiring.length?expiring.map(m=>{const d=daysUntil(m.expiryDate);const pl=Plans.all().find(p=>p.id===m.planId);return`<tr style="background:${d<=3?'rgba(239,68,68,.06)':'rgba(251,191,36,.05)'}"><td>${esc(m.name)}</td><td>${esc(pl?pl.name:'—')}</td><td>${formatDate(m.expiryDate)}</td><td><span class="days-badge ${d<=3?'days-urgent':'days-warn'}">${d}d</span></td></tr>`}).join(''):`<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">✅</div><p>No expiring memberships</p></div></td></tr>`}
      </tbody></table>
    </div>
  </div>
  ${(()=>{
    if(!pendingUsers.length)return'';
    const rows=pendingUsers.map(u=>`<tr style="background:rgba(251,191,36,.04)">
      <td><div style="display:flex;align-items:center;gap:8px"><div class="user-avatar avatar-${u.role}" style="width:26px;height:26px;font-size:10px;flex-shrink:0;${u.avatar?'background:url(\''+u.avatar+'\') center/cover;background-size:cover;':''}">${u.avatar?'':esc(initials(u.name))}</div><div><div style="font-weight:600;color:var(--white)">${esc(u.name)}</div><div style="font-size:11px;color:var(--gray-500);font-family:monospace">@${esc(u.username)}</div></div></div></td>
      <td><span class="badge badge-${u.role}">${u.role}</span></td>
      <td style="font-size:12px;color:var(--gray-500)">${formatDate(u.createdAt||today())}</td>
      <td><div class="td-actions">
        <button class="btn-primary btn-sm" onclick="approveUser('${u.id}');renderDashboard()" style="padding:5px 12px;font-size:11px">✔ Approve</button>
        <button class="btn-danger btn-sm" onclick="deleteUser('${u.id}')" style="padding:5px 12px;font-size:11px">✕ Reject</button>
      </div></td>
    </tr>`).join('');
    return`<div class="table-card" style="margin-top:0;border-top:2px solid var(--gold)">
      <div class="table-header" style="background:rgba(251,191,36,.04)">
        <h3 style="color:var(--gold)">⏳ Pending Account Approvals <span style="font-size:13px;font-weight:400;color:var(--gray-500);margin-left:6px">${pendingUsers.length} staff account${pendingUsers.length!==1?'s':''} awaiting review</span></h3>
        <button class="btn-secondary btn-sm" onclick="navigate('users')">View All Users →</button>
      </div>
      <div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Role</th><th>Registered</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  })()}`;
}
function buildStaffDashboard(){
  const members=Members.all().filter(m=>m.status!=='Archived');
  const today_=today();
  const attendance=Attendance.all().filter(a=>a.date===today_);
  const expiring3=members.filter(m=>{const d=daysUntil(m.expiryDate);return d>=0&&d<=3;});
  const newThisMonth=members.filter(m=>{const d=new Date(m.createdAt||m.startDate);const now=new Date();return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();});
  const todayLog=attendance.map(a=>{const m=Members.all().find(x=>x.id===a.memberId);const pl=m?Plans.all().find(p=>p.id===m.planId):null;return{...a,memberName:m?m.name:'Unknown',planName:pl?pl.name:'—'};});
  const todayWalkins=Walkins.all().filter(w=>w.date===today_).length;
  return `
  <div class="stats-grid">
    <div class="stat-card orange"><div class="stat-label">Total Members</div><div class="stat-value">${members.length}</div></div>
    <div class="stat-card green"><div class="stat-label">Today's Check-Ins</div><div class="stat-value">${attendance.length}</div></div>
    <div class="stat-card gold"><div class="stat-label">Pending Renewals</div><div class="stat-value">${expiring3.length}</div><div class="stat-hint">Expiring within 3 days</div></div>
    <div class="stat-card blue"><div class="stat-label">Today's Walk-Ins</div><div class="stat-value">${todayWalkins}</div><div class="stat-hint">₱${(todayWalkins*getWalkinFee()).toLocaleString()} collected</div></div>
  </div>
  <div class="checkin-btn-wrap" style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
    <button class="btn-primary" style="width:auto;display:inline-flex;align-items:center;gap:8px" onclick="navigate('scanner')">${iconSvg('camera',16)} Open QR Scanner</button>
    <button class="btn-secondary" style="background:rgba(179,188,181,.15);color:var(--orange);border:1px solid rgba(179,188,181,.3)" onclick="navigate('walkin')">🚶 Register Walk-In</button>
    <a style="font-size:12px;color:var(--gray-500);cursor:pointer;text-decoration:underline;text-underline-offset:3px" onclick="openCheckin()">Manual check-in (no QR)</a>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div class="table-card">
      <div class="table-header"><h3>Today's Check-Ins</h3></div>
      <table><thead><tr><th>Member</th><th>Check-In</th><th>Check-Out</th><th>Duration</th></tr></thead><tbody>
      ${todayLog.length?todayLog.map(a=>`<tr><td>${esc(a.memberName)}</td><td>${esc(a.checkIn||a.time)}</td><td>${a.checkOut?esc(a.checkOut):'<span style="color:var(--green);font-size:11px">Checked In</span>'}</td><td>${a.checkOut?esc(a.duration||'—'):'Active (checked-in)'}</td></tr>`).join(''):`<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">📋</div><p>No check-ins today</p></div></td></tr>`}
      </tbody></table>
    </div>
    <div class="table-card">
      <div class="table-header"><h3>Renewal Reminders</h3></div>
      <table><thead><tr><th>Member</th><th>Expiry</th><th>Days</th><th></th></tr></thead><tbody>
      ${expiring3.length?expiring3.map(m=>{const d=daysUntil(m.expiryDate);return`<tr><td>${esc(m.name)}</td><td>${formatDate(m.expiryDate)}</td><td><span class="days-badge ${d<=1?'days-urgent':'days-warn'}">${d}d</span></td><td><button class="btn-primary btn-sm" onclick="openPaymentForMember('${m.id}')">Pay</button></td></tr>`;}).join(''):`<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">✅</div><p>No reminders</p></div></td></tr>`}
      </tbody></table>
    </div>
  </div>`;
}
function buildTrainerDashboard(){
  const u=currentUser;
  const today_=today();
  const week=addDays(today_,7);
  const allSessions=Sessions.all().filter(s=>s.trainerId===u.id);
  const todaySessions=allSessions.filter(s=>s.date===today_).sort((a,b)=>a.start.localeCompare(b.start));
  const weekSessions=allSessions.filter(s=>s.date>today_&&s.date<=week).sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
  const scheduledToday=todaySessions.filter(s=>s.status==='Scheduled').length;
  const completedToday=todaySessions.filter(s=>s.status==='Completed').length;
  const assignedMembers=[...new Set(allSessions.map(s=>s.memberId))];
  const statusBadge=s=>{const cls={Scheduled:'badge-scheduled',Completed:'badge-completed',Cancelled:'badge-cancelled'}[s.status]||'';return`<span class="badge ${cls}">${s.status}</span>`;};
  return `
  <div class="stats-grid">
    <div class="stat-card orange"><div class="stat-label">My Sessions Today</div><div class="stat-value">${todaySessions.length}</div><div class="stat-hint">${scheduledToday} scheduled · ${completedToday} done</div></div>
    <div class="stat-card green"><div class="stat-label">Upcoming This Week</div><div class="stat-value">${weekSessions.length}</div><div class="stat-hint">Next 7 days</div></div>
    <div class="stat-card gold"><div class="stat-label">Assigned Members</div><div class="stat-value">${assignedMembers.length}</div><div class="stat-hint">Unique members</div></div>
    <div class="stat-card blue"><div class="stat-label">Total Sessions</div><div class="stat-value">${allSessions.length}</div><div class="stat-hint">${allSessions.filter(s=>s.status==='Completed').length} completed overall</div></div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div class="table-card">
      <div class="table-header"><h3>Today's Schedule <span style="font-size:12px;font-weight:400;color:var(--gray-500);margin-left:6px">${todaySessions.length} session${todaySessions.length!==1?'s':''}</span></h3></div>
      <table><thead><tr><th>Time</th><th>Member</th><th>Type</th><th>Status</th></tr></thead><tbody>
      ${todaySessions.length?todaySessions.map(s=>`<tr>
        <td>${esc(s.start)}–${esc(s.end)}</td>
        <td>${esc(s.memberName||'—')}</td>
        <td>${esc(s.type||'—')}</td>
        <td>${statusBadge(s)}</td>
      </tr>`).join(''):`<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">📅</div><p>No sessions today</p></div></td></tr>`}
      </tbody></table>
    </div>
    <div class="table-card">
      <div class="table-header"><h3>Upcoming Sessions <span style="font-size:12px;font-weight:400;color:var(--gray-500);margin-left:6px">next 7 days</span></h3></div>
      <table><thead><tr><th>Date</th><th>Time</th><th>Member</th><th>Type</th><th>Status</th></tr></thead><tbody>
      ${weekSessions.length?weekSessions.map(s=>`<tr>
        <td>${formatDate(s.date)}</td>
        <td>${esc(s.start)}–${esc(s.end)}</td>
        <td>${esc(s.memberName||'—')}</td>
        <td>${esc(s.type||'—')}</td>
        <td>${statusBadge(s)}</td>
      </tr>`).join(''):`<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">📅</div><p>No upcoming sessions</p></div></td></tr>`}
      </tbody></table>
    </div>
  </div>`;
}

// ======================================================================
// TRAINER: MY ASSIGNED MEMBERS
// ======================================================================
function renderMyAssigned(){
  const el=document.getElementById('panelMyassigned');
  const u=currentUser;
  const allSessions=Sessions.all().filter(s=>s.trainerId===u.id&&s.status!=='Cancelled');
  const memberIds=[...new Set(allSessions.map(s=>s.memberId))];
  const rows=memberIds.map(id=>{
    const m=Members.one(id);
    const plan=m&&m.planId?Plans.one(m.planId):null;
    const mySessions=allSessions.filter(s=>s.memberId===id);
    const completed=mySessions.filter(s=>s.status==='Completed').length;
    const upcoming=mySessions.filter(s=>s.status==='Scheduled'&&s.date>=today()).length;
    const totalAtt=Attendance.all().filter(a=>a.memberId===id).length;
    const sessLimit=plan&&plan.sessions!=='Unlimited'?Number(plan.sessions):null;
    const left=sessLimit===null?'∞':Math.max(0,sessLimit-totalAtt);
    const statusCls=m&&(m.status==='Active'||m.status==='Expiring Soon')?'badge-active':m&&m.status==='Expired'?'badge-inactive':'badge-pending';
    return`<tr>
      <td><div style="display:flex;align-items:center;gap:10px"><div class="user-avatar avatar-trainer" style="width:32px;height:32px;font-size:11px;flex-shrink:0;${m&&m.avatar?'background:url(\''+m.avatar+'\') center/cover;background-size:cover;':''}">${m&&m.avatar?'':esc(initials(m?m.name:'?'))}</div><div><div style="font-weight:600;color:var(--white)">${esc(m?m.name:'Unknown member')}</div><div style="font-size:11px;color:var(--gray-500);font-family:monospace">${esc(m?m.id:'—')}</div></div></div></td>
      <td>${esc(plan?plan.name:'—')}</td>
      <td><span class="badge ${statusCls}">${esc(m?(m.status==='Expiring Soon'?'Expiring Soon':m.status):'—')}</span></td>
      <td><span class="days-badge days-warn">${left}</span></td>
      <td>${completed}<span style="color:var(--gray-500);font-size:11px"> / ${mySessions.length} total</span></td>
      <td>${upcoming}</td>
      <td><div class="td-actions"><button class="btn-secondary btn-sm" onclick="schedTrainerFilter='${u.id}';schedView='list';navigate('schedule')">View Sessions</button></div></td>
    </tr>`;}).join('');
  el.innerHTML=`
  <div class="stats-grid">
    <div class="stat-card orange"><div class="stat-label">Assigned Members</div><div class="stat-value">${memberIds.length}</div><div class="stat-hint">Unique members</div></div>
    <div class="stat-card green"><div class="stat-label">Sessions Completed</div><div class="stat-value">${allSessions.filter(s=>s.status==='Completed').length}</div><div class="stat-hint">All time</div></div>
    <div class="stat-card gold"><div class="stat-label">Upcoming Sessions</div><div class="stat-value">${allSessions.filter(s=>s.status==='Scheduled'&&s.date>=today()).length}</div><div class="stat-hint">Scheduled</div></div>
  </div>
  <div class="table-card">
    <div class="table-header"><h3>My Assigned Members <span style="font-size:12px;font-weight:400;color:var(--gray-500);margin-left:6px">${memberIds.length} member${memberIds.length!==1?'s':''}</span></h3></div>
    <div style="overflow-x:auto"><table><thead><tr><th>Member</th><th>Plan Type</th><th>Status</th><th>Sessions Left</th><th>Completed</th><th>Upcoming</th><th>Actions</th></tr></thead><tbody>
    ${rows||`<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">👥</div><p>No members assigned yet</p><p class="empty-sub">Sessions assigned to you by the front desk will appear here.</p></div></td></tr>`}
    </tbody></table></div>
  </div>`;
}

// ======================================================================
// MEMBER DASHBOARD (self-service portal for Member accounts)
// ======================================================================
function mbStepsHtml(mem){
  const steps=[{id:'registered',label:'Registered'},{id:'pay',label:'Awaiting Payment'},{id:'active',label:'Active'}];
  let cur='registered';
  if(mem.status==='pending_payment')cur='pay';
  else if(mem.status==='Active'||mem.status==='Expiring Soon'||mem.status==='Expired')cur='active';
  const states={registered:'todo',pay:'todo',active:'todo'};
  if(cur==='active'){states.registered='done';states.pay='done';states.active='done';}
  else if(cur==='pay'){states.registered='done';states.pay='cur';}
  else states.registered='cur';
  return `<div class="mb-steps">${steps.map((s,i)=>`${i?'<div class="mb-steps-line"></div>':''}<div class="mb-step ${states[s.id]}"><span class="mb-step-dot">${states[s.id]==='done'?'✓':'·'}</span><span>${s.label}</span></div>`).join('')}</div>`;
}
function buildMemberDashboard(){
  const mem=Members.one(currentUser.memberId||currentUser.id);
  if(!mem)return'<div class="table-card"><div class="empty-state"><p>Member record not found. Please contact the front desk.</p></div></div>';
  const plan=mem.planId?Plans.one(mem.planId):null;
  const d=daysUntil(mem.expiryDate);
  const today_=today();
  const myAtt=Attendance.all().filter(a=>a.memberId===mem.id).slice().reverse().slice(0,6);
  const totalAtt=Attendance.all().filter(a=>a.memberId===mem.id).length;
  const locked=mem.status==='pending_payment';
  let banner='',panel='';
  if(mem.status==='pending_payment'){
    banner=`<div class="mb-banner pending">
      <div class="mb-banner-ico">⏳</div>
      <div>
        <div class="mb-banner-title">Awaiting Payment</div>
        <div class="mb-banner-sub">Your account is active as soon as the front desk confirms your payment. Visit the counter and pay in <strong>Cash</strong> or <strong>GCash</strong>.</div>
      </div>
      <button class="mb-banner-btn" onclick="mbToggleHowToPay()">💳 How to Pay</button>
    </div>`;
  } else if(mem.status==='Archived'){
    banner=`<div class="mb-banner archived">
      <div class="mb-banner-ico">🗄</div>
      <div>
        <div class="mb-banner-title">Account Archived</div>
        <div class="mb-banner-sub">Your pending sign-up was archived. Visit the front desk to sign up again.</div>
      </div>
    </div>`;
  } else if(d<0){
    banner=`<div class="mb-banner expired">
      <div class="mb-banner-ico">🚫</div>
      <div>
        <div class="mb-banner-title">Plan Expired</div>
        <div class="mb-banner-sub">Entry is blocked. Please visit the front desk to renew your membership.</div>
      </div>
    </div>`;
  } else {
    banner=`<div class="mb-banner active">
      <div class="mb-banner-ico">✅</div>
      <div>
        <div class="mb-banner-title">Membership Active</div>
        <div class="mb-banner-sub">Valid until <strong>${formatDate(mem.expiryDate)}</strong> (${d} day${d!==1?'s':''} left). Show your QR at the entrance to check in.</div>
      </div>
    </div>`;
  }
  const paySteps=locked?`
    <div class="mb-pay-steps" id="mbPaySteps" style="display:none">
      <div class="mb-pay-steps-title">💳 How to Pay</div>
      <div class="mb-pay-step"><span class="mb-pay-step-n">1</span>Visit the front desk counter at the gym.</div>
      <div class="mb-pay-step"><span class="mb-pay-step-n">2</span>Tell the staff your name: <strong>${esc(mem.name)}</strong> (<span style="font-family:monospace">${esc(mem.id)}</span>).</div>
      <div class="mb-pay-step"><span class="mb-pay-step-n">3</span>Pay in <strong>Cash</strong> or <strong>GCash</strong>${plan?` — <strong>₱${Number(plan.price).toLocaleString()}</strong> (${esc(plan.name)} plan)`:''}.</div>
      <div class="mb-pay-step"><span class="mb-pay-step-n">4</span>Your QR activates instantly once payment is confirmed.</div>
      <div class="mb-pay-steps-contact">
        <a class="btn-secondary btn-sm" href="tel:+639150435696">📞 Call Front Desk</a>
        <a class="btn-secondary btn-sm" href="sms:+639150435696">💬 Message Front Desk</a>
      </div>
    </div>`:'';
  const sessLeft=locked?'—':(plan?(plan.sessions==='Unlimited'?'∞':Math.max(0,Number(plan.sessions)-totalAtt)):'—');
  const helpRow=`<div class="mb-help-strip">
    <div class="mb-help-title">Need Help?</div>
    <div class="mb-help-msg">Payments, renewals &amp; plan changes are handled at the front desk.</div>
    <div class="mb-help-actions">
      <a class="btn-secondary btn-sm" href="tel:+639150435696">📞 Call Front Desk</a>
      <button class="btn-secondary btn-sm" onclick="navigate('myMessages')" style="cursor:pointer"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>Message the Gym</button>
    </div>
  </div>`;
  const changePlan=(mem.status==='pending_payment')?`
    <div class="mb-change-plan">
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--gray-500);margin-bottom:10px">Change Plan (before paying)</div>
      <div style="display:flex;gap:8px;align-items:center">
        <select id="mbPlanSelect" style="flex:1;padding:9px 10px;background:var(--navy-700);border:1.5px solid var(--navy-600);border-radius:8px;color:var(--white);outline:none;font-size:13px">${Plans.all().filter(p=>p.status==='Active').map(p=>`<option value="${p.id}" ${p.id===mem.planId?'selected':''}>${esc(p.name)} — ₱${Number(p.price).toLocaleString()}</option>`).join('')}</select>
        <button class="btn-primary btn-sm" onclick="memberChangePlan('${mem.id}')">💾 Save</button>
      </div>
      <div style="font-size:11px;color:var(--gray-500);margin-top:8px;display:flex;gap:5px;align-items:center">💡 <span>Changes apply before payment is confirmed at the counter.</span></div>
    </div>`:'';
  const planCard=`<div class="mb-plan-card">
    <div style="display:flex;justify-content:space-between;align-items:start;gap:10px">
      <div>
        <div style="font-size:11px;color:var(--gray-500);text-transform:uppercase;letter-spacing:1px;font-weight:700">Your Plan</div>
        <div class="mb-plan-name">${esc(plan?plan.name:'—')}</div>
      </div>
      ${plan?`<div class="mb-plan-price">₱${Number(plan.price).toLocaleString()}<span>/${plan.duration===1?'mo':plan.duration+'mo'}</span></div>`:''}
    </div>
    ${plan?`<ul class="mb-plan-perks">${(plan.benefits||plan.perks||'').split(/\n|,/).map(b=>b.trim()).filter(Boolean).map(b=>`<li>${esc(b)}</li>`).join('')}</ul>`:''}
    <div class="mb-plan-meta">
      <div><span>Duration</span><strong>${plan?plan.duration+' month(s)':'-'}</strong></div>
      <div><span>Start</span><strong>${mem.planStart?formatDate(mem.planStart):'—'}</strong></div>
      <div><span>Expiry</span><strong>${mem.expiryDate?formatDate(mem.expiryDate):'—'}</strong></div>
      <div><span>Sessions Left</span><strong>${sessLeft}</strong></div>
    </div>
  </div>`;
  const qrBlock=`<div class="mb-qr-box${locked?' locked':''}">
    ${locked?'<div class="mb-qr-pending">⏳ Pending payment — this QR activates once the front desk confirms it</div>':''}
    <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:var(--gray-500);margin-bottom:10px;text-align:center">Entrance QR — Daily</div>
    <div class="mb-qr-frame">
      ${locked?'<div class="mb-qr-lock">🔒</div>':''}
      <div class="mb-qr-canvas-wrap"><div id="mbQrCanvas"></div></div>
    </div>
    ${mem.avatar?`<div style="text-align:center;margin-top:12px"><img class="mb-avatar-photo" src="${mem.avatar}" alt="${esc(mem.name)}"></div>`:''}
    <div style="text-align:center;font-size:12px;color:var(--white);font-weight:700">${esc(mem.name)}</div>
    <div style="text-align:center;font-size:10px;font-family:monospace;color:var(--gray-500)">${esc(mem.id)}</div>
    <div style="text-align:center;margin-top:10px"><button class="btn-secondary btn-sm" onclick="navigate('myqr')">🖨 View Full QR</button></div>
  </div>`;
  panel=`<div class="mb-grid">
    <div style="display:grid;gap:16px">
      ${planCard}
      ${changePlan}
      <div class="table-card">
        <div class="table-header"><h3>Recent Attendance</h3><button class="btn-secondary btn-sm" onclick="navigate('myattendance')">View All</button></div>
        <table><thead><tr><th>Date</th><th>Time In</th><th>Status</th></tr></thead><tbody>
        ${myAtt.length?myAtt.map(a=>`<tr><td>${formatDate(a.date)}</td><td>${esc(a.checkIn||'—')}</td><td><span class="badge ${a.checkOut?'badge-completed':'badge-scheduled'}">${a.checkOut?'Completed':'Checked In'}</span></td></tr>`).join(''):`<tr><td colspan="3"><div class="empty-state"><div class="empty-icon">📋</div><p>No check-ins yet</p><p class="empty-sub">${locked?'Your check-ins will appear here once your membership is active.':'Scan your QR at the entrance — your visits will show up here.'}</p></div></td></tr>`}
        </tbody></table>
      </div>
      ${locked?'':helpRow}
    </div>
    <div style="display:grid;gap:16px;align-content:start">
      ${qrBlock}
    </div>
  </div>`;
  const stepsTrack=mem.status==='pending_payment'?mbStepsHtml(mem):'';
  return `${dashHero('')}${announceStripHtml()}${banner}${stepsTrack}${paySteps}${panel}`;
}
function mbToggleHowToPay(){
  const el=document.getElementById('mbPaySteps');
  if(!el)return;
  const open=el.style.display==='block';
  el.style.display=open?'none':'block';
  if(!open&&typeof el.scrollIntoView==='function')el.scrollIntoView({behavior:'smooth',block:'center'});
}
function memberChangePlan(memberId){
  const sel=document.getElementById('mbPlanSelect');
  if(!sel)return;
  const planId=sel.value;
  const mem=Members.one(memberId);
  if(!mem){toast('Member not found.','error');return;}
  if(mem.status!=='pending_payment'){toast('Plan can only be changed while payment is pending.','error');return;}
  Members.update(memberId,{planId});
  const notifs=Notifications.all();
  notifs.forEach(n=>{if(n.memberId===memberId&&n.type==='pending_payment'&&n.status==='open'){n.planId=planId;}});
  Notifications.save(notifs);
  toast('Plan updated. New plan will be confirmed at the counter.');
  renderDashboard();
}
function renderMyQr(){
  const el=document.getElementById('panelMyqr');
  const mem=Members.one(currentUser.memberId||currentUser.id);
  if(!mem){el.innerHTML='<div class="table-card"><div class="empty-state"><p>Member record not found.</p></div></div>';return;}
  const plan=mem.planId?Plans.one(mem.planId):null;
  if(mem.status==='Archived'){
    el.innerHTML=`<div class="mb-banner archived">
      <div class="mb-banner-ico">🗄</div>
      <div>
        <div class="mb-banner-title">Account Archived</div>
        <div class="mb-banner-sub">Your sign-up was archived. Visit the front desk to sign up again.</div>
      </div>
    </div>`;
    return;
  }
  if(mem.status==='Expired'){
    el.innerHTML=`<div class="mb-banner expired">
      <div class="mb-banner-ico">🚫</div>
      <div>
        <div class="mb-banner-title">QR Not Available</div>
        <div class="mb-banner-sub">Your plan is not active. Please renew at the front desk.</div>
      </div>
    </div>`;
    return;
  }
  const locked=mem.status==='pending_payment';
  el.innerHTML=`
  <div style="max-width:480px;margin:0 auto">
    <div class="mb-qr-page${locked?' locked':''}">
      ${locked?'<div class="mb-qr-pending">⏳ Pending payment — this QR activates once the front desk confirms it</div>':''}
      <div class="mb-qr-page-brand">FIT<span>CORE</span></div>
      ${mem.avatar?`<img class="mb-avatar-photo" src="${mem.avatar}" alt="${esc(mem.name)}" style="margin-top:10px">`:''}
      <div class="mb-qr-page-name">${esc(mem.name)}</div>
      <div class="mb-qr-page-id">${esc(mem.id)}</div>
      <div class="mb-qr-frame" style="border-radius:14px;padding:18px;margin:14px 0">
        ${locked?'<div class="mb-qr-lock">🔒</div>':''}
        <div class="mb-qr-canvas-wrap"><div id="myQrCanvas"></div></div>
      </div>
      <div style="text-align:center;font-size:11px;color:var(--gray-500);line-height:1.7">
        ${plan?`<div>${esc(plan.name)} · ${mem.status==='pending_payment'?'payment pending':'valid until '+formatDate(mem.expiryDate)}</div>`:''}
        <div>Show this QR at the entrance — the QR rotates daily.</div>
      </div>
      ${locked?'':'<div style="display:flex;gap:10px;margin:14px auto 0;max-width:300px">'+
        '<button class="btn-secondary btn-sm" style="flex:1" onclick="refreshMyQr()"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>Refresh</button>'+
        '<button class="btn-primary btn-sm" style="flex:1" onclick="downloadMyQr()"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Save QR</button>'+
        '</div>'}
    </div>
  </div>`;
  refreshMyQr();
}
function downloadMyQr(){
  const mem=Members.one(currentUser.memberId||currentUser.id);
  if(!mem)return;
  if(mem.status==='pending_payment'||mem.status==='Archived'){toast('Your QR is not active yet.','error');return;}
  const img=document.querySelector('#myQrCanvas img');
  if(!img){toast('QR not ready yet. Please try again.','error');return;}
  const plan=mem.planId?Plans.one(mem.planId):null;
  const W=720,H=960;
  const cv=document.createElement('canvas');
  cv.width=W;cv.height=H;
  const ctx=cv.getContext('2d');
  const im=new Image();
  im.onload=function(){
    // Background: dark navy gradient
    const bg=ctx.createLinearGradient(0,0,0,H);
    bg.addColorStop(0,'#0d1322');bg.addColorStop(.55,'#141d33');bg.addColorStop(1,'#0a0f1c');
    ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
    // Decorative glow circles
    const glow=ctx.createRadialGradient(640,120,10,640,120,260);
    glow.addColorStop(0,'rgba(127,250,136,.22)');glow.addColorStop(1,'rgba(127,250,136,0)');
    ctx.fillStyle=glow;ctx.fillRect(380,0,340,380);
    // Header
    ctx.fillStyle='#7ffa88';
    ctx.font='900 46px Arial';ctx.textAlign='center';
    ctx.fillText('FITCORE',W/2,84);
    ctx.fillStyle='rgba(255,255,255,.45)';
    ctx.font='600 19px Arial';ctx.letterSpacing='6px';
    ctx.fillText('G Y M   M E M B E R S H I P',W/2,118);
    // QR card
    const qrSize=430;
    const qx=(W-qrSize)/2,qy=158;
    ctx.fillStyle='rgba(255,255,255,.06)';
    ctx.beginPath();ctx.roundRect(qx-12,qy-12,qrSize+24,qrSize+24,26);ctx.fill();
    ctx.fillStyle='#ffffff';
    ctx.beginPath();ctx.roundRect(qx,qy,qrSize,qrSize,18);ctx.fill();
    ctx.drawImage(im,qx+26,qy+26,qrSize-52,qrSize-52);
    // Avatar + name
    ctx.fillStyle='rgba(127,250,136,.14)';
    ctx.beginPath();ctx.arc(W/2,706,40,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#7ffa88';
    ctx.font='900 30px Arial';
    ctx.fillText(initials(mem.name),W/2,716);
    ctx.fillStyle='#ffffff';
    ctx.font='800 34px Arial';
    ctx.fillText(mem.name,W/2,786);
    // ID chip
    const idLabel='ID '+mem.id;
    ctx.font='700 22px monospace';
    const idW=ctx.measureText(idLabel).width+36;
    ctx.fillStyle='rgba(255,255,255,.08)';
    ctx.beginPath();ctx.roundRect(W/2-idW/2,806,idW,44,22);ctx.fill();
    ctx.fillStyle='rgba(255,255,255,.85)';
    ctx.fillText(idLabel,W/2,836);
    // Plan + validity
    ctx.font='600 24px Arial';
    ctx.fillStyle='rgba(255,255,255,.6)';
    ctx.fillText(plan?plan.name+' · valid until '+formatDate(mem.expiryDate):'',W/2,898);
    // Footer
    ctx.fillStyle='rgba(255,255,255,.32)';
    ctx.font='600 18px Arial';
    ctx.fillText('Show at the FitCore entrance · QR rotates daily',W/2,H-34);
    const a=document.createElement('a');
    a.href=cv.toDataURL('image/png');
    a.download='FitCore-QR-'+mem.id+'.png';
    document.body.appendChild(a);a.click();a.remove();
    toast('QR saved to your device. You can save it to your Photos.');
  };
  im.onerror=function(){toast('Could not export QR.','error');};
  im.src=img.src;
}
function refreshMyQr(){
  const mem=Members.one(currentUser.memberId||currentUser.id);
  if(!mem)return;
  const token=qrTokenFor(mem.id,today());
  renderQrTo(document.getElementById('myQrCanvas'),token,6);
  renderQrTo(document.getElementById('mbQrCanvas'),token,4);
}
function renderMyAttendance(){
  const el=document.getElementById('panelMyattendance');
  const mem=Members.one(currentUser.memberId||currentUser.id);
  if(!mem){el.innerHTML='<div class="table-card"><div class="empty-state"><p>Member record not found.</p></div></div>';return;}
  const rows=Attendance.all().filter(a=>a.memberId===mem.id).slice().reverse();
  const total=rows.length;
  const thisMonth=new Date();
  const monthCount=rows.filter(a=>{const d=new Date(a.date);return d.getMonth()===thisMonth.getMonth()&&d.getFullYear()===thisMonth.getFullYear();}).length;
  el.innerHTML=`
  <div class="stats-grid">
    <div class="stat-card orange"><div class="stat-label">Total Check-Ins</div><div class="stat-value">${total}</div><div class="stat-hint">All time</div></div>
    <div class="stat-card green"><div class="stat-label">This Month</div><div class="stat-value">${monthCount}</div><div class="stat-hint">${thisMonth.toLocaleString('en-US',{month:'long'})}</div></div>
    <div class="stat-card gold"><div class="stat-label">Last Visit</div><div class="stat-value" style="font-size:20px">${rows.length?formatDate(rows[0].date):'—'}</div><div class="stat-hint">${rows.length?esc(rows[0].checkIn||''):''}</div></div>
  </div>
  <div class="table-card">
    <div class="table-header"><h3>My Attendance <span style="font-size:12px;font-weight:400;color:var(--gray-500);margin-left:6px">${total} record${total!==1?'s':''}</span></h3></div>
    <div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Duration</th><th>Status</th></tr></thead><tbody>
    ${rows.length?rows.map(a=>`<tr><td>${formatDate(a.date)}</td><td>${esc(a.checkIn||'—')}</td><td>${esc(a.checkOut||'—')}</td><td>${esc(a.duration||'—')}</td><td><span class="badge ${a.checkOut?'badge-completed':'badge-scheduled'}">${a.checkOut?'Completed':'Checked In'}</span></td></tr>`).join(''):`<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">📋</div><p>No check-ins yet. Scan your QR at the entrance to start.</p></div></td></tr>`}
    </tbody></table></div>
  </div>`;
}

// ======================================================================
// PANEL: MEMBERS
// ======================================================================
let memberPage=1;let memberSearch='';let memberStatusFilter='All';let memberPlanFilter='All';
function renderMembers(){
  const el=document.getElementById('panelMembers');
  const plans=Plans.all();
  const planOpts=plans.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  el.innerHTML=`
  <div class="page-actions">
    <div class="table-controls">
      <input class="search-input" placeholder="Search by name or ID…" value="${esc(memberSearch)}" oninput="memberSearch=this.value;memberPage=1;refreshMemberTable()">
      <select class="filter-sel" onchange="memberStatusFilter=this.value;memberPage=1;refreshMemberTable()">
        <option>All</option><option>Active</option><option>Expired</option><option>Expiring Soon</option><option value="pending_payment">Pending Payment</option>
      </select>
      <select class="filter-sel" onchange="memberPlanFilter=this.value;memberPage=1;refreshMemberTable()">
        <option value="All">All Plans</option>${planOpts}
      </select>
    </div>
    <button class="btn-primary" onclick="openMemberModal()">+ Add New Member</button>
    <button class="btn-secondary" style="width:46px;height:46px;padding:0;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0" onclick="renumberMembers()" title="Purge archived members and renumber IDs sequentially (MEM-0001, MEM-0002, …)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
    <button class="btn-danger" style="width:46px;height:46px;padding:0;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0" onclick="resetAllMembers()" title="Delete ALL members — empty member list"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
  </div>
  <div class="table-card" id="memberTableCard"></div>`;
  refreshMemberTable();
}
function refreshMemberTable(){
  let data=Members.all().filter(m=>m.status!=='Archived');
  if(memberSearch){const s=memberSearch.toLowerCase();data=data.filter(m=>m.name.toLowerCase().includes(s)||m.id.toLowerCase().includes(s));}
  if(memberStatusFilter!=='All')data=data.filter(m=>m.status===memberStatusFilter);
  if(memberPlanFilter!=='All')data=data.filter(m=>m.planId===memberPlanFilter);
  const perPage=10;const total=data.length;const pages=Math.ceil(total/perPage)||1;
  const slice=data.slice((memberPage-1)*perPage,memberPage*perPage);
  const plans=Plans.all();
  const allUsers=Users.all();
  const roleColorMap={admin:'var(--orange)',staff:'#d7ddd8',trainer:'var(--green)'};
  const rows=slice.length?slice.map(m=>{
    const pl=plans.find(p=>p.id===m.planId);
    const badgeCls={Active:'badge-active',Expired:'badge-expired',Suspended:'badge-suspended','Expiring Soon':'badge-expiring','pending_payment':'badge-pending'}[m.status]||'badge-suspended';
    // Created By
    const createdByUser=m.createdBy?allUsers.find(u=>u.name===m.createdBy||u.username===m.createdByUsername):null;
    const cRoleColor=createdByUser?roleColorMap[createdByUser.role]||'var(--gray-300)':'var(--gray-300)';
    const cRoleTag=createdByUser?`<span style="font-size:9px;font-weight:800;padding:2px 5px;border-radius:4px;background:rgba(255,255,255,.07);color:${cRoleColor};margin-left:4px;text-transform:uppercase">${createdByUser.role}</span>`:'';
    const createdLine=m.createdBy?`<div style="font-size:12px;font-weight:600;color:var(--gray-100)">${esc(m.createdBy)}${cRoleTag}</div>`:`<span style="font-size:11px;color:var(--gray-500)">—</span>`;
    // Edited By
    const editedByUser=m.editedBy?allUsers.find(u=>u.name===m.editedBy||u.username===m.editedByUsername):null;
    const eRoleColor=editedByUser?roleColorMap[editedByUser.role]||'var(--gray-300)':'var(--gray-300)';
    const eRoleTag=editedByUser?`<span style="font-size:9px;font-weight:800;padding:2px 5px;border-radius:4px;background:rgba(255,255,255,.07);color:${eRoleColor};margin-left:4px;text-transform:uppercase">${editedByUser.role}</span>`:'';
    const editedLine=m.editedBy?`<div style="font-size:11px;color:var(--gray-500);margin-top:3px">✎ ${esc(m.editedBy)}${eRoleTag}</div>`:'';
    return`<tr>
      <td>${esc(m.id)}</td>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="member-avatar" style="${m.avatar?'background:url(\''+m.avatar+'\') center/cover;background-size:cover;':''}">${m.avatar?'':esc(initials(m.name))}</div>${esc(m.name)}</div></td>
      <td>${esc(m.contact)}</td>
      <td>${esc(pl?pl.name:'—')}</td>
      <td>${formatDate(m.startDate)}</td>
      <td>${formatDate(m.expiryDate)}</td>
      <td><span class="badge ${badgeCls}">${esc(m.status)}</span></td>
      <td><div>${createdLine}${editedLine}</div></td>
      <td><div class="td-actions">
        <button class="btn-icon" title="View" onclick="viewMember('${m.id}')">👁</button>
        <button class="btn-icon" title="Edit" onclick="openMemberModal('${m.id}')">✏️</button>
        <button class="btn-icon" title="Delete" style="color:var(--red);border-color:rgba(239,68,68,.25);background:rgba(239,68,68,.08)" onmouseover="this.style.background='var(--red)';this.style.color='#fff'" onmouseout="this.style.background='rgba(239,68,68,.08)';this.style.color='var(--red)'" onclick="deleteMember('${m.id}')">✕</button>
      </div></td>
    </tr>`;}).join(''):`<tr><td colspan="9"><div class="empty-state"><div class="empty-icon">👥</div><p>No members found</p></div></td></tr>`;
  let pag='';
  if(pages>1){
    pag=`<div class="pagination">
      <button class="page-btn" onclick="memberPage=${memberPage-1};refreshMemberTable()" ${memberPage===1?'disabled':''}>‹</button>
      ${Array.from({length:pages},(_,i)=>`<button class="page-btn ${i+1===memberPage?'active':''}" onclick="memberPage=${i+1};refreshMemberTable()">${i+1}</button>`).join('')}
      <button class="page-btn" onclick="memberPage=${memberPage+1};refreshMemberTable()" ${memberPage===pages?'disabled':''}>›</button>
      <span class="page-info">Showing ${(memberPage-1)*perPage+1}–${Math.min(memberPage*perPage,total)} of ${total}</span>
    </div>`;}
  document.getElementById('memberTableCard').innerHTML=`
    <div class="table-header"><h3>Members <span style="font-size:12px;font-weight:400;color:var(--gray-500);margin-left:6px">${total} record${total!==1?'s':''}</span></h3></div>
    <div style="overflow-x:auto"><table><thead><tr><th>ID</th><th>Name</th><th>Contact</th><th>Plan</th><th>Start</th><th>Expiry</th><th>Status</th><th>Created / Edited By</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${pag}`;
}
let editingMemberId=null;
function openMemberModal(id=null){
  editingMemberId=id;
  document.getElementById('memberModalTitle').textContent=id?'Edit Member':'Add New Member';
  document.getElementById('memberFormError').style.display='none';
  const plans=Plans.all().filter(p=>p.status==='Active');
  document.getElementById('mf_plan').innerHTML=plans.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  // Sync amount when plan changes
  document.getElementById('mf_plan').onchange=function(){
    const plan=Plans.one(this.value);
    document.getElementById('mf_amount').value=plan?plan.price:'';
  };
  if(id){
    const m=Members.one(id);
    if(!m)return;
    document.getElementById('mf_name').value=m.name||'';
    document.getElementById('mf_contact').value=m.contact||'';
    document.getElementById('mf_age').value=m.age||'';
    document.getElementById('mf_sex').value=m.sex||'';
    document.getElementById('mf_plan').value=m.planId||'';
    // Lock plan field for non-admins when editing an existing member
    const planSelect=document.getElementById('mf_plan');
    const planNote=document.getElementById('mf_plan_note');
    if(currentUser.role!=='admin'){
      planSelect.disabled=true;
      planSelect.style.opacity='0.5';
      planSelect.style.cursor='not-allowed';
      if(planNote)planNote.style.display='flex';
    } else {
      planSelect.disabled=false;
      planSelect.style.opacity='';
      planSelect.style.cursor='';
      if(planNote)planNote.style.display='none';
    }
    document.getElementById('mf_start').value=m.startDate||'';
    document.getElementById('mf_address').value=m.address||'';
    document.getElementById('mf_ecname').value=m.ecName||'';
    document.getElementById('mf_ecnum').value=m.ecNum||'';
    document.getElementById('mf_notes').value=m.notes||'';
    document.getElementById('mf_user').value=m.username||'';
    document.getElementById('mf_pass').value='';
    document.getElementById('mf_paydate').value=today();
    const plan=Plans.one(m.planId);
    document.getElementById('mf_amount').value=plan?plan.price:'';
    document.getElementById('mf_method').value='';
    document.getElementById('mf_paynotes').value='';
    // Lock billing section for non-admins on existing members
    const billingNote=document.getElementById('mf_billing_note');
    const billingInputs=['mf_paydate','mf_method','mf_paynotes'];
    if(currentUser.role!=='admin'){
      billingInputs.forEach(fid=>{
        const el=document.getElementById(fid);
        if(el){el.disabled=true;el.style.opacity='0.5';el.style.cursor='not-allowed';}
      });
      if(billingNote)billingNote.style.display='flex';
    } else {
      billingInputs.forEach(fid=>{
        const el=document.getElementById(fid);
        if(el){el.disabled=false;el.style.opacity='';el.style.cursor='';}
      });
      if(billingNote)billingNote.style.display='none';
    }
  } else {
    ['mf_name','mf_contact','mf_age','mf_address','mf_ecname','mf_ecnum','mf_notes','mf_user','mf_pass'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('mf_sex').value='';
    document.getElementById('mf_start').value=today();
    document.getElementById('mf_paydate').value=today();
    document.getElementById('mf_method').value='';
    document.getElementById('mf_paynotes').value='';
    // auto-fill amount from first plan
    const plan=plans.length?Plans.one(plans[0].id):null;
    document.getElementById('mf_amount').value=plan?plan.price:'';
    if(plans.length)document.getElementById('mf_plan').value=plans[0].id;
    // Always unlock plan and billing for new members (any role can register)
    const ps=document.getElementById('mf_plan');
    const pn=document.getElementById('mf_plan_note');
    ps.disabled=false;ps.style.opacity='';ps.style.cursor='';
    if(pn)pn.style.display='none';
    ['mf_paydate','mf_method','mf_paynotes'].forEach(fid=>{
      const el=document.getElementById(fid);
      if(el){el.disabled=false;el.style.opacity='';el.style.cursor='';}
    });
    const bn=document.getElementById('mf_billing_note');
    if(bn)bn.style.display='none';
  }
  openModal('memberModal');
}
async function saveMember(){
  const name=document.getElementById('mf_name').value.trim();
  const contact=document.getElementById('mf_contact').value.trim();
  // If non-admin is editing, preserve the existing plan from the DB
  const planSelect=document.getElementById('mf_plan');
  const planId=editingMemberId&&currentUser.role!=='admin'
    ? (Members.one(editingMemberId)||{}).planId||planSelect.value
    : planSelect.value;
  const startDate=document.getElementById('mf_start').value;
  const err=document.getElementById('memberFormError');
  err.style.display='none';
  if(!name||!contact||!planId||!startDate){err.textContent='Please fill in all required fields.';err.style.display='block';return;}
  const members=Members.all();
  if(!editingMemberId){
    const dup=members.find(m=>m.name.toLowerCase()===name.toLowerCase()&&m.contact===contact&&m.status!=='Archived');
    if(dup){err.textContent='A member with the same name and contact number already exists. Please verify the information.';err.style.display='block';return;}
    // Validate billing fields for new members
    const method=document.getElementById('mf_method').value;
    if(!method){err.textContent='Please select a payment method.';err.style.display='block';return;}
  }
  const plan=Plans.one(planId);
  const expiryDate=addMonths(startDate,plan?plan.duration:1);
  const uname=document.getElementById('mf_user').value.trim();
  const pass=document.getElementById('mf_pass').value;
  if(uname||pass){
    if(pass&&pass.length<6){err.textContent='Password must be at least 6 characters.';err.style.display='block';return;}
    if(uname&&Members.all().some(x=>x.username&&x.username.toLowerCase()===uname.toLowerCase()&&x.id!==editingMemberId)){err.textContent='Username already taken. Please choose a different username.';err.style.display='block';return;}
    if(uname&&Users.all().some(x=>x.username.toLowerCase()===uname.toLowerCase())){err.textContent='Username already taken by a staff or trainer account.';err.style.display='block';return;}
  }
  const data={
    name:sanitizeText(name),contact:sanitizeText(contact),age:sanitizeText(document.getElementById('mf_age').value),sex:sanitizeText(document.getElementById('mf_sex').value),
    planId,startDate,expiryDate,address:sanitizeText(document.getElementById('mf_address').value.trim()),
    ecName:sanitizeText(document.getElementById('mf_ecname').value.trim()),ecNum:sanitizeText(document.getElementById('mf_ecnum').value.trim()),
    notes:sanitizeText(document.getElementById('mf_notes').value.trim()),status:'Active'
  };
  if(uname)data.username=uname;
  // Online mode: member login credentials live in Firebase Auth
  let memberAuthEmail=null;
  if(window.GMSFB&&GMSFB.enabled&&pass){
    if(editingMemberId){err.textContent='Changing an existing member\u2019s password is not supported in online mode.';err.style.display='block';return;}
    memberAuthEmail=GMSFB.authEmailFor({username:uname});
    const r=await GMSFB.createUserCreds(memberAuthEmail,pass);
    if(!r.ok){err.textContent=r.error;err.style.display='block';return;}
  }
  if(memberAuthEmail)data.authEmail=memberAuthEmail;
  else if(pass)data.passwordHash=hashPassword(pass);
  const confirmTitle=editingMemberId?'Update Member':'Add New Member';
  const confirmMsg=editingMemberId
    ?`Save changes to <strong>${esc(name)}</strong>? Billing records linked to this member will also be synced automatically.`
    :`Add <strong>${esc(name)}</strong> as a new member under the <strong>${esc(plan?plan.name:'selected')}</strong> plan? A payment record will be created automatically.`;
  openConfirm(confirmTitle, confirmMsg, ()=>{
    if(editingMemberId){
      const idx=members.findIndex(m=>m.id===editingMemberId);
      // Capture old values BEFORE overwriting to build a change log
      const oldM=members[idx]||{};
      const allPlans=Plans.all();
      const oldPlanName=(allPlans.find(p=>p.id===oldM.planId)||{name:oldM.planId||'—'}).name;
      const newPlanName=plan?plan.name:(planId||'—');
      const fieldLabels={
        name:'Name', contact:'Contact', age:'Age', sex:'Sex',
        planId:'Plan', startDate:'Start Date', address:'Address',
        ecName:'Emergency Contact', ecNum:'EC Number', notes:'Notes'
      };
      const changedParts=[];
      Object.keys(fieldLabels).forEach(k=>{
        const oldVal=k==='planId'?oldPlanName:(String(oldM[k]||'')).trim();
        const newVal=k==='planId'?newPlanName:(String(data[k]||'')).trim();
        if(oldVal!==newVal){
          changedParts.push(fieldLabels[k]+': "'+oldVal+'" → "'+newVal+'"');
        }
      });
      const changeDetail=changedParts.length?changedParts.join(' | '):'No field changes detected';
      if(idx>-1)members[idx]={...members[idx],...data,editedBy:currentUser.name,editedByUsername:currentUser.username,editedByRole:currentUser.role,editedAt:today()};
      Members.save(members);
      // AUTO-SYNC: update all linked payment records with new member info
      const payments=Payments.all();
      let payUpdated=false;
      payments.forEach(p=>{
        if(p.memberId===editingMemberId){
          p.memberName=name;
          if(planId&&planId!==p.planId){
            p.planId=planId;
            p.planName=plan?plan.name:p.planName;
            p.newExpiry=addMonths(p.date,plan?plan.duration:1);
          }
          p.syncedAt=today();
          payUpdated=true;
        }
      });
      // Only admin can sync/update payment records
      if(payUpdated&&currentUser.role==='admin')Payments.save(payments);
      logActivity('Edited','Member',name,'ID: '+editingMemberId+' | '+changeDetail);
      toast(currentUser.role==='admin'?'Member updated. Billing records synced automatically.':'Member info updated successfully.');
    } else {
      const newId=nextMemberId();
      members.push({id:newId,...data,createdBy:currentUser.name,createdByUsername:currentUser.username,createdByRole:currentUser.role,createdAt:today(),bgCheckStatus:'Pending',bgCheckDate:'',bgCheckBy:'',bgCheckNotes:''});
      Members.save(members);
      logActivity('Added','Member',name,'ID: '+newId+' | Plan: '+(plan?plan.name:''));
      // AUTO-CREATE PAYMENT RECORD
      const payDate=document.getElementById('mf_paydate').value||today();
      const amount=parseFloat(document.getElementById('mf_amount').value)||plan.price;
      const method=document.getElementById('mf_method').value;
      const payNotes=document.getElementById('mf_paynotes').value.trim();
      const payments=Payments.all();
      const newPayId=nextId(KEY.payments,'PAY');
      payments.push({
        id:newPayId,memberId:newId,memberName:name,
        planId,planName:plan?plan.name:'Unknown',
        amount,date:payDate,newExpiry:expiryDate,method,
        notes:payNotes,
        recordedBy:currentUser.name,
        recordedByUsername:currentUser.username,
        status:'Paid',createdAt:today()
      });
      Payments.save(payments);
      toast('Member added & payment recorded successfully.');
    }
    closeModal('memberModal');renderMembers();scanRenewals();updateHeroMemberCount();
    if(document.getElementById('billingTableCard'))refreshBillingTable();
  },'Save','btn-primary');
}
function deleteMember(id){
  const m=Members.one(id);
  openConfirm('Delete Member',`Are you sure you want to delete ${m?esc(m.name):'this member'}? This cannot be undone.`,()=>{
    const members=Members.all();const idx=members.findIndex(m=>m.id===id);
    if(idx>-1){logActivity('Deleted','Member',members[idx].name,'ID: '+members[idx].id+' | Plan: '+(Plans.all().find(p=>p.id===members[idx].planId)||{name:'—'}).name);members[idx].status='Archived';}
    Members.save(members);toast('Member archived.');renderMembers();
  });
}
function renumberMembers(){
  const all=Members.all();
  const archived=all.filter(m=>m.status==='Archived');
  const live=all.filter(m=>m.status!=='Archived');
  const aIds=archived.map(m=>m.id);
  const remap={};
  live.forEach((m,i)=>{remap[m.id]='MEM-'+String(i+1).padStart(4,'0');});
  const changed=live.filter(m=>remap[m.id]!==m.id).length;
  openConfirm('Renumber Members','This will permanently delete '+archived.length+' archived member(s) and renumber members so IDs run sequentially from MEM-0001 (e.g. MEM-0009 → MEM-0006, MEM-0010 → MEM-0007). Payments, notifications, attendance and sessions are updated to match. Continue?',function(){
    Members.save(live.map(m=>{m.id=remap[m.id];return m;}));
    Payments.save(Payments.all().filter(p=>!aIds.includes(p.memberId)).map(p=>{if(remap[p.memberId])p.memberId=remap[p.memberId];return p;}));
    Notifications.save(Notifications.all().filter(n=>!aIds.includes(n.memberId)).map(n=>{if(remap[n.memberId])n.memberId=remap[n.memberId];return n;}));
    Attendance.save(Attendance.all().filter(a=>!aIds.includes(a.memberId)).map(a=>{if(remap[a.memberId])a.memberId=remap[a.memberId];return a;}));
    Sessions.save(Sessions.all().filter(s=>!aIds.includes(s.memberId)).map(s=>{if(remap[s.memberId])s.memberId=remap[s.memberId];if(remap[s.id])s.id=remap[s.id];return s;}));
    Members.all().forEach(m=>{if(m.qrToken||m.status==='Active'){try{Members.update(m.id,{qrToken:qrTokenFor(m.id,today())});}catch(e){}}});
    logActivity('Renumbered','Members','Renumbered '+changed+' member(s) · removed '+archived.length+' archived');
    renderMembers();scanRenewals();updateHeroMemberCount();renderDashboard();
    toast('Member IDs renumbered sequentially.');
  },'Renumber','btn-primary');
}
function resetAllMembers(){
  const n=Members.count();
  const p=Payments.count();
  openConfirm('Reset All Members','This will permanently delete <strong>ALL '+n+' member(s)</strong> and their '+p+' payment record(s), attendance, sessions, notifications and messages. The member list will be empty — no member registered. Continue?',function(){
    Members.save([]);
    Payments.save([]);
    Attendance.save([]);
    Sessions.save([]);
    Notifications.save([]);
    Messages.save([]);
    logActivity('Reset','Members','Deleted all members — list reset to empty');
    renderMembers();scanRenewals();updateHeroMemberCount();renderDashboard();updatePendingBadge();updateQueueBadge();
    toast('All members removed. No member registered.');
  },'Reset All','btn-danger');
}
function viewMember(id){
  currentProfileId=id;
  const m=Members.one(id);
  if(!m)return;
  const plan=Plans.one(m.planId);
  const payments=Payments.all().filter(p=>p.memberId===id);
  const sessions=Sessions.all().filter(s=>s.memberId===id);
  const attendance=Attendance.all().filter(a=>a.memberId===id).slice().reverse();
  const badgeCls={Active:'badge-active',Expired:'badge-expired',Suspended:'badge-suspended','Expiring Soon':'badge-expiring'}[m.status]||'';
  const bgBadgeCls={Cleared:'badge-active',Flagged:'badge-suspended',Pending:'badge-pending'}[m.bgCheckStatus||'Pending']||'badge-pending';
  document.getElementById('profileModalBody').innerHTML=`
  <div class="profile-section">
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px">
      <div class="user-avatar avatar-admin" style="width:52px;height:52px;border-radius:12px;flex-shrink:0;background:url('${m.avatar||''}') center/cover no-repeat;${m.avatar?'':'color:var(--gray-400);font-size:18px;line-height:52px'}">${m.avatar?'':esc(initials(m.name))}</div>
      <div><div style="font-size:20px;font-weight:800;font-family:'Barlow Condensed',sans-serif">${esc(m.name)}</div>
      <div style="color:var(--gray-500);font-size:12px">${esc(m.id)}</div>
      <span class="badge ${badgeCls}" style="margin-top:4px">${esc(m.status)}</span></div>
    </div>
    <h4>Personal Information</h4>
    <div class="profile-grid">
      <div class="profile-field"><label>Contact</label><p>${esc(m.contact||'—')}</p></div>
      <div class="profile-field"><label>Age / Sex</label><p>${esc(m.age||'—')} / ${esc(m.sex||'—')}</p></div>
      <div class="profile-field"><label>Address</label><p>${esc(m.address||'—')}</p></div>
      <div class="profile-field"><label>Emergency Contact</label><p>${esc(m.ecName||'—')} ${m.ecNum?'('+esc(m.ecNum)+')':''}</p></div>
    </div>
  </div>
  <div class="profile-section">
    <h4>Membership</h4>
    <div class="profile-grid">
      <div class="profile-field"><label>Plan</label><p>${esc(plan?plan.name:'—')}</p></div>
      <div class="profile-field"><label>Start Date</label><p>${formatDate(m.startDate)}</p></div>
      <div class="profile-field"><label>Expiry Date</label><p>${formatDate(m.expiryDate)}</p></div>
      <div class="profile-field"><label>Days Remaining</label><p>${daysUntil(m.expiryDate)} days</p></div>
    </div>
    ${m.notes?`<div class="profile-field" style="margin-top:10px"><label>Notes</label><p>${esc(m.notes)}</p></div>`:''}
   </div>
   <div class="profile-section">
     <h4>Entrance QR — Staff Check-In</h4>
     <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
       <div style="background:#fff;padding:10px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.25);width:120px;height:120px;flex-shrink:0"><canvas id="profileQrCanvas" width="100" height="100"></canvas></div>
       <div style="flex:1;min-width:200px">
         <p style="font-size:12px;color:var(--gray-500)">Member forgot their phone? Show this QR or check them in manually from the front desk.</p>
         <input type="text" id="profileQrToken" readonly style="width:100%;font-family:monospace;font-size:11px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:8px 10px;color:var(--gray-400);cursor:pointer" onclick="this.select()" placeholder="QR token">
         <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
           <button class="btn-sm btn-primary" style="height:32px" onclick="profileCheckIn('${id}')">✓ Check In</button>
           <button class="btn-sm btn-secondary" style="height:32px" onclick="copyMemberToken('${id}')">Copy Token</button>
         </div>
         <div id="profileQrStatus" style="font-size:12px;margin-top:8px;min-height:16px"></div>
       </div>
     </div>
   </div>
  <div class="profile-section">
    <h4>Background Check</h4>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <span class="badge ${bgBadgeCls}">${esc(m.bgCheckStatus||'Pending')}</span>
      ${m.bgCheckDate?`<span style="font-size:11px;color:var(--gray-500)">${formatDate(m.bgCheckDate)} · by ${esc(m.bgCheckBy||'—')}</span>`:''}
    </div>
    ${m.bgCheckNotes?`<div class="profile-field"><label>Notes</label><p>${esc(m.bgCheckNotes)}</p></div>`:''}
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn-sm" style="background:rgba(127,250,136,.15);color:var(--green);border:1px solid rgba(127,250,136,.4)" onclick="setBgCheck('${id}','Cleared')">✓ Cleared</button>
      <button class="btn-sm" style="background:rgba(239,68,68,.12);color:var(--red);border:1px solid rgba(239,68,68,.4)" onclick="setBgCheck('${id}','Flagged')">⚑ Flagged</button>
    </div>
  </div>
  <div class="profile-section">
    <h4>Payment History</h4>
    ${payments.length?`<table style="width:100%"><thead><tr><th>ID</th><th>Plan</th><th>Amount</th><th>Date</th><th>Method</th></tr></thead><tbody>${payments.map(p=>`<tr><td>${esc(p.id)}</td><td>${esc(p.planName)}</td><td style="color:var(--green)">₱${Number(p.amount).toLocaleString()}</td><td>${formatDate(p.date)}</td><td>${esc(p.method)}</td></tr>`).join('')}</tbody></table>`:
    '<div class="empty-state" style="padding:20px"><div class="empty-icon">💳</div><p>No payments recorded</p></div>'}
  </div>
  <div class="profile-section">
    <h4>Session History</h4>
    ${sessions.length?`<table style="width:100%"><thead><tr><th>Date</th><th>Trainer</th><th>Type</th><th>Status</th></tr></thead><tbody>${sessions.map(s=>`<tr><td>${formatDate(s.date)}</td><td>${esc(s.trainerName)}</td><td>${esc(s.type)}</td><td><span class="badge badge-${esc(s.status.toLowerCase())}">${esc(s.status)}</span></td></tr>`).join('')}</tbody></table>`:
    '<div class="empty-state" style="padding:20px"><div class="empty-icon">📅</div><p>No sessions</p></div>'}
  </div>
  <div class="profile-section">
    <h4>Attendance History</h4>
    ${attendance.length?`<table style="width:100%"><thead><tr><th>Date</th><th>Check In</th><th>Check Out</th><th>Duration</th><th>Recorded By</th></tr></thead><tbody>${attendance.map(a=>`<tr><td>${formatDate(a.date)}</td><td>${esc(a.checkIn||a.time||'—')}</td><td>${a.checkOut?esc(a.checkOut):'<span style="color:var(--gold);font-size:11px">In Gym</span>'}</td><td>${esc(a.duration||'—')}</td><td>${esc(a.recordedBy||a.scannedBy||'—')}</td></tr>`).join('')}</tbody></table>`:
    '<div class="empty-state" style="padding:20px"><div class="empty-icon">🕐</div><p>No attendance recorded</p></div>'}
  </div>`;
  document.getElementById('profileQrToken').value=qrTokenFor(m.id,today());
  openModal('profileModal');
  const cm=document.getElementById('profileQrCanvas');
  if(cm)renderQrTo(cm,qrTokenFor(m.id,today()),4);
}
function openEditFromProfile(){closeModal('profileModal');openMemberModal(currentProfileId);}
function openMemberProfileEdit(){
  const m=Members.one(currentUser.memberId||currentUser.id);
  if(!m){toast('Member record not found.','error');return;}
  if(m.avatar){document.getElementById('mep_avatar_preview').src=m.avatar;document.getElementById('mep_avatar_preview').style.display='block';document.getElementById('mep_avatar_clear').style.display='inline-flex';}
  else {document.getElementById('mep_avatar_preview').src='';document.getElementById('mep_avatar_preview').style.display='none';document.getElementById('mep_avatar_clear').style.display='none';}
  if(m.bg){document.getElementById('mep_bg_preview').src=m.bg;document.getElementById('mep_bg_preview').style.display='block';document.getElementById('mep_bg_clear').style.display='inline-flex';}
  else {document.getElementById('mep_bg_preview').src='';document.getElementById('mep_bg_preview').style.display='none';document.getElementById('mep_bg_clear').style.display='none';}
  document.getElementById('mep_avatar').value=m.avatar||'';
  document.getElementById('mep_bg').value=m.bg||'';
  const err=document.getElementById('mepError');if(err){err.textContent='';err.style.display='none';}
  openModal('memberProfileEditModal');
}
function saveMemberProfileEdit(){
  const m=Members.one(currentUser.memberId||currentUser.id);
  if(!m){toast('Member record not found.','error');return;}
  const avatar=document.getElementById('mep_avatar').value;
  const bg=document.getElementById('mep_bg').value;
  if(avatar&&avatar.length>120000){toast('Profile photo is too large — please use a smaller image.','error');return;}
  if(bg&&bg.length>120000){toast('Background image is too large — please use a smaller image.','error');return;}
  Members.update(m.id,{avatar:avatar||'',bg:bg||''});
  logActivity('Updated','Member Profile',m.name+' updated profile photo');
  closeModal('memberProfileEditModal');
  refreshMemberHome();
  toast('Profile photo saved.');
}
function refreshMemberHome(){
  buildSidebar();
  renderTopbar();
  renderDashboard();
}
function copyMemberToken(id){
  const t=qrTokenFor(id,today());
  try{navigator.clipboard.writeText(t);toast('QR token copied to clipboard.');}
  catch(e){try{prompt('Copy the member QR token:',t);}catch(_){}}
}
function profileCheckIn(id){
  const m=Members.one(id);
  const st=document.getElementById('profileQrStatus');
  const show=(msg,ok)=>{if(st){st.innerHTML='<span style="color:'+(ok?'var(--green)':'var(--red)')+'">'+msg+'</span>';}};
  if(!m){show('Member not found',false);return;}
  if(m.status==='pending_payment'){show(m.name+' has NOT paid yet — send to the counter first.',false);return;}
  if(m.status==='Archived'){show('Account archived — entry blocked.',false);return;}
  if(daysUntil(m.expiryDate)<0){show('Plan expired on '+formatDate(m.expiryDate)+' — renew at the counter, entry blocked.',false);return;}
  const now=new Date();
  const last=Attendance.all().filter(a=>a.memberId===m.id).slice(-1)[0];
  if(last&&last.date===today()&&last.checkInTs&&(now.getTime()-last.checkInTs)<QR_SCAN_DUP_WINDOW_MIN*60000){show(m.name+' already checked in at '+last.checkIn+' — duplicate blocked.',false);return;}
  const time=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  Attendance.add({id:uid(),memberId:m.id,date:today(),time,checkIn:time,checkInTs:now.getTime(),checkOut:null,checkOutTs:null,duration:null,recordedBy:currentUser.name,scannedBy:currentUser.name,source:'staff'});
  show(m.name+' checked in at '+time+'.',true);
  toast(m.name+' checked in.');
}
let historySearch='';let memberHistoryTab='All';
function renderHistory(){
  const el=document.getElementById('panelHistory');
  const counts={All:0,Active:0,'Expiring Soon':0,Expired:0,pending_payment:0,Archived:0};
  const all=Members.all();
  const payments=Payments.all();
  const eligible=all.filter(m=>m.status!=='pending_payment'||payments.some(p=>p.memberId===m.id));
  eligible.forEach(m=>{counts.All++;if(counts[m.status]!==undefined)counts[m.status]++;});
  const tab=(st,label)=>`<button class="rtab ${memberHistoryTab===st?'active':''}" onclick="memberHistoryTab='${st}';renderHistory()">${label} <span class="user-tab-count">(${counts[st]})</span></button>`;
  el.innerHTML=`
  <div class="report-tabs">
    ${tab('All','All Members')}
    ${tab('Active','Active')}
    ${tab('Expiring Soon','Expiring Soon')}
    ${tab('Expired','Expired')}
    ${tab('pending_payment','Pending Payment')}
    ${tab('Archived','Archived')}
  </div>
  <div class="page-actions">
    <div class="table-controls">
      <input class="search-input" placeholder="Search by name or ID…" value="${esc(historySearch)}" oninput="historySearch=this.value;refreshHistoryTable()">
    </div>
    <span style="font-size:11px;color:var(--gray-500)">Permanent record of every member who availed a membership</span>
  </div>
  <div class="table-card" id="historyTableCard"></div>`;
  refreshHistoryTable();
}
function refreshHistoryTable(){
  const payments=Payments.all();
  const attendance=Attendance.all();
  const sessions=Sessions.all();
  const plans=Plans.all();
  let rows=Members.all().filter(m=>m.status!=='pending_payment'||payments.some(p=>p.memberId===m.id)).filter(m=>memberHistoryTab==='All'||m.status===memberHistoryTab).map(m=>{
    const mp=payments.filter(p=>p.memberId===m.id);
    const ma=attendance.filter(a=>a.memberId===m.id);
    const ms=sessions.filter(s=>s.memberId===m.id);
    const pl=plans.find(p=>p.id===m.planId);
    const first=[...mp.map(p=>p.date),m.startDate].filter(Boolean).sort()[0]||m.createdAt||'';
    const last=[...mp.map(p=>p.date),...ma.map(a=>a.date),m.expiryDate].filter(Boolean).sort().slice(-1)[0]||'';
    const totalPaid=mp.reduce((s,p)=>s+Number(p.amount||0),0);
    return{id:m.id,name:m.name,plan:pl?pl.name:'—',totalPaid,payCount:mp.length,attCount:ma.length,sessCount:ms.length,first,last,status:m.status};
  });
  if(historySearch){const s=historySearch.toLowerCase();rows=rows.filter(r=>r.name.toLowerCase().includes(s)||r.id.toLowerCase().includes(s));}
  rows=rows.sort((a,b)=>String(b.last).localeCompare(String(a.last)));
  const totalAll=rows.reduce((s,r)=>s+r.totalPaid,0);
  const badgeCls={Active:'badge-active',Expired:'badge-expired',Suspended:'badge-suspended','Expiring Soon':'badge-expiring','pending_payment':'badge-pending',Archived:'badge-suspended'};
  const table=document.getElementById('historyTableCard');
  if(!table)return;
  table.innerHTML=`
  <div class="table-header"><h3>${memberHistoryTab==='All'?'Member History':memberHistoryTab==='pending_payment'?'Pending Payment':memberHistoryTab}</h3><span style="font-size:11px;color:var(--gray-500)">${rows.length} member(s) · Total Paid ₱${Number(totalAll).toLocaleString()}</span></div>
  <div style="overflow-x:auto"><table style="min-width:900px"><thead><tr><th>ID</th><th>Name</th><th>Plan</th><th>Total Paid</th><th>Payments</th><th>Attendance</th><th>Sessions</th><th>First Avail</th><th>Last Avail</th><th>Status</th></tr></thead>
  <tbody>${rows.length?rows.map(r=>`<tr style="cursor:pointer" onclick="viewMember('${r.id}')">
    <td>${esc(r.id)}</td>
    <td><div style="display:flex;align-items:center;gap:8px"><div class="member-avatar" style="${r.avatar?'background:url(\''+r.avatar+'\') center/cover;background-size:cover;':''}">${r.avatar?'':esc(initials(r.name))}</div>${esc(r.name)}</div></td>
    <td>${esc(r.plan)}</td>
    <td style="color:var(--green);font-weight:600">₱${Number(r.totalPaid).toLocaleString()}</td>
    <td>${r.payCount}</td><td>${r.attCount}</td><td>${r.sessCount}</td>
    <td>${formatDate(r.first)}</td><td>${formatDate(r.last)}</td>
    <td><span class="badge ${badgeCls[r.status]||'badge-suspended'}">${esc(r.status)}</span></td>
  </tr>`).join(''):`<tr><td colspan="10"><div class="empty-state"><div class="empty-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></div><p>No member history found</p></div></td></tr>`}
  </tbody></table></div>`;
}

// ======================================================================
// PANEL: BILLING
// ======================================================================
let billingSearch='';let billingFromDate='';let billingToDate='';let billingPlanFilter='All';let billingPage=1;
function renderBilling(){
  const el=document.getElementById('panelBilling');
  const plans=Plans.all();
  const planOpts=plans.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  el.innerHTML=`
  <div class="page-actions">
    <div class="table-controls">
      <input class="search-input" placeholder="Search member…" value="${esc(billingSearch)}" oninput="billingSearch=this.value;billingPage=1;refreshBillingTable()">
      <input type="date" class="search-input" style="min-width:130px" value="${esc(billingFromDate)}" onchange="billingFromDate=this.value;billingPage=1;refreshBillingTable()">
      <input type="date" class="search-input" style="min-width:130px" value="${esc(billingToDate)}" onchange="billingToDate=this.value;billingPage=1;refreshBillingTable()">
      <select class="filter-sel" onchange="billingPlanFilter=this.value;billingPage=1;refreshBillingTable()">
        <option value="All">All Plans</option>${planOpts}
      </select>
    </div>
  </div>
  <div class="table-card" id="billingTableCard"></div>`;
  refreshBillingTable();
}
function refreshBillingTable(){
  let data=Payments.all();
  if(billingSearch){const s=billingSearch.toLowerCase();data=data.filter(p=>p.memberName.toLowerCase().includes(s));}
  if(billingFromDate)data=data.filter(p=>p.date>=billingFromDate);
  if(billingToDate)data=data.filter(p=>p.date<=billingToDate);
  if(billingPlanFilter!=='All')data=data.filter(p=>p.planId===billingPlanFilter);
  data=data.slice().reverse();
  const perPage=10;const total=data.length;const pages=Math.ceil(total/perPage)||1;
  const slice=data.slice((billingPage-1)*perPage,billingPage*perPage);
  const rows=slice.length?slice.map(p=>`<tr>
    <td>${esc(p.id)}</td><td>${esc(p.memberName)}</td><td>${esc(p.planName)}</td>
    <td style="color:var(--green);font-weight:600">₱${Number(p.amount).toLocaleString()}</td>
    <td>${formatDate(p.date)}</td><td>${formatDate(p.newExpiry)}</td>
    <td>${esc(p.recordedBy||'—')}</td><td>${esc(p.method||'—')}</td>
    <td><span class="badge badge-paid">Paid</span></td>
    <td>${p.source==='renewal'?'<span style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:5px;background:rgba(251,191,36,.15);color:var(--gold);letter-spacing:.5px;border:1px solid rgba(251,191,36,.3)">🔄 RENEWAL</span>':p.syncedAt?'<span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:5px;background:rgba(170,181,255,.12);color:#d7ddd8;letter-spacing:.5px;border:1px solid rgba(170,181,255,.25)" title="Auto-synced when member info was edited">🔗 SYNCED</span>':'<span style="font-size:10px;color:var(--gray-500)">—</span>'}</td>
    <td><div class="td-actions"><button class="btn-icon" title="View Receipt" onclick="viewReceipt('${p.id}')">🧾</button></div></td>
  </tr>`).join(''):`<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">💳</div><p>No payments found</p></div></td></tr>`;
  let pag='';if(pages>1){pag=`<div class="pagination"><button class="page-btn" onclick="billingPage=${billingPage-1};refreshBillingTable()" ${billingPage===1?'disabled':''}>‹</button>${Array.from({length:pages},(_,i)=>`<button class="page-btn ${i+1===billingPage?'active':''}" onclick="billingPage=${i+1};refreshBillingTable()">${i+1}</button>`).join('')}<button class="page-btn" onclick="billingPage=${billingPage+1};refreshBillingTable()" ${billingPage===pages?'disabled':''}>›</button><span class="page-info">${total} records</span></div>`;}
  document.getElementById('billingTableCard').innerHTML=`
    <div class="table-header"><h3>Payments <span style="font-size:12px;font-weight:400;color:var(--gray-500);margin-left:6px">${total} record${total!==1?'s':''}</span></h3></div>
    <div style="overflow-x:auto"><table><thead><tr><th>Pay ID</th><th>Member</th><th>Plan</th><th>Amount</th><th>Date</th><th>New Expiry</th><th>Recorded By</th><th>Method</th><th>Status</th><th>Source</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${pag}`;
}
let _renewalPaymentSource=null;
function openPaymentModal(prefillMemberId=null){
  const _isFromRenewal=!!_renewalPaymentSource;_renewalPaymentSource=null;
  document.getElementById('paymentModalTitle').textContent=_isFromRenewal?'🔄 Renewal Payment':'Record Payment';
  document.getElementById('paymentFormError').style.display='none';
  document.getElementById('paymentModal').dataset.fromRenewal=_isFromRenewal?'1':'';
  document.getElementById('pf_memberSearch').value='';
  document.getElementById('pf_memberId').value='';
  document.getElementById('pf_memberList').style.display='none';
  document.getElementById('pf_amount').value='';
  document.getElementById('pf_date').value=today();
  document.getElementById('pf_method').value='';
  document.getElementById('pf_notes').value='';
  const refWrap=document.getElementById('pf_refWrap');
  if(refWrap){refWrap.style.display='none';const ref=document.getElementById('pf_reference');if(ref)ref.value='';}
  const plans=Plans.all().filter(p=>p.status==='Active');
  document.getElementById('pf_plan').innerHTML=`<option value="">Select plan</option>`+plans.map(p=>`<option value="${p.id}">${esc(p.name)} — ₱${p.price}</option>`).join('');
  if(prefillMemberId){
    const m=Members.one(prefillMemberId);
    if(m){document.getElementById('pf_memberSearch').value=m.name;document.getElementById('pf_memberId').value=m.id;if(m.planId){document.getElementById('pf_plan').value=m.planId;onPayPlanChange();}}
  }
  openModal('paymentModal');
}
function togglePfReference(){
  const method=document.getElementById('pf_method').value;
  const wrap=document.getElementById('pf_refWrap');
  if(wrap)wrap.style.display=method==='GCash'?'block':'none';
}
function openPaymentForMember(id){_renewalPaymentSource=id;openPaymentModal(id);}
function filterMemberDropdown(val){
  const list=document.getElementById('pf_memberList');
  if(!val){list.style.display='none';return;}
  const members=Members.all().filter(m=>m.status!=='Archived'&&m.name.toLowerCase().includes(val.toLowerCase())).slice(0,8);
  if(!members.length){list.style.display='none';return;}
  list.innerHTML=members.map(m=>`<div style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid rgba(255,255,255,.05)" onmousedown="selectPayMember('${m.id}','${esc(m.name).replace(/'/g,"&#39;")}','${m.planId||''}')" onmouseover="this.style.background='rgba(179,188,181,.1)'" onmouseout="this.style.background=''">${esc(m.name)} <span style="color:var(--gray-500);font-size:11px">${esc(m.id)}</span></div>`).join('');
  list.style.display='block';
}
function selectPayMember(id,name,planId){
  document.getElementById('pf_memberSearch').value=name;
  document.getElementById('pf_memberId').value=id;
  document.getElementById('pf_memberList').style.display='none';
  if(planId){document.getElementById('pf_plan').value=planId;onPayPlanChange();}
}
function onPayPlanChange(){
  const planId=document.getElementById('pf_plan').value;
  if(!planId){document.getElementById('pf_amount').value='';return;}
  const plan=Plans.one(planId);
  if(plan)document.getElementById('pf_amount').value=plan.price;
}
function savePayment(){
  const memberId=document.getElementById('pf_memberId').value;
  const planId=document.getElementById('pf_plan').value;
  const amount=parseFloat(document.getElementById('pf_amount').value);
  const date=document.getElementById('pf_date').value;
  const method=document.getElementById('pf_method').value;
  const notes=document.getElementById('pf_notes').value.trim();
  const err=document.getElementById('paymentFormError');
  err.style.display='none';
  if(!memberId||!planId||!amount||!date||!method){err.textContent='Please fill in all required fields.';err.style.display='block';return;}
  if(amount<=0){err.textContent='Invalid payment amount. Please enter a valid amount greater than zero.';err.style.display='block';return;}
  const reference=document.getElementById('pf_reference')?document.getElementById('pf_reference').value.trim():'';
  if(method==='GCash'&&!reference){err.textContent='Please enter the GCash reference number.';err.style.display='block';return;}
  const member=Members.one(memberId);
  const plan=Plans.one(planId);
  const newExpiry=addMonths(date,plan?plan.duration:1);
  const fromRenewal=document.getElementById('paymentModal').dataset.fromRenewal==='1';
  const confirmTitle=fromRenewal?'🔄 Confirm Renewal Payment':'💳 Confirm Payment';
  const memberInitials=member?member.name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2):'?';
  const confirmMsg='Are you sure you want to record this payment?'
    +'<div style="margin-top:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.9">'
    +'<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.06)">'
    +'<div style="width:36px;height:36px;border-radius:8px;background:var(--orange);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;flex-shrink:0">'+memberInitials+'</div>'
    +'<div><div style="font-weight:700;color:var(--white);font-size:13px">'+(member?esc(member.name):'Unknown')+'</div>'
    +'<div style="color:var(--gray-500);font-size:11px;font-family:monospace">'+(member?esc(member.id):'')+'</div></div>'
    +(fromRenewal?'<span style="margin-left:auto;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px;background:rgba(251,191,36,.15);color:var(--gold);text-transform:uppercase;border:1px solid rgba(251,191,36,.3)">🔄 RENEWAL</span>':'<span style="margin-left:auto;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px;background:rgba(127,250,136,.12);color:var(--green);text-transform:uppercase">NEW</span>')
    +'</div>'
    +'<div><span style="color:var(--gray-500);width:100px;display:inline-block">Plan:</span> <strong style="color:var(--white)">'+(plan?esc(plan.name):'Unknown')+'</strong></div>'
    +'<div><span style="color:var(--gray-500);width:100px;display:inline-block">Method:</span> <strong style="color:var(--white)">'+esc(method)+'</strong></div>'
    +'<div><span style="color:var(--gray-500);width:100px;display:inline-block">Amount:</span> <strong style="color:var(--green)">₱'+Number(amount).toLocaleString()+'</strong></div>'
    +'<div><span style="color:var(--gray-500);width:100px;display:inline-block">Payment Date:</span> <strong style="color:var(--white)">'+formatDate(date)+'</strong></div>'
    +'<div><span style="color:var(--gray-500);width:100px;display:inline-block">New Expiry:</span> <strong style="color:var(--white)">'+formatDate(newExpiry)+'</strong></div>'
    +'</div>'
    +'<div style="margin-top:10px;font-size:11px;color:#d7ddd8;background:rgba(179,188,181,.06);border:1px solid rgba(179,188,181,.2);border-radius:6px;padding:8px 12px">&#128161; This will record the payment and update the member expiry date.</div>';
  openConfirm(confirmTitle,confirmMsg,function(){
    const payments=Payments.all();
    const newId=nextId(KEY.payments,'PAY');
    payments.push({id:newId,memberId,memberName:member?member.name:'Unknown',planId,planName:plan?plan.name:'Unknown',amount,date,newExpiry,method,reference:sanitizeText(reference),notes:sanitizeText(notes),recordedBy:currentUser.name,recordedByUsername:currentUser.username,staffId:currentUser.id,status:'Paid',source:fromRenewal?'renewal':'billing',timestamp:Date.now(),createdAt:today()});
    Payments.save(payments);
    const members=Members.all();
    const idx=members.findIndex(m=>m.id===memberId);
    if(idx>-1){members[idx].planId=planId;members[idx].expiryDate=newExpiry;members[idx].status='Active';members[idx].planStart=date;members[idx].qrNonce=newQrNonce(memberId);}
    Members.save(members);
    const live=Members.one(memberId);
    if(live)Members.update(memberId,{qrToken:qrTokenFor(memberId,today())});
    resolveNotifsForMember(memberId);
    _dismissedIds.add(memberId);
    document.getElementById('paymentModal').dataset.fromRenewal='';
    toast('Payment recorded successfully.');
    closeModal('paymentModal');
    renderBilling();
    scanRenewals();
    if(fromRenewal){setTimeout(function(){navigate('notifications');viewRenewalReceipt(newId);},300);}
  },'Confirm','btn-primary');
}
function deletePayment(id){
  const p=Payments.one(id);if(!p)return;
  openConfirm('Delete Payment',`Delete payment record ${p.id} for ${esc(p.memberName)}? This cannot be undone.`,()=>{
    const payments=Payments.all().filter(x=>x.id!==id);
    Payments.save(payments);
    toast('Payment record deleted.','info');
    refreshBillingTable();
  });
}
function openEditPayment(id){
  const p=Payments.one(id);if(!p)return;
  document.getElementById('editPaymentError').style.display='none';
  document.getElementById('ep_id').value=p.id;
  document.getElementById('ep_memberId').value=p.memberId;
  document.getElementById('ep_memberName').value=p.memberName;
  document.getElementById('ep_amount').value=p.amount;
  document.getElementById('ep_date').value=p.date;
  document.getElementById('ep_notes').value=p.notes||'';
  const plans=Plans.all().filter(pl=>pl.status==='Active');
  document.getElementById('ep_plan').innerHTML=`<option value="">Select plan</option>`+plans.map(pl=>`<option value="${pl.id}">${esc(pl.name)} — ₱${pl.price}</option>`).join('');
  document.getElementById('ep_plan').value=p.planId;
  document.getElementById('ep_method').value=p.method||'';
  const epRef=document.getElementById('ep_reference');
  if(epRef)epRef.value=p.reference||'';
  const epRefWrap=document.getElementById('ep_refWrap');
  if(epRefWrap)epRefWrap.style.display=(p.method||'')==='GCash'?'block':'none';
  openModal('editPaymentModal');
}
function onEditPlanChange(){
  const planId=document.getElementById('ep_plan').value;
  if(!planId)return;
  const plan=Plans.one(planId);
  if(plan)document.getElementById('ep_amount').value=plan.price;
}
function saveEditPayment(){
  const id=document.getElementById('ep_id').value;
  const memberId=document.getElementById('ep_memberId').value;
  const planId=document.getElementById('ep_plan').value;
  const amount=parseFloat(document.getElementById('ep_amount').value);
  const date=document.getElementById('ep_date').value;
  const method=document.getElementById('ep_method').value;
  const notes=document.getElementById('ep_notes').value.trim();
  const err=document.getElementById('editPaymentError');
  err.style.display='none';
  if(!planId||!amount||!date||!method){err.textContent='Please fill in all required fields.';err.style.display='block';return;}
  if(amount<=0){err.textContent='Invalid amount. The payment amount must be greater than zero.';err.style.display='block';return;}
  const reference=document.getElementById('ep_reference')?document.getElementById('ep_reference').value.trim():'';
  if(method==='GCash'&&!reference){err.textContent='Please enter the GCash reference number.';err.style.display='block';return;}
  const plan=Plans.one(planId);
  const newExpiry=addMonths(date,plan?plan.duration:1);
  const payments=Payments.all();
  const idx=payments.findIndex(p=>p.id===id);
  if(idx<0){err.textContent='Payment record not found. Please refresh and try again.';err.style.display='block';return;}
  payments[idx]={...payments[idx],planId,planName:plan?plan.name:payments[idx].planName,amount,date,newExpiry,method,reference,notes,editedBy:currentUser.username,editedAt:today()};
  Payments.save(payments);
  // Update member plan and expiry
  const members=Members.all();const midx=members.findIndex(m=>m.id===memberId);
  if(midx>-1){members[midx].planId=planId;members[midx].expiryDate=newExpiry;members[midx].status='Active';members[midx].planStart=date;members[midx].qrNonce=newQrNonce(memberId);}
  Members.save(members);
  const live=Members.one(memberId);
  if(live)Members.update(memberId,{qrToken:qrTokenFor(memberId,today())});
  resolveNotifsForMember(memberId);
  _dismissedIds.add(memberId);
  toast('Payment updated successfully.','success');
  closeModal('editPaymentModal');renderBilling();scanRenewals();
}
function viewRenewalReceipt(id){viewReceipt(id);}
function viewReceipt(id){
  const p=Payments.one(id);if(!p)return;
  // Always pull the latest member name from the members DB (reflects edits)
  const liveMember=Members.one(p.memberId);
  const displayMemberName=liveMember?liveMember.name:p.memberName;
  const users=Users.all();
  let staffDisplay=p.recordedBy||'—';
  const match=users.find(u=>
    u.username===p.recordedByUsername||
    u.username===p.recordedBy||
    u.name===p.recordedBy
  );
  if(match)staffDisplay=match.name;
  const isRenewal=p.source==='renewal';
  document.getElementById('receiptBody').innerHTML=`
  <div class="receipt">
    <div class="receipt-header">
      <div class="receipt-sticker">
        <svg width="46" height="46" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="48" height="48" rx="12" fill="url(#rcGrad)"/>
          <rect x="8" y="21" width="7" height="6" rx="2" fill="white"/>
          <rect x="33" y="21" width="7" height="6" rx="2" fill="white"/>
          <rect x="13" y="17" width="5" height="14" rx="2" fill="white"/>
          <rect x="30" y="17" width="5" height="14" rx="2" fill="white"/>
          <rect x="18" y="22" width="12" height="4" rx="2" fill="white"/>
          <defs><linearGradient id="rcGrad" x1="0" y1="0" x2="48" y2="48"><stop offset="0%" stop-color="#7ffa88"/><stop offset="100%" stop-color="#4ade80"/></linearGradient></defs>
        </svg>
      </div>
      <h2>FITCORE <span>GMS</span></h2>
      <div class="receipt-sub">Gym Management System</div>
      <div class="receipt-tag ${isRenewal?'tag-renew':'tag-paid'}">${isRenewal?'🔄 Membership Renewal Receipt':'Official Receipt'}</div>
    </div>
    <div class="receipt-meta">
      <div><span>Receipt No.</span><strong>${p.id}</strong></div>
      <div><span>Payment Date</span><strong>${formatDate(p.date)}</strong></div>
    </div>
    <div class="receipt-body">
      <div class="receipt-row"><span>Member</span><strong>${esc(displayMemberName)}</strong></div>
      <div class="receipt-row"><span>Member ID</span><strong>${esc(p.memberId)}</strong></div>
      <div class="receipt-row"><span>Membership Plan</span><strong>${esc(p.planName)}</strong></div>
      <div class="receipt-row"><span>Payment Method</span><strong>${esc(p.method)}</strong></div>
      <div class="receipt-row"><span>New Expiry Date</span><strong>${formatDate(p.newExpiry)}</strong></div>
    </div>
    <div class="receipt-total">
      <span>Amount Paid</span>
      <strong>&#8369;${Number(p.amount).toLocaleString()}</strong>
    </div>
    <div class="receipt-foot">
      <div class="receipt-footer-note">Recorded by <strong>${esc(staffDisplay)}</strong> &middot; ${formatDateTime(p.createdAt)}</div>
      <div class="receipt-barcode" aria-hidden="true"></div>
      <div class="receipt-thanks">Train hard &middot; Stay strong &middot; See you at FitCore</div>
    </div>
  </div>`;
  openModal('receiptModal');
}

// ======================================================================
// PANEL: SCHEDULE
// ======================================================================
let schedView='week';let schedTrainerFilter='all';let schedMemberSearch='';
function renderSchedule(){
  const el=document.getElementById('panelSchedule');
  const users=Users.all().filter(u=>u.role==='trainer');
  const canCreate=currentUser.role==='staff'||currentUser.role==='admin';
  const isTrainer=currentUser.role==='trainer';
  if(isTrainer)schedTrainerFilter=currentUser.id;
  // Deduplicate trainers by ID
  const uniqueTrainers=users.filter((u,i,a)=>a.findIndex(x=>x.id===u.id)===i);
  const trainerOpts=(isTrainer
    ? `<option value="${currentUser.id}" selected>My Schedule</option>`
    : `<option value="all" ${schedTrainerFilter==='all'?'selected':''}>All Trainers</option>`
      + uniqueTrainers.map(u=>`<option value="${u.id}" ${schedTrainerFilter===u.id?'selected':''}>${esc(u.name)}</option>`).join('')
  );
  const filterLabel=isTrainer?'<span style="font-size:10px;font-weight:700;color:var(--gray-500);text-transform:uppercase;letter-spacing:1px;align-self:center">View:</span>':'';
  el.innerHTML=`
  ${isTrainer?renderTrainerProfile():''}
  <div class="sched-controls">
    <div class="view-toggle">
      <button class="vt-btn ${schedView==='week'?'active':''}" onclick="schedView='week';renderSchedule()">📅 Week</button>
      <button class="vt-btn ${schedView==='list'?'active':''}" onclick="schedView='list';renderSchedule()">📋 List</button>
    </div>
    ${filterLabel}
    <select class="filter-sel" onchange="schedTrainerFilter=this.value;renderSchedule()">
      ${trainerOpts}
    </select>
    <input class="search-input" placeholder="Search member name…" value="${esc(schedMemberSearch)}" oninput="schedMemberSearch=this.value;if(schedView==='list'){renderListView();}" style="min-width:180px">
    ${canCreate?`<button class="btn-primary" style="margin-left:auto" onclick="openSessionModal()">+ Create Session</button>`:''}
  </div>
  <div id="schedContent"></div>`;
  if(schedView==='week')renderWeekView();else renderListView();
}
function renderTrainerProfile(){
  const u=currentUser;
  const sessions=Sessions.all().filter(s=>s.trainerId===u.id);
  const scheduled=sessions.filter(s=>s.status==='Scheduled').length;
  const completed=sessions.filter(s=>s.status==='Completed').length;
  const cancelled=sessions.filter(s=>s.status==='Cancelled').length;
  const todaySessions=sessions.filter(s=>s.date===today()&&s.status==='Scheduled').length;
  const ini=u.avatar?`<img src="${u.avatar}" class="trainer-avatar-lg" style="background-size:cover;background-position:center;background-repeat:no-repeat">`:u.name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  const specs=Array.isArray(u.specializations)&&u.specializations.length?u.specializations:[];
  const days=Array.isArray(u.availableDays)&&u.availableDays.length?u.availableDays:[];
  const hours=(u.availableFrom&&u.availableTo)?`${u.availableFrom} – ${u.availableTo}`:'';
  const displayName=u.coachName||u.name;
  return`<div class="trainer-profile-card">
    ${u.avatar?`<div class="trainer-avatar-lg" style="background-image:url('${u.avatar}')"></div>`:`<div class="trainer-avatar-lg">${ini}</div>`}
    <div class="trainer-profile-info" style="flex:1">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px">
        <div class="trainer-profile-name" style="margin-bottom:0">${esc(displayName)}</div>
        ${u.coachName&&u.coachName!==u.name?`<div style="font-size:12px;color:var(--gray-500)">(${esc(u.name)})</div>`:''}
        <button onclick="openTrainerEditModal()" style="background:rgba(179,188,181,.12);border:1px solid rgba(179,188,181,.3);color:var(--orange);border-radius:7px;padding:5px 13px;font-size:11px;font-weight:700;cursor:pointer;transition:.2s;letter-spacing:.5px;text-transform:uppercase" onmouseover="this.style.background='var(--orange)';this.style.color='#fff'" onmouseout="this.style.background='rgba(179,188,181,.12)';this.style.color='var(--orange)'">&#9998; Edit Profile</button>
      </div>
      <span class="trainer-profile-role">&#9679; Certified Trainer &middot; @${esc(u.username)}</span>
      ${specs.length?`<div style="display:flex;flex-wrap:wrap;gap:5px;margin:8px 0 4px">${specs.map(s=>`<span style="background:rgba(179,188,181,.1);border:1px solid rgba(179,188,181,.22);color:var(--orange);border-radius:5px;padding:3px 9px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px">${esc(s)}</span>`).join('')}</div>`:''}
      ${days.length||hours?`<div style="font-size:11px;color:var(--gray-500);margin-bottom:8px">&#9200; ${days.map(esc).join(', ')}${hours?' &middot; '+esc(hours):''}</div>`:''}
      ${u.bio?`<div style="font-size:12px;color:var(--gray-300);font-style:italic;margin-bottom:10px;line-height:1.5">&ldquo;${esc(u.bio)}&rdquo;</div>`:''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        <span class="trainer-session-badge tsb-scheduled">&#128336; ${scheduled} Scheduled</span>
        <span class="trainer-session-badge tsb-completed">&#10003; ${completed} Completed</span>
        ${cancelled?`<span class="trainer-session-badge tsb-cancelled">&#10005; ${cancelled} Cancelled</span>`:''}
      </div>
      <div class="trainer-profile-stats">
        <div class="tp-stat"><div class="tp-stat-num">${sessions.length}</div><div class="tp-stat-label">Total Sessions</div></div>
        <div class="tp-stat"><div class="tp-stat-num">${todaySessions}</div><div class="tp-stat-label">Today</div></div>
        <div class="tp-stat"><div class="tp-stat-num">${completed}</div><div class="tp-stat-label">Done</div></div>
        <div class="tp-stat"><div class="tp-stat-num">${completed&&sessions.length?Math.round(completed/sessions.length*100):0}%</div><div class="tp-stat-label">Completion</div></div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end;min-width:140px">
      <div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:var(--gray-500);margin-bottom:4px">Account Info</div>
      <div style="font-size:12px;color:var(--gray-300)">&#128222; ${esc(u.contact||'&mdash;')}</div>
      <div style="font-size:12px;color:var(--gray-500);font-family:monospace">@${esc(u.username)}</div>
      <div style="margin-top:8px"><span class="badge badge-trainer">&#9679; Active</span></div>
    </div>
  </div>`;
}
function openTrainerEditModal(){
  const u=currentUser;
  if(u.avatar){
    document.getElementById('tep_avatar').value=u.avatar||'';
    document.getElementById('tep_avatar_preview').src=u.avatar;document.getElementById('tep_avatar_preview').style.display='block';
  } else {
    document.getElementById('tep_avatar').value='';
    document.getElementById('tep_avatar_preview').style.display='none';
  }
  document.getElementById('tep_fullname').value=u.name||'';
  document.getElementById('tep_coachname').value=u.coachName||'';
  document.getElementById('tep_bio').value=u.bio||'';
  document.querySelectorAll('#tep_specs input[type=checkbox]').forEach(cb=>{
    cb.checked=Array.isArray(u.specializations)&&u.specializations.includes(cb.value);
  });
  document.querySelectorAll('#tep_days input[type=checkbox]').forEach(cb=>{
    cb.checked=Array.isArray(u.availableDays)&&u.availableDays.includes(cb.value);
  });
  document.getElementById('tep_from').value=u.availableFrom||'';
  document.getElementById('tep_to').value=u.availableTo||'';
  document.getElementById('tepError').style.display='none';
  openModal('trainerEditProfileModal');
}
function saveTrainerProfile(){
  const fullname=document.getElementById('tep_fullname').value.trim();
  const coachname=document.getElementById('tep_coachname').value.trim();
  const avatar=document.getElementById('tep_avatar').value;
  const bio=document.getElementById('tep_bio').value.trim();
  const specs=[...document.querySelectorAll('#tep_specs input[type=checkbox]:checked')].map(c=>c.value);
  const days=[...document.querySelectorAll('#tep_days input[type=checkbox]:checked')].map(c=>c.value);
  const from=document.getElementById('tep_from').value;
  const to=document.getElementById('tep_to').value;
  const errEl=document.getElementById('tepError');
  errEl.style.display='none';
  if(!fullname){errEl.textContent='Full name is required.';errEl.style.display='block';return;}
  const users=Users.all();
  const idx=users.findIndex(x=>x.id===currentUser.id);
  if(idx<0){errEl.textContent='User not found.';errEl.style.display='block';return;}
  users[idx].name=fullname;
  users[idx].coachName=coachname||fullname;
  users[idx].bio=bio;
  users[idx].specializations=specs;
  users[idx].availableDays=days;
  users[idx].availableFrom=from;
  users[idx].availableTo=to;
  users[idx].avatar=avatar||'';
  Users.save(users);
  currentUser={...currentUser,...users[idx]};
  setSession(currentUser);
  const sn=document.getElementById('sideUserName');
  if(sn)sn.textContent=fullname;
  setUserAvatar(document.getElementById('sideUserAvatar'),fullname,avatar||'');
  setUserAvatar(document.getElementById('topAvatar'),fullname,avatar||'');
  closeModal('trainerEditProfileModal');
  toast('Profile updated successfully!','success');
  renderSchedule();
}
function updateSepAvatar(name){
  const av=document.getElementById('sep_avatar_initials');
  const img=document.getElementById('sep_avatar_preview');
  const hidden=document.getElementById('sep_avatar').value;
  if(hidden&&hidden.length>20){
    if(av)av.style.backgroundImage='url("'+hidden+'")';
    if(av)av.textContent='';
    if(img){img.src=hidden;img.style.display='block';}
  } else {
    if(av){av.style.backgroundImage='';av.textContent=initials(name||currentUser.name);}
    if(img)img.style.display='none';
  }
  const dn=document.getElementById('sep_display_name');
  if(dn)dn.textContent=name||currentUser.name;
}
function openStaffEditModal(){
  if(!currentUser)return;
  if(currentUser.role==='member'){openMemberProfileEdit();return;}
  if(currentUser.role==='trainer'){openTrainerEditModal();return;}
  const u={...currentUser};
  if(u.avatar){
    document.getElementById('sep_avatar').value=u.avatar||'';
    document.getElementById('sep_avatar_preview').src=u.avatar;document.getElementById('sep_avatar_preview').style.display='block';
    document.getElementById('sep_avatar_initials').style.backgroundImage='url("'+u.avatar+'")';document.getElementById('sep_avatar_initials').textContent='';
  } else {
    document.getElementById('sep_avatar').value='';
    document.getElementById('sep_avatar_preview').style.display='none';
    document.getElementById('sep_avatar_initials').style.backgroundImage='';document.getElementById('sep_avatar_initials').textContent=initials(u.name);
  }
  document.getElementById('sep_name').value=u.name||'';
  document.getElementById('sep_contact').value=u.contact||'';
  document.getElementById('sep_display_name').textContent=u.name;
  document.getElementById('sep_display_username').textContent='@'+u.username;
  const badge=document.getElementById('sep_role_badge');
  if(badge){badge.textContent=u.role==='admin'?'Admin':'Staff';}
  document.getElementById('sepError').style.display='none';
  openModal('staffEditProfileModal');
}
function saveStaffProfile(){
  const name=document.getElementById('sep_name').value.trim();
  const contact=document.getElementById('sep_contact').value.trim();
  const avatar=document.getElementById('sep_avatar').value;
  const errEl=document.getElementById('sepError');
  errEl.style.display='none';
  if(!name){errEl.textContent='Full name is required.';errEl.style.display='block';return;}
  const users=Users.all();
  const idx=users.findIndex(x=>x.id===currentUser.id);
  if(idx<0){errEl.textContent='User not found.';errEl.style.display='block';return;}
  users[idx].name=name;
  users[idx].contact=contact;
  users[idx].avatar=avatar||'';
  Users.save(users);
  currentUser={...currentUser,name,contact,avatar:avatar||''};
  setSession(currentUser);
  const sn=document.getElementById('sideUserName');
  if(sn)sn.textContent=name;
  setUserAvatar(document.getElementById('sideUserAvatar'),name,avatar||'');
  setUserAvatar(document.getElementById('topAvatar'),name,avatar||'');
  closeModal('staffEditProfileModal');
  toast('Profile updated successfully!','success');
}
function getSchedSessions(){
  let s=Sessions.all();
  if(schedTrainerFilter!=='all')s=s.filter(x=>x.trainerId===schedTrainerFilter);
  return s;
}

function viewSession(id){
  const sessions=Sessions.all();
  const s=sessions.find(x=>x.id===id);
  if(!s)return;
  const statusColor=s.status==='Completed'?'#7ffa88':s.status==='Cancelled'?'#ef4444':'#fbbf24';
  const statusIcon=s.status==='Completed'?'✓ Completed':s.status==='Cancelled'?'✕ Cancelled':'● Scheduled';
  const statusBg=s.status==='Completed'?'rgba(127,250,136,.12)':s.status==='Cancelled'?'rgba(239,68,68,.12)':'rgba(251,191,36,.12)';
  const isMySession=currentUser.role==='trainer'&&s.trainerId===currentUser.id;
  const body=document.getElementById('sessionInfoBody');
  body.innerHTML=`
    <div style="display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--gray-500);margin-bottom:4px">Session Type</div>
          <div style="font-size:18px;font-weight:800;color:var(--white)">${esc(s.type||'—')}</div>
        </div>
        <div style="background:${statusBg};border:1px solid ${statusColor}44;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:800;color:${statusColor};letter-spacing:.5px;text-transform:uppercase">${statusIcon}</div>
      </div>
      <hr style="border:none;border-top:1px solid rgba(255,255,255,.06)">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div style="background:var(--navy-700);border-radius:8px;padding:14px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--gray-500);margin-bottom:6px">👤 Member</div>
          <div style="font-size:14px;font-weight:700;color:var(--white)">${esc(s.memberName||'—')}</div>
        </div>
        <div style="background:var(--navy-700);border-radius:8px;padding:14px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--gray-500);margin-bottom:6px">🏋️ Trainer</div>
          <div style="font-size:14px;font-weight:700;color:var(--white)">${esc(s.trainerName||'—')}</div>
        </div>
        <div style="background:var(--navy-700);border-radius:8px;padding:14px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--gray-500);margin-bottom:6px">📅 Date</div>
          <div style="font-size:14px;font-weight:700;color:var(--white)">${formatDate(s.date)}</div>
        </div>
        <div style="background:var(--navy-700);border-radius:8px;padding:14px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--gray-500);margin-bottom:6px">🕐 Time</div>
          <div style="font-size:14px;font-weight:700;color:var(--white)">${esc(s.start)} – ${esc(s.end)}</div>
        </div>
      </div>
      ${s.notes?`<div style="background:var(--navy-700);border-radius:8px;padding:14px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--gray-500);margin-bottom:6px">📝 Notes</div><div style="font-size:13px;color:var(--gray-100);line-height:1.6">${esc(s.notes)}</div></div>`:''}
      <div style="background:var(--navy-700);border-radius:8px;padding:14px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--gray-500);margin-bottom:8px">🕓 History</div>
        <div style="font-size:12px;color:var(--gray-300)">Created by <strong style="color:var(--gray-100)">${esc(s.createdBy||'—')}</strong>${s.createdAt?' on '+formatDate(s.createdAt):''}</div>
        ${s.editedBy?`<div style="font-size:12px;color:var(--gray-300);margin-top:4px">Last edited by <strong style="color:var(--gray-100)">${esc(s.editedBy)}</strong>${s.editedAt?' on '+formatDate(s.editedAt):''}</div>`:''}
        ${(currentUser.role==='admin'||currentUser.role==='staff')&&s.statusLog&&s.statusLog.length?`
        <div style="margin-top:12px;border-top:1px solid rgba(255,255,255,.06);padding-top:12px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--gray-500);margin-bottom:8px">🔄 Status Changes by Trainer</div>
          ${s.statusLog.map(log=>{
            const roleColorMap={admin:'var(--orange)',staff:'#d7ddd8',trainer:'var(--green)'};
            const clr=roleColorMap[log.byRole]||'var(--gray-300)';
            const fromClr=log.from==='Completed'?'#7ffa88':log.from==='Cancelled'?'#ef4444':'#fbbf24';
            const toClr=log.to==='Completed'?'#7ffa88':log.to==='Cancelled'?'#ef4444':'#fbbf24';
            const timeStr=log.at?new Date(log.at).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
            return`<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;background:rgba(255,255,255,.03);border-radius:6px;padding:8px 10px">
              <div style="flex:1">
                <div style="font-size:12px;color:var(--gray-100);font-weight:600">${esc(log.by||'—')} <span style="font-size:9px;font-weight:800;padding:1px 6px;border-radius:4px;background:rgba(255,255,255,.07);color:${clr};margin-left:2px;text-transform:uppercase">${esc(log.byRole||'')}</span></div>
                <div style="font-size:11px;color:var(--gray-500);margin-top:2px">${timeStr}</div>
              </div>
              <div style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700">
                <span style="color:${fromClr};background:rgba(255,255,255,.05);padding:2px 8px;border-radius:4px">${log.from}</span>
                <span style="color:var(--gray-500)">→</span>
                <span style="color:${toClr};background:rgba(255,255,255,.05);padding:2px 8px;border-radius:4px">${log.to}</span>
              </div>
            </div>`;
          }).join('')}
        </div>`:''}
      </div>
    </div>`;
  const foot=document.getElementById('sessionInfoFoot');
  if(isMySession&&s.status==='Scheduled'){
    foot.innerHTML=`<button class="btn-secondary" onclick="closeModal('sessionInfoModal')">Close</button>
      <button class="btn-primary" style="background:#7ffa88;border-color:#7ffa88" onclick="closeModal('sessionInfoModal');confirmCompleteSession('${id}')">✓ Mark as Done</button>
      <button class="btn-danger" onclick="closeModal('sessionInfoModal');confirmCancelSession('${id}')">✕ Cancel Session</button>`;
  } else {
    foot.innerHTML=`<button class="btn-secondary" onclick="closeModal('sessionInfoModal')">Close</button>`;
    if((currentUser.role==='admin'||currentUser.role==='staff')&&s.status!=='Cancelled'){
      foot.innerHTML=`<button class="btn-secondary" onclick="closeModal('sessionInfoModal')">Close</button>
        <button class="btn-primary" onclick="closeModal('sessionInfoModal');editSession('${id}')">✏️ Edit</button>`;
    }
  }
  openModal('sessionInfoModal');
}

function renderWeekView(){
  const sessions=getSchedSessions();
  const mon=getMondayOf(today());
  const days=[];for(let i=0;i<7;i++)days.push(addDays(mon,i));
  const times=[];for(let h=6;h<=21;h++)times.push(`${h.toString().padStart(2,'0')}:00`);
  const colors={'u3':'#b3bcb5','u2':'#b3bcb5'};function getColor(tid){return colors[tid]||'#7ffa88';}
  const dayHeaders=days.map(d=>{const dd=new Date(d);return`<div class="wh-cell">${dd.toLocaleString('en-US',{weekday:'short'})}<br><span style="font-size:13px;font-weight:700;color:${d===today()?'var(--orange)':'inherit'}">${dd.getDate()}</span></div>`;}).join('');
  const timeSlots=times.map(t=>`<div class="time-slot">${t}</div>`).join('');
  const dayCols=days.map(d=>{
    const daySessions=sessions.filter(s=>s.date===d);
    const blocks=daySessions.map(s=>{
      const sh=parseInt(s.start.split(':')[0]);const sm=parseInt(s.start.split(':')[1]||0);
      const eh=parseInt(s.end.split(':')[0]);const em=parseInt(s.end.split(':')[1]||0);
      const top=((sh-6)*60+sm)/15*12;
      const height=((eh-sh)*60+(em-sm))/15*12;
      const clr=getColor(s.trainerId);
      const isMyBlock=currentUser.role==='trainer'&&s.trainerId===currentUser.id;
      const isOtherTrainer=currentUser.role==='trainer'&&s.trainerId!==currentUser.id;
      const clickAttr=isMyBlock?`onclick="viewSession('${s.id}')"`:(!isOtherTrainer?`onclick="viewSession('${s.id}')"`:'' );
      const blockCursor=isOtherTrainer?'default':(currentUser.role==='trainer'?'pointer':'pointer');
      const blockOpacity=isOtherTrainer?'0.45':'1';
      const statusColor=s.status==='Completed'?'#7ffa88':s.status==='Cancelled'?'#ef4444':'#fbbf24';
      const statusIcon=s.status==='Completed'?'✓ Done':s.status==='Cancelled'?'✕ Cancelled':'● Scheduled';
      const statusBg=s.status==='Completed'?'rgba(127,250,136,0.15)':s.status==='Cancelled'?'rgba(239,68,68,0.15)':'rgba(251,191,36,0.12)';
      const borderClr=s.status==='Completed'?'#7ffa88':s.status==='Cancelled'?'#ef4444':clr;
      const blockBg=s.status==='Completed'?'rgba(127,250,136,0.08)':s.status==='Cancelled'?'rgba(239,68,68,0.08)':`${clr}20`;
      const myTag=isMyBlock?`<div style="font-size:7px;font-weight:900;color:var(--green);letter-spacing:.5px;text-transform:uppercase;margin-bottom:1px">● MINE</div>`:'';
      return`<div class="session-block" style="top:${top}px;height:${Math.max(height,48)}px;background:${blockBg};border-left:3px solid ${borderClr};position:absolute;left:2px;right:2px;border-radius:4px;padding:4px 6px;overflow:hidden;cursor:${blockCursor};opacity:${blockOpacity}" ${clickAttr}>
        ${myTag}
        <div style="font-size:10px;font-weight:700;color:${clr}">${s.start}</div>
        <div style="font-size:10px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#fff">${esc(s.memberName||'')}</div>
        <div style="font-size:9px;color:var(--gray-500)">${esc(s.trainerName||'')} · ${esc(s.type||'')}</div>
        <div style="margin-top:3px;display:inline-flex;align-items:center;gap:3px;background:${statusBg};border:1px solid ${statusColor}33;border-radius:3px;padding:1px 5px">
          <span style="font-size:8px;font-weight:800;color:${statusColor};letter-spacing:.5px;text-transform:uppercase">${statusIcon}</span>
        </div>
      </div>`;}).join('');
    return`<div class="day-col" style="${d===today()?'background:rgba(179,188,181,.03)':''}">${blocks}</div>`;}).join('');
  document.getElementById('schedContent').innerHTML=`
  <div class="week-grid">
    <div class="week-header"><div class="wh-cell">Time</div>${dayHeaders}</div>
    <div class="week-body"><div class="time-col">${timeSlots}</div>${dayCols}</div>
  </div>`;
}
function renderListView(){
  let sessions=getSchedSessions().sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
  if(schedMemberSearch){const s=schedMemberSearch.toLowerCase();sessions=sessions.filter(x=>(x.memberName||'').toLowerCase().includes(s));}
  const allUsers=Users.all();
  const roleColorMap={admin:'var(--orange)',staff:'#d7ddd8',trainer:'var(--green)'};
  const rows=sessions.length?sessions.map(s=>{
    const statusCls={'Scheduled':'badge-scheduled','Completed':'badge-completed','Cancelled':'badge-cancelled'}[s.status]||'';
    const createdByUser=s.createdBy?allUsers.find(u=>u.name===s.createdBy||u.username===s.createdByUsername):null;
    const roleColor=createdByUser?roleColorMap[createdByUser.role]||'var(--gray-300)':'var(--gray-300)';
    const roleTag=createdByUser?`<span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,.07);color:${roleColor};margin-left:4px;text-transform:uppercase">${createdByUser.role}</span>`:'';
    const createdLine=s.createdBy?`<div style="font-size:12px;font-weight:600;color:var(--gray-100)">${esc(s.createdBy)}${roleTag}</div>`:`<span style="font-size:11px;color:var(--gray-500)">—</span>`;
    const editedByUser=s.editedBy?allUsers.find(u=>u.name===s.editedBy||u.username===s.editedByUsername):null;
    const editedRoleColor=editedByUser?roleColorMap[editedByUser.role]||'var(--gray-300)':'var(--gray-300)';
    const editedRoleTag=editedByUser?`<span style="font-size:9px;font-weight:800;padding:2px 5px;border-radius:4px;background:rgba(255,255,255,.07);color:${editedRoleColor};margin-left:4px;text-transform:uppercase">${editedByUser.role}</span>`:'';
    const editedLine=s.editedBy?`<div style="font-size:11px;color:var(--gray-500);margin-top:3px">✎ ${esc(s.editedBy)}${editedRoleTag}</div>`:'';
    const createdByDisplay=`<div>${createdLine}${editedLine}</div>`;
    const isMySession=currentUser.role==='trainer'&&s.trainerId===currentUser.id;
    const rowHighlight=isMySession?'background:rgba(127,250,136,.04);':'';
    const myBadge=isMySession?`<span style="font-size:9px;font-weight:800;padding:1px 6px;border-radius:4px;background:rgba(127,250,136,.15);color:var(--green);border:1px solid rgba(127,250,136,.25);margin-left:6px">MY SESSION</span>`:'';
    return`<tr style="${rowHighlight}">
      <td>${formatDate(s.date)}</td><td>${esc(s.start)}–${esc(s.end)}</td>
      <td>${esc(s.trainerName||'—')}${myBadge}</td><td>${esc(s.memberName||'—')}</td>
      <td>${esc(s.type)}</td>
      <td><span class="badge ${statusCls}">${esc(s.status)}</span></td>
      <td>${createdByDisplay}</td>
      <td><div class="td-actions">
        ${currentUser.role==='trainer'
          ?(s.trainerId===currentUser.id
            ?(s.status==='Scheduled'
              ?`<button onclick="confirmCompleteSession('${s.id}')" title="Mark as Completed" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;font-size:11px;font-weight:800;border-radius:6px;border:1px solid rgba(127,250,136,.35);background:rgba(127,250,136,.12);color:#7ffa88;cursor:pointer;transition:.2s" onmouseover="this.style.background='#7ffa88';this.style.color='#000'" onmouseout="this.style.background='rgba(127,250,136,.12)';this.style.color='#7ffa88'">✓ Complete</button>
               <button onclick="confirmCancelSession('${s.id}')" title="Cancel Session" style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;font-size:11px;font-weight:800;border-radius:6px;border:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.1);color:var(--red);cursor:pointer;transition:.2s" onmouseover="this.style.background='var(--red)';this.style.color='#fff'" onmouseout="this.style.background='rgba(239,68,68,.1)';this.style.color='var(--red)'">✕ Cancel</button>`
              :`<span style="font-size:11px;font-weight:700;padding:3px 8px;border-radius:5px;background:rgba(255,255,255,.05);color:var(--gray-500)">${s.status==='Completed'?'✓ Done':'✕ Cancelled'}</span>`)
            :`<span style="font-size:11px;color:var(--gray-500)" title="View only">👁</span>`)
          :(currentUser.role==='admin'
            ?`<button class="btn-icon" onclick="editSession('${s.id}')" title="Edit">✏️</button><button class="btn-icon" title="Delete" style="color:var(--red);border-color:rgba(239,68,68,.25);background:rgba(239,68,68,.08)" onmouseover="this.style.background='var(--red)';this.style.color='#fff'" onmouseout="this.style.background='rgba(239,68,68,.08)';this.style.color='var(--red)'" onclick="deleteSession('${s.id}')">✕</button>`
            :`<button class="btn-icon" onclick="editSession('${s.id}')" title="Edit">✏️</button><button class="btn-icon" title="Delete" style="color:var(--red);border-color:rgba(239,68,68,.25);background:rgba(239,68,68,.08)" onmouseover="this.style.background='var(--red)';this.style.color='#fff'" onmouseout="this.style.background='rgba(239,68,68,.08)';this.style.color='var(--red)'" onclick="deleteSession('${s.id}')">✕</button>`)}
      </div></td>
    </tr>`;}).join(''):`<tr><td colspan="8"><div class="empty-state"><div class="empty-icon">📅</div><p>No sessions found</p></div></td></tr>`;
  document.getElementById('schedContent').innerHTML=`
  <div class="table-card">
    <div class="table-header"><h3>${esc(schedTrainerFilter==='all'?'All Sessions':schedTrainerFilter===currentUser.id?'My Sessions':sessions.length&&sessions[0].trainerName?sessions[0].trainerName+"'s Sessions":'Sessions')}</h3></div>
    <div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Time</th><th>Trainer</th><th>Member</th><th>Type</th><th>Status</th><th>Created / Edited By</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>`;
}
function confirmCompleteSession(id){
  const s=Sessions.one(id);
  if(!s)return;
  if(currentUser.role==='trainer'&&s.trainerId!==currentUser.id){toast('You can only update your own sessions.','error');return;}
  const detail=`<div style="margin-top:12px;background:rgba(127,250,136,.06);border:1px solid rgba(127,250,136,.2);border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.9">
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Member:</span> <strong style="color:var(--white)">${esc(s.memberName||'—')}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Type:</span> <strong style="color:var(--white)">${esc(s.type||'—')}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Date:</span> <strong style="color:var(--white)">${formatDate(s.date)}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Time:</span> <strong style="color:var(--white)">${esc(s.start)} – ${esc(s.end)}</strong></div>
  </div>`;
  openConfirm('✓ Mark Session as Completed',
    `Are you sure you want to mark this session as <strong style="color:#7ffa88">Completed</strong>?${detail}`,
    ()=>{ markSessionDone(id); },
    'Mark as Completed','btn-primary');
}

function confirmCancelSession(id){
  const s=Sessions.one(id);
  if(!s)return;
  if(currentUser.role==='trainer'&&s.trainerId!==currentUser.id){toast('You can only update your own sessions.','error');return;}
  const detail=`<div style="margin-top:12px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.9">
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Member:</span> <strong style="color:var(--white)">${esc(s.memberName||'—')}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Type:</span> <strong style="color:var(--white)">${esc(s.type||'—')}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Date:</span> <strong style="color:var(--white)">${formatDate(s.date)}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Time:</span> <strong style="color:var(--white)">${esc(s.start)} – ${esc(s.end)}</strong></div>
  </div>`;
  openConfirm('✕ Cancel Session',
    `Are you sure you want to <strong style="color:#ef4444">Cancel</strong> this session?${detail}`,
    ()=>{
      const sessions=Sessions.all();
      const idx=sessions.findIndex(x=>x.id===id);
      if(idx<0)return;
      const prev=sessions[idx].status;
      sessions[idx].status='Cancelled';
      if(!sessions[idx].statusLog)sessions[idx].statusLog=[];
      sessions[idx].statusLog.push({from:prev,to:'Cancelled',by:currentUser.name,byUsername:currentUser.username,byRole:currentUser.role,at:new Date().toISOString()});
      Sessions.save(sessions);
      logActivity('Status Changed','Session',(sessions[idx].memberName||'?')+' with '+(sessions[idx].trainerName||'?'),'Date: '+sessions[idx].date+' | '+sessions[idx].start+'–'+sessions[idx].end+' | '+prev+' → Cancelled');
      toast('Session cancelled.','info');
      renderSchedule();
    },
    'Yes, Cancel Session','btn-danger');
}

function markSessionDone(id){
  const sessions=Sessions.all();
  const idx=sessions.findIndex(s=>s.id===id);
  if(idx<0)return;
  if(sessions[idx].trainerId!==currentUser.id){toast('You can only mark your own sessions as done.','error');return;}
  const prevStatus=sessions[idx].status;
  sessions[idx].status='Completed';
  sessions[idx].completedAt=today();
  sessions[idx].completedBy=currentUser.username;
  if(!sessions[idx].statusLog)sessions[idx].statusLog=[];
  sessions[idx].statusLog.push({
    from:prevStatus,to:'Completed',
    by:currentUser.name,byUsername:currentUser.username,byRole:currentUser.role,
    at:new Date().toISOString()
  });
  Sessions.save(sessions);
  toast('Session marked as completed. Great work!','success');
  renderSchedule();
}
function getMondayOf(dateStr){const d=new Date(dateStr);const day=d.getDay();const diff=d.getDate()-day+(day===0?-6:1);return new Date(d.setDate(diff)).toISOString().split('T')[0];}
function buildTimeOptions(){
  const opts=[];for(let h=5;h<=22;h++)for(let m of[0,30]){const hh=h.toString().padStart(2,'0');const mm=m.toString().padStart(2,'0');opts.push(`<option value="${hh}:${mm}">${hh}:${mm}</option>`);}
  return opts.join('');
}
let editingSessionId=null;
function filterSessionTrainer(val){
  const list=document.getElementById('sf_trainerList');
  document.getElementById('sf_trainer').value='';
  updateSessionTypesByTrainer();
  const trainers=Users.all().filter(u=>u.role==='trainer'&&u.status!=='locked');
  const matches=val?trainers.filter(u=>u.name.toLowerCase().includes(val.toLowerCase())||(u.coachName||'').toLowerCase().includes(val.toLowerCase())):trainers;
  if(!matches.length){list.innerHTML='<div style="padding:10px 14px;color:var(--gray-500);font-size:13px">No trainers found</div>';list.style.display='block';return;}
  list.innerHTML='';
  matches.forEach(function(u){
    const specs=Array.isArray(u.specializations)&&u.specializations.length?u.specializations.slice(0,2).map(esc).join(', ')+(u.specializations.length>2?' +more':''):'';
    const div=document.createElement('div');
    div.style.cssText='padding:9px 12px;font-size:13px;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;display:flex;flex-direction:column;gap:2px';
    div.innerHTML=`<span style="font-weight:600;color:var(--white)">${esc(u.name)}${u.coachName&&u.coachName!==u.name?' <span style="font-size:11px;color:var(--gray-500)">(${esc(u.coachName)})</span>':''}</span>${specs?`<span style="font-size:10px;color:var(--orange)">${specs}</span>`:''}`;
    div.addEventListener('mousedown',function(){selectSessTrainer(u.id,u.coachName||u.name);});
    div.addEventListener('mouseover',function(){this.style.background='rgba(179,188,181,.1)';});
    div.addEventListener('mouseout',function(){this.style.background='';});
    list.appendChild(div);
  });
  list.style.display='block';
}
function selectSessTrainer(id,name){
  document.getElementById('sf_trainerSearch').value=name;
  document.getElementById('sf_trainer').value=id;
  document.getElementById('sf_trainerList').style.display='none';
  updateSessionTypesByTrainer();
}
// Close trainer list on outside click
document.addEventListener('click',function(e){
  const wrap=document.getElementById('sf_trainerSearch');
  const list=document.getElementById('sf_trainerList');
  if(wrap&&list&&!wrap.contains(e.target)&&!list.contains(e.target))list.style.display='none';
});
function updateSessionTypesByTrainer(){
  const trainerId=document.getElementById('sf_trainer').value;
  const trainer=Users.all().find(u=>u.id===trainerId);
  const specs=Array.isArray(trainer&&trainer.specializations)&&trainer.specializations.length?trainer.specializations:['Personal Training','Cardio','Strength Training','Flexibility','Assessment'];
  const typeMap={'Personal Training':'Personal Training','Strength Training':'Strength Training','Cardio':'Cardio','Yoga':'Yoga','Zumba':'Zumba','HIIT':'HIIT','Flexibility':'Flexibility','CrossFit':'CrossFit','Body Building':'Body Building','Muay Thai':'Muay Thai','Boxing':'Boxing','Pilates':'Pilates'};
  const types=specs.map(s=>typeMap[s]||s);
  if(!types.includes('Assessment'))types.push('Assessment');
  const sel=document.getElementById('sf_type');
  const prev=sel.value;
  sel.innerHTML=`<option value="">Select type</option>`+types.map(t=>`<option value="${t}">${t}</option>`).join('');
  if(prev&&types.includes(prev))sel.value=prev;
}
function openSessionModal(){
  if(currentUser.role!=='staff'&&currentUser.role!=='admin'){toast('Only staff can create sessions.','error');return;}
  editingSessionId=null;
  document.getElementById('sessionModalTitle').textContent='Create Session';
  document.getElementById('sessionFormError').style.display='none';
  document.getElementById('sf_trainerSearch').value='';
  document.getElementById('sf_trainer').value='';
  document.getElementById('sf_trainerList').style.display='none';
  updateSessionTypesByTrainer();
  document.getElementById('sf_memberSearch').value='';document.getElementById('sf_memberId').value='';document.getElementById('sf_memberList').style.display='none';
  document.getElementById('sf_type').value='';document.getElementById('sf_date').value=today();
  const timeOpts=buildTimeOptions();
  document.getElementById('sf_start').innerHTML=timeOpts;document.getElementById('sf_end').innerHTML=timeOpts;
  document.getElementById('sf_start').value='08:00';document.getElementById('sf_end').value='09:00';
  document.getElementById('sf_notes').value='';
  openModal('sessionModal');
}
function editSession(id){
  const s=Sessions.one(id);if(!s)return;
  if(currentUser.role!=='staff'&&currentUser.role!=='admin'){toast('Only staff can edit sessions.','error');return;}
  editingSessionId=id;
  document.getElementById('sessionModalTitle').textContent='Edit Session';
  document.getElementById('sessionFormError').style.display='none';
  const trainers=Users.all().filter(u=>u.role==='trainer');
  const trainerObj=trainers.find(u=>u.id===s.trainerId);
  document.getElementById('sf_trainerSearch').value=trainerObj?(trainerObj.coachName||trainerObj.name):'';
  document.getElementById('sf_trainer').value=s.trainerId;
  document.getElementById('sf_trainerList').style.display='none';
  updateSessionTypesByTrainer();
  document.getElementById('sf_memberSearch').value=s.memberName||'';document.getElementById('sf_memberId').value=s.memberId||'';
  document.getElementById('sf_type').value=s.type;document.getElementById('sf_date').value=s.date;
  const timeOpts=buildTimeOptions();
  document.getElementById('sf_start').innerHTML=timeOpts;document.getElementById('sf_end').innerHTML=timeOpts;
  document.getElementById('sf_start').value=s.start;document.getElementById('sf_end').value=s.end;
  document.getElementById('sf_notes').value=s.notes||'';
  openModal('sessionModal');
}
function filterSessionMember(val){
  const list=document.getElementById('sf_memberList');
  if(!val){list.style.display='none';return;}
  const members=Members.all().filter(m=>m.status!=='Archived'&&m.name.toLowerCase().includes(val.toLowerCase())).slice(0,8);
  if(!members.length){list.style.display='none';return;}
  list.innerHTML='';
  members.forEach(function(m){
    const isExpired=m.status==='Expired';
    const div=document.createElement('div');
    div.style.cssText='padding:8px 12px;font-size:13px;border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;justify-content:space-between;'+(isExpired?'cursor:not-allowed;opacity:0.5;':'cursor:pointer;');
    div.innerHTML=esc(m.name)+(isExpired?'<span style="font-size:10px;font-weight:800;color:#ef4444;background:rgba(239,68,68,.12);padding:2px 7px;border-radius:4px;letter-spacing:.5px;margin-left:8px;">EXPIRED</span>':'');
    if(!isExpired){
      div.addEventListener('mousedown',function(){selectSessMember(m.id,m.name);});
      div.addEventListener('mouseover',function(){this.style.background='rgba(179,188,181,.1)';});
      div.addEventListener('mouseout',function(){this.style.background='';});
    }
    list.appendChild(div);
  });
  list.style.display='block';
}
function selectSessMember(id,name){
  document.getElementById('sf_memberSearch').value=name;
  document.getElementById('sf_memberId').value=id;
  document.getElementById('sf_memberList').style.display='none';
}
function saveSession(){
  const trainerId=document.getElementById('sf_trainer').value;
  const memberId=document.getElementById('sf_memberId').value;
  const type=document.getElementById('sf_type').value;
  const date=document.getElementById('sf_date').value;
  const start=document.getElementById('sf_start').value;
  const end=document.getElementById('sf_end').value;
  const err=document.getElementById('sessionFormError');
  err.style.display='none';
  if(!trainerId||!memberId||!type||!date||!start||!end){err.textContent='Please fill in all required fields.';err.style.display='block';return;}
  const memberCheck=Members.one(memberId);
  if(memberCheck&&memberCheck.status==='Expired'){err.textContent='Cannot schedule a session for '+memberCheck.name+'. Their membership has expired. Please renew their membership first.';err.style.display='block';return;}
  if(end<=start){err.textContent='Invalid time range. The end time must be after the start time.';err.style.display='block';return;}
  const sessions=Sessions.all();
  // Conflict: same trainer, same date, overlapping time
  const trainerConflict=sessions.filter(s=>s.trainerId===trainerId&&s.date===date&&s.status!=='Cancelled'&&s.id!==editingSessionId).find(s=>start<s.end&&end>s.start);
  if(trainerConflict){err.textContent=`Schedule Conflict: This trainer already has a session from ${trainerConflict.start}–${trainerConflict.end} on this date. Please choose a different time.`;err.style.display='block';return;}
  // Conflict: same member assigned to another session at same time
  const memberConflict=sessions.filter(s=>s.memberId===memberId&&s.date===date&&s.status!=='Cancelled'&&s.id!==editingSessionId).find(s=>start<s.end&&end>s.start);
  if(memberConflict){err.textContent=`Schedule Conflict: This member already has a session from ${memberConflict.start}–${memberConflict.end} on this date.`;err.style.display='block';return;}
  if(sessions.filter(s=>s.trainerId===trainerId&&s.date===date&&s.status!=='Cancelled').length>=8){err.textContent='Trainer not available for the selected day.';err.style.display='block';return;}
  const trainer=Users.all().find(u=>u.id===trainerId);
  const member=Members.one(memberId);
  const data={trainerId,trainerName:trainer?trainer.name:'Unknown',memberId,memberName:member?member.name:'Unknown',type,date,start,end,notes:sanitizeText(document.getElementById('sf_notes').value.trim()),status:'Scheduled'};
  if(editingSessionId){
    const idx=sessions.findIndex(s=>s.id===editingSessionId);
    if(idx>-1)sessions[idx]={...sessions[idx],...data,editedBy:currentUser.name,editedByUsername:currentUser.username,editedByRole:currentUser.role,editedAt:today()};
    Sessions.save(sessions);logActivity('Edited','Session',data.memberName+' with '+data.trainerName,'Date: '+data.date+' | '+data.start+'–'+data.end+' | Type: '+data.type);toast('Session updated.');
  } else {
    sessions.push({id:uid(),...data,createdBy:currentUser.name,createdByUsername:currentUser.username,createdByRole:currentUser.role,createdAt:today()});Sessions.save(sessions);logActivity('Added','Session',data.memberName+' with '+data.trainerName,'Date: '+data.date+' | '+data.start+'–'+data.end+' | Type: '+data.type);toast('Session Scheduled Successfully.');
  }
  closeModal('sessionModal');renderSchedule();if(currentUser.role==='admin'||currentUser.role==='staff'){renderDashboard();}
}
function toggleSessionStatus(id){
  const sessions=Sessions.all();const idx=sessions.findIndex(s=>s.id===id);
  if(idx<0)return;
  const s=sessions[idx];
  const cycle={Scheduled:'Completed',Completed:'Cancelled',Cancelled:'Scheduled'};
  const newStatus=cycle[s.status]||'Scheduled';
  sessions[idx].status=newStatus;
  if(!sessions[idx].statusLog)sessions[idx].statusLog=[];
  sessions[idx].statusLog.push({
    from:s.status,to:newStatus,
    by:currentUser.name,byUsername:currentUser.username,byRole:currentUser.role,
    at:new Date().toISOString()
  });
  Sessions.save(sessions);logActivity('Status Changed','Session',(s.memberName||'Unknown')+' with '+(s.trainerName||'Unknown'),'Date: '+s.date+' | '+s.start+'–'+s.end+' | '+s.status+' → '+newStatus);toast(`Session marked as ${newStatus}.`,'info');renderSchedule();
}
function deleteSession(id){
  const s=Sessions.all().find(x=>x.id===id);
  const detail=s?`<div style="margin-top:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.8">
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Member:</span> <strong style="color:var(--white)">${esc(s.memberName||'—')}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Trainer:</span> <strong style="color:var(--white)">${esc(s.trainerName||'—')}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Date:</span> <strong style="color:var(--white)">${formatDate(s.date)}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Time:</span> <strong style="color:var(--white)">${esc(s.start)}–${esc(s.end)}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Type:</span> <strong style="color:var(--white)">${esc(s.type||'—')}</strong></div>
  </div>`:'';
  openConfirm('Delete Session',`Are you sure you want to delete this session? This cannot be undone.${detail}`,()=>{
    const dS=Sessions.all().find(x=>x.id===id);if(dS)logActivity('Deleted','Session',(dS.memberName||'?')+' with '+(dS.trainerName||'?'),'Date: '+dS.date+' | '+dS.start+'–'+dS.end+' | Type: '+(dS.type||'?'));const sessions=Sessions.all().filter(x=>x.id!==id);Sessions.save(sessions);toast('Session deleted.');renderSchedule();
  });
}

// ======================================================================
// PANEL: NOTIFICATIONS
// ======================================================================
let dismissedNotifs=false;
let _dismissedIds=new Set();
let _notifFilter='All';
function dismissRenewal(memberId){
  _dismissedIds.add(memberId);
  renderNotifications();
  scanRenewals();
}
function dismissAllRenewals(){
  const allExpiring=Members.all().filter(m=>{
    if(m.status==='Archived')return false;
    const d=daysUntil(m.expiryDate);
    return d<=7;
  });
  const pending=allExpiring.filter(m=>!_dismissedIds.has(m.id));
  if(!pending.length){toast('No renewal reminders to dismiss.','error');return;}
  openConfirm('Dismiss All Renewal Reminders',
    `Dismiss all <strong>${pending.length}</strong> renewal reminder${pending.length!==1?'s':''}?<br><span style="font-size:12px;color:var(--gray-500)">This hides expired, urgent and upcoming reminders for now — they will reappear after the page reloads.</span>`,
    ()=>{pending.forEach(m=>_dismissedIds.add(m.id));renderNotifications();scanRenewals();},
    'Dismiss All');
}
function confirmRenew(memberId){
  const m=Members.one(memberId);
  if(!m)return;
  const pl=m.planId?Plans.one(m.planId):null;
  const price=pl?Number(pl.price):0;
  openConfirm('🔄 Renew Membership',
    `Renew <strong>${esc(m.name)}</strong>'s <strong>${esc(pl?pl.name:'—')}</strong> plan for <strong>₱${price.toLocaleString()}</strong>?<br><span style="font-size:12px;color:var(--gray-500)">You'll confirm the payment details next.</span>`,
    ()=>{openPaymentForMember(memberId);},
    'Continue','btn-primary');
}
function renderNotifications(){
  const el=document.getElementById('panelNotifications');
  const allExpiring=Members.all().filter(m=>{
    if(m.status==='Archived')return false;
    const d=daysUntil(m.expiryDate);
    return d<=7;
  });
  const members=allExpiring.filter(m=>!_dismissedIds.has(m.id));
  const plans=Plans.all();
  const bucketOf=m=>{const d=daysUntil(m.expiryDate);return d<0?'expired':(d<=2?'urgent':'upcoming');};
  const buckets={expired:[],urgent:[],upcoming:[]};
  members.forEach(m=>buckets[bucketOf(m)].push(m));
  ['expired','urgent','upcoming'].forEach(k=>buckets[k].sort((a,b)=>daysUntil(a.expiryDate)-daysUntil(b.expiryDate)));
  const visible=_notifFilter==='All'?[...buckets.expired,...buckets.urgent,...buckets.upcoming]:(buckets[_notifFilter]||[]);
  const now=new Date();
  const monthPays=Payments.all().filter(p=>{const d=new Date(p.date);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();});
  const monthRev=monthPays.reduce((a,p)=>a+Number(p.amount),0);
  const items=visible.map(m=>{
    const d=daysUntil(m.expiryDate);const pl=plans.find(p=>p.id===m.planId);
    const bucket=bucketOf(m);
    const avatarColor=bucket==='expired'?'#991b1b':bucket==='urgent'?'var(--orange)':'var(--gold)';
    const dayLabel=bucket==='expired'?`Expired ${Math.abs(d)} day${Math.abs(d)!==1?'s':''} ago`:`${d} day${d!==1?'s':''} left`;
    const badgeCls=bucket==='expired'?'badge-expired':bucket==='urgent'?'badge-urgent':'badge-expiring';
    const cls=bucket==='expired'?'expired':bucket==='urgent'?'urgent':'warning';
    const dayColor=d<0?'var(--red)':d<=2?'var(--orange)':'var(--gold)';
    return`<div class="notif-item ${cls}" style="display:flex;align-items:center;gap:12px;transition:.15s" onmouseover="this.style.background='rgba(255,255,255,.035)'" onmouseout="this.style.background=''">
      <div class="user-avatar" style="width:36px;height:36px;font-size:12px;background:${avatarColor};flex-shrink:0">${esc(initials(m.name))}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span class="notif-name">${esc(m.name)}</span>
          <span class="badge ${badgeCls}" style="font-size:8px">${esc(pl?pl.name:'—')}</span>
        </div>
        <div style="font-size:11px;color:var(--gray-500);margin-top:2px">Expires ${formatDate(m.expiryDate)} <span style="color:${dayColor};font-weight:700">· ${dayLabel}</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <button class="btn-primary btn-sm" onclick="confirmRenew('${m.id}')" style="font-size:11px;padding:7px 14px;width:auto">Renew →</button>
        <button title="Dismiss this reminder for now — it returns after the page reloads" onclick="dismissRenewal('${m.id}')" style="flex-shrink:0;background:transparent;border:1px solid rgba(255,255,255,.1);color:var(--gray-500);width:28px;height:28px;border-radius:7px;cursor:pointer;font-size:12px;font-weight:700;transition:.15s;display:inline-flex;align-items:center;justify-content:center" onmouseover="this.style.background='rgba(239,68,68,.12)';this.style.color='var(--red)';this.style.borderColor='rgba(239,68,68,.35)'" onmouseout="this.style.background='transparent';this.style.color='var(--gray-500)';this.style.borderColor='rgba(255,255,255,.1)'"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    </div>`;}).join('');
  const tab=(label,key,cnt)=>`<button class="filter-chip${_notifFilter===key?' active':''}" onclick="_notifFilter='${key}';renderNotifications()">${label} <span style="opacity:.7">(${cnt})</span></button>`;
  el.innerHTML=`
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
    <div>
      <div class="section-title" style="margin-bottom:4px">Member Renewals <span class="badge badge-expired" style="margin-left:6px">${members.length}</span></div>
      <div style="font-size:12px;color:var(--gray-500)">${buckets.expired.length} expired &nbsp;·&nbsp; ${buckets.urgent.length} urgent &nbsp;·&nbsp; ${buckets.upcoming.length} upcoming</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn-primary btn-sm" onclick="showRenewedPage()" style="width:auto">🔄 Recently Renewed</button>
      <button class="btn-secondary btn-sm" onclick="dismissAllRenewals()">Dismiss All</button>
    </div>
  </div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
    ${tab('All','All',members.length)}
    ${tab('Expired','expired',buckets.expired.length)}
    ${tab('Urgent','urgent',buckets.urgent.length)}
    ${tab('Upcoming','upcoming',buckets.upcoming.length)}
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
    <div class="renew-mini-stat">🔄 ${monthPays.length} renewals this month</div>
    <div class="renew-mini-stat">💰 ₱${monthRev.toLocaleString()} collected</div>
  </div>
  ${visible.length?`<div class="notif-list">${items}</div>`:`<div class="table-card"><div class="empty-state"><div class="empty-icon">✅</div><p>${_notifFilter==='All'?'All members have been attended to.':'No members in this category right now.'}</p></div></div>`}`;
}

// ======================================================================
// SUB-PAGE: RECENTLY RENEWED (opened from Member Renewals button)
// ======================================================================
function showRenewedPage(){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  const pe=document.getElementById('panelRenewed');
  if(pe)pe.classList.add('active');
  document.getElementById('pageTitle').textContent='Recently Renewed';
  _lastPanel='renewed';
  renderPanel('renewed');
}
function backToRenewals(){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  const pe=document.getElementById('panelNotifications');
  if(pe)pe.classList.add('active');
  document.getElementById('pageTitle').textContent='Member Renewals';
  _lastPanel='notifications';
  renderNotifications();
}
let _renewedFilter='All';
function renderRenewed(){
  const el=document.getElementById('panelRenewed');
  if(!el)return;
  const list=Payments.all().slice().reverse();
  const allExpiring=Members.all().filter(m=>{
    if(m.status==='Archived')return false;
    return daysUntil(m.expiryDate)<=7;
  });
  const bucketOf=m=>{const d=daysUntil(m.expiryDate);return d<0?'expired':(d<=2?'urgent':'upcoming');};
  const buckets={expired:[],urgent:[],upcoming:[]};
  allExpiring.forEach(m=>buckets[bucketOf(m)].push(m));
  const now=new Date();
  const monthPays=Payments.all().filter(p=>{const d=new Date(p.date);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();});
  const monthRev=monthPays.reduce((a,p)=>a+Number(p.amount),0);
  const memberBucket={};allExpiring.forEach(m=>memberBucket[m.id]=bucketOf(m));
  const filtered=_renewedFilter==='All'?list:list.filter(p=>memberBucket[p.memberId]===_renewedFilter);
  const tab=(label,key,cnt)=>`<button class="filter-chip${_renewedFilter===key?' active':''}" onclick="_renewedFilter='${key}';renderRenewed()">${label} <span style="opacity:.7">(${cnt})</span></button>`;
  el.innerHTML=`
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
    <div>
      <div class="section-title" style="margin-bottom:4px">Recently Renewed <span class="badge badge-active" style="margin-left:6px">${list.length}</span></div>
      <div style="font-size:12px;color:var(--gray-500)">All recorded membership renewals and payments, newest first.</div>
    </div>
    <button class="btn-secondary btn-sm" onclick="backToRenewals()">← Back to Member Renewals</button>
  </div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">
    ${tab('All','All',allExpiring.length)}
    ${tab('Expired','expired',buckets.expired.length)}
    ${tab('Urgent','urgent',buckets.urgent.length)}
    ${tab('Upcoming','upcoming',buckets.upcoming.length)}
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
    <div class="renew-mini-stat">🔄 ${monthPays.length} renewals this month</div>
    <div class="renew-mini-stat">💰 ₱${monthRev.toLocaleString()} collected</div>
  </div>
  <div class="table-card">
    <div class="table-header"><h3>Renewal Records</h3></div>
    ${filtered.length?`<div style="overflow-x:auto"><table><thead><tr><th>Member</th><th>Plan</th><th>Amount</th><th>Date</th></tr></thead><tbody>
    ${filtered.map(p=>`<tr><td>${esc(p.memberName)}</td><td>${esc(p.planName)}</td><td>₱${Number(p.amount).toLocaleString()}</td><td>${formatDate(p.date)}</td></tr>`).join('')}
    </tbody></table></div>`:`<div class="empty-state"><div class="empty-icon">🔄</div><p>No renewals in this category right now.</p></div>`}
  </div>`;
}

// ======================================================================
// MEMBER MESSAGES (in-system front desk chat)
// ======================================================================
let _msgThreadId=null,_msgStaffMode=false;
function updateMessageBadge(){
  const n=Messages.all().filter(m=>m.direction==='in'&&!m.read).length;
  const b=document.getElementById('msgBadge');
  if(b){b.style.display=n?'flex':'none';b.textContent=n;}
  if(typeof updateMyBadges==='function')updateMyBadges();
}
function openMemberMessageModal(){
  const mem=Members.one(currentUser.memberId||currentUser.id);
  if(!mem)return;
  _msgThreadId=mem.id;_msgStaffMode=false;
  document.getElementById('messageModalTitle').textContent='Message the Gym';
  document.getElementById('msgInput').placeholder='Type your message…';
  renderMsgThread();
  openModal('messageModal');
}
function openMsgThread(memberId){
  _msgThreadId=memberId;_msgStaffMode=true;
  const mem=Members.one(memberId);
  document.getElementById('messageModalTitle').textContent=mem?'Message — '+mem.name:'Message';
  document.getElementById('msgInput').placeholder='Reply to '+(mem?mem.name:'member')+'…';
  const all=Messages.all();
  let changed=false;
  all.forEach(m=>{if(m.memberId===memberId&&m.direction==='in'&&!m.read){m.read=true;changed=true;}});
  if(changed)Messages.save(all);
  renderMsgThread();updateMessageBadge();
  openModal('messageModal');
}
function renderMsgThread(){
  const msgs=Messages.all().filter(m=>m.memberId===_msgThreadId).sort((a,b)=>a.ts-b.ts);
  const body=document.getElementById('messageModalBody');
  if(!body)return;
  body.innerHTML=msgs.length?msgs.map(m=>{
    // Messenger layout: the viewer's OWN messages sit on the RIGHT (green),
    // the other party's on the LEFT (dark) — in both the member view and the
    // front-desk view.
    const own=_msgStaffMode?m.direction==='out':m.direction==='in';
    const who=m.direction==='in'?(m.memberName||'Member'):'Front Desk';
    return `
    <div class="msg-row${own?' own':' other'}">
      <div class="msg-bubble">
        <div class="msg-meta">${esc(who)} · ${formatDate(m.date)} ${esc(m.time||'')}</div>
        ${esc(m.text)}
      </div>${_msgStaffMode?`<button class="msg-del" title="Delete message" onclick="deleteMsg('${m.id}')">&#10005;</button>`:''}
    </div>`;}).join(''):`<div class="empty-state" style="padding:30px"><div class="empty-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><p>No messages yet</p><p class="empty-sub" style="font-size:12px;color:var(--gray-500)">${_msgStaffMode?'This member has not sent any messages.':'Send a message and the front desk will reply here.'}</p></div>`;
  body.scrollTop=body.scrollHeight;
}
function sendMessage(){
  const input=document.getElementById('msgInput');
  const text=(input.value||'').trim();
  if(!text)return;
  const mem=Members.one(_msgThreadId);
  Messages.add({id:'MSG'+uid(),memberId:_msgThreadId,memberName:mem?mem.name:'Member',text,time:new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}),date:today(),ts:Date.now(),direction:_msgStaffMode?'out':'in',read:_msgStaffMode});
  if(!_msgStaffMode)logActivity('Message','Member',mem?mem.name:'Member',text);
  input.value='';
  renderMsgThread();updateMessageBadge();
  if(_msgStaffMode&&document.getElementById('panelMessages'))renderMessages();
  toast('Message sent.');
}

// ======================================================================
// MEMBER PAGES: MESSAGE THE GYM + NOTIFICATIONS (full-page Messenger)
// ======================================================================
function myUnreadReplies(){
  if(!currentUser||currentUser.role!=='member')return 0;
  const mid=currentUser.memberId||currentUser.id;
  return Messages.all().filter(m=>m.memberId===mid&&m.direction==='out'&&!m.readByMember).length;
}
function updateMyBadges(){
  if(!currentUser||currentUser.role!=='member')return;
  const replies=myUnreadReplies();
  const mb=document.getElementById('myMsgBadge');
  if(mb){mb.style.display=replies?'flex':'none';mb.textContent=replies;}
}
function myMsgBubble(m){
  const own=m.direction==='in';
  const who=m.direction==='in'?(m.memberName||'Member'):'Front Desk';
  return `
  <div class="msg-row${own?' own':' other'}">
    <div class="msg-bubble">
      <div class="msg-meta">${esc(who)} · ${formatDate(m.date)} ${esc(m.time||'')}</div>
      ${esc(m.text)}
    </div>${own?`<button class="msg-del" title="Delete message" onclick="deleteMsg('${m.id}')">&#10005;</button>`:''}
  </div>`;
}
// Delete a chat message. Members may only delete their own; admin/staff may
// moderate (delete any) from the front-desk thread view.
function deleteMsg(id){
  const msg=Messages.one(id);
  if(!msg)return;
  const memberOwnsIt=currentUser&&currentUser.role==='member'&&msg.direction==='in'&&msg.memberId===(currentUser.memberId||currentUser.id);
  const staffAllowed=currentUser&&(currentUser.role==='admin'||currentUser.role==='staff');
  if(!memberOwnsIt&&!staffAllowed){toast('You can only delete your own messages.','error');return;}
  openConfirm('Delete Message','Delete this message? This cannot be undone.',function(){
    Messages.remove(id);
    const pg=document.getElementById('panelMyMessages');
    if(pg&&pg.classList.contains('active'))renderMyMessages();
    if(_msgThreadId){renderMsgThread();if(typeof renderMessages==='function'&&document.getElementById('panelMessages'))renderMessages();}
    updateMessageBadge();
    toast('Message deleted.');
  },'Delete','btn-danger');
}
function renderMyMessages(){
  const el=document.getElementById('panelMyMessages');
  if(!el)return;
  const mid=currentUser.memberId||currentUser.id;
  const mem=Members.one(mid);
  const all=Messages.all();
  let changed=false;
  all.forEach(m=>{if(m.memberId===mid&&m.direction==='out'&&!m.readByMember){m.readByMember=true;changed=true;}});
  if(changed)Messages.save(all);
  const msgs=all.filter(m=>m.memberId===mid).sort((a,b)=>a.ts-b.ts);
  el.innerHTML=`
  <div class="mychat">
    <div class="mychat-head">
      <div class="mychat-avatar"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg></div>
      <div class="mychat-id">
        <div class="mychat-name">Front Desk <span class="online-dot" title="Online"></span></div>
        <div class="mychat-sub">FitCore Gym${mem?' · '+esc(mem.name):''} — replies appear here instantly</div>
      </div>
    </div>
    <div class="mychat-thread" id="myChatThread">
      ${msgs.length?msgs.map(myMsgBubble).join(''):`<div class="empty-state" style="padding:40px 20px"><div class="empty-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><p>No messages yet</p><p class="empty-sub" style="font-size:12px;color:var(--gray-500)">Send a message below and the front desk will reply here.</p></div>`}
    </div>
    <div class="mychat-inputrow">
      <input id="myMsgInput" placeholder="Type your message…" maxlength="500" onkeydown="if(event.key==='Enter')sendMyMessage()">
      <button class="btn-primary" onclick="sendMyMessage()">Send</button>
    </div>
  </div>`;
  const t=document.getElementById('myChatThread');
  if(t)t.scrollTop=t.scrollHeight;
  updateMyBadges();
}
function sendMyMessage(){
  const input=document.getElementById('myMsgInput');
  const text=(input?input.value:'').trim();
  if(!text)return;
  const mid=currentUser.memberId||currentUser.id;
  const mem=Members.one(mid);
  Messages.add({id:'MSG'+uid(),memberId:mid,memberName:mem?mem.name:'Member',text,time:new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}),date:today(),ts:Date.now(),direction:'in',read:false});
  logActivity('Message','Member',mem?mem.name:'Member',text);
  if(input)input.value='';
  renderMyMessages();
  toast('Message sent.');
}
function renderMessages(){
  const el=document.getElementById('panelMessages');
  const all=Messages.all().slice().reverse();
  const threads=[];
  all.forEach(m=>{
    let t=threads.find(x=>x.memberId===m.memberId);
    if(!t){t={memberId:m.memberId,memberName:m.memberName,unread:0,last:m};threads.push(t);}
    t.last=m;if(m.direction==='in'&&!m.read)t.unread++;
  });
  el.innerHTML=`
  <div class="table-card">
    <div class="table-header"><h3>Member Messages <span style="font-size:12px;font-weight:400;color:var(--gray-500);margin-left:6px">${threads.length} conversation(s)</span></h3></div>
    ${threads.length?threads.map(t=>`<div style="display:flex;align-items:center;gap:12px;padding:13px 18px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer;transition:.15s" onmouseover="this.style.background='rgba(255,255,255,.04)'" onmouseout="this.style.background=''" onclick="openMsgThread('${t.memberId}')">
      <div class="user-avatar" style="width:38px;height:38px;font-size:12px;background:linear-gradient(135deg,var(--orange),var(--orange-dark));flex-shrink:0">${esc(initials(t.memberName))}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-weight:800;color:var(--white);font-size:14px">${esc(t.memberName)}</span>
          ${t.unread?`<span class="nav-badge" style="display:flex;position:static">${t.unread}</span>`:''}
        </div>
        <div style="font-size:12px;color:var(--gray-500);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.last.text)}</div>
      </div>
      <span style="font-size:11px;color:var(--gray-500);flex-shrink:0">${formatDate(t.last.date)} ${esc(t.last.time||'')}</span>
    </div>`).join(''):`<div class="empty-state"><div class="empty-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><p>No messages yet</p><p class="empty-sub">Member questions from the "Need Help?" section will appear here.</p></div>`}
  </div>`;
}
//
// Export/Import Messages functions
//
function exportMessages(){
  const msgs=Messages.all();
  const data=JSON.stringify(msgs);
  const blob=new Blob([data],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download='messages-backup.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Messages exported.');
}
function importMessages(){
  const input=document.createElement('input');
  input.type='file';
  input.accept='application/json';
  input.onchange=e=>{
    const file=e.target.files[0];
    const reader=new FileReader();
    reader.onload=f=>{
      try{
        const msgs=JSON.parse(reader.result);
        if(msgs&&Array.isArray(msgs)&&msgs.length>0){
          if(confirm('This will replace all current messages. Continue?')){
            Messages.save(msgs);
            renderMessages();
            toast('Messages imported.');
          }
        }else{alert('Invalid messages format.');}
      }catch(e){alert('Error reading file.');}
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

// ======================================================================
// PANEL: ANNOUNCEMENTS (gym closures, events, anniversaries)
// ======================================================================
const ANNOUNCE_META={general:{icon:`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h2l3 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M14 8a5 5 0 0 1 0 8"/><path d="M17.5 5.5a9 9 0 0 1 0 13"/></svg>`,label:'General',cls:'badge-active'},event:{icon:`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,label:'Event',cls:'badge-expiring'},holiday:{icon:`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,label:'Holiday / Closed',cls:'badge-expired'},alert:{icon:`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,label:'Alert',cls:'badge-suspended'}};
function renderAnnouncements(){
  const el=document.getElementById('panelAnnouncements');
  const all=Announcements.all().slice().reverse();
  el.innerHTML=`
  <div class="page-actions">
    <div class="table-controls">
      <span style="font-size:11px;color:var(--gray-500)">Post gym closures, events and anniversaries — members see these on their dashboard</span>
    </div>
    <button class="btn-primary" style="display:inline-flex;align-items:center;gap:8px" onclick="openAnnounceModal()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h2l3 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M14 8a5 5 0 0 1 0 8"/><path d="M17.5 5.5a9 9 0 0 1 0 13"/></svg> Post Announcement</button>
  </div>
  <div class="table-card">
    <div class="table-header"><h3>Announcements <span style="font-size:12px;font-weight:400;color:var(--gray-500);margin-left:6px">${all.length} total</span></h3></div>
    ${all.length?all.map(a=>{
      const meta=ANNOUNCE_META[a.type]||ANNOUNCE_META.general;
      return `<div style="display:flex;align-items:flex-start;gap:14px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.06)">
        <div style="font-size:22px;flex-shrink:0">${meta.icon}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-weight:800;color:var(--white);font-size:14px">${esc(a.title)}</span>
            <span class="badge ${meta.cls}">${meta.label}</span>
            ${a.date?`<span style="font-size:11px;color:var(--gray-500)">${formatDate(a.date)}</span>`:''}
          </div>
          <div style="font-size:12.5px;color:var(--gray-500);margin-top:6px;white-space:pre-wrap">${esc(a.text)}</div>
          <div style="font-size:11px;color:var(--gray-600);margin-top:8px">Posted by ${esc(a.createdBy||'Admin')} · ${formatDate(a.createdAt)}</div>
        </div>
        <button class="btn-icon" style="flex-shrink:0" title="Delete announcement" onclick="deleteAnnouncement('${a.id}')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>`;
    }).join(''):`<div class="empty-state"><div class="empty-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2a1 1 0 0 0 1 1h2l3 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M14 8a5 5 0 0 1 0 8"/><path d="M17.5 5.5a9 9 0 0 1 0 13"/></svg></div><p>No announcements yet</p><p class="empty-sub">Post a gym closure, event or anniversary — members will see it on their dashboard.</p></div>`}
  </div>`;
}
function openAnnounceModal(){
  document.getElementById('an_type').value='general';
  document.getElementById('an_date').value=today();
  document.getElementById('an_title').value='';
  document.getElementById('an_text').value='';
  const err=document.getElementById('announceFormError');
  if(err){err.textContent='';err.style.display='none';}
  openModal('announceModal');
}
function saveAnnouncement(){
  const err=document.getElementById('announceFormError');
  const title=document.getElementById('an_title').value.trim();
  const text=document.getElementById('an_text').value.trim();
  if(!title||!text){err.textContent='Please fill in the title and message.';err.style.display='block';return;}
  Announcements.add({id:nextId(KEY.announcements,'ANN'),type:document.getElementById('an_type').value,date:document.getElementById('an_date').value,title:sanitizeText(title),text:sanitizeText(text),createdBy:currentUser.name||'Admin',createdAt:today(),time:new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})});
  logActivity('Posted','Announcement','"'+title+'"');
  closeModal('announceModal');
  renderAnnouncements();
  toast('Announcement posted. Members can see it now.');
}
function deleteAnnouncement(id){
  const a=Announcements.one(id);
  if(!a)return;
  openConfirm('Delete Announcement','Delete "'+a.title+'"? Members will no longer see it.',function(){
    Announcements.remove(id);
    logActivity('Deleted','Announcement','"'+a.title+'"');
    renderAnnouncements();
    toast('Announcement deleted.');
  },'Delete','btn-danger');
}
function announceStripHtml(){
  const all=Announcements.all().slice().reverse().slice(0,4);
  if(!all.length)return'';
  return `<div style="display:grid;gap:10px;margin-bottom:16px">${all.map(a=>{
    const meta=ANNOUNCE_META[a.type]||ANNOUNCE_META.general;
    return `<div style="display:flex;align-items:flex-start;gap:12px;background:linear-gradient(135deg,rgba(127,250,136,.08),rgba(127,250,136,.02));border:1px solid rgba(127,250,136,.25);border-radius:14px;padding:14px 16px">
      <div style="font-size:20px;flex-shrink:0">${meta.icon}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-weight:800;color:var(--white);font-size:13.5px">${esc(a.title)}</span>
          <span class="badge ${meta.cls}" style="font-size:9.5px;padding:2px 8px">${meta.label}</span>
        </div>
        <div style="font-size:12.5px;color:var(--gray-500);margin-top:4px;white-space:pre-wrap">${esc(a.text)}</div>
        ${a.date?`<div style="font-size:11px;color:var(--orange);font-weight:600;margin-top:6px">📅 ${formatDate(a.date)}</div>`:''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

// ======================================================================
// PANEL: PAYMENT QUEUE (pending_payment activation)
// ======================================================================
let _confirmPaymentMemberId=null;
let _queueSearch='',_queuePlanFilter='All';
const _queueSelected=new Set();
function renderQueue(){
  const el=document.getElementById('panelQueue');
  const plans=Plans.all().filter(p=>p.status==='Active');
  let pending=Members.all().filter(m=>m.status==='pending_payment');
  if(_queueSearch){const s=_queueSearch.toLowerCase();pending=pending.filter(m=>m.name.toLowerCase().includes(s)||m.id.toLowerCase().includes(s)||(m.email||'').toLowerCase().includes(s));}
  if(_queuePlanFilter!=='All')pending=pending.filter(m=>m.planId===_queuePlanFilter);
  pending.sort((a,b)=>(a.createdAt||'').localeCompare(b.createdAt||''));
  const total=openPendingNotifs().length;
  const items=pending.map(m=>{
    const plan=m.planId?Plans.one(m.planId):null;
    const ageDays=Math.max(0,Math.floor((Date.now()-new Date(m.createdAt||Date.now()))/86400000));
    const daysLeft=PENDING_ARCHIVE_DAYS-ageDays;
    const urgent=daysLeft<=1;
    const ageColor=ageDays<=2?'var(--green)':(ageDays>=PENDING_ARCHIVE_DAYS-2?'var(--red)':'var(--gold)');
    return`<div class="queue-card${urgent?' urgent':''}">
      <label class="queue-check" title="Select for bulk confirm"><input type="checkbox" onchange="toggleQueueSelect('${m.id}',this.checked)" ${_queueSelected.has(m.id)?'checked':''}></label>
      <div class="queue-main">
        <div class="queue-avatar">${esc(initials(m.name))}</div>
        <div class="queue-info">
          <div class="queue-name">${esc(m.name)}${urgent?'<span class="badge badge-expired" style="margin-left:6px">auto-archive soon</span>':''}</div>
          <div class="queue-meta"><span class="queue-meta-id">${esc(m.id)}</span></div>
          <div class="queue-meta"><span class="queue-ico">${iconSvg('mail',12)}</span><span>${esc(m.email||'no email')}</span></div>
          <div class="queue-meta"><span class="queue-ico">${iconSvg('phone',12)}</span><span>${esc(m.contact||'—')}</span></div>
        </div>
      </div>
      <div class="queue-detail">
        <div class="queue-plan-row"><span class="queue-plan-name">${esc(plan?plan.name:'—')}</span><span class="badge badge-pending">Pending</span></div>
        <div class="queue-price">₱${plan?Number(plan.price).toLocaleString():'0'}</div>
        <div class="queue-date" style="color:${ageColor}">Registered ${formatDate(m.createdAt)} (${ageDays}d ago)</div>
      </div>
      <div class="queue-actions">
        <button class="btn-primary btn-sm" onclick="openConfirmPayment('${m.id}')">💰 Confirm Payment</button>
      </div>
    </div>`;
  }).join('');
  const bulkBtn=_queueSelected.size?`<button class="btn-primary btn-sm" onclick="confirmSelectedPayments()">✓ Confirm Selected (${_queueSelected.size})</button>`:'';
  el.innerHTML=`
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
    <div>
      <div class="section-title" style="margin-bottom:4px">Pending Payments <span class="badge badge-expiring" style="margin-left:6px">${total}</span></div>
      <div style="font-size:12px;color:var(--gray-500)">Members who self-registered and are awaiting counter payment. Unpaid sign-ups are auto-archived after ${PENDING_ARCHIVE_DAYS} days.</div>
    </div>
    ${bulkBtn}
  </div>
  <div class="queue-toolbar">
    <input class="search-input" placeholder="Search by name, ID or email…" value="${esc(_queueSearch)}" oninput="_queueSearch=this.value;renderQueue()">
    <select class="filter-sel" onchange="_queuePlanFilter=this.value;renderQueue()">
      <option value="All">All Plans</option>
      ${plans.map(p=>`<option value="${p.id}" ${p.id===_queuePlanFilter?'selected':''}>${esc(p.name)}</option>`).join('')}
    </select>
  </div>
  ${pending.length?`<div class="queue-list">${items}</div>`:`<div class="table-card"><div class="empty-state"><div class="empty-icon">✅</div><p>All caught up! No pending payments right now.</p></div></div>`}`;
}
function toggleQueueSelect(id,checked){if(checked)_queueSelected.add(id);else _queueSelected.delete(id);renderQueue();}
function confirmSelectedPayments(){
  const ids=[..._queueSelected].filter(id=>Members.one(id));
  if(!ids.length){toast('No members selected.','error');return;}
  const names=ids.map(id=>Members.one(id).name);
  const totalAmt=ids.reduce((s,id)=>{const m=Members.one(id);const p=m.planId?Plans.one(m.planId):null;return s+(p?Number(p.price):0);},0);
  openConfirm(
    `Confirm ${ids.length} payment${ids.length!==1?'s':''}?`,
    `Mark <strong>${esc(names.length>2?names.slice(0,2).join(', ')+' +'+(names.length-2)+' more':names.join(', '))}</strong> as paid (₱${totalAmt.toLocaleString()})?<br><span style="font-size:12px;color:var(--gray-500)">Each member's QR activates immediately.</span>`,
    ()=>{
      ids.forEach(id=>{const m=Members.one(id);const p=m.planId?Plans.one(m.planId):null;applyPaymentConfirmation(id,p?Number(p.price):0,'Cash','');});
      _queueSelected.clear();
      toast(`${ids.length} payment${ids.length!==1?'s':''} confirmed.`);
      updateQueueBadge();
      renderQueue();
      scanRenewals();
    },
    `✓ Confirm (${ids.length})`,
    'btn-primary'
  );
}
function openConfirmPayment(memberId){
  _confirmPaymentMemberId=memberId;
  const m=Members.one(memberId);
  if(!m)return;
  const plan=m.planId?Plans.one(m.planId):null;
  document.getElementById('cpm_memberId').value=memberId;
  document.getElementById('confirmPaymentError').style.display='none';
  document.getElementById('cpm_summary').innerHTML=`
    <div style="display:flex;align-items:center;gap:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.06);margin-bottom:12px">
      <div class="user-avatar" style="width:40px;height:40px;background:rgba(251,191,36,.15);color:var(--gold);flex-shrink:0">${esc(initials(m.name))}</div>
      <div>
        <div style="font-weight:800;color:var(--white);font-size:14px">${esc(m.name)}</div>
        <div style="font-size:11px;font-family:monospace;color:var(--gray-500)">${esc(m.id)} · ${esc(m.email||'no email')}</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px">
      <div style="background:var(--navy-700);border-radius:8px;padding:10px 12px"><div style="font-size:10px;color:var(--gray-500);text-transform:uppercase;letter-spacing:1px">Plan</div><div style="font-weight:700;color:var(--white);margin-top:2px">${esc(plan?plan.name:'—')}</div></div>
      <div style="background:var(--navy-700);border-radius:8px;padding:10px 12px"><div style="font-size:10px;color:var(--gray-500);text-transform:uppercase;letter-spacing:1px">Plan Price</div><div style="font-weight:700;color:var(--green);margin-top:2px">₱${plan?Number(plan.price).toLocaleString():'0'}</div></div>
      <div style="background:var(--navy-700);border-radius:8px;padding:10px 12px"><div style="font-size:10px;color:var(--gray-500);text-transform:uppercase;letter-spacing:1px">Duration</div><div style="font-weight:700;color:var(--white);margin-top:2px">${plan?plan.duration+' month(s)':'-'}</div></div>
      <div style="background:var(--navy-700);border-radius:8px;padding:10px 12px"><div style="font-size:10px;color:var(--gray-500);text-transform:uppercase;letter-spacing:1px">New Expiry</div><div style="font-weight:700;color:var(--white);margin-top:2px">${plan?formatDate(addMonths(today(),plan.duration)):'—'}</div></div>
    </div>`;
  document.getElementById('cpm_amount').value=plan?plan.price:'';
  document.getElementById('cpm_method').value='';
  document.getElementById('cpm_reference').value='';
  toggleCpmReference();
  openModal('confirmPaymentModal');
}
function toggleCpmReference(){
  const method=document.getElementById('cpm_method').value;
  const wrap=document.getElementById('cpm_refWrap');
  if(wrap)wrap.style.display=method==='GCash'?'block':'none';
}
function applyPaymentConfirmation(memberId,amount,method,reference){
  const member=Members.one(memberId);
  if(!member)return null;
  const plan=member.planId?Plans.one(member.planId):null;
  const start=today();
  const newExpiry=addMonths(start,plan?plan.duration:1);
  const now=new Date();
  const newId=nextId(KEY.payments,'PAY');
  const payments=Payments.all();
  payments.push({id:newId,memberId,memberName:member.name,planId:member.planId,planName:plan?plan.name:'Unknown',amount,date:start,newExpiry,method,reference,notes:'',recordedBy:currentUser.name,recordedByUsername:currentUser.username,staffId:currentUser.id,status:'Paid',source:'activation',timestamp:now.getTime(),createdAt:start});
  Payments.save(payments);
  const nonce=newQrNonce(memberId);
  Members.update(memberId,{status:'Active',planStart:start,startDate:start,expiryDate:newExpiry,qrNonce:nonce});
  Members.update(memberId,{qrToken:qrTokenFor(memberId,start)});
  resolveNotifsForMember(memberId);
  _queueSelected.delete(memberId);
  return member;
}
function confirmPayment(){
  const memberId=document.getElementById('cpm_memberId').value;
  const amount=parseFloat(document.getElementById('cpm_amount').value);
  const method=document.getElementById('cpm_method').value;
  const reference=document.getElementById('cpm_reference').value.trim();
  const err=document.getElementById('confirmPaymentError');
  err.style.display='none';
  if(!memberId||!amount||!method){err.textContent='Please fill in all required fields.';err.style.display='block';return;}
  if(amount<=0){err.textContent='Invalid payment amount.';err.style.display='block';return;}
  if(method==='GCash'&&!reference){err.textContent='Please enter the GCash reference number.';err.style.display='block';return;}
  const member=applyPaymentConfirmation(memberId,amount,method,reference);
  if(!member){err.textContent='Member not found.';err.style.display='block';return;}
  closeModal('confirmPaymentModal');
  toast(`Payment confirmed — ${member.name} is now active.`);
  updateQueueBadge();
  renderQueue();
  scanRenewals();
}

// ======================================================================
// PANEL: QR SCANNER (entrance attendance via QR)
// ======================================================================
let _scanStream=null,_scanRaf=null,_scanCanvas=null,_scanCtx=null,_scanning=false,_scanLocked=false;
function renderScanner(){
  const el=document.getElementById('panelScanner');
  el.innerHTML=`
  <div style="display:grid;grid-template-columns:1.15fr 1fr;gap:16px;align-items:start">
    <div class="scan-card">
      <div class="scan-header">
        <div>
          <div class="section-title" style="margin-bottom:4px">Camera Scanner</div>
          <div style="font-size:12px;color:var(--gray-500)">Point the camera at the member's QR code</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn-primary btn-sm" id="scanStartBtn" onclick="startScanner()">▶ Start Camera</button>
          <button class="btn-secondary btn-sm" id="scanStopBtn" style="display:none" onclick="stopScanner()">■ Stop</button>
        </div>
      </div>
      <div class="scan-viewport" id="scanViewport">
        <video id="scanVideo" playsinline muted style="width:100%;height:100%;object-fit:cover;display:none"></video>
        <div class="scan-placeholder" id="scanPlaceholder">${iconSvg('camera',36)}<div style="font-size:13px;color:var(--gray-500);margin-top:8px">Camera is off</div></div>
        <div class="scan-corner tl"></div><div class="scan-corner tr"></div><div class="scan-corner bl"></div><div class="scan-corner br"></div>
      </div>
      <div id="scanError" class="error-msg" style="margin-top:10px"></div>
    </div>
    <div style="display:grid;gap:16px">
      <div class="table-card">
        <div class="table-header"><h3>Manual Entry</h3></div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Paste / Type QR Token</label>
          <input type="text" id="scanManualInput" placeholder="FCG.MEM-xxxx.yyyymmdd.xxxxxxxx" onkeydown="if(event.key==='Enter')scanManualToken()" style="font-family:monospace;font-size:12px">
        </div>
        <button class="btn-primary btn-sm" onclick="scanManualToken()">Validate Token</button>
      </div>
      <div id="scanResult" class="scan-result-wrap"></div>
    </div>
  </div>`;
  stopScanner();
  const manual=document.getElementById('scanManualInput');
  if(manual)manual.value='';
}
function startScanner(){
  const video=document.getElementById('scanVideo');
  const placeholder=document.getElementById('scanPlaceholder');
  const err=document.getElementById('scanError');
  if(!video)return;
  if(err)err.style.display='none';
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    if(err){err.textContent='Camera not supported in this browser. Use Manual Entry instead.';err.style.display='block';}
    return;
  }
  stopScanner();
  navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}}).then(stream=>{
    _scanStream=stream;
    video.srcObject=stream;
    video.style.display='block';
    if(placeholder)placeholder.style.display='none';
    const sb=document.getElementById('scanStartBtn');if(sb)sb.style.display='none';
    const st=document.getElementById('scanStopBtn');if(st)st.style.display='';
    video.play().then(()=>{
      _scanCanvas=document.createElement('canvas');
      _scanCtx=_scanCanvas.getContext('2d');
      _scanning=true;
      _scanLoop();
    }).catch(()=>{});
  }).catch(()=>{
    if(err){err.textContent='Camera access denied. Use Manual Entry instead.';err.style.display='block';}
  });
}
function stopScanner(){
  _scanning=false;
  if(_scanRaf){cancelAnimationFrame(_scanRaf);_scanRaf=null;}
  if(_scanStream){_scanStream.getTracks().forEach(t=>t.stop());_scanStream=null;}
  const video=document.getElementById('scanVideo');
  if(video){video.srcObject=null;video.style.display='none';}
  const placeholder=document.getElementById('scanPlaceholder');
  if(placeholder)placeholder.style.display='';
  const sb=document.getElementById('scanStartBtn');if(sb)sb.style.display='';
  const st=document.getElementById('scanStopBtn');if(st)st.style.display='none';
}
function _scanLoop(){
  if(!_scanning)return;
  const video=document.getElementById('scanVideo');
  if(!video||video.readyState!==video.HAVE_ENOUGH_DATA){_scanRaf=requestAnimationFrame(_scanLoop);return;}
  const w=video.videoWidth,h=video.videoHeight;
  if(w===0||h===0){_scanRaf=requestAnimationFrame(_scanLoop);return;}
  _scanCanvas.width=w;_scanCanvas.height=h;
  _scanCtx.drawImage(video,0,0,w,h);
  const img=_scanCtx.getImageData(0,0,w,h);
  const code=jsQR(img.data,img.width,img.height,{inversionAttempts:'dontInvert'});
  if(code&&code.data&&!_scanLocked)processQrToken(code.data);
  _scanRaf=requestAnimationFrame(_scanLoop);
}
function processQrToken(token){
  if(!token)return;
  if(_scanLocked){showScanResult('busy','Processing…','Wait a moment before the next scan.');return;}
  const parsed=parseQrToken(token);
  if(!parsed){showScanResult('invalid','Invalid QR Code','This is not a valid FitCore entrance QR.');return;}
  if(parsed.dateStr!==today()){showScanResult('invalid','QR is Outdated','Entrance QRs rotate daily. Ask the member to refresh their QR.');return;}
  const member=Members.one(parsed.memberId);
  if(!member){showScanResult('invalid','Member Not Found','No member record matches this QR.');return;}
  if(member.status==='pending_payment'){showScanResult('blocked','Payment Pending',member.name+' has not paid yet — send to the counter.');return;}
  if(member.status==='Archived'){showScanResult('blocked','Account Archived','Member account is archived.');return;}
  if(daysUntil(member.expiryDate)<0){showScanResult('blocked','Plan Expired',member.name+'\'s plan expired on '+formatDate(member.expiryDate)+'. Renew at the counter — entry blocked.');return;}
  const now=new Date();
  const last=Attendance.all().filter(a=>a.memberId===member.id).slice(-1)[0];
  if(last&&last.date===today()&&last.checkInTs&&(now.getTime()-last.checkInTs)<QR_SCAN_DUP_WINDOW_MIN*60000){
    const mins=Math.max(1,Math.ceil((QR_SCAN_DUP_WINDOW_MIN*60000-(now.getTime()-last.checkInTs))/60000));
    showScanResult('blocked','Duplicate Scan Blocked',member.name+' already checked in at '+last.checkIn+'. Try again in ~'+mins+' min.');
    return;
  }
  const time=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  Attendance.add({id:uid(),memberId:member.id,date:today(),time,checkIn:time,checkInTs:now.getTime(),checkOut:null,checkOutTs:null,duration:null,recordedBy:currentUser.name,scannedBy:currentUser.name,source:'qr'});
  showScanResult('granted','Entry Granted',member.name+' ('+member.id+') — logged at '+time);
  _scanLocked=true;
  setTimeout(()=>{_scanLocked=false;},4000);
}
function scanManualToken(){
  const input=document.getElementById('scanManualInput');
  const err=document.getElementById('scanError');
  if(!input)return;
  const val=input.value.trim();
  if(!val){if(err){err.textContent='Please paste or type the QR token.';err.style.display='block';}return;}
  if(err)err.style.display='none';
  processQrToken(val);
}
function showScanResult(type,title,sub){
  const wrap=document.getElementById('scanResult');
  if(!wrap)return;
  const meta={
    granted:{cls:'ok',ico:'✅',color:'var(--green)'},
    blocked:{cls:'block',ico:'🚫',color:'var(--red)'},
    invalid:{cls:'block',ico:'⚠️',color:'var(--red)'},
    busy:{cls:'block',ico:'⏳',color:'var(--gold)'}
  };
  const m=meta[type]||meta.invalid;
  wrap.innerHTML=`<div class="scan-result ${m.cls}">
    <div style="font-size:30px">${m.ico}</div>
    <div style="font-weight:800;color:${m.color};margin-top:8px">${esc(title)}</div>
    ${sub?`<div style="font-size:12px;color:var(--gray-500);margin-top:4px">${esc(sub)}</div>`:''}
  </div>`;
  iconize(wrap);
}

// ======================================================================
// PANEL: WALK-IN
// ======================================================================
let walkinSearch='';let walkinPage=1;
function renderWalkin(){
  const el=document.getElementById('panelWalkin');
  el.innerHTML=`
  <div class="page-actions">
    <div class="table-controls">
      <input class="search-input" placeholder="Search visitor name…" value="${esc(walkinSearch)}" oninput="walkinSearch=this.value;walkinPage=1;refreshWalkinTable()">
      ${currentUser.role==='admin'?`<button class="btn-secondary" onclick="openWalkinSettingsModal()">⚙ Walk-In Price: ₱${getWalkinFee().toLocaleString()}</button>`:''}
    </div>
    <button class="btn-primary" onclick="openWalkinModal()">🚶 Register Walk-In</button>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px" id="walkinStats"></div>
  <div class="table-card" id="walkinTableCard"></div>`;
  refreshWalkinTable();
}
function refreshWalkinTable(){
  let data=Walkins.all();
  if(walkinSearch){const s=walkinSearch.toLowerCase();data=data.filter(w=>w.visitorName.toLowerCase().includes(s));}
  // Stats
  const today_=today();
  const todayCount=Walkins.all().filter(w=>w.date===today_).length;
  const totalRevenue=Walkins.all().reduce((a,w)=>a+Number(w.fee),0);
  const thisMonth=new Date();
  const monthlyCount=Walkins.all().filter(w=>{const d=new Date(w.date);return d.getMonth()===thisMonth.getMonth()&&d.getFullYear()===thisMonth.getFullYear();}).length;
  document.getElementById('walkinStats').innerHTML=`
    <div class="stat-card orange"><div class="stat-label">Today's Walk-Ins</div><div class="stat-value">${todayCount}</div><div class="stat-hint">₱${(todayCount*getWalkinFee()).toLocaleString()} collected today</div></div>
    <div class="stat-card green"><div class="stat-label">This Month</div><div class="stat-value">${monthlyCount}</div><div class="stat-hint">Walk-in visits</div></div>
    <div class="stat-card gold"><div class="stat-label">Total Walk-In Revenue</div><div class="stat-value" style="font-size:22px">₱${totalRevenue.toLocaleString()}</div><div class="stat-hint">All-time earnings</div></div>`;
  data=data.slice().reverse();
  const perPage=10;const total=data.length;const pages=Math.ceil(total/perPage)||1;
  const slice=data.slice((walkinPage-1)*perPage,walkinPage*perPage);
  const rows=slice.length?slice.map(w=>`<tr>
    <td>${esc(w.id)}</td>
    <td>${esc(w.visitorName)}</td>
    <td>${formatDate(w.date)}</td>
    <td>${esc(w.time)}</td>
    <td style="color:var(--green);font-weight:600">₱${Number(w.fee).toLocaleString()}</td>
    <td>${esc(w.recordedBy||'—')}</td>
    <td><div class="td-actions"><button class="btn-icon" title="View Receipt" onclick="viewWalkinReceipt('${w.id}')">🧾</button></div></td>
  </tr>`).join(''):`<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">🚶</div><p>No walk-in records found</p></div></td></tr>`;
  let pag='';if(pages>1){pag=`<div class="pagination"><button class="page-btn" onclick="walkinPage=${walkinPage-1};refreshWalkinTable()" ${walkinPage===1?'disabled':''}>‹</button>${Array.from({length:pages},(_,i)=>`<button class="page-btn ${i+1===walkinPage?'active':''}" onclick="walkinPage=${i+1};refreshWalkinTable()">${i+1}</button>`).join('')}<button class="page-btn" onclick="walkinPage=${walkinPage+1};refreshWalkinTable()" ${walkinPage===pages?'disabled':''}>›</button><span class="page-info">${total} records</span></div>`;}
  document.getElementById('walkinTableCard').innerHTML=`
    <div class="table-header"><h3>Walk-In Records <span style="font-size:12px;font-weight:400;color:var(--gray-500);margin-left:6px">${total} record${total!==1?'s':''}</span></h3></div>
    <div style="overflow-x:auto"><table><thead><tr><th>ID</th><th>Visitor Name</th><th>Date</th><th>Time</th><th>Fee</th><th>Recorded By</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>${pag}`;
}
// ======================================================================
// RECEIPT PRINT (receipt-only clean sheet via hidden iframe)
// ======================================================================
function printReceipt(){
  const node=document.querySelector('#receiptBody .receipt');
  if(!node){toast('No receipt to print.','error');return;}
  // Hidden iframe instead of window.open(): pop-up blockers and mobile
  // browsers frequently block or blank the old pop-up approach.
  const old=document.getElementById('rcPrintFrame');
  if(old&&old.parentNode)old.parentNode.removeChild(old);
  const frame=document.createElement('iframe');
  frame.id='rcPrintFrame';
  frame.setAttribute('aria-hidden','true');
  frame.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;';
  document.body.appendChild(frame);
  const doc=frame.contentWindow.document;
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>FitCore Receipt</title><style>
  *{box-sizing:border-box;margin:0;padding:0}
  @page{margin:12mm}
  body{font-family:'Roboto','Segoe UI',Arial,sans-serif;background:#fff;color:#0a0a0a;padding:26px;display:flex;justify-content:center;font-size:14px;line-height:1.5}
  .sheet{width:100%;max-width:430px}
  .receipt{background:#fff;color:#0a0a0a;padding:30px 28px 22px;border-radius:18px;position:relative;overflow:hidden;width:100%;border:1px solid #e6ebf4}
  .receipt::before{content:'';position:absolute;top:0;left:0;right:0;height:5px;background:linear-gradient(90deg,#16a34a 0%,#fbbf24 50%,#b3bcb5 100%)}
  .receipt-header{text-align:center;margin-bottom:16px}
  .receipt-sticker{display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px}
  .receipt h2{font-family:'Arial Black',Impact,sans-serif;font-size:24px;font-weight:900;letter-spacing:4px;text-transform:uppercase;color:#0a0a0a;line-height:1;margin-bottom:6px}
  .receipt h2 span{color:#16a34a}
  .receipt-sub{font-size:10px;color:#8b96ad;letter-spacing:2px;text-transform:uppercase;font-weight:700}
  .receipt-tag{display:inline-block;margin-top:12px;padding:5px 14px;border-radius:100px;font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase}
  .tag-paid{background:linear-gradient(135deg,#bbf7d0,#86efac);color:#14532d;border:1px solid #86efac}
  .tag-renew{background:linear-gradient(135deg,#fde68a,#fbbf24);color:#78350f;border:1px solid #fbbf24}
  .tag-walkin{background:linear-gradient(135deg,#e5e7eb,#cbd5d1);color:#0a0a0a;border:1px solid #cbd5d1}
  .receipt-meta{display:flex;justify-content:space-between;gap:12px;background:#f6f8fc;border:1px solid #e6ebf4;border-radius:10px;padding:10px 14px;margin-bottom:12px}
  .receipt-meta div{min-width:0}
  .receipt-meta span{display:block;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:#8b96ad;margin-bottom:2px}
  .receipt-meta strong{font-size:12px;color:#0a0a0a;letter-spacing:.5px}
  .receipt-body{padding:4px 2px}
  .receipt-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-bottom:1px dashed #dde3ee;font-size:13px}
  .receipt-row:last-child{border-bottom:none}
  .receipt-row span{color:#6d7ca0}
  .receipt-row strong{color:#0a0a0a;font-weight:700;text-align:right}
  .receipt-total{display:flex;justify-content:space-between;align-items:center;background:linear-gradient(135deg,rgba(34,197,94,.10),rgba(251,191,36,.08));border:1px solid rgba(34,197,94,.35);border-radius:12px;padding:14px 16px;margin-top:14px}
  .receipt-total span{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:#15803d}
  .receipt-total strong{font-size:24px;font-family:'Arial Black',Impact,sans-serif;font-weight:900;color:#15803d}
  .receipt-foot{margin-top:16px;text-align:center}
  .receipt-footer-note{font-size:11px;color:#8b96ad}
  .receipt-barcode{width:170px;height:34px;margin:14px auto 8px;background:repeating-linear-gradient(90deg,#0a0a0a 0 2px,transparent 2px 5px,#0a0a0a 5px 6px,transparent 6px 10px);opacity:.85}
  .receipt-thanks{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#8b96ad}
  @media print{
    body{padding:0}
    .receipt{border:none;border-radius:0;max-width:none;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .receipt::before{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
  </style></head><body><div class="sheet">${node.outerHTML}</div></body></html>`);
  doc.close();
  const printNow=function(){
    try{
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }catch(e){toast('Print failed. Please try again.','error');}
    setTimeout(function(){if(frame.parentNode)frame.parentNode.removeChild(frame);},60000);
  };
  if(doc.readyState==='complete')setTimeout(printNow,200);
  else frame.onload=function(){setTimeout(printNow,200);};
}
function viewWalkinReceipt(id){
  const w=Walkins.all().find(x=>x.id===id);if(!w)return;
  const users=Users.all();
  const match=users.find(u=>u.username===w.recordedBy||u.name===w.recordedBy);
  const staffDisplay=match?match.name:(w.recordedBy||'—');
  const recordedTime=w.time||'—';
  document.getElementById('receiptBody').innerHTML=`
  <div class="receipt">
    <div class="receipt-header">
      <div class="receipt-sticker">
        <svg width="46" height="46" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="48" height="48" rx="12" fill="url(#rcGrad)"/>
          <rect x="8" y="21" width="7" height="6" rx="2" fill="white"/>
          <rect x="33" y="21" width="7" height="6" rx="2" fill="white"/>
          <rect x="13" y="17" width="5" height="14" rx="2" fill="white"/>
          <rect x="30" y="17" width="5" height="14" rx="2" fill="white"/>
          <rect x="18" y="22" width="12" height="4" rx="2" fill="white"/>
          <defs><linearGradient id="rcGrad" x1="0" y1="0" x2="48" y2="48"><stop offset="0%" stop-color="#7ffa88"/><stop offset="100%" stop-color="#4ade80"/></linearGradient></defs>
        </svg>
      </div>
      <h2>FITCORE <span>GMS</span></h2>
      <div class="receipt-sub">Gym Management System</div>
      <div class="receipt-tag tag-walkin">🎟️ Walk-In Receipt</div>
    </div>
    <div class="receipt-meta">
      <div><span>Receipt No.</span><strong>${w.id}</strong></div>
      <div><span>Visit Date</span><strong>${formatDate(w.date)}</strong></div>
    </div>
    <div class="receipt-body">
      <div class="receipt-row"><span>Visitor Name</span><strong>${esc(w.visitorName)}</strong></div>
      <div class="receipt-row"><span>Visit Type</span><strong>Walk-In (Single Visit)</strong></div>
      <div class="receipt-row"><span>Time In</span><strong>${esc(recordedTime)}</strong></div>
      <div class="receipt-row"><span>Payment Method</span><strong>Cash</strong></div>
    </div>
    <div class="receipt-total">
      <span>Amount Paid</span>
      <strong>&#8369;${Number(w.fee).toLocaleString()}</strong>
    </div>
    <div class="receipt-foot">
      <div class="receipt-footer-note">Recorded by <strong>${esc(staffDisplay)}</strong> &middot; ${formatDate(w.date)} ${esc(recordedTime)}</div>
      <div class="receipt-barcode" aria-hidden="true"></div>
      <div class="receipt-thanks">Train hard &middot; Stay strong &middot; See you at FitCore</div>
    </div>
  </div>`;
  openModal('receiptModal');
}
function openWalkinModal(){
  document.getElementById('wi_name').value='';
  document.getElementById('walkinError').style.display='none';
  const fee=getWalkinFee();
  const feeEl=document.getElementById('walkinFeeDisplay');
  if(feeEl)feeEl.textContent='₱'+formatPeso(fee);
  const feeNote=document.getElementById('walkinFeeNote');
  if(feeNote)feeNote.textContent='Daily rate · Single visit · Set by admin';
  document.getElementById('walkinFooterDefault').style.display='flex';
  document.getElementById('walkinFooterConfirm').style.display='none';
  openModal('walkinModal');
}
function walkinAskConfirm(){
  const name=document.getElementById('wi_name').value.trim();
  const err=document.getElementById('walkinError');
  err.style.display='none';
  if(!name){err.textContent="Please enter the visitor's full name to proceed.";err.style.display='block';return;}
  const confEl=document.getElementById('walkinConfirmText');
  if(confEl)confEl.innerHTML=`⚠️ Are you sure you want to record this walk-in and collect <strong>₱${formatPeso(getWalkinFee())}</strong>?`;
  document.getElementById('walkinFooterDefault').style.display='none';
  document.getElementById('walkinFooterConfirm').style.display='flex';
}
function walkinCancelConfirm(){
  document.getElementById('walkinFooterDefault').style.display='flex';
  document.getElementById('walkinFooterConfirm').style.display='none';
}
function saveWalkin(){
  const name=document.getElementById('wi_name').value.trim();
  const err=document.getElementById('walkinError');
  err.style.display='none';
  if(!name){err.textContent="Please enter the visitor's full name to proceed.";err.style.display='block';return;}
  const walkins=Walkins.all();
  const now=new Date();
  const time=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
  const newId='WI-'+String(walkins.length+1).padStart(4,'0');
  const fee=getWalkinFee();
  walkins.push({id:newId,visitorName:sanitizeText(name),date:today(),time,fee,recordedBy:currentUser.username,createdAt:today()});
  Walkins.save(walkins);
  toast(`Walk-in recorded for ${name}. Fee: ₱${fee.toLocaleString()}.00`);
  closeModal('walkinModal');renderWalkin();
}
function deleteWalkin(id){
  openConfirm('Delete Walk-In','Are you sure you want to delete this walk-in record?',()=>{
    const walkins=Walkins.all().filter(w=>w.id!==id);Walkins.save(walkins);toast('Walk-in record deleted.','info');renderWalkin();
  });
}
function openWalkinSettingsModal(){
  if(currentUser.role!=='admin'){toast('Only admins can change the walk-in price.','error');return;}
  document.getElementById('wiFeeInput').value=getWalkinFee();
  document.getElementById('walkinFeeError').style.display='none';
  openModal('walkinSettingsModal');
}
function saveWalkinFee(){
  if(currentUser.role!=='admin'){toast('Only admins can change the walk-in price.','error');return;}
  const err=document.getElementById('walkinFeeError');
  err.style.display='none';
  const val=parseFloat(document.getElementById('wiFeeInput').value);
  if(!val||val<=0){err.textContent='Please enter a valid price greater than zero.';err.style.display='block';return;}
  if(val>10000){err.textContent='Price looks too high. Enter a reasonable daily rate.';err.style.display='block';return;}
  setWalkinFee(val);
  logActivity('Updated','Settings','Walk-in daily rate set to ₱'+val.toLocaleString(),'Daily walk-in fee');
  toast(`Walk-in price updated to ₱${val.toLocaleString()}.00`);
  closeModal('walkinSettingsModal');
  renderWalkin();
  const explore=document.getElementById('landingExplore');
  if(explore&&explore.style.display!=='none')renderExplorePlans();
  syncStaticWalkinPrice();
}

// ======================================================================
// PANEL: PLANS
// ======================================================================
function renderPlans(){
  const el=document.getElementById('panelPlans');
  const plans=Plans.all();
  const members=Members.all().filter(m=>m.status!=='Archived');
  const isStaff=currentUser.role==='staff';
  // Get admin info
  const admin=Users.all().find(u=>u.role==='admin');
  const adminName=admin?admin.name:'Administrator';
  const adminContact=admin&&admin.contact?admin.contact:'—';
  const adminUsername=admin?admin.username:'—';
  const cards=plans.map(p=>{
    const count=members.filter(m=>m.planId===p.id).length;
    const benefits=(p.benefits||'').split(/\n|,/).map(b=>b.trim()).filter(Boolean);
    return`<div class="plan-card">
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px">
        <div><div class="plan-card-name">${esc(p.name)}</div><span class="badge ${p.status==='Active'?'badge-active':'badge-inactive'}">${esc(p.status)}</span></div>
        ${!isStaff?`<div class="td-actions"><button class="btn-icon" onclick="openPlanModal('${p.id}')">✏️</button></div>`:''}
      </div>
      <div class="plan-card-price">₱${Number(p.price).toLocaleString()}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div style="background:var(--navy-700);border-radius:8px;padding:8px;text-align:center"><div style="font-size:10px;color:var(--gray-500);text-transform:uppercase;letter-spacing:.5px">Duration</div><div style="font-weight:700">${p.duration} mo.</div></div>
        <div style="background:var(--navy-700);border-radius:8px;padding:8px;text-align:center"><div style="font-size:10px;color:var(--gray-500);text-transform:uppercase;letter-spacing:.5px">Sessions</div><div style="font-weight:700">${p.sessions}</div></div>
      </div>
      ${benefits.map(b=>`<div class="plan-feature">✓ ${esc(b)}</div>`).join('')}
      <div style="margin-top:10px;font-size:11px;color:var(--gray-500)">${count} active member${count!==1?'s':''}</div>
    </div>`;}).join('');
  el.innerHTML=`
  <div class="page-actions">
    ${isStaff?`<div style="background:rgba(179,188,181,.08);border:1px solid rgba(179,188,181,.25);border-radius:10px;padding:16px 20px;font-size:13px;color:#b3bcb5;width:100%">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-weight:700;font-size:14px;color:#93c5fd">
        <span style="font-size:18px">👁</span> View Only — Contact the Administrator to modify membership plans.
      </div>
      <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:12px">
        <span style="font-size:22px">📞</span>
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--gray-500);margin-bottom:2px">Admin Contact Number</div>
          <div style="color:var(--white);font-weight:800;font-size:16px;letter-spacing:1px">${esc(adminContact)}</div>
        </div>
      </div>
    </div>`:'<div></div>'}
    ${!isStaff?`<button class="btn-primary" onclick="openPlanModal()">+ Add New Plan</button>`:''}
  </div>
  <div class="plan-grid">${cards||`<div class="empty-state"><div class="empty-icon">📋</div><p>No plans created yet</p></div>`}</div>`;
}
let editingPlanId=null;
function openPlanModal(id=null){
  editingPlanId=id;
  document.getElementById('planModalTitle').textContent=id?'Edit Plan':'Add New Plan';
  document.getElementById('planFormError').style.display='none';
  if(id){
    const p=Plans.one(id);if(!p)return;
    document.getElementById('plf_name').value=p.name;document.getElementById('plf_price').value=p.price;
    document.getElementById('plf_dur').value=p.duration;
    if(p.sessions==='Unlimited'){document.getElementById('plf_unlimited').checked=true;document.getElementById('plf_sessions').value='';document.getElementById('plf_sessions').disabled=true;}
    else{document.getElementById('plf_unlimited').checked=false;document.getElementById('plf_sessions').value=p.sessions;document.getElementById('plf_sessions').disabled=false;}
    document.getElementById('plf_benefits').value=p.benefits||'';document.getElementById('plf_status').value=p.status||'Active';
  } else {
    ['plf_name','plf_price','plf_dur','plf_sessions','plf_benefits'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('plf_unlimited').checked=false;document.getElementById('plf_sessions').disabled=false;document.getElementById('plf_status').value='Active';
  }
  openModal('planModal');
}
function toggleUnlimited(cb){document.getElementById('plf_sessions').disabled=cb.checked;if(cb.checked)document.getElementById('plf_sessions').value='';}
function savePlan(){
  if(!currentUser||currentUser.role!=='admin'){toast('Only admins can create or edit membership plans.','error');return;}
  const name=document.getElementById('plf_name').value.trim();
  const price=parseFloat(document.getElementById('plf_price').value);
  const dur=parseInt(document.getElementById('plf_dur').value);
  const unlimited=document.getElementById('plf_unlimited').checked;
  const sessions=unlimited?'Unlimited':parseInt(document.getElementById('plf_sessions').value);
  const benefits=document.getElementById('plf_benefits').value.trim();
  const status=document.getElementById('plf_status').value;
  const err=document.getElementById('planFormError');
  err.style.display='none';
  if(!name||!price||!dur||(!unlimited&&!sessions)){err.textContent='Please fill in all required fields.';err.style.display='block';return;}
  if(price<=0||dur<=0){err.textContent='Invalid price or duration. Please enter values greater than zero.';err.style.display='block';return;}
  const plans=Plans.all();
  const dup=plans.find(p=>p.name.toLowerCase()===name.toLowerCase()&&p.id!==editingPlanId);
  if(dup){err.textContent='Plan name already in use. Please choose a different plan name.';err.style.display='block';return;}
  const data={name:sanitizeText(name),price,duration:dur,sessions,benefits:sanitizeText(benefits),status};
  if(editingPlanId){
    const idx=plans.findIndex(p=>p.id===editingPlanId);
    if(idx>-1)plans[idx]={...plans[idx],...data};Plans.save(plans);toast('Plan updated.');
  } else {plans.push({id:uid(),...data});Plans.save(plans);toast('Plan created.');}
  closeModal('planModal');renderPlans();renderExplorePlans();
}
function renderExplorePlans(){
  const container=document.getElementById('exploreCardsContainer');
  if(!container)return;
  if(!Plans.all().length&&window.GMSFB&&GMSFB.enabled&&typeof GMSFB.ensureSeededPlans==='function')GMSFB.ensureSeededPlans();
  const plans=Plans.all().filter(p=>p.status==='Active');
  const badges=['Starter','Popular','Best Value','Elite','Premium','Top Pick'];
  const featuredIdx=1; // second plan is "featured" (orange border)
  let html=plans.map((p,i)=>{
    const isFeatured=i===featuredIdx;
    const durLabel=p.duration===1?'/mo':(p.duration===3?'/3mo':'/'+p.duration+'mo');
    const sessLabel=p.sessions==='Unlimited'?'Unlimited Sessions':(p.sessions+' Sessions');
    const benefitLines=p.benefits?p.benefits.split('\n').filter(b=>b.trim()).map(b=>`<li>&#10003; ${esc(b.trim())}</li>`).join(''):'<li>&#10003; Gym Access</li>';
    const badge=badges[i]||'Plan';
    return`<div class="explore-card${isFeatured?' featured':''} reveal reveal-d${i%4}">
      <div class="ec-badge">${esc(badge)}</div>
      <div class="ec-name">${esc(p.name)}</div>
      <div class="ec-price">&#8369;${Number(p.price).toLocaleString()}<span>${esc(durLabel)}</span></div>
      <ul class="ec-features">${benefitLines}<li>&#10003; ${esc(sessLabel)}</li></ul>
      <button class="btn-primary ec-btn" onclick="startMemberSignup('${p.id}')">Choose ${esc(p.name)} →</button>
    </div>`;
  }).join('');
  // Always append the static Walk-In card at the end
  html+=`<div class="explore-card walkin-card reveal reveal-d3">
    <div class="ec-badge">No Commitment</div>
    <div class="ec-name">Walk-In</div>
    <div class="ec-price">&#8369;${getWalkinFee().toLocaleString()}<span>/day</span></div>
    <ul class="ec-features"><li>&#10003; Full Gym Access</li><li>&#10003; Single Day Pass</li><li>&#10003; No Registration</li><li>&#10003; Pay at Front Desk</li></ul>
    <button class="btn-primary ec-btn btn-gold" onclick="showLandingSection('register',null)">Visit Us →</button>
    <div class="walkin-note">&#9888; For occasional visitors.<br>No membership required.</div>
  </div>`;
  container.innerHTML=html;
  initReveals();
}

// ======================================================================
// LANDING: TRAINERS, COUNTERS, SCROLL REVEALS
// ======================================================================
function renderTrainers(){
  const container=document.getElementById('trainersGrid');
  if(!container)return;
  const trainers=Users.all().filter(u=>u.role==='trainer'&&u.status==='active');
  if(!trainers.length){
    container.innerHTML=`<div class="empty-state" style="grid-column:1/-1;background:var(--glass-bg);border:var(--glass-border);border-radius:var(--radius)"><div class="empty-icon">&#127948;</div><p>Trainer profiles are being set up. Check back soon!</p></div>`;
    return;
  }
  container.innerHTML=trainers.map((t,i)=>{
    const name=t.coachName||t.name;
    const specs=(t.specializations&&t.specializations.length)?t.specializations.slice(0,3).map(esc).join(' · '):'Certified Trainer';
    const days=(t.availableDays&&t.availableDays.length)?`<span>${iconSvg('calendar',12)} ${t.availableDays.map(esc).join(', ')}</span>`:'';
    const hours=(t.availableFrom&&t.availableTo)?`<span>${iconSvg('clock',12)} ${esc(t.availableFrom)} – ${esc(t.availableTo)}</span>`:'';
    return`<div class="trainer-card reveal reveal-d${i%4}">
      <div class="tc-avatar">${esc(initials(name))}</div>
      <div class="tc-name">${esc(name)}</div>
      <div class="tc-role">${specs}</div>
      ${t.bio?`<p class="tc-bio">${esc(t.bio)}</p>`:''}
      <div class="tc-meta">${days}${hours}</div>
    </div>`;
  }).join('');
  initReveals();
}

let _revealObserver=null;
function initReveals(){
  const els=document.querySelectorAll('.reveal:not(.visible)');
  if(!els.length)return;
  if(_revealObserver){
    els.forEach(el=>_revealObserver.observe(el));
    return;
  }
  _revealObserver=new IntersectionObserver(entries=>{
    entries.forEach(en=>{
      if(en.isIntersecting){en.target.classList.add('visible');_revealObserver.unobserve(en.target);}
    });
  },{threshold:.12});
  els.forEach(el=>_revealObserver.observe(el));
}

function animateCount(el,target,dur=1100){
  if(!el)return;
  const end=parseInt(target,10);
  if(isNaN(end)){el.textContent=target;return;}
  const t0=performance.now();
  function step(t){
    const p=Math.min(1,(t-t0)/dur);
    const eased=1-Math.pow(1-p,3);
    el.textContent=Math.round(end*eased);
    if(p<1)requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function initHeroStats(){
  document.querySelectorAll('#landingHome [data-count]').forEach(el=>{
    if(el.dataset.counted)return;
    el.dataset.counted='1';
    animateCount(el,el.dataset.count);
  });
}

/* ======================================================================
   Portfolio-style FX: cursor glow + scroll progress bar
   ====================================================================== */
function initCursorGlow(){
  const glow=document.getElementById('cursorGlow');
  if(!glow)return;
  if(window.matchMedia&&window.matchMedia('(hover:none),(pointer:coarse)').matches){glow.style.display='none';return;}
  let raf=null;
  window.addEventListener('mousemove',e=>{
    if(raf)return;
    raf=requestAnimationFrame(()=>{
      glow.style.left=e.clientX+'px';
      glow.style.top=e.clientY+'px';
      glow.classList.remove('idle');
      raf=null;
    });
  },{passive:true});
  document.addEventListener('mouseleave',()=>glow.classList.add('idle'));
}
function initProgressBar(){
  const fill=document.getElementById('progressFill');
  if(!fill)return;
  function update(){
    const doc=document.documentElement;
    const max=doc.scrollHeight-doc.clientHeight;
    fill.style.width=(max>0?(window.scrollY/max)*100:0)+'%';
  }
  window.addEventListener('scroll',update,{passive:true});
  window.addEventListener('resize',update);
  update();
}

function deletePlan(id){
  if(!currentUser||currentUser.role!=='admin'){toast('Only admins can delete membership plans.','error');return;}
  const p=Plans.one(id);
  if(activeCount>0){toast('Cannot delete this plan. There are active members currently enrolled in it.','error');return;}
  openConfirm('Delete Plan',`Delete plan "${esc(p?p.name:'')}"?`,()=>{
    const plans=Plans.all().filter(p=>p.id!==id);Plans.save(plans);toast('Plan deleted.');renderPlans();renderExplorePlans();
  });
}

// ======================================================================
// PANEL: REPORTS
// ======================================================================
let reportType='revenue';
function renderReports(){
  const el=document.getElementById('panelReports');
  const isStaff=currentUser.role==='staff';
  el.innerHTML=`
  <div class="report-tabs">
    <button class="rtab ${reportType==='revenue'?'active':''}" onclick="reportType='revenue';renderReports()">💰 Revenue</button>
    <button class="rtab ${reportType==='attendance'?'active':''}" onclick="reportType='attendance';renderReports()">📋 Attendance</button>
    <button class="rtab ${reportType==='membership'?'active':''}" onclick="reportType='membership';renderReports()">👥 Membership</button>
    ${!isStaff?`<button class="rtab ${reportType==='trainer'?'active':''}" onclick="reportType='trainer';renderReports()">🏋️ Trainer Schedule</button>
    <button class="rtab ${reportType==='activity'?'active':''}" onclick="reportType='activity';renderReports()">📝 Activity Log</button>`:''}
  </div>
  ${isStaff&&(reportType==='trainer'||reportType==='activity')?(reportType='revenue',''):''}
  <div class="report-filters" id="reportFilters">
    <div class="form-group"><label>From Date</label><input type="date" id="rpt_from" class="search-input"></div>
    <div class="form-group"><label>To Date</label><input type="date" id="rpt_to" class="search-input"></div>
    ${reportType==='revenue'?`<div class="form-group"><label>Plan</label><select id="rpt_plan" class="filter-sel"><option value="all">All Plans</option>${Plans.all().map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>`:''}
    ${reportType==='attendance'?`<div class="form-group"><label>Member</label><select id="rpt_member" class="filter-sel"><option value="all">All Members</option>${Members.all().filter(m=>m.status!=='Archived').map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>`:''}
    ${reportType==='membership'?`<div class="form-group"><label>Search Member</label><div style="position:relative"><input type="text" id="rpt_member_search" class="search-input" placeholder="Type member name…" oninput="filterMemberReportList(this.value)" onfocus="filterMemberReportList(this.value)" autocomplete="off" style="width:100%"><div id="rpt_member_drop" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--navy-800);border:1.5px solid var(--orange);border-radius:10px;z-index:200;max-height:240px;overflow-y:auto;box-shadow:0 12px 32px rgba(0,0,0,.6)">${(()=>{const active=Members.all().filter(m=>m.status!=='Archived');const deleted=Members.all().filter(m=>m.status==='Archived');let html='';if(active.length){html+=`<div style="padding:6px 12px 4px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:var(--green);background:rgba(127,250,136,.05);border-bottom:1px solid rgba(127,250,136,.12);position:sticky;top:0">✓ Active Members</div>`;html+=active.map(m=>`<div class="country-item" style="padding:9px 14px" onclick="selectMemberReport('${m.id}','${esc(m.name).replace(/'/g,"&#39;")}')"><span style="font-weight:600">${esc(m.name)}</span></div>`).join('');}if(deleted.length){html+=`<div style="padding:6px 12px 4px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:#fca5a5;background:rgba(239,68,68,.05);border-top:1px solid rgba(239,68,68,.15);border-bottom:1px solid rgba(239,68,68,.1);position:sticky;top:0">⚠ Deleted Members</div>`;html+=deleted.map(m=>`<div class="country-item" style="padding:9px 14px;opacity:.75" onclick="selectMemberReport('${m.id}','${esc(m.name).replace(/'/g,"&#39;")}')"><span style="font-weight:600;color:var(--gray-300)">${esc(m.name)}</span><span style="margin-left:8px;font-size:9px;font-weight:800;color:#fca5a5;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.25);border-radius:4px;padding:1px 6px">DELETED</span></div>`).join('');}return html;})()}</div></div><input type="hidden" id="rpt_member_id" value="all"></div>`:''}

    ${reportType==='trainer'?`<div class="form-group"><label>Search Trainer</label><div style="position:relative"><input type="text" id="rpt_trainer_search" class="search-input" placeholder="Type trainer name…" oninput="filterTrainerReportList(this.value)" autocomplete="off" style="width:100%"><div id="rpt_trainer_drop" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--navy-800);border:1.5px solid var(--orange);border-radius:8px;z-index:200;max-height:180px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,.5)">${Users.all().filter(u=>u.role==='trainer').map(u=>`<div class="country-item" onclick="selectTrainerReport('${u.id}','${esc(u.name).replace(/'/g,"&#39;")}')"><span>${esc(u.name)}</span></div>`).join('')}</div></div><input type="hidden" id="rpt_trainer_filter" value="all"></div>`:''}

    ${reportType==='activity'?`<div class="form-group"><label>Category</label><select id="rpt_act_cat" class="filter-sel"><option value="all">All</option><option value="Member">Member</option><option value="Session">Session</option></select></div><div class="form-group"><label>Action</label><select id="rpt_act_action" class="filter-sel"><option value="all">All Actions</option><option value="Added">Added</option><option value="Edited">Edited</option><option value="Deleted">Deleted</option><option value="Status Changed">Status Changed</option></select></div>`:''}
    <div class="form-group" style="align-self:end"><button class="btn-primary" onclick="generateReport()">Generate Report</button></div>
  </div>
  <div class="report-output" id="reportOutput"></div>`;
}
function generateReport(){
  const fromInput=document.getElementById('rpt_from')?.value||'';
  const toInput=document.getElementById('rpt_to')?.value||'';
  const from=fromInput;
  const to=toInput||today();
  const output=document.getElementById('reportOutput');
  output.classList.add('visible');
  if(reportType==='revenue'){
    let data=Payments.all();
    if(from)data=data.filter(p=>p.date>=from);
    if(to)data=data.filter(p=>p.date<=to);
    const planFilter=document.getElementById('rpt_plan')?.value||'all';
    if(planFilter!=='all')data=data.filter(p=>p.planId===planFilter);
    // Walk-in revenue
    let walkins=Walkins.all();
    if(from)walkins=walkins.filter(w=>w.date>=from);
    if(to)walkins=walkins.filter(w=>w.date<=to);
    const walkinRevenue=walkins.reduce((a,w)=>a+Number(w.fee),0);
    if(!data.length&&!walkins.length){output.innerHTML=`<div class="empty-state"><div class="empty-icon">📊</div><p>No data found for the selected filters. Try adjusting the date range.</p></div>`;return;}
    const memberRevenue=data.reduce((a,p)=>a+Number(p.amount),0);
    const total=memberRevenue+walkinRevenue;
    const txCount=data.length+walkins.length;
    const avgAmount=txCount?total/txCount:0;
    // Group by month (combined)
    const byMonth={};
    data.forEach(p=>{const m=p.date.slice(0,7);byMonth[m]=(byMonth[m]||0)+Number(p.amount);});
    walkins.forEach(w=>{const m=w.date.slice(0,7);byMonth[m]=(byMonth[m]||0)+Number(w.fee);});
    const months=Object.keys(byMonth).sort();
    const monthShort=m=>new Date(m+'-01').toLocaleString('en-US',{month:'short'});
    const maxVal=Math.max(...Object.values(byMonth),1);
    const barW=50;const gap=16;const chartH=120;
    const bars=months.map((m,i)=>{const v=byMonth[m];const bh=Math.max(4,(v/maxVal)*chartH);const x=i*(barW+gap)+10;const y=chartH-bh+20;return`<g><rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="5" fill="url(#repBarGrad)"/><rect x="${x}" y="${y}" width="${barW}" height="3" rx="1.5" fill="rgba(255,255,255,.35)"/><text x="${x+barW/2}" y="${chartH+32}" text-anchor="middle" fill="#b3bcb5" font-size="10">${monthShort(m)}</text><text x="${x+barW/2}" y="${y-4}" text-anchor="middle" fill="#7ffa88" font-size="9" font-weight="700">₱${v>=1000?(v/1000).toFixed(1)+'k':v}</text></g>`;}).join('');
    const svgW=Math.max(300,months.length*(barW+gap)+30);
    const gridLines=[20,50,80,110,140].map(y=>`<line x1="10" y1="${y}" x2="${svgW-10}" y2="${y}" stroke="rgba(179,188,181,.12)" stroke-width="1"/>`).join('');
    const revUsers=Users.all();
    function revRecorderLabel(name){
      if(!name||name==='—')return'—';
      const u=revUsers.find(x=>x.name===name||x.username===name);
      if(!u)return name;
      const roleMap={admin:'Admin',staff:'Staff',trainer:'Trainer'};
      const tag=roleMap[u.role]||u.role;
      const col=u.role==='admin'?'var(--orange)':u.role==='trainer'?'var(--green)':'#d7ddd8';
      return`${esc(u.name)} <span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,.07);color:${col};margin-left:4px">${esc(tag)}</span>`;
    }
    const rows=data.slice().reverse().map(p=>`<tr><td>${esc(p.id)}</td><td>${esc(p.memberName)}</td><td>${esc(p.planName)}</td><td style="color:var(--green)">₱${Number(p.amount).toLocaleString()}</td><td>${formatDate(p.date)}</td><td>${esc(p.method)}</td><td>${revRecorderLabel(p.recordedBy)}</td><td><span class="badge badge-paid">Membership</span></td></tr>`).join('');
    const walkinRows=walkins.slice().reverse().map(w=>`<tr><td>${esc(w.id)}</td><td>${esc(w.visitorName)}</td><td>Walk-In</td><td style="color:var(--orange)">₱${Number(w.fee).toLocaleString()}</td><td>${formatDate(w.date)}</td><td>Cash</td><td>${revRecorderLabel(w.recordedBy)}</td><td><span class="badge badge-pending">Walk-In</span></td></tr>`).join('');
    output.innerHTML=`
    <div class="stats-grid">
      <div class="stat-card orange"><div class="stat-label">Total Revenue</div><div class="stat-value" style="font-size:22px">₱${total.toLocaleString()}</div><div class="stat-hint">Memberships + Walk-Ins</div></div>
      <div class="stat-card green"><div class="stat-label">Membership Revenue</div><div class="stat-value" style="font-size:22px">₱${memberRevenue.toLocaleString()}</div></div>
      <div class="stat-card blue" style="border-left-color:#fbbf24"><div class="stat-label">Walk-In Revenue</div><div class="stat-value" style="font-size:22px">₱${walkinRevenue.toLocaleString()}</div><div class="stat-hint">${walkins.length} visit${walkins.length!==1?'s':''}${walkins.length?` · avg ₱${(walkinRevenue/walkins.length).toFixed(0)} per visit`:''}</div></div>
      <div class="stat-card gold"><div class="stat-label">Avg Transaction</div><div class="stat-value" style="font-size:22px">₱${avgAmount.toFixed(0)}</div></div>
    </div>
    ${months.length?`<div class="chart-card" style="margin-bottom:20px"><div class="chart-title">Combined Revenue by Month</div><svg viewBox="0 0 ${svgW} 160" style="height:160px"><defs><linearGradient id="repBarGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#7ffa88"/><stop offset="100%" stop-color="#4ade80"/></linearGradient></defs>${gridLines}${bars}</svg></div>`:''}
    <div class="table-card">
      <div class="table-header"><h3>Revenue Records</h3><div style="display:flex;gap:8px"><button class="btn-secondary btn-sm" onclick="printReport()">🖨️ Print</button><button class="btn-secondary btn-sm" onclick="exportCSV('revenue')">📥 Export CSV</button></div></div>
      <div style="overflow-x:auto"><table><thead><tr><th>ID</th><th>Name</th><th>Plan / Type</th><th>Amount</th><th>Date</th><th>Method</th><th>Recorded By</th><th>Type</th></tr></thead><tbody>${rows}${walkinRows}</tbody></table></div>
    </div>`;
  } else if(reportType==='attendance'){
    let data=Attendance.all();
    if(from)data=data.filter(a=>a.date>=from);
    if(to)data=data.filter(a=>a.date<=to);
    const memberFilter=document.getElementById('rpt_member')?.value||'all';
    if(memberFilter!=='all'){
      const memberIds=Sessions.all().filter(s=>s.memberId===memberFilter).map(s=>s.memberId);
      data=data.filter(a=>memberIds.includes(a.memberId));
    }
    if(!data.length){output.innerHTML=`<div class="empty-state"><div class="empty-icon">📊</div><p>No data found for the selected filters. Try adjusting the date range.</p></div>`;return;}
    const checkedIn=data.filter(a=>a.checkIn&&!a.checkOut).length;
    const completed=data.filter(a=>a.checkOut).length;
    const users=Users.all();
    function recorderLabel(name){
      if(!name||name==='—')return'—';
      const u=users.find(x=>x.name===name||x.username===name);
      if(!u)return esc(name);
      const roleMap={admin:'Admin',staff:'Staff',trainer:'Trainer'};
      const tag=roleMap[u.role]||u.role;
      const col=u.role==='admin'?'var(--orange)':u.role==='trainer'?'var(--green)':'#d7ddd8';
      return`${esc(u.name)} <span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,.07);color:${col};margin-left:4px">${esc(tag)}</span>`;
    }
    const rows=data.slice().reverse().map(a=>{const m=Members.all().find(x=>x.id===a.memberId);return`<tr><td>${formatDate(a.date)}</td><td>${esc(a.checkIn||a.time||'—')}</td><td>${a.checkOut?esc(a.checkOut):'<span style="color:var(--gold)">In Gym</span>'}</td><td>${esc(a.duration||'—')}</td><td>${esc(m?m.name:'Unknown')}</td><td>${recorderLabel(a.recordedBy)}</td></tr>`;}).join('');
    output.innerHTML=`
    <div class="stats-grid">
      <div class="stat-card orange"><div class="stat-label">Total Check-Ins</div><div class="stat-value">${data.length}</div></div>
      <div class="stat-card green"><div class="stat-label">Completed</div><div class="stat-value">${completed}</div><div class="stat-hint">Checked out</div></div>
      <div class="stat-card gold"><div class="stat-label">Still In Gym</div><div class="stat-value">${checkedIn}</div></div>
    </div>
    <div class="table-card">
      <div class="table-header"><h3>Attendance Records</h3><div style="display:flex;gap:8px"><button class="btn-secondary btn-sm" onclick="printReport()">🖨️ Print</button><button class="btn-secondary btn-sm" onclick="exportCSV('attendance')">📥 Export CSV</button></div></div>
      <div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Check-In</th><th>Check-Out</th><th>Duration</th><th>Member</th><th>Recorded By</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  } else if(reportType==='trainer'){
    const allSessions=Sessions.all();
    const allUsers=Users.all();
    const allMembers=Members.all();
    let sessions=allSessions.slice();
    if(from)sessions=sessions.filter(s=>s.date>=from);
    if(to)sessions=sessions.filter(s=>s.date<=to);
    const trainerFil=document.getElementById('rpt_trainer_filter')?.value||'all';
    if(trainerFil!=='all')sessions=sessions.filter(s=>s.trainerId===trainerFil);
    if(!sessions.length){output.innerHTML=`<div class="empty-state"><div class="empty-icon">📊</div><p>No trainer schedule data found for the selected filters.</p></div>`;return;}
    const totalSessions=sessions.length;
    const uniqueTrainers=trainerFil!=='all'?1:[...new Set(sessions.map(s=>s.trainerId))].length;
    const uniqueMembers=[...new Set(sessions.map(s=>s.memberId).filter(Boolean))].length;
    const statusCounts={Scheduled:0,Completed:0,Cancelled:0};
    sessions.forEach(s=>{if(statusCounts[s.status]!==undefined)statusCounts[s.status]++;});
    const rows=sessions.slice().sort((a,b)=>a.date<b.date?1:-1).map(s=>{
      const trainer=allUsers.find(u=>u.id===s.trainerId);
      const member=allMembers.find(m=>m.id===s.memberId);
      const trainerName=trainer?trainer.name:'—';
      const memberName=member?member.name:(s.memberName||'—');
      const statusCls={Scheduled:'badge-pending',Completed:'badge-active',Cancelled:'badge-locked'}[s.status]||'';
      const timeDisplay=s.time||(s.startTime?s.startTime+(s.endTime?' – '+s.endTime:''):'—');
      const createdByUser=s.createdBy?allUsers.find(u=>u.name===s.createdBy||u.username===s.createdByUsername):null;
      const roleColorMap={admin:'var(--orange)',staff:'#d7ddd8',trainer:'var(--green)'};
      const roleColor=createdByUser?roleColorMap[createdByUser.role]||'var(--gray-300)':'var(--gray-300)';
      const roleTag=createdByUser?`<span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,.07);color:${roleColor};margin-left:4px;text-transform:uppercase">${createdByUser.role}</span>`:'';
      const editedByUser=s.editedBy?allUsers.find(u=>u.name===s.editedBy||u.username===s.editedByUsername):null;
      const editedRoleColor=editedByUser?roleColorMap[editedByUser.role]||'var(--gray-300)':'var(--gray-300)';
      const editedRoleTag=editedByUser?`<span style="font-size:9px;font-weight:800;padding:2px 5px;border-radius:4px;background:rgba(255,255,255,.07);color:${editedRoleColor};margin-left:4px;text-transform:uppercase">${editedByUser.role}</span>`:'';
      const createdByDisplay=s.createdBy?`<div style="font-size:12px;font-weight:600">${esc(s.createdBy)}${roleTag}</div>${s.editedBy?`<div style="font-size:11px;color:var(--gray-500);margin-top:2px">✎ ${esc(s.editedBy)}${editedRoleTag}</div>`:''}`:'<span style="color:var(--gray-500)">—</span>';
      return`<tr>
        <td>${formatDate(s.date)}</td>
        <td><strong>${esc(trainerName)}</strong></td>
        <td>${esc(timeDisplay)}</td>
        <td>${esc(s.type||s.sessionType||'—')}</td>
        <td>${esc(memberName)}</td>
        <td><span class="badge ${statusCls}">${esc(s.status)}</span></td>
        <td>${createdByDisplay}</td>
        <td>${esc(s.notes||'—')}</td>
      </tr>`;
    }).join('');
    const trainerFil2=document.getElementById('rpt_trainer_filter')?.value||'all';
    const singleTrainer=trainerFil2!=='all'?allUsers.find(u=>u.id===trainerFil2):null;
    output.innerHTML=`
    <div class="stats-grid">
      <div class="stat-card orange"><div class="stat-label">Total Sessions</div><div class="stat-value">${totalSessions}</div>${singleTrainer?`<div class="stat-hint">${esc(singleTrainer.name)}</div>`:''}</div>
      <div class="stat-card green"><div class="stat-label">Completed</div><div class="stat-value">${statusCounts.Completed}</div></div>
      <div class="stat-card gold"><div class="stat-label">Scheduled</div><div class="stat-value">${statusCounts.Scheduled}</div></div>
      <div class="stat-card blue" style="border-left-color:#ef4444"><div class="stat-label">Cancelled</div><div class="stat-value">${statusCounts.Cancelled}</div></div>
      ${!singleTrainer?`<div class="stat-card blue"><div class="stat-label">Trainers</div><div class="stat-value">${uniqueTrainers}</div></div>`:`<div class="stat-card blue"><div class="stat-label">Members Handled</div><div class="stat-value">${uniqueMembers}</div></div>`}
    </div>
    <div class="table-card">
      <div class="table-header"><h3>Trainer Schedule Records</h3><div style="display:flex;gap:8px"><button class="btn-secondary btn-sm" onclick="printReport()">🖨️ Print</button><button class="btn-secondary btn-sm" onclick="exportCSV('trainer')">📥 Export CSV</button></div></div>
      <div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Trainer</th><th>Time</th><th>Session Type</th><th>Member</th><th>Status</th><th>Created / Edited By</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  } else if(reportType==='activity'){
    let log=ActivityLog.all()||[];
    const from2=document.getElementById('rpt_from')?.value||'';
    const to2=document.getElementById('rpt_to')?.value||today();
    if(from2)log=log.filter(e=>e.at>=from2+'T00:00:00.000Z'||e.at>=from2);
    if(to2)log=log.filter(e=>e.at<=to2+'T23:59:59.999Z'||e.at<=to2+'T23:59:59');
    const catF=document.getElementById('rpt_act_cat')?.value||'all';
    const actF=document.getElementById('rpt_act_action')?.value||'all';
    if(catF!=='all')log=log.filter(e=>e.category===catF);
    if(actF!=='all')log=log.filter(e=>e.action===actF);
    const actionColor={'Added':'#7ffa88','Edited':'#fbbf24','Deleted':'#ef4444','Status Changed':'#b3bcb5'};
    const actionBg={'Added':'rgba(127,250,136,.12)','Edited':'rgba(251,191,36,.12)','Deleted':'rgba(239,68,68,.12)','Status Changed':'rgba(96,165,250,.12)'};
    const catIcon={'Member':'👤','Session':'📅'};
    const roleColorMap={admin:'var(--orange)',staff:'#d7ddd8',trainer:'var(--green)'};
    const totalAdded=log.filter(e=>e.action==='Added').length;
    const totalEdited=log.filter(e=>e.action==='Edited').length;
    const totalDeleted=log.filter(e=>e.action==='Deleted').length;
    const totalStatus=log.filter(e=>e.action==='Status Changed').length;
    if(!log.length){output.innerHTML=`<div class="empty-state"><div class="empty-icon">📝</div><p>No activity recorded yet. Actions like adding, editing, or deleting members and sessions will appear here.</p></div>`;return;}
    const rows=log.map(e=>{
      const clr=actionColor[e.action]||'var(--gray-300)';
      const bg=actionBg[e.action]||'rgba(255,255,255,.05)';
      const roleClr=roleColorMap[e.byRole]||'var(--gray-300)';
      const dt=new Date(e.at);
      const dateStr=dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
      const timeStr=dt.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      return`<tr>
        <td><span style="font-size:11px;font-weight:800;padding:3px 9px;border-radius:4px;background:${bg};color:${clr};letter-spacing:.5px;text-transform:uppercase;white-space:nowrap">${esc(e.action)}</span></td>
        <td><span style="font-size:12px;font-weight:700;color:var(--white)">${catIcon[e.category]||'•'} ${esc(e.category)}</span></td>
        <td style="font-size:12px;color:var(--white);font-weight:700;max-width:200px">${esc(e.detail||'—')}</td>
        <td style="font-size:12px;color:var(--white);font-weight:700;max-width:200px">${esc(e.extra||'—')}</td>
        <td><div style="font-size:12px;font-weight:700;color:var(--white)">${esc(e.by||'—')} <span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:4px;background:rgba(255,255,255,.09);color:${roleClr};margin-left:3px;text-transform:uppercase">${esc(e.byRole||'')}</span></div></td>
        <td style="white-space:nowrap"><div style="font-size:12px;color:var(--white);font-weight:700">${dateStr}</div><div style="font-size:11px;color:var(--gray-300);margin-top:2px">🕐 ${timeStr}</div></td>
      </tr>`;}).join('');
    output.innerHTML=`
    <div class="stats-grid">
      <div class="stat-card green"><div class="stat-label">Added</div><div class="stat-value">${totalAdded}</div></div>
      <div class="stat-card gold"><div class="stat-label">Edited</div><div class="stat-value">${totalEdited}</div></div>
      <div class="stat-card orange" style="border-top-color:#ef4444"><div class="stat-label">Deleted</div><div class="stat-value">${totalDeleted}</div></div>
      <div class="stat-card blue"><div class="stat-label">Status Changed</div><div class="stat-value">${totalStatus}</div></div>
    </div>
    <div class="table-card">
      <div class="table-header"><h3>Activity Log</h3><div style="display:flex;gap:8px"><button class="btn-secondary btn-sm" onclick="printReport()">🖨️ Print</button></div></div>
      <div style="overflow-x:auto"><table><thead><tr><th>Action</th><th>Category</th><th>Name / Detail</th><th>Info</th><th>Done By</th><th>Date & Time</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>`;
  } else {
    const allMembers=Members.all();
    const members=allMembers.filter(m=>m.status!=='Archived');
    const archivedMembers=allMembers.filter(m=>m.status==='Archived');
    const allPayments=Payments.all();
    let filtered=members;
    if(from)filtered=filtered.filter(m=>(m.createdAt||m.startDate)>=from);
    if(to)filtered=filtered.filter(m=>(m.createdAt||m.startDate)<=to);
    // Member search filter (includes archived)
    const memberIdFilter=document.getElementById('rpt_member_id')?.value||'all';
    let singleMemberMode=false;
    let singleMember=null;
    if(memberIdFilter!=='all'){
      const foundInAll=allMembers.find(m=>m.id===memberIdFilter);
      filtered=allMembers.filter(m=>m.id===memberIdFilter);
      singleMemberMode=true;
      singleMember=foundInAll||null;
    }
    if(!filtered.length){output.innerHTML=`<div class="empty-state"><div class="empty-icon">📊</div><p>No data found for the selected filters. Try adjusting the date range.</p></div>`;return;}
    const active=filtered.filter(m=>m.status==='Active'||m.status==='Expiring Soon').length;
    const expired=filtered.filter(m=>m.status==='Expired').length;
    const archivedCount=filtered.filter(m=>m.status==='Archived').length;
    const allUsers=Users.all();
    const roleColorMap={admin:'var(--orange)',staff:'#d7ddd8',trainer:'var(--green)'};
    const rows=filtered.map(m=>{
      const pl=Plans.all().find(p=>p.id===m.planId);
      const badgeCls={Active:'badge-active',Expired:'badge-expired','Expiring Soon':'badge-expiring',Suspended:'badge-suspended',Archived:'badge-archived'}[m.status]||'';
      const payCount=allPayments.filter(p=>p.memberId===m.id).length;
      // Created By
      const createdByUser=m.createdBy?allUsers.find(u=>u.name===m.createdBy||u.username===m.createdByUsername):null;
      const cRoleColor=createdByUser?roleColorMap[createdByUser.role]||'var(--gray-300)':'var(--gray-300)';
      const cRoleTag=createdByUser?`<span style="font-size:9px;font-weight:800;padding:2px 5px;border-radius:4px;background:rgba(255,255,255,.07);color:${cRoleColor};margin-left:4px;text-transform:uppercase">${createdByUser.role}</span>`:'';
      const createdLine=m.createdBy?`<div style="font-size:12px;font-weight:600">${esc(m.createdBy)}${cRoleTag}</div>`:`<span style="color:var(--gray-500)">—</span>`;
      // Edited By
      const editedByUser=m.editedBy?allUsers.find(u=>u.name===m.editedBy||u.username===m.editedByUsername):null;
      const eRoleColor=editedByUser?roleColorMap[editedByUser.role]||'var(--gray-300)':'var(--gray-300)';
      const eRoleTag=editedByUser?`<span style="font-size:9px;font-weight:800;padding:2px 5px;border-radius:4px;background:rgba(255,255,255,.07);color:${eRoleColor};margin-left:4px;text-transform:uppercase">${editedByUser.role}</span>`:'';
      const editedLine=m.editedBy?`<div style="font-size:11px;color:var(--gray-500);margin-top:2px">✎ ${esc(m.editedBy)}${eRoleTag}</div>`:'';
      const isArchived=m.status==='Archived';const rowStyle=isArchived?'opacity:0.6;background:rgba(239,68,68,.03);':'';
      return`<tr style="${rowStyle}"><td style="${isArchived?'text-decoration:line-through;color:var(--gray-500)':''}">${esc(m.id)}</td><td><div style="display:flex;align-items:center;gap:6px">${isArchived?'🗑️':''}<span style="${isArchived?'text-decoration:line-through;color:var(--gray-500)':''}">${esc(m.name)}</span></div></td><td>${esc(pl?pl.name:'—')}</td><td>${formatDate(m.startDate)}</td><td>${formatDate(m.expiryDate)}</td><td><span class="badge ${badgeCls}">${esc(isArchived?'Deleted':m.status)}</span></td><td style="text-align:center"><span style="background:rgba(179,188,181,.12);color:var(--orange);font-size:13px;font-weight:800;padding:3px 10px;border-radius:6px;border:1px solid rgba(179,188,181,.25)">${payCount}x</span></td><td><div>${createdLine}${editedLine}</div></td></tr>`;
    }).join('');
    // If single member, show their payment history too
    let payHistorySection='';
    if(singleMemberMode&&singleMember){
      const memberPayments=allPayments.filter(p=>p.memberId===singleMember.id).slice().reverse();
      const totalPaid=memberPayments.reduce((a,p)=>a+Number(p.amount),0);
      const payRows=memberPayments.length?memberPayments.map(p=>`<tr><td>${esc(p.id)}</td><td>${esc(p.planName)}</td><td style="color:var(--green);font-weight:700">₱${Number(p.amount).toLocaleString()}</td><td>${formatDate(p.date)}</td><td>${formatDate(p.newExpiry)}</td><td>${esc(p.method||'—')}</td><td>${esc(p.recordedBy||'—')}</td></tr>`).join(''):`<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">💳</div><p>No payments found</p></div></td></tr>`;
      payHistorySection=`
      <div class="table-card" style="margin-top:16px">
        <div class="table-header"><h3>💳 Payment History — ${esc(singleMember.name)}</h3><span style="font-size:12px;color:var(--gray-500);font-weight:400">${memberPayments.length} payment${memberPayments.length!==1?'s':''} · Total: <span style="color:var(--green);font-weight:700">₱${totalPaid.toLocaleString()}</span></span></div>
        <div style="overflow-x:auto"><table><thead><tr><th>Pay ID</th><th>Plan</th><th>Amount</th><th>Date</th><th>New Expiry</th><th>Method</th><th>Recorded By</th></tr></thead><tbody>${payRows}</tbody></table></div>
      </div>`;
    }
    output.innerHTML=`
    <div class="stats-grid">
      <div class="stat-card orange"><div class="stat-label">Total Members</div><div class="stat-value">${filtered.length}</div></div>
      <div class="stat-card green"><div class="stat-label">Active</div><div class="stat-value">${active}</div></div>
      <div class="stat-card gold"><div class="stat-label">Expired</div><div class="stat-value">${expired}</div></div>
      ${archivedCount>0?`<div class="stat-card" style="border-top-color:#fca5a5"><div class="stat-label" style="color:#fca5a5">🗑️ Deleted</div><div class="stat-value" style="color:#fca5a5">${archivedCount}</div><div class="stat-hint">removed members</div></div>`:''}
      ${singleMemberMode&&singleMember?`<div class="stat-card blue"><div class="stat-label">Total Payments</div><div class="stat-value">${allPayments.filter(p=>p.memberId===singleMember.id).length}x</div><div class="stat-hint">membership renewals</div></div>`:''}
    </div>
    <div class="table-card">
      <div class="table-header"><h3>Membership Report <span style="font-size:11px;font-weight:400;color:var(--gray-500);margin-left:6px">including deleted members</span></h3><div style="display:flex;gap:8px"><button class="btn-secondary btn-sm" onclick="printReport()">🖨️ Print</button><button class="btn-secondary btn-sm" onclick="exportCSV('membership')">📥 Export CSV</button></div></div>
      <div style="overflow-x:auto"><table><thead><tr><th>ID</th><th>Name</th><th>Plan</th><th>Start</th><th>Expiry</th><th>Status</th><th>Times Paid</th><th>Created / Edited By</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>${payHistorySection}`;
  }
}
function filterTrainerReportList(val){
  const drop=document.getElementById('rpt_trainer_drop');
  if(!drop)return;
  const all=Users.all().filter(u=>u.role==='trainer');
  const filtered=val?all.filter(u=>u.name.toLowerCase().includes(val.toLowerCase())):all;
  drop.style.display=filtered.length?'block':'none';
  drop.innerHTML=filtered.map(u=>`<div class="country-item" onclick="selectTrainerReport('${u.id}','${esc(u.name).replace(/'/g,"&#39;")}')"><span>${esc(u.name)}</span></div>`).join('');
  if(!val){document.getElementById('rpt_trainer_filter').value='all';}
}
function selectTrainerReport(id,name){
  const inp=document.getElementById('rpt_trainer_search');
  const hid=document.getElementById('rpt_trainer_filter');
  const drop=document.getElementById('rpt_trainer_drop');
  if(inp)inp.value=name;
  if(hid)hid.value=id;
  if(drop)drop.style.display='none';
}

function filterMemberReportList(val){
  const drop=document.getElementById('rpt_member_drop');
  if(!drop)return;
  const all=Members.all();
  const filtered=val?all.filter(m=>m.name.toLowerCase().includes(val.toLowerCase())):all;
  if(!filtered.length){drop.style.display='none';return;}
  const active=filtered.filter(m=>m.status!=='Archived');
  const deleted=filtered.filter(m=>m.status==='Archived');
  let html='';
  if(active.length){
    html+=`<div style="padding:6px 12px 4px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:var(--green);background:rgba(127,250,136,.05);border-bottom:1px solid rgba(127,250,136,.12)">✓ Active Members</div>`;
html+=active.map(m=>`<div class="country-item" style="padding:9px 14px" onclick="selectMemberReport('${m.id}','${esc(m.name).replace(/'/g,"&#39;")}')"><span style="font-weight:600">${esc(m.name)}</span></div>`).join('');
  }
  if(deleted.length){
    html+=`<div style="padding:6px 12px 4px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:#fca5a5;background:rgba(239,68,68,.05);border-top:1px solid rgba(239,68,68,.15);border-bottom:1px solid rgba(239,68,68,.1)">⚠ Deleted Members</div>`;
html+=deleted.map(m=>`<div class="country-item" style="padding:9px 14px;opacity:.75" onclick="selectMemberReport('${m.id}','${esc(m.name).replace(/'/g,"&#39;")}')"><span style="font-weight:600;color:var(--gray-300)">${esc(m.name)}</span><span style="margin-left:8px;font-size:9px;font-weight:800;color:#fca5a5;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.25);border-radius:4px;padding:1px 6px">DELETED</span></div>`).join('');
  }
  drop.innerHTML=html;
  drop.style.display='block';
  if(!val){document.getElementById('rpt_member_id').value='all';}
}
function selectMemberReport(id,name){
  const inp=document.getElementById('rpt_member_search');
  const hid=document.getElementById('rpt_member_id');
  const drop=document.getElementById('rpt_member_drop');
  if(inp)inp.value=name;
  if(hid)hid.value=id;
  if(drop)drop.style.display='none';
}
document.addEventListener('click',function(e){
  if(!e.target.closest('#rpt_member_search')&&!e.target.closest('#rpt_member_drop')){
    const drop=document.getElementById('rpt_member_drop');
    if(drop)drop.style.display='none';
  }
  if(!e.target.closest('#rpt_trainer_search')&&!e.target.closest('#rpt_trainer_drop')){
    const drop=document.getElementById('rpt_trainer_drop');
    if(drop)drop.style.display='none';
  }
});
function printReport(){
  const output=document.getElementById('reportOutput');
  if(!output||!output.innerHTML.trim()){toast('Generate a report first.','error');return;}
  // Hidden iframe (same reliable approach as receipt printing) — pop-up
  // blockers and mobile browsers often block or blank window.open().
  const old=document.getElementById('reportPrintFrame');
  if(old&&old.parentNode)old.parentNode.removeChild(old);
  const frame=document.createElement('iframe');
  frame.id='reportPrintFrame';
  frame.setAttribute('aria-hidden','true');
  frame.style.cssText='position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;';
  document.body.appendChild(frame);
  const doc=frame.contentWindow.document;
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><title>FitCore GMS — Report</title>
  <style>
  :root{--orange:#7ffa88;--orange-dark:#4ade80;--gold:#fbbf24;--green:#4ade80;--gray-300:#b3bcb5;--gray-500:#5e625f;--navy-900:#0a0a0a;--cyan:#b3bcb5}
  *{box-sizing:border-box}
  @page{margin:12mm}
  body{font-family:'Segoe UI',Roboto,Arial,sans-serif;color:#0a0a0a;padding:0;margin:0;font-size:12.5px;background:#fff}
  .page{max-width:920px;margin:0 auto;padding:28px 32px}
  .print-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:14px;border-bottom:3px solid #7ffa88;margin-bottom:18px}
  .ph-brand{display:flex;align-items:center;gap:10px}
  .ph-logo{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#7ffa88,#4ade80);color:#fff;font-family:Impact,'Arial Black',sans-serif;font-size:21px;font-weight:900;display:flex;align-items:center;justify-content:center}
  .ph-name{font-family:Impact,'Arial Black',sans-serif;font-size:17px;font-weight:900;letter-spacing:2px;text-transform:uppercase;color:#0a0a0a;line-height:1.1}
  .ph-name em{font-style:normal;color:#7ffa88}
  .ph-tag{font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:#5e625f;margin-top:2px}
  .ph-meta{text-align:right;font-size:10.5px;color:#5e625f;line-height:1.6}
  .ph-meta strong{color:#0a0a0a}
  .stats-grid{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
  .stat-card{border:1px solid #e6ebf4;border-radius:12px;padding:12px 16px;min-width:130px;border-top:3px solid #7ffa88}
  .stat-card.green{border-top-color:#4ade80}
  .stat-card.gold{border-top-color:#fbbf24}
  .stat-card.blue{border-top-color:#0ea5e9}
  .stat-label{font-size:9px;font-weight:800;text-transform:uppercase;color:#5e625f;margin-bottom:4px;letter-spacing:1px}
  .stat-value{font-size:23px;font-weight:900;color:#0a0a0a;font-family:Impact,'Arial Black',sans-serif}
  .stat-hint{font-size:10px;color:#5e625f;margin-top:3px}
  .chart-card{border:1px solid #e6ebf4;border-radius:12px;padding:14px 16px;margin-bottom:16px}
  .chart-title{font-size:9px;font-weight:800;text-transform:uppercase;color:#5e625f;margin-bottom:10px;letter-spacing:1.5px}
  .chart-card svg{width:100%}
  .table-card{border:1px solid #e6ebf4;border-radius:12px;overflow:hidden;margin-bottom:14px}
  .table-header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;background:#f6f8fc;border-bottom:1px solid #e6ebf4}
  .table-header h3{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#0a0a0a;margin:0}
  .table-header .btn-secondary,.table-header button{display:none}
  table{width:100%;border-collapse:collapse;font-size:11.5px}
  thead th{background:#0a0a0a;color:#fff;padding:8px 10px;text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.5px}
  tbody td{padding:7px 10px;border-bottom:1px solid #eef1f6;vertical-align:middle}
  tbody tr:nth-child(even){background:#fafbfd}
  .badge{display:inline-block;padding:2px 8px;border-radius:100px;font-size:9.5px;font-weight:800;text-transform:uppercase}
  .badge-active,.badge-paid{background:#dcfce7;color:#166534}
  .badge-expired,.badge-locked{background:#fee2e2;color:#991b1b}
  .badge-pending{background:#fef3c7;color:#92400e}
  .badge-expiring{background:#fde68a;color:#92400e}
  .badge-suspended{background:#fecaca;color:#991b1b}
  .badge-archived{background:#e2e8f0;color:#475569}
  .report-doc-head{display:none}
  .empty-state{text-align:center;padding:36px 16px;color:#5e625f;font-size:12px}
  .print-foot{margin-top:18px;padding-top:12px;border-top:1px solid #e6ebf4;display:flex;justify-content:space-between;gap:12px;font-size:10px;color:#5e625f}
  .print-foot strong{color:#0a0a0a}
  @media print{button{display:none}thead th{-webkit-print-color-adjust:exact;print-color-adjust:exact}tbody tr:nth-child(even){-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body><div class="page">
  <div class="print-header">
    <div class="ph-brand">
      <div class="ph-logo">F</div>
      <div><div class="ph-name">FITCORE <em>GMS</em></div><div class="ph-tag">Gym Management System</div></div>
    </div>
    <div class="ph-meta"><strong>Generated</strong>: ${new Date().toLocaleString()}<br><strong>By</strong>: ${esc(currentUser.name)} (${esc(currentUser.role)})</div>
  </div>
  ${output.innerHTML}
  <div class="print-foot">
    <div><strong>FitCore GMS</strong> &mdash; Gym Management System</div>
    <div>Printed ${new Date().toLocaleString()}</div>
  </div>
  </div></body></html>`);
  doc.close();
  const printNow=function(){
    try{
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }catch(e){toast('Print failed. Please try again.','error');}
    setTimeout(function(){if(frame.parentNode)frame.parentNode.removeChild(frame);},60000);
  };
  if(doc.readyState==='complete')setTimeout(printNow,250);
  else frame.onload=function(){setTimeout(printNow,250);};
}
// Neutralize spreadsheet formula injection: cells starting with = + - @ (or tab/CR) get a
// leading apostrophe so Excel/Sheets treat them as text, not formulas.
function csvCell(v){
  const s=String(v==null?'':v);
  const guarded=/^[=+\-@\t\r]/.test(s)?'\''+s:s;
  return '"'+guarded.replace(/"/g,'""')+'"';
}
function exportCSV(type){
  let csv='';let filename='';
  if(type==='revenue'){
    const data=Payments.all();
    const walkins=Walkins.all();
    csv='ID,Name,Plan/Type,Amount,Date,Method,Category\n'
      +data.map(p=>`${csvCell(p.id)},${csvCell(p.memberName)},${csvCell(p.planName)},${p.amount},${p.date},${csvCell(p.method)},Membership`).join('\n')
      +'\n'+walkins.map(w=>`${csvCell(w.id)},${csvCell(w.visitorName)},Walk-In,${w.fee},${w.date},Cash,Walk-In`).join('\n');
    filename='revenue_report.csv';
  } else if(type==='attendance'){
    const data=Attendance.all();
    csv='Date,Check-In,Check-Out,Duration,Member ID,Recorded By\n'+data.map(a=>`${a.date},${csvCell(a.checkIn||a.time||'')},${csvCell(a.checkOut||'')},${csvCell(a.duration||'')},${csvCell(a.memberId)},${csvCell(a.recordedBy||'')}`).join('\n');
    filename='attendance_report.csv';
  } else if(type==='trainer'){
    const sessions=Sessions.all();
    const users=Users.all();
    const members=Members.all();
    csv='Date,Trainer,Time,Session Type,Member,Status,Created By,Edited By,Notes\n'+sessions.map(s=>{
      const trainer=users.find(u=>u.id===s.trainerId);
      const member=members.find(m=>m.id===s.memberId);
      const time=s.time||(s.startTime?s.startTime+(s.endTime?' - '+s.endTime:''):'');
      return `${s.date},${csvCell(trainer?trainer.name:'')},${csvCell(time)},${csvCell(s.type||s.sessionType||'')},${csvCell(member?member.name:(s.memberName||''))},${csvCell(s.status)},${csvCell(s.createdBy||'')},${csvCell(s.editedBy||'')},${csvCell(s.notes||'')}`;
    }).join('\n');
    filename='trainer_schedule_report.csv';
  } else {
    const data=Members.all().filter(m=>m.status!=='Archived');
    csv='ID,Name,Plan ID,Start Date,Expiry Date,Status,Created By,Edited By\n'+data.map(m=>`${csvCell(m.id)},${csvCell(m.name)},${csvCell(m.planId||'')},${m.startDate},${m.expiryDate},${csvCell(m.status)},${csvCell(m.createdBy||'')},${csvCell(m.editedBy||'')}`).join('\n');
    filename='membership_report.csv';
  }
  const blob=new Blob([csv],{type:'text/csv'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
  toast('CSV exported successfully.');
}

// ======================================================================
// PANEL: USER MANAGEMENT
// ======================================================================
let userSearch='';
let userRoleTab='staff';
function renderUsers(){
  const el=document.getElementById('panelUsers');
  const counts={admin:0,staff:0,trainer:0};
  Users.all().forEach(u=>{if(counts[u.role]!==undefined)counts[u.role]++;});
  const tab=(role,label)=>`<button class="rtab ${userRoleTab===role?'active':''}" onclick="userRoleTab='${role}';renderUsers()">${label} <span class="user-tab-count">(${counts[role]})</span></button>`;
  const searchPh={admin:'Admins',staff:'Staff',trainer:'Trainers'}[userRoleTab]||'users';
  el.innerHTML=`
  <div class="report-tabs">
    ${tab('admin','Admins')}
    ${tab('staff','Staff')}
    ${tab('trainer','Trainers')}
  </div>
  <div class="page-actions">
    <input class="search-input" placeholder="Search ${searchPh}…" value="${esc(userSearch)}" oninput="userSearch=this.value;refreshUserTable()">
    <button class="btn-primary" onclick="openUserModal()">+ Add User</button>
  </div>
  <div class="table-card" id="userTableCard"></div>`;
  refreshUserTable();
  updatePendingBadge();
}
function refreshUserTable(){
  const label={admin:'Admins',staff:'Staff',trainer:'Trainers'}[userRoleTab]||'Users';
  const singular={admin:'admin',staff:'staff',trainer:'trainer'}[userRoleTab]||'user';
  let data=Users.all().filter(u=>u.role===userRoleTab);
  if(userSearch){const s=userSearch.toLowerCase();data=data.filter(u=>u.name.toLowerCase().includes(s)||u.username.toLowerCase().includes(s));}
  const rows=data.length?data.map(u=>{
    const roleCls={admin:'badge-admin',staff:'badge-staff',trainer:'badge-trainer'}[u.role]||'';
    const statusCls=u.status==='locked'?'badge-locked':u.status==='pending'?'badge-pending':'badge-active';
    const statusLabel=u.status==='locked'?'Locked':u.status==='pending'?'Pending':'Active';
    const trainerExtra=u.role==='trainer'&&u.specializations?`<div style="font-size:10px;color:var(--orange);margin-top:2px">🏋️ ${Array.isArray(u.specializations)?u.specializations.slice(0,2).map(esc).join(', ')+(u.specializations.length>2?' +more':''):''}</div>`:'';
    const trainerHours=u.role==='trainer'&&u.availableFrom?`<div style="font-size:10px;color:var(--gray-500);margin-top:1px">⏰ ${esc(u.availableFrom)}–${esc(u.availableTo||'')}</div>`:'';
    return`<tr>
      <td><div style="display:flex;align-items:center;gap:8px"><div class="user-avatar avatar-${u.role}" style="width:28px;height:28px;font-size:10px;${u.avatar?'background:url(\''+u.avatar+'\') center/cover;background-size:cover;':''}">${u.avatar?'':esc(initials(u.name))}</div><div><div>${esc(u.name)}${u.coachName&&u.coachName!==u.name?` <span style="font-size:10px;color:var(--gray-500)">(${esc(u.coachName)})</span>`:''}</div><div style="font-size:11px;color:var(--gray-500);font-family:monospace;margin-top:2px">${esc(u.contact||'—')}</div>${trainerExtra}${trainerHours}</div></div></td>
      <td>${esc(u.username)}</td>
      <td><span class="badge ${roleCls}">${esc(u.role)}</span></td>
      <td>${formatDate(u.createdAt||today())}</td>
      <td><span class="badge ${statusCls}">${statusLabel}</span></td>
      <td><div class="td-actions">
        <button class="btn-icon" title="View" onclick="viewUser('${u.id}')">👤</button>
        <button class="btn-icon" title="Edit" onclick="openUserModal('${u.id}')">✎</button>
        ${u.status==='pending'?`<button class="btn-icon" title="Approve" style="color:var(--green)" onclick="approveUser('${u.id}')">✔</button>`:`<button class="btn-icon" title="${u.status==='locked'?'Unlock':'Lock'}" onclick="toggleUserLock('${u.id}')">${u.status==='locked'?'○':'●'}</button>`}
        ${u.id===currentUser.id?`<button class="btn-icon" title="Cannot delete your own account" style="opacity:.3;cursor:not-allowed;color:var(--gray-500);border-color:rgba(255,255,255,.08)" disabled>✕</button>`:`<button class="btn-icon" title="Delete User" style="color:var(--red);border-color:rgba(239,68,68,.25);background:rgba(239,68,68,.08)" onmouseover="this.style.background='var(--red)';this.style.color='#fff'" onmouseout="this.style.background='rgba(239,68,68,.08)';this.style.color='var(--red)'" onclick="deleteUser('${u.id}')">✕</button>`}
      </div></td>
    </tr>`;}).join(''):`<tr><td colspan="6"><div class="empty-state"><div class="empty-icon">—</div><p>No ${singular} found</p></div></td></tr>`;
  document.getElementById('userTableCard').innerHTML=`
    <div class="table-header"><h3>${label}</h3></div>
    <div style="overflow-x:auto"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Created</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
let editingUserId=null;
function openUserModal(id=null){
  editingUserId=id;
  document.getElementById('userModalTitle').textContent=id?'Edit User':'Add User';
  document.getElementById('userFormError').style.display='none';
  if(id){
    const u=Users.one(id);if(!u)return;
    document.getElementById('uf_name').value=u.name;document.getElementById('uf_contact').value=u.contact||'';document.getElementById('uf_user').value=u.username;
    document.getElementById('uf_pass').value='';document.getElementById('uf_pass2').value='';
    document.getElementById('uf_role').value=u.role==='admin'?'staff':u.role;
    // Hide role field for admin users — role cannot be changed
    const roleRow=document.getElementById('uf_role_row');
    if(roleRow)roleRow.style.display=u.role==='admin'?'none':'block';
  } else {
    ['uf_name','uf_contact','uf_user','uf_pass','uf_pass2'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('uf_role').value=userRoleTab;
    const roleRow=document.getElementById('uf_role_row');
    if(roleRow)roleRow.style.display='block';
  }
  openModal('userModal');
}
async function saveUser(){
  const name=document.getElementById('uf_name').value.trim();
  const contact=document.getElementById('uf_contact').value.trim();
  const username=document.getElementById('uf_user').value.trim();
  const pass=document.getElementById('uf_pass').value;
  const pass2=document.getElementById('uf_pass2').value;
  const role=document.getElementById('uf_role').value;
  const err=document.getElementById('userFormError');
  err.style.display='none';
  if(!name||!username||(!editingUserId&&!pass)||!role){err.textContent='Please fill in all required fields.';err.style.display='block';return;}
  if(contact&&!/^09\d{9}$/.test(contact)){err.textContent='Please enter a valid 11-digit contact number (e.g. 09171234567).';err.style.display='block';return;}
  if(pass&&pass!==pass2){err.textContent='Passwords do not match. Please re-enter your password correctly.';err.style.display='block';return;}
  const users=Users.all();
  const dup=users.find(u=>u.username===username&&u.id!==editingUserId);
  if(dup){err.textContent='Username already taken. Please choose a different username.';err.style.display='block';return;}
  // Online mode: passwords are managed by Firebase Auth
  let authEmail=null;
  if(window.GMSFB&&GMSFB.enabled){
    if(editingUserId&&pass){err.textContent='Changing another user\u2019s password is not supported in online mode.';err.style.display='block';return;}
    if(!editingUserId){
      authEmail=GMSFB.authEmailFor({username:username});
      const r=await GMSFB.createUserCreds(authEmail,pass);
      if(!r.ok){err.textContent=r.error;err.style.display='block';return;}
    }
  }
  if(editingUserId){
    const idx=users.findIndex(u=>u.id===editingUserId);
    if(idx>-1){users[idx].name=name;users[idx].contact=contact;users[idx].username=username;users[idx].role=role;if(pass&&!authEmail){users[idx].passwordHash=hashPassword(pass);delete users[idx].password;}}
    Users.save(users);toast('User updated.');
  } else {
    if(authEmail)users.push({id:uid(),name,contact,username,authEmail,role,status:'active',createdAt:today()});
    else users.push({id:uid(),name,contact,username,passwordHash:hashPassword(pass),role,status:'active',createdAt:today()});
    Users.save(users);toast('User created.');
  }
  userRoleTab=role;
  closeModal('userModal');renderUsers();
}
function toggleUserLock(id){
  if(id===currentUser.id){toast('You cannot lock your own account.','error');return;}
  const users=Users.all();const idx=users.findIndex(u=>u.id===id);
  if(idx<0)return;
  users[idx].status=users[idx].status==='locked'?'active':'locked';
  Users.save(users);toast(`User ${users[idx].status==='locked'?'locked':'unlocked'}.`,'info');renderUsers();
}
function approveUser(id){
  const users=Users.all();const idx=users.findIndex(u=>u.id===id);
  if(idx<0)return;
  users[idx].status='active';
  Users.save(users);toast('Account approved. User can now log in.','success');renderUsers();updatePendingBadge();
}
let _upPassVisible=false;let _upPassVal='';
function viewUser(id){
  const u=Users.one(id);if(!u)return;
  _upPassVisible=false;_upPassVal=u.passwordHash||'';
  const roleMap={admin:'Admin',staff:'Staff',trainer:'Trainer'};
  const roleColors={admin:'var(--orange)',staff:'#d7ddd8',trainer:'var(--green)'};
  const avatarCls={admin:'avatar-admin',staff:'avatar-staff',trainer:'avatar-trainer'}[u.role]||'avatar-staff';
  const tag=roleMap[u.role]||u.role;
  const col=roleColors[u.role]||'var(--gray-300)';
  document.getElementById('up_avatar').className='user-avatar '+avatarCls;
  document.getElementById('up_avatar').style.cssText='width:64px;height:64px;font-size:20px;font-weight:800;border-radius:14px;flex-shrink:0';
  document.getElementById('up_avatar').textContent=initials(u.name);
  document.getElementById('up_name').textContent=u.name;
  document.getElementById('up_username').textContent='@'+u.username;
  document.getElementById('up_role_badge').innerHTML=`<span class="badge" style="background:rgba(255,255,255,.07);color:${col};font-size:10px">${tag}</span>`;
  document.getElementById('up_contact').textContent=u.contact||'—';
  document.getElementById('up_user2').textContent=u.username;
  document.getElementById('up_pass').textContent='••••••••';
  document.getElementById('up_status').innerHTML=`<span class="badge ${u.status==='locked'?'badge-locked':'badge-active'}">${u.status==='locked'?'Locked':'Active'}</span>`;
  document.getElementById('up_created').textContent=formatDate(u.createdAt||today());
  document.getElementById('up_edit_btn').onclick=function(){closeModal('userProfileModal');openUserModal(id);};
  // Trainer extra info
  let trainerSection=document.getElementById('up_trainer_section');
  if(!trainerSection){
    trainerSection=document.createElement('div');
    trainerSection.id='up_trainer_section';
    document.getElementById('up_edit_btn').parentNode.insertBefore(trainerSection,document.getElementById('up_edit_btn'));
  }
  if(u.role==='trainer'&&(u.coachName||u.specializations||u.availableDays)){
    const specs=Array.isArray(u.specializations)?u.specializations.join(', '):'—';
    const days=Array.isArray(u.availableDays)?u.availableDays.join(', '):'—';
    const hours=(u.availableFrom&&u.availableTo)?`${u.availableFrom} – ${u.availableTo}`:'—';
    trainerSection.style.display='block';
    trainerSection.innerHTML=`
      <div style="margin:12px 0;border-top:1px solid rgba(179,188,181,.2);padding-top:12px">
        <div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:var(--orange);margin-bottom:10px">🏋️ Trainer Profile</div>
        <div style="font-size:12px;line-height:2;color:var(--gray-300)">
          <div><span style="color:var(--gray-500);width:110px;display:inline-block">Coach Name:</span><strong style="color:var(--white)">${esc(u.coachName||'—')}</strong></div>
          <div><span style="color:var(--gray-500);width:110px;display:inline-block">Best For:</span><strong style="color:var(--white)">${esc(specs)}</strong></div>
          <div><span style="color:var(--gray-500);width:110px;display:inline-block">Days:</span><strong style="color:var(--white)">${esc(days)}</strong></div>
          <div><span style="color:var(--gray-500);width:110px;display:inline-block">Hours:</span><strong style="color:var(--orange)">${esc(hours)}</strong></div>
          ${u.bio?`<div style="margin-top:8px;background:rgba(255,255,255,.04);border-radius:7px;padding:9px 12px;font-size:12px;color:var(--gray-300);line-height:1.6;border:1px solid rgba(255,255,255,.07)">${esc(u.bio)}</div>`:''}
        </div>
      </div>`;
  } else {
    trainerSection.style.display='none';trainerSection.innerHTML='';
  }
  openModal('userProfileModal');
}
function toggleUpPass(){
  _upPassVisible=!_upPassVisible;
  document.getElementById('up_pass').textContent=_upPassVisible?_upPassVal:'••••••••';
  document.getElementById('up_pass_btn').innerHTML=_upPassVisible?iconSvg('eyeOff',15):iconSvg('eye',15);
}
function deleteUser(id){
  if(id===currentUser.id){toast('You cannot delete your own account.','error');return;}
  const u=Users.one(id);
  const roleColors={admin:'var(--orange)',staff:'#d7ddd8',trainer:'var(--green)'};
  const roleColor=u?roleColors[u.role]||'var(--gray-300)':'var(--gray-300)';
  const detail=u?`<div style="margin-top:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.8">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,.06)">
      <div class="user-avatar avatar-${u.role}" style="width:36px;height:36px;font-size:12px;font-weight:800;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;${u.avatar?'background:url(\''+u.avatar+'\') center/cover;background-size:cover;':''}">${u.avatar?'':initials(u.name)}</div>
      <div><div style="font-weight:700;color:var(--white);font-size:13px">${esc(u.name)}</div><div style="color:var(--gray-500);font-size:11px;font-family:monospace">@${esc(u.username)}</div></div>
      <span style="margin-left:auto;font-size:9px;font-weight:800;padding:3px 8px;border-radius:4px;background:rgba(255,255,255,.07);color:${roleColor};text-transform:uppercase">${esc(u.role)}</span>
    </div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Contact:</span> <strong style="color:var(--white)">${esc(u.contact||'—')}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Status:</span> <strong style="color:${u.status==='locked'?'var(--red)':'var(--green)'}">${u.status==='locked'?'Locked':'Active'}</strong></div>
    <div><span style="color:var(--gray-500);width:80px;display:inline-block">Created:</span> <strong style="color:var(--white)">${formatDate(u.createdAt||today())}</strong></div>
  </div><div style="margin-top:10px;font-size:11px;color:var(--red);background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.15);border-radius:6px;padding:8px 12px">⚠ This will permanently remove the user and cannot be undone.</div>`:'';
  openConfirm('Delete User',`Are you sure you want to delete this user?${detail}`,()=>{
    const users=Users.all().filter(x=>x.id!==id);Users.save(users);toast('User deleted.');renderUsers();updatePendingBadge();
  });
}

// ======================================================================
// CHECK-IN / CHECK-OUT
// ======================================================================
// ---- CHECK-IN search helpers ----
let _ciMembers=[];
function openCheckin(){
  _ciMembers=Members.all().filter(m=>m.status!=='Archived'&&m.status!=='Expired');
  document.getElementById('ci_search').value='';
  document.getElementById('ci_member').value='';
  document.getElementById('ci_list').style.display='none';
  document.getElementById('ci_selected').style.display='none';
  document.getElementById('checkinError').style.display='none';
  openModal('checkinModal');
  setTimeout(()=>document.getElementById('ci_search').focus(),100);
}
function filterCheckinList(val){
  const list=document.getElementById('ci_list');
  document.getElementById('ci_member').value='';
  document.getElementById('ci_selected').style.display='none';
  if(!val.trim()){list.style.display='none';return;}
  const q=val.toLowerCase();
  const matches=_ciMembers.filter(m=>m.name.toLowerCase().includes(q)||m.id.toLowerCase().includes(q)).slice(0,10);
  if(!matches.length){list.innerHTML='<div style="padding:10px 14px;color:var(--gray-500);font-size:13px">No members found</div>';list.style.display='block';return;}
  list.innerHTML=matches.map(m=>`<div style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid rgba(255,255,255,.05);display:flex;justify-content:space-between;align-items:center"
    onmousedown="selectCheckinMember('${m.id}','${esc(m.name).replace(/'/g,"&#39;")}','${m.status}')"
    onmouseover="this.style.background='rgba(127,250,136,.08)'" onmouseout="this.style.background=''">
    <span>${esc(m.name)}</span>
    <span style="font-size:10px;color:var(--gray-500)">${esc(m.id)}</span>
  </div>`).join('');
  list.style.display='block';
}
function selectCheckinMember(id,name,status){
  document.getElementById('ci_member').value=id;
  document.getElementById('ci_search').value=name;
  document.getElementById('ci_list').style.display='none';
  const sel=document.getElementById('ci_selected');
  sel.innerHTML=`✅ <strong>${esc(name)}</strong> <span style="font-size:11px;color:var(--gray-500)">${esc(id)}</span>`;
  sel.style.display='block';
}
function doCheckin(){
  const memberId=document.getElementById('ci_member').value;
  const err=document.getElementById('checkinError');
  err.style.display='none';
  if(!memberId){err.textContent='Please search and select a member first.';err.style.display='block';return;}
  const today_=today();
  const attendance=Attendance.all();
  const existing=attendance.find(a=>a.memberId===memberId&&a.date===today_);
  if(existing&&existing.checkOut){err.textContent='Member already completed attendance today.';err.style.display='block';return;}
  if(existing&&!existing.checkOut){err.textContent='Member already checked in. Use Check-Out instead.';err.style.display='block';return;}
  const now=new Date();
  const time=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const ts=now.getTime();
  attendance.push({id:uid(),memberId,date:today_,time,checkIn:time,checkInTs:ts,checkOut:null,checkOutTs:null,duration:null,recordedBy:currentUser.name});
  Attendance.save(attendance);
  toast('Check-in recorded successfully.');closeModal('checkinModal');
  if(document.getElementById('panelDashboard').classList.contains('active'))renderDashboard();
}

// ---- CHECK-OUT dropdown helpers ----
let _coAttendance=[];
function openCheckout(){
  const today_=today();
  const attendance=Attendance.all();
  const members=Members.all();
  _coAttendance=attendance.filter(a=>a.date===today_&&a.checkIn&&!a.checkOut).map(a=>{
    const m=members.find(x=>x.id===a.memberId);
    return{...a,memberName:m?m.name:'Unknown'};
  });
  document.getElementById('co_search').value='';
  document.getElementById('co_member').value='';
  document.getElementById('co_list').style.display='none';
  document.getElementById('co_selected').style.display='none';
  document.getElementById('checkoutError').style.display='none';
  openModal('checkoutModal');
  setTimeout(()=>document.getElementById('co_search').focus(),120);
}
function filterCheckoutList(val){
  const list=document.getElementById('co_list');
  document.getElementById('co_member').value='';
  document.getElementById('co_selected').style.display='none';
  if(!val.trim()){list.style.display='none';return;}
  const q=val.toLowerCase();
  const matches=_coAttendance.filter(a=>a.memberName.toLowerCase().includes(q)).slice(0,10);
  if(!matches.length){
    list.innerHTML='<div style="padding:10px 14px;color:var(--gray-500);font-size:13px">No checked-in members found</div>';
    list.style.display='block';return;
  }
  list.innerHTML=matches.map(a=>`<div style="padding:9px 14px;cursor:pointer;font-size:13px;border-bottom:1px solid rgba(255,255,255,.05);display:flex;justify-content:space-between;align-items:center"
    onmousedown="selectCheckoutMember('${a.id}','${esc(a.memberName).replace(/'/g,"&#39;")}','${esc(a.checkIn)}')"
    onmouseover="this.style.background='rgba(179,188,181,.08)'" onmouseout="this.style.background=''">
    <span>${esc(a.memberName)}</span>
    <span style="font-size:10px;color:var(--gray-500)">In: ${esc(a.checkIn)}</span>
  </div>`).join('');
  list.style.display='block';
}
function selectCheckoutMember(attId,name,checkIn){
  document.getElementById('co_member').value=attId;
  document.getElementById('co_search').value=name;
  document.getElementById('co_list').style.display='none';
  const sel=document.getElementById('co_selected');
  sel.innerHTML='&#x1F6AA; <strong>'+esc(name)+'</strong> <span style="font-size:11px;color:var(--gray-500)">Checked in: '+esc(checkIn)+'</span>';
  sel.style.display='block';
}

function doCheckout(){
  const attId=document.getElementById('co_member').value;
  const err=document.getElementById('checkoutError');
  err.style.display='none';
  if(!attId){err.textContent='Please search and select a checked-in member first.';err.style.display='block';return;}
  const attendance=Attendance.all();
  const idx=attendance.findIndex(a=>a.id===attId);
  if(idx<0){err.textContent='Record not found.';err.style.display='block';return;}
  const now=new Date();
  const time=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const ts=now.getTime();
  const inTs=attendance[idx].checkInTs||ts;
  const durMs=ts-inTs;
  const durMins=Math.round(durMs/60000);
  const hrs=Math.floor(durMins/60);const mins=durMins%60;
  const duration=hrs>0?`${hrs}h ${mins}m`:`${mins}m`;
  attendance[idx].checkOut=time;attendance[idx].checkOutTs=ts;attendance[idx].duration=duration;
  Attendance.save(attendance);
  toast(`Check-out recorded. Duration: ${duration}`);closeModal('checkoutModal');
  if(document.getElementById('panelDashboard').classList.contains('active'))renderDashboard();
}

// ======================================================================
// CLOSE MODAL ON BACKDROP CLICK
// ======================================================================
document.querySelectorAll('.modal-overlay').forEach(el=>{
  el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('open');});
});

// ======================================================================
// INIT
// ======================================================================
function updateHeroMemberCount(){
  const el=document.getElementById('heroMemberCount');
  if(!el)return;
  const count=Members.all().filter(m=>m.status!=='Archived').length;
  el.setAttribute('data-count',count);
  if(!el.dataset.counted){el.dataset.counted='1';animateCount(el,count);}
}
(function(){
  seedData();
  updateHeroMemberCount();
  initHeroStats();
  initReveals();
  initCursorGlow();
  initProgressBar();
  const sess=getSession();
  if(sess){currentUser=sess;loadApp();}
})();

// ======================================================================
// ACTIVITY LOG
// ======================================================================
function logActivity(action,category,detail,extra){
  const log=ActivityLog.all()||[];
  log.unshift({id:'ACT'+Date.now(),action,category,detail,extra:extra||'',
    by:currentUser?currentUser.name:'System',byUsername:currentUser?currentUser.username:'',
    byRole:currentUser?currentUser.role:'',at:new Date().toISOString()});
  if(log.length>500)log.length=500;
  ActivityLog.save(log);
}
// ======================================================================
// MOBILE RESPONSIVE HELPERS
// ======================================================================
function toggleMobileMenu(){
  const btn=document.getElementById('lnHamburger');
  const menu=document.getElementById('lnMobileMenu');
  if(btn&&menu){btn.classList.toggle('open');menu.classList.toggle('open');}
}
function closeMobileMenu(){
  const btn=document.getElementById('lnHamburger');
  const menu=document.getElementById('lnMobileMenu');
  if(btn)btn.classList.remove('open');
  if(menu)menu.classList.remove('open');
}
function toggleSidebar(){
  const sb=document.getElementById('appSidebar');
  const ov=document.getElementById('sidebarOverlay');
  if(sb){sb.classList.toggle('mobile-open');}
  if(ov){ov.classList.toggle('open');}
}
function closeSidebar(){
  const sb=document.getElementById('appSidebar');
  const ov=document.getElementById('sidebarOverlay');
  if(sb)sb.classList.remove('mobile-open');
  if(ov)ov.classList.remove('open');
}
// Close sidebar on nav item click (mobile)
document.addEventListener('click',function(e){
  if(window.innerWidth<=768&&e.target.closest('.nav-item')){closeSidebar();}
});
// ======================================================================
// COUNTRY PHONE PICKER
// ======================================================================
const COUNTRIES=[
  {flag:'PH',name:'Philippines',code:'+63'},
  {flag:'US',name:'United States',code:'+1'},
  {flag:'GB',name:'United Kingdom',code:'+44'},
  {flag:'AU',name:'Australia',code:'+61'},
  {flag:'CA',name:'Canada',code:'+1'},
  {flag:'JP',name:'Japan',code:'+81'},
  {flag:'KR',name:'South Korea',code:'+82'},
  {flag:'CN',name:'China',code:'+86'},
  {flag:'IN',name:'India',code:'+91'},
  {flag:'SG',name:'Singapore',code:'+65'},
  {flag:'MY',name:'Malaysia',code:'+60'},
  {flag:'ID',name:'Indonesia',code:'+62'},
  {flag:'TH',name:'Thailand',code:'+66'},
  {flag:'VN',name:'Vietnam',code:'+84'},
  {flag:'HK',name:'Hong Kong',code:'+852'},
  {flag:'TW',name:'Taiwan',code:'+886'},
  {flag:'NZ',name:'New Zealand',code:'+64'},
  {flag:'AE',name:'UAE',code:'+971'},
  {flag:'SA',name:'Saudi Arabia',code:'+966'},
  {flag:'QA',name:'Qatar',code:'+974'},
  {flag:'BH',name:'Bahrain',code:'+973'},
  {flag:'KW',name:'Kuwait',code:'+965'},
  {flag:'OM',name:'Oman',code:'+968'},
  {flag:'DE',name:'Germany',code:'+49'},
  {flag:'FR',name:'France',code:'+33'},
  {flag:'IT',name:'Italy',code:'+39'},
  {flag:'ES',name:'Spain',code:'+34'},
  {flag:'PT',name:'Portugal',code:'+351'},
  {flag:'NL',name:'Netherlands',code:'+31'},
  {flag:'BE',name:'Belgium',code:'+32'},
  {flag:'CH',name:'Switzerland',code:'+41'},
  {flag:'SE',name:'Sweden',code:'+46'},
  {flag:'NO',name:'Norway',code:'+47'},
  {flag:'DK',name:'Denmark',code:'+45'},
  {flag:'FI',name:'Finland',code:'+358'},
  {flag:'RU',name:'Russia',code:'+7'},
  {flag:'BR',name:'Brazil',code:'+55'},
  {flag:'MX',name:'Mexico',code:'+52'},
  {flag:'AR',name:'Argentina',code:'+54'},
  {flag:'ZA',name:'South Africa',code:'+27'},
  {flag:'NG',name:'Nigeria',code:'+234'},
  {flag:'KE',name:'Kenya',code:'+254'},
  {flag:'GH',name:'Ghana',code:'+233'},
  {flag:'PK',name:'Pakistan',code:'+92'},
  {flag:'BD',name:'Bangladesh',code:'+880'},
  {flag:'LK',name:'Sri Lanka',code:'+94'},
  {flag:'NP',name:'Nepal',code:'+977'},
  {flag:'MM',name:'Myanmar',code:'+95'},
  {flag:'KH',name:'Cambodia',code:'+855'},
  {flag:'BN',name:'Brunei',code:'+673'},
  {flag:'PG',name:'Papua New Guinea',code:'+675'},
];
let selectedCountry=COUNTRIES[0];
function renderCountryList(filter=''){
  const list=document.getElementById('countryList');
  if(!list)return;
  const filtered=filter?COUNTRIES.filter(c=>c.name.toLowerCase().includes(filter.toLowerCase())||c.code.includes(filter)):COUNTRIES;
  list.innerHTML=filtered.map(c=>`<div class="country-item${c.code===selectedCountry.code&&c.name===selectedCountry.name?' selected':''}" onclick="selectCountry('${c.flag}','${c.name}','${c.code}')"><span class="ci-flag">${c.flag}</span><span class="ci-name">${c.name}</span><span class="ci-code">${c.code}</span></div>`).join('');
}
function filterCountries(val){renderCountryList(val);}
function selectCountry(flag,name,code){
  selectedCountry={flag,name,code};
  document.getElementById('phoneFlag').textContent=flag;
  document.getElementById('phoneDialCode').textContent=code;
  closeCountryDrop();
}
function toggleCountryDrop(){
  const drop=document.getElementById('countryDrop');
  const btn=document.getElementById('phoneFlagBtn');
  const isOpen=drop.classList.contains('open');
  if(isOpen){closeCountryDrop();}
  else{drop.classList.add('open');btn.classList.add('open');renderCountryList();document.getElementById('countrySearch').value='';setTimeout(()=>document.getElementById('countrySearch').focus(),50);}
}
function closeCountryDrop(){
  document.getElementById('countryDrop').classList.remove('open');
  document.getElementById('phoneFlagBtn').classList.remove('open');
}
document.addEventListener('click',function(e){
  if(!e.target.closest('.phone-wrap'))closeCountryDrop();
});

// ============================= INIT =============================
// Convert every static emoji in the markup (header, nav, modals, landing)
// into SVG icons the moment the script loads. A MutationObserver keeps the
// rule for any content injected later (table refreshes, dropdowns, toasts).
(()=>{
  iconize(document);
  syncStaticWalkinPrice();
  const iconObserver=new MutationObserver(ms=>{
    for(const m of ms){
      if(!m.addedNodes||!m.addedNodes.length)continue;
      for(const n of m.addedNodes){
        if(n.nodeType===1)iconize(n);
        else if(n.nodeType===3&&n.parentNode)iconize(n.parentNode);
      }
    }
  });
  iconObserver.observe(document.body,{childList:true,subtree:true});
})();
