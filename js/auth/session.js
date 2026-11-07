import { validateAuthConfig } from './config.js';
import { loadAuthSDK } from './provider.js';

const emptyState = () => ({status:'guest',clerkSignedIn:false,convex:'not-connected',profile:null,displayName:'',reason:'',setupRequired:false});
const LOGOUT_INTENT = 'melly-auth-logout-pending-v1';

// Owns only volatile account state. It has no workspace, storage-schema or sync API.
export class AuthSession {
  constructor(config, {loadSDK=loadAuthSDK, env=globalThis, approvedDevUrl=""} = {}) {
    this.config=config; this.approvedDevUrl=approvedDevUrl; this.loadSDK=loadSDK; this.env=env; this.state=emptyState();
    const checked=validateAuthConfig(config, this.approvedDevUrl);if(!checked.ready)this.state={...this.state,setupRequired:true,reason:checked.reason};
    this.listeners=new Set(); this.generation=0; this.client=null; this.sdk=null; this.sessionId=null; this.starting=null;
    try { this.logoutPending=env.localStorage?.getItem(LOGOUT_INTENT)==='true'; } catch { this.logoutPending=false; }
    this.onlineHandler=()=>{ void this.start(true); };
    this.storageHandler=event=>{if(event.key!==LOGOUT_INTENT)return;if(event.newValue==='true'){this.logoutPending=true;this.invalidate();this.publish({status:'error',reason:'SIGN_OUT_PENDING'});}else{this.logoutPending=false;void this.start(true);}};
    this.offlineHandler=()=>{ this.invalidate(); this.publish({status:'offline',reason:'OFFLINE'}); };
  }
  subscribe(listener) { this.listeners.add(listener); listener(this.state); return ()=>this.listeners.delete(listener); }
  publish(patch) { this.state={...this.state,...patch}; for(const receive of this.listeners)receive(this.state); }
  invalidate() {
    ++this.generation; this.sessionId=null;
    const client=this.client; this.client=null;
    if(client) { try { void Promise.resolve(client.close()).catch(()=>{}); } catch { /* Remote state is already discarded. */ } }
    this.publish({clerkSignedIn:false,convex:'not-connected',profile:null,displayName:''});
  }
  async start(force=false) {
    if(this.starting)return this.starting;
    this.starting=this.initialize(force).finally(()=>{this.starting=null;});return this.starting;
  }
  async initialize(force) {
    this.bindNetwork();
    const checked=validateAuthConfig(this.config, this.approvedDevUrl);
    if(!checked.ready){this.invalidate();this.publish({status:this.env.navigator?.onLine===false?'offline':'guest',reason:checked.reason,setupRequired:true});return;}
    if(this.env.__TAURI_INTERNALS__ || !['http:','https:'].includes(this.env.location?.protocol || '')){this.invalidate();this.publish({status:'error',reason:'NATIVE_ORIGIN_UNVERIFIED'});return;}
    this.bindNetwork();
    if(this.env.navigator?.onLine===false){this.offlineHandler();return;}
    if(this.logoutPending){this.publish({status:'error',reason:'SIGN_OUT_PENDING'});return;}
    if(this.sdk){await this.reconcile({session:this.sdk.clerk.session,user:this.sdk.clerk.user},force);return;}
    this.invalidate();const generation=this.generation;this.publish({status:'loading',reason:'LOADING_PROVIDER',setupRequired:false});
    try {
      const sdk=await this.loadSDK(checked.config,this.env);
      await sdk.load();
      if(generation!==this.generation || this.env.navigator?.onLine===false)return;
      this.sdk=sdk;
      this.listenToSDK();
      await this.reconcile({session:sdk.clerk.session,user:sdk.clerk.user});
    } catch {if(generation===this.generation){this.invalidate();this.publish({status:'error',reason:'PROVIDER_UNAVAILABLE'});}}
  }
  listenToSDK() {
    this.removeListener?.();
    this.removeListener=this.sdk.clerk.addListener(resources=>{void this.reconcile(resources);});
  }
  bindNetwork() {
    if(this.networkBound)return;this.networkBound=true;
    this.env.addEventListener?.('storage',this.storageHandler);
    this.env.addEventListener?.('online',this.onlineHandler);this.env.addEventListener?.('offline',this.offlineHandler);
  }
  async reconcile({session,user},force=false) {
    if(this.logoutPending)return;
    if(this.env.navigator?.onLine===false){this.offlineHandler();return;}
    if(!session || !user || session.status!=='active'){
      const expired=!!this.sessionId || (session && session.status!=='active');
      if(!expired && !this.client && this.state.status==='guest')return;
      this.invalidate();this.publish({status:expired?'session-expired':'guest',reason:expired?'SESSION_EXPIRED':''});return;
    }
    if(this.sessionId===session.id && !force)return;
    this.invalidate();this.sessionId=session.id;const generation=this.generation;
    this.publish({status:'signed-in',clerkSignedIn:true,convex:'verifying',displayName:user.fullName || 'Melly IDE account',reason:''});
    const current=()=>generation===this.generation && !this.logoutPending && this.sdk?.clerk.session?.id===session.id && this.sdk?.clerk.user?.id===user.id && this.env.navigator?.onLine!==false;
    let client;
    try { client=this.sdk.createClient();this.client=client;client.setAuth(async ({forceRefreshToken=false}={})=>{
      if(!current())return null;
      try {
        const options={skipCache:forceRefreshToken};if(this.config.tokenMode==='template')options.template='convex';
        const token=await session.getToken(options);
        if(!current())return null;
        if(!token){this.invalidate();this.publish({status:'session-expired',reason:'SESSION_EXPIRED'});return null;}
        return token;
      } catch {if(current()){this.invalidate();this.publish({status:this.env.navigator?.onLine===false?'offline':'session-expired',reason:'TOKEN_UNAVAILABLE'});}return null;}
    }, authenticated=>{
      if(!current())return;
      if(!authenticated){this.invalidate();this.publish({status:'session-expired',reason:'TOKEN_REJECTED'});return;}
      void this.confirmIdentity(client,current,user.id);
    }); } catch {if(current()){this.invalidate();this.publish({status:'error',reason:'CONVEX_UNAVAILABLE'});}}
  }
  async confirmIdentity(client,current,subject) {
    try {
      const profile=await client.readIdentity();
      if(!current())return;
      if(!profile || typeof profile.principal!=='string' || profile.issuer!==this.config.clerkIssuer || profile.subject!==subject || profile.plan!=='free' || profile.syncEnabled!==false)throw new Error('INVALID_IDENTITY');
      this.publish({convex:'confirmed',profile,reason:''});
    } catch {if(current())this.publish({convex:'error',profile:null,reason:'IDENTITY_UNCONFIRMED'});}
  }
  async signOut() {
    // Drop privileges before awaiting network revocation; late A results cannot reach B.
    this.logoutPending=true;this.invalidate();this.publish({status:'loading',reason:'SIGNING_OUT'});
    try {this.env.localStorage?.setItem(LOGOUT_INTENT,'true');} catch { /* No tokens or identity are written here. */ }
    try {
      if(!this.sdk){const checked=validateAuthConfig(this.config, this.approvedDevUrl);if(!checked.ready)throw new Error('NO_PROVIDER');this.sdk=await this.loadSDK(checked.config,this.env);await this.sdk.load();this.listenToSDK();}
      await this.sdk.clerk.signOut();
      this.logoutPending=false;try{this.env.localStorage?.removeItem(LOGOUT_INTENT);}catch{}
      this.publish({...emptyState(),reason:'SIGNED_OUT'});
    } catch {this.publish({status:'error',reason:'SIGN_OUT_PENDING'});}
  }
  mount(kind,host) {
    if(!this.sdk || this.env.navigator?.onLine===false || this.logoutPending || this.state.setupRequired) return false;
    this.unmount();
    const method=kind==='sign-up'?'openSignUp':'openSignIn';
    try {
      const returnURL=new URL(this.env.location.href);returnURL.search='';returnURL.hash='account';
      this.sdk.clerk[method]({appearance:{variables:{colorPrimary:'#a176f4',colorBackground:'#171421',colorText:'#f6f0ff',colorInputBackground:'#252031',colorInputText:'#ffffff',borderRadius:'0.75rem'}},forceRedirectUrl:returnURL.href,fallbackRedirectUrl:returnURL.href});
      this.mounted={kind,host};return true;
    }catch{this.publish({status:'error',reason:'AUTH_UI_UNAVAILABLE'});return false;}
  }
  unmount() {if(!this.mounted)return;const {kind,host}=this.mounted;this.mounted=null;this.sdk?.clerk[kind==='sign-up'?'closeSignUp':'closeSignIn']();}
  dispose() {this.unmount();this.removeListener?.();this.env.removeEventListener?.('storage',this.storageHandler);this.env.removeEventListener?.('online',this.onlineHandler);this.env.removeEventListener?.('offline',this.offlineHandler);this.invalidate();this.listeners.clear();}
}
