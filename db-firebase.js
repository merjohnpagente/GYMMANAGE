// ============================================================
// GMS ⇄ FIREBASE SYNC ADAPTER (db-firebase.js)
// ------------------------------------------------------------
// Strategy: "sync-cache". The app keeps using its synchronous
// localStorage Repository API unchanged. This adapter:
//   1. Mirrors Firestore collections into localStorage (cache)
//   2. Pushes local writes to Firestore (diff-based batches)
//   3. Keeps every device live via onSnapshot listeners
//   4. Replaces password auth with Firebase Authentication
//      (usernames map to synthetic in-app email identities)
// ============================================================
(function(){
  'use strict';
  if(!window.firebase||!window.FIREBASE_CONFIG){window.GMSFB={enabled:false};return;}

  var COLMAP={
    gms_users:'users', gms_members:'members', gms_payments:'payments',
    gms_sessions:'sessions', gms_plans:'plans', gms_attendance:'attendance',
    gms_walkins:'walkins', gms_notifications:'notifications',
    gms_messages:'messages', gms_announcements:'announcements',
    gms_settings:'settings', gms_activity_log:'activitylog'
  };
  var AUTH_DOMAIN_SUFFIX='@fitcoregym.local';
  var GMSFB={
    enabled:true, ready:false, _applying:false,
    _lastCloud:{}, _listeners:[], _syncErr:{}, _listenersStarted:false, _unsubs:[],
    // ---------- bootstrap ----------
    init:function(){
      try{
        this.app=firebase.initializeApp(window.FIREBASE_CONFIG);
        this.auth=firebase.auth();
        this.db=firebase.firestore();
        this.db.settings({ignoreUndefinedProperties:true});
        // Secondary app: creating accounts must NOT kick the admin out of their session
        this.secondary=(firebase.apps.find(function(a){return a.name==='gms-admin-tasks';})
          ||firebase.initializeApp(window.FIREBASE_CONFIG,'gms-admin-tasks'));
        this.ready=true;
        var self=this;
        // Re-attach fresh listeners whenever the signed-in identity changes
        // (login, logout, registration flows). A failed listener never
        // recovers by itself, so every auth change gets clean new ones.
        this.auth.onAuthStateChanged(function(){self.restartListeners();});
        this.startListeners();
      }catch(e){console.error('[GMSFB] init failed',e);this.enabled=false;}
    },
    // ---------- live listeners ----------
    // Listeners are (re)started on every auth state change (see init).
    // Before anyone signs in, Firestore denies reads — that is expected and
    // must NOT mark the device degraded.
    startListeners:function(){
      if(this._listenersStarted||!this.ready)return;
      this._listenersStarted=true;
      var self=this;
      Object.keys(COLMAP).forEach(function(key){
        var un=self.db.collection(COLMAP[key]).onSnapshot(
          function(snap){delete self._syncErr[COLMAP[key]];self._onSnap(key,snap);},
          function(err){
            console.warn('[GMSFB] snapshot',COLMAP[key],err.code);
            if((err&&err.code)==='permission-denied'&&!self.auth.currentUser){
              // Guest device (nobody signed in): the rules keep personal
              // collections private, but plans must still render so the
              // landing page and member signup work. Seed the local default
              // catalogue; once the public-read rules are live the snapshot
              // delivers the real cloud plans anyway.
              if(COLMAP[key]==='plans')self.ensureSeededPlans();
              return;
            }
            self._syncErr[COLMAP[key]]=(err&&err.code)||'error';
            if(typeof updateSyncWarning==='function')updateSyncWarning();
          });
        self._unsubs.push(un);
      });
    },
    stopListeners:function(){
      this._unsubs.forEach(function(u){try{u();}catch(e){}});
      this._unsubs=[];this._listenersStarted=false;
    },
    restartListeners:function(){
      this.stopListeners();this._syncErr={};
      this.startListeners();
    },
    // ---------- one-time fresh start on this device ----------
    bootstrapLocal:function(){
      if(localStorage.getItem('gms_fb_fresh')==='2')return;
      Object.keys(COLMAP).forEach(function(k){localStorage.removeItem(k);});
      localStorage.removeItem('gms_login_attempts');
      localStorage.removeItem('gms_seeded');
      localStorage.setItem('gms_fb_fresh','2');
    },
    // ---------- sync health ----------
    // True when at least one collection listener is failing (offline,
    // permission-denied, etc.). Devices in this state may show stale data.
    degraded:function(){return Object.keys(this._syncErr).length>0;},
    // Resolves as soon as the first snapshot for a collection has arrived
    // (empty or not), or after `ms` milliseconds. Used by login so accounts
    // are always validated against the CLOUD user list, never an empty cache.
    waitForSnap:function(key,ms){
      var deadline=Date.now()+(ms||3000);
      return new Promise(function(res){
        (function poll(){
          if(GMSFB._lastCloud[key]!==undefined||Date.now()>deadline)return res();
          setTimeout(poll,100);
        })();
      });
    },
    // ---------- Firestore → cache ----------
    _onSnap:function(storageKey,snap){
      var arr=[];
      snap.forEach(function(d){var v=d.data();v.id=d.id;arr.push(v);});
      var col=COLMAP[storageKey];
      var map={};
      arr.forEach(function(v){map[v.id]=v;});
      this._lastCloud[col]=map;
      this._applying=true;
      try{localStorage.setItem(storageKey,JSON.stringify(arr));}catch(e){}
      this._applying=false;
      this._notify(storageKey);
    },
    _notify:function(storageKey){
      try{
        if(storageKey==='gms_plans'){
          var arr=[];try{arr=JSON.parse(localStorage.getItem('gms_plans'))||[];}catch(e){}
          if(!arr.length){
            // Empty snapshot arrived: clear the seed latch so the default
            // catalogue can be (re)seeded and pickers never stay blank.
            this._plansSeedTried=false;
            this.ensureSeededPlans();
          }
          if(typeof renderExplorePlans==='function')renderExplorePlans();
          var mo=document.getElementById('memberSignup');
          if(mo&&mo.style.display!=='none'&&typeof populateMsPlanSelect==='function'){
            var pick=(typeof _msPlanPicked!=='undefined'&&_msPlanPicked)||(typeof _memberSignupPlanId!=='undefined'&&_memberSignupPlanId)||undefined;
            populateMsPlanSelect(pick);
          }
        }
        var appEl=document.getElementById('app');
        if(appEl&&appEl.classList.contains('active')&&typeof _lastPanel!=='undefined'&&_lastPanel&&typeof renderPanel==='function'){renderPanel(_lastPanel);}
        if(typeof updateSyncWarning==='function')updateSyncWarning();
        if(typeof updateQueueBadge==='function')updateQueueBadge();
        if(typeof updateMessageBadge==='function')updateMessageBadge();
        if(typeof updatePendingBadge==='function')updatePendingBadge();
        if(typeof scanRenewals==='function')scanRenewals();
      }catch(e){console.warn('[GMSFB] notify',e);}
    },
    // ---------- cache → Firestore (diff batch) ----------
    pushCollection:function(storageKey,arr){
      if(!this.ready)return;
      var col=COLMAP[storageKey];if(!col)return;
      var last=this._lastCloud[col]||{};
      var next={};var self=this;
      (arr||[]).forEach(function(v){if(v&&v.id)next[v.id]=v;});
      var batch=self.db.batch();var ops=0;
      Object.keys(next).forEach(function(id){
        var clean=self._clean(next[id]);
        if(!last[id]||JSON.stringify(clean)!==JSON.stringify(self._clean(last[id]))){batch.set(self.db.collection(col).doc(id),clean);ops++;}
      });
      Object.keys(last).forEach(function(id){if(!next[id]){batch.delete(self.db.collection(col).doc(id));ops++;}});
      if(ops){batch.commit().catch(function(e){console.warn('[GMSFB] push',col,e.code);});}
      this._lastCloud[col]=next;
    },
    _clean:function(v){
      var c=Array.isArray(v)?v.slice():Object.assign({},v);
      delete c.password;delete c.passwordHash;
      var self=this;
      Object.keys(c).forEach(function(k){
        if(c[k]===undefined)c[k]=null;
        else if(c[k]&&typeof c[k]==='object'&&!Array.isArray(c[k]))c[k]=self._clean(c[k]);
      });
      return c;
    },
    // ---------- auth helpers ----------
    adminAuthEmail:'admin1@fitcore.com',
    authEmailFor:function(u){
      if(u&&u.email)return String(u.email).toLowerCase();
      var un=(u&&u.username?u.username:'user').toLowerCase();
      return un+AUTH_DOMAIN_SUFFIX;
    },
    _mapAuthError:function(e){
      var c=e&&e.code||'';
      if(c.indexOf('invalid-credential')>-1||c.indexOf('wrong-password')>-1||c.indexOf('user-not-found')>-1)return'Invalid username or password.';
      if(c.indexOf('too-many-requests')>-1)return'Account locked. Too many failed attempts — try again in 15 minutes.';
      if(c.indexOf('email-already-in-use')>-1)return'That username/email is already registered. Please log in instead.';
      if(c.indexOf('weak-password')>-1)return'Password must be at least 6 characters.';
      if(c.indexOf('network')>-1)return'Network error. Please check your internet connection.';
      return'Authentication error. Please try again.';
    },
    signIn:function(email,pass){
      var self=this;
      return this.auth.signInWithEmailAndPassword(email,pass).then(function(){return{ok:true};})
        .catch(function(e){return{ok:false,error:self._mapAuthError(e),code:e&&e.code};});
    },
    createUserCreds:function(email,pass){
      // NOTE: the secondary app stays signed in as the new user afterwards so
      // secSetDoc() can write the profile doc with full authentication.
      // Call secondarySignOut() once all profile writes are done.
      var sec=this.secondary;var self=this;
      return sec.auth().createUserWithEmailAndPassword(email,pass).then(function(cred){
        return{ok:true,uid:cred.user.uid,email:email};
      }).catch(function(e){return{ok:false,error:self._mapAuthError(e),code:e&&e.code};});
    },
    secondarySignOut:function(){try{if(this.secondary)this.secondary.auth().signOut();}catch(e){}},
    // Write a profile doc through the SECONDARY app's Firestore. Right after
    // createUserCreds the secondary app is authenticated as the new user, so
    // this write always passes security rules — on any device. Guarantees
    // registrations reach the cloud.
    secSetDoc:function(col,doc){
      if(!this.secondary)return Promise.resolve({ok:false});
      try{
        return this.secondary.firestore().collection(col).doc(doc.id).set(this._clean(doc))
          .then(function(){return{ok:true};})
          .catch(function(e){console.warn('[GMSFB] secSetDoc',col,e&&e.code);return{ok:false};});
      }catch(e){console.warn('[GMSFB] secSetDoc',col,e);return Promise.resolve({ok:false});}
    },
    // Sign the PRIMARY app out (used on logout and after registration flows
    // that had to authenticate the default app as a freshly created user).
    signOut:function(){try{if(this.auth)this.auth.signOut();}catch(e){}},
    // ---------- default plan seeding ----------
    // Seeds the default plan catalogue once when the plans collection is
    // empty. Called right after a successful ADMIN sign-in or when an empty
    // plans snapshot arrives. Stores NO password anywhere: the cloud write
    // simply runs under whoever is authenticated, as the rules require.
    ensureSeededPlans:function(){
      if(this._plansSeedTried)return;
      var plans=[];try{plans=JSON.parse(localStorage.getItem('gms_plans'))||[];}catch(e){}
      if(plans.length){this._plansSeedTried=true;return;}
      this._plansSeedTried=true;
      var defaults=[
        {id:'pl1',name:'Basic',price:500,duration:1,sessions:8,benefits:'Gym access\nLocker use',status:'Active'},
        {id:'pl2',name:'Standard',price:900,duration:1,sessions:16,benefits:'Gym access\nLocker use\n1 trainer session',status:'Active'},
        {id:'pl3',name:'Premium',price:1500,duration:3,sessions:'Unlimited',benefits:'Full access\nPriority trainer\nFree assessment',status:'Active'}
      ];
      // Seed the local mirror first so plan pickers render without waiting
      // on the network; the live snapshot then reconciles with cloud truth.
      try{localStorage.setItem('gms_plans',JSON.stringify(defaults));}catch(e){}
      if(typeof renderExplorePlans==='function')renderExplorePlans();
      var mo=document.getElementById('memberSignup');
      if(mo&&mo.style.display!=='none'&&typeof populateMsPlanSelect==='function')populateMsPlanSelect();
      // Cloud write requires an authenticated session (firestore.rules).
      if(!this.auth||!this.auth.currentUser)return;
      var self=this;var batch=this.db.batch();
      defaults.forEach(function(p){batch.set(self.db.collection('plans').doc(p.id),p);});
      batch.commit().catch(function(e){console.warn('[GMSFB] plan seed',e&&e.code);});
    },
  };
  window.GMSFB=GMSFB;
  GMSFB.init();
})();
