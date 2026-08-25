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
    _lastCloud:{}, _listeners:[],
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
        var self=this;
        Object.keys(COLMAP).forEach(function(key){
          self.db.collection(COLMAP[key]).onSnapshot(function(snap){self._onSnap(key,snap);},function(err){console.warn('[GMSFB] snapshot',COLMAP[key],err.code);});
        });
        this.ready=true;
        var self=this;
        setTimeout(function(){self.ensureSeededPlans();},2500);
      }catch(e){console.error('[GMSFB] init failed',e);this.enabled=false;}
    },
    // ---------- one-time fresh start on this device ----------
    bootstrapLocal:function(){
      if(localStorage.getItem('gms_fb_fresh')==='2')return;
      Object.keys(COLMAP).forEach(function(k){localStorage.removeItem(k);});
      localStorage.removeItem('gms_login_attempts');
      localStorage.removeItem('gms_seeded');
      localStorage.setItem('gms_fb_fresh','2');
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
        this.ensureSeededAdmin();
        if(storageKey==='gms_plans'){
          var arr=[];try{arr=JSON.parse(localStorage.getItem('gms_plans'))||[];}catch(e){}
          if(!arr.length)this.ensureSeededPlans();
          if(typeof renderExplorePlans==='function')renderExplorePlans();
          var mo=document.getElementById('memberSignup');
          if(mo&&mo.style.display!=='none'&&typeof populateMsPlanSelect==='function'){
            var pick=(typeof _msPlanPicked!=='undefined'&&_msPlanPicked)||(typeof _memberSignupPlanId!=='undefined'&&_memberSignupPlanId)||undefined;
            populateMsPlanSelect(pick);
          }
        }
        var appEl=document.getElementById('app');
        if(appEl&&appEl.classList.contains('active')&&typeof _lastPanel!=='undefined'&&_lastPanel&&typeof renderPanel==='function'){renderPanel(_lastPanel);}
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
      var sec=this.secondary;var self=this;
      return sec.auth().createUserWithEmailAndPassword(email,pass).then(function(cred){
        var uid=cred.user.uid;
        return sec.auth().signOut().then(function(){return{ok:true,uid:uid,email:email};});
      }).catch(function(e){return{ok:false,error:self._mapAuthError(e),code:e&&e.code};});
    },
    createAdmin:function(username,pass,name){
      var self=this;var email=this.authEmailFor({username:username});
      return this.createUserCreds(email,pass).then(function(r){
        if(!r.ok)return r;
        var batch=self.db.batch();
        batch.set(self.db.collection('users').doc('u1'),{id:'u1',name:name,username:username,authEmail:email,role:'admin',status:'active',createdAt:new Date().toISOString().split('T')[0]});
        batch.set(self.db.collection('meta').doc('config'),{adminBootstrapped:true,at:new Date().toISOString()});
        return batch.commit().then(function(){return{ok:true};}).catch(function(e){return{ok:false,error:'Database error: '+e.code};});
      });
    },
    // ---------- built-in admin (admin / admin123) ----------
    // Seeds the default admin account into Firebase on first boot so the
    // system is usable immediately. Idempotent: skips if an admin exists.
    _adminSeedTried:false,
    adminAuthEmail:'admin@fitcoregym.local',
    ensureSeededAdmin:function(){
      if(this._adminSeedTried)return;
      var users=[];try{users=JSON.parse(localStorage.getItem('gms_users'))||[];}catch(e){}
      if(users.some(function(u){return u.role==='admin';})){this._adminSeedTried=true;return;}
      this._adminSeedTried=true;
      var self=this;var email=this.adminAuthEmail;
      var wasSignedIn=!!this.auth.currentUser;
      var adminDoc={id:'u1',name:'System Admin',username:'admin',authEmail:email,role:'admin',status:'active',contact:'09150435696',createdAt:new Date().toISOString().split('T')[0]};
      this.secondary.auth().createUserWithEmailAndPassword(email,'admin123').then(function(){
        // Authenticate the DEFAULT app so security rules allow the write
        return self.auth.signInWithEmailAndPassword(email,'admin123').then(function(){
          var batch=self.db.batch();
          batch.set(self.db.collection('users').doc('u1'),adminDoc);
          batch.set(self.db.collection('meta').doc('config'),{adminBootstrapped:true,at:new Date().toISOString()});
          return batch.commit();
        }).then(function(){if(!wasSignedIn)return self.auth.signOut();});
      }).catch(function(e){
        // Auth user may already exist (e.g. previous attempt) — just ensure the profile doc
        if(e&&e.code==='auth/email-already-in-use'){
          self.auth.signInWithEmailAndPassword(email,'admin123').then(function(){
            return self.db.collection('users').doc('u1').set(adminDoc,{merge:true});
          }).then(function(){if(!wasSignedIn)return self.auth.signOut();}).catch(function(){});
        }
      });
    },
    // ---------- default membership plans (required for member signup) ----------
    _plansSeedTried:false,
    ensureSeededPlans:function(){
      if(this._plansSeedTried)return;
      var plans=[];try{plans=JSON.parse(localStorage.getItem('gms_plans'))||[];}catch(e){}
      if(plans.length){this._plansSeedTried=true;return;}
      this._plansSeedTried=true;
      var self=this;var wasSignedIn=!!this.auth.currentUser;
      var defaults=[
        {id:'pl1',name:'Basic',price:500,duration:1,sessions:8,benefits:'Gym access\nLocker use',status:'Active'},
        {id:'pl2',name:'Standard',price:900,duration:1,sessions:16,benefits:'Gym access\nLocker use\n1 trainer session',status:'Active'},
        {id:'pl3',name:'Premium',price:1500,duration:3,sessions:'Unlimited',benefits:'Full access\nPriority trainer\nFree assessment',status:'Active'}
      ];
      this.auth.signInWithEmailAndPassword(this.adminAuthEmail,'admin123').then(function(){
        var batch=self.db.batch();
        defaults.forEach(function(p){batch.set(self.db.collection('plans').doc(p.id),p);});
        return batch.commit();
      }).then(function(){if(!wasSignedIn)return self.auth.signOut();})
        .catch(function(e){
          console.warn('[GMSFB] plan seed',e&&e.code);
          if(!wasSignedIn){try{self.auth.signOut();}catch(_){}}
          // Admin account may not exist yet on very first boot — retry shortly
          var c=e&&e.code||'';
          if(self._plansRetry<2&&(c==='auth/user-not-found'||c==='auth/invalid-credential'||c==='auth/invalid-login-credentials')){
            self._plansRetry=(self._plansRetry||0)+1;
            setTimeout(function(){self._plansSeedTried=false;self.ensureSeededPlans();},3000);
          }
        });
    },
    // Resolves once an admin account is present in the local cache (waits for
    // the cloud snapshot / seeding so an immediate admin login never misses).
    ensureAdminReady:function(){
      var self=this;
      function adminInCache(){
        var u=[];try{u=JSON.parse(localStorage.getItem('gms_users'))||[];}catch(e){}
        return u.some(function(x){return x.role==='admin';});
      }
      if(adminInCache())return Promise.resolve(true);
      this.ensureSeededAdmin();
      return new Promise(function(res){
        var tries=0;
        var t=setInterval(function(){
          tries++;
          if(adminInCache()||tries>15){clearInterval(t);res(adminInCache());}
        },300);
      });
    },
    signOut:function(){try{this.auth.signOut();}catch(e){}}
  };
  window.GMSFB=GMSFB;
  GMSFB.init();
})();
