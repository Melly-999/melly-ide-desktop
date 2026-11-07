const copy = {
  en:{title:'Account',back:'Back to workspace',guest:'Guest',loading:'Loading',signed:'Signed in',offline:'Offline',expired:'Session expired',error:'Error',signin:'Sign in',signup:'Sign up',signout:'Sign out',retry:'Retry connection',local:'Continue locally',blocked:'BLOCKED — OWNER SETUP REQUIRED',setup:'Online sign-in is not configured for this build. A dedicated Melly IDE development account service must be connected first.',privacy:'Local projects stay on this device and are shared by users of this browser profile. Signing in does not upload them.',sync:'Project sync is not enabled.',free:'Free plan',plan:'Pro subscriptions are not available.',accountId:'Account ID',clerk:'Clerk session',convex:'Convex identity',yes:'Signed in',no:'Not connected',confirmed:'Confirmed by server',verifying:'Verifying',unconfirmed:'Not confirmed',notice:'Your local editor and backups remain available without signing in.',native:'Native login is not verified for this WebView origin. Use the authorized web preview for online authentication.',network:'Connect to the internet to verify your session. No cloud profile is shown offline.',expiredDetail:'Your online session could not be verified. Sign in again; local files are unchanged.',providerError:'Account connection failed. Retry online. No local files were changed.',signoutPending:'Remote sign-out is not confirmed. Remote access is blocked on this device; retry sign-out online.',signedout:'Signed out. Local projects were preserved.',identityError:'Clerk is signed in, but Convex identity has not been confirmed. Check the development integration.',authui:'Complete verification in the secure Clerk dialog.',progress:'Connecting to the account service…'},
  pl:{title:'Konto',back:'Wróć do pracy',guest:'Gość',loading:'Ładowanie',signed:'Zalogowano',offline:'Offline',expired:'Sesja wygasła',error:'Błąd',signin:'Zaloguj się',signup:'Utwórz konto',signout:'Wyloguj się',retry:'Ponów połączenie',local:'Pracuj lokalnie',blocked:'BLOKADA — WYMAGANA KONFIGURACJA WŁAŚCICIELA',setup:'Logowanie online nie jest skonfigurowane w tej wersji. Najpierw podłącz oddzielną usługę kont deweloperskich Melly IDE.',privacy:'Projekty lokalne pozostają na tym urządzeniu i są wspólne dla użytkowników tego profilu przeglądarki. Logowanie ich nie wysyła.',sync:'Synchronizacja projektów nie jest włączona.',free:'Plan Free',plan:'Subskrypcje Pro są niedostępne.',accountId:'Identyfikator konta',clerk:'Sesja Clerk',convex:'Tożsamość Convex',yes:'Zalogowano',no:'Nie połączono',confirmed:'Potwierdzono na serwerze',verifying:'Weryfikacja',unconfirmed:'Nie potwierdzono',notice:'Lokalny edytor i kopie zapasowe są dostępne bez logowania.',native:'Logowanie natywne nie zostało zweryfikowane dla tej przeglądarki WebView. Użyj autoryzowanego podglądu WWW.',network:'Połącz się z internetem, aby zweryfikować sesję. Profil chmurowy nie jest wyświetlany offline.',expiredDetail:'Nie udało się zweryfikować sesji online. Zaloguj się ponownie; pliki lokalne nie zostały zmienione.',providerError:'Połączenie z kontem nie powiodło się. Ponów online. Pliki lokalne pozostały bez zmian.',signoutPending:'Nie potwierdzono wylogowania z serwera. Dostęp zdalny na tym urządzeniu jest zablokowany; ponów wylogowanie online.',signedout:'Wylogowano. Projekty lokalne zostały zachowane.',identityError:'Sesja Clerk jest aktywna, ale tożsamość Convex nie została potwierdzona. Sprawdź integrację deweloperską.',authui:'Dokończ weryfikację w bezpiecznym oknie Clerk.',progress:'Łączenie z usługą kont…'}
};
const escape = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export class AccountScreen {
  constructor(app,auth){this.app=app;this.auth=auth;this.mode='account';this.previousRoute='dashboard';}
  init(){
    this.root=document.createElement('section');this.root.id='viewAccount';this.root.className='view-screen premium-page account-page';this.root.hidden=true;
    document.getElementById('appWrapper').append(this.root);
    this.root.addEventListener('click',event=>{
      const action=event.target.closest('[data-account-action]')?.dataset.accountAction;
      if(action==='sign-in'||action==='sign-up'){this.mode=action;void this.auth.start(true).then(()=>{this.render();if(!this.auth.state.clerkSignedIn)this.auth.mount(this.mode);});}
      if(action==='retry')void this.auth.start(true);
      if(action==='sign-out')void this.auth.signOut();
      if(action==='back'){this.auth.unmount();this.app.switchView(this.previousRoute);}
    });
    this.unsubscribe=this.auth.subscribe(()=>this.render());
    this.languageObserver=new MutationObserver(()=>this.render());this.languageObserver.observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  }
  open(mode='account'){
    if(this.app.shell.route!=='account')this.previousRoute=['code','studio','review','tasks','assistant'].includes(this.app.shell.route)?this.app.shell.route:'dashboard';
    this.mode=mode;document.getElementById('moreMenu').open=false;this.render();this.app.switchView('account');
    if(['sign-in','sign-up'].includes(mode)&&!this.auth.state.setupRequired)void this.auth.start(true).then(()=>{if(!this.auth.state.clerkSignedIn)this.auth.mount(mode);});
  }
  render(){
    const lang=document.documentElement.lang==='pl'?'pl':'en',t=copy[lang],s=this.auth.state;
    const focused=this.root.contains(document.activeElement)?document.activeElement:null;
    const focusAction=focused?.dataset.accountAction,focusHeading=focused?.tagName==='H1';
    this.root.lang=lang;
    const status={guest:t.guest,loading:t.loading,'signed-in':t.signed,offline:t.offline,'session-expired':t.expired,error:t.error}[s.status];
    const reason=s.setupRequired?t.setup:s.reason==='NATIVE_ORIGIN_UNVERIFIED'?t.native:s.status==='offline'?t.network:s.reason==='SIGN_OUT_PENDING'?t.signoutPending:s.reason==='SIGNED_OUT'?t.signedout:s.status==='session-expired'?t.expiredDetail:s.reason==='IDENTITY_UNCONFIRMED'?t.identityError:s.status==='error'?t.providerError:s.status==='loading'?t.progress:t.notice;
    if(s.clerkSignedIn||s.setupRequired||s.status==='offline'||this.mode==='account')this.auth.unmount();
    this.root.innerHTML=`<div class="account-heading"><div><h1 tabindex="-1">${t.title}</h1><p>${t.notice}</p></div><button class="quiet-button" data-account-action="back">${t.back}</button></div>
      <section class="surface account-summary"><div class="section-heading"><h2 id="accountState" role="status" aria-live="polite">${status}</h2>${s.clerkSignedIn?`<span class="connection-pill">${t.free}</span>`:''}</div>${s.setupRequired?`<p class="account-blocked">${t.blocked}</p>`:''}<p id="accountNotice" role="status">${reason}</p>${s.clerkSignedIn?`<p class="account-name">${escape(s.displayName)}</p>`:''}<dl class="account-facts">${s.convex==='confirmed'&&s.profile?`<div><dt>${t.accountId}</dt><dd><code id="accountIdentityReference">${escape(s.profile.subject)}</code></dd></div>`:''}<div><dt>${t.clerk}</dt><dd id="clerkIdentityState">${s.clerkSignedIn?t.yes:t.no}</dd></div><div><dt>${t.convex}</dt><dd id="convexIdentityState">${s.convex==='confirmed'?t.confirmed:s.convex==='verifying'?t.verifying:t.unconfirmed}</dd></div></dl><p>${t.sync}</p><div class="account-actions">${s.clerkSignedIn||s.reason==='SIGN_OUT_PENDING'?`<button class="primary-button" data-account-action="sign-out">${t.signout}</button>`:!s.setupRequired&&s.status!=='offline'&&s.reason!=='NATIVE_ORIGIN_UNVERIFIED'?`<button class="primary-button" data-account-action="sign-in" ${s.status==='loading'?'disabled':''}>${t.signin}</button><button class="quiet-button" data-account-action="sign-up" ${s.status==='loading'?'disabled':''}>${t.signup}</button>`:''}${!s.setupRequired&&['error','session-expired'].includes(s.status)&&s.reason!=='SIGN_OUT_PENDING'?`<button class="quiet-button" data-account-action="retry">${t.retry}</button>`:''}<button class="quiet-button" data-account-action="back">${t.local}</button></div></section>
      ${['sign-in','sign-up'].includes(this.mode)&&!s.clerkSignedIn&&!s.setupRequired&&s.status!=='offline'?`<section class="account-auth-panel" aria-label="Clerk ${this.mode}"><p>${t.authui}</p><div id="clerkAuthHost"></div></section>`:''}<section class="surface account-privacy"><h2>${t.free}</h2><p>${t.plan}</p><p>${t.privacy}</p></section>`;
    if(focusHeading)this.root.querySelector('h1')?.focus({preventScroll:true});
    else if(focusAction)this.root.querySelector(`[data-account-action="${focusAction}"]`)?.focus({preventScroll:true});
    const header=document.querySelector('[data-config="account"]');if(header){header.textContent=s.clerkSignedIn?t.title:t.signin;header.setAttribute('aria-label',t.title);header.lang=lang;}

  }
  hide(){this.auth.unmount();}
}
