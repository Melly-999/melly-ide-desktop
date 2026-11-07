// Remote Clerk UI/session endpoints are never part of the offline shell inventory.
export async function loadAuthSDK(config, env = globalThis) {
  const {createClerk,createIdentityClient} = await loadLocalSDK(env);
  const clerk = createClerk(config.clerkPublishableKey);
  return {
    clerk,
    createClient:()=>createIdentityClient(config.convexUrl),
    async load() {
      await loadClerkUI(config.clerkIssuer, env);
      await clerk.load({ui:{ClerkUI:env.__internal_ClerkUICtor},telemetry:{disabled:true}});
    }
  };
}
function loadClerkUI(issuer, env) {
  if (env.__internal_ClerkUICtor) return Promise.resolve();
  return new Promise((resolve,reject) => {
    const script = env.document.createElement('script');
    const timer = env.setTimeout(() => { script.remove(); reject(new Error('CLERK_UI_UNAVAILABLE')); },15000);
    script.src = issuer + '/npm/@clerk/ui@1/dist/ui.browser.js';
    script.async = true; script.crossOrigin = 'anonymous';
    script.onload = () => { env.clearTimeout(timer); env.__internal_ClerkUICtor ? resolve() : reject(new Error('CLERK_UI_UNAVAILABLE')); };
    script.onerror = () => { env.clearTimeout(timer); script.remove(); reject(new Error('CLERK_UI_UNAVAILABLE')); };
    env.document.head.append(script);
  });
}

function loadLocalSDK(env) {
  if(env.__MELLY_AUTH_SDK__)return Promise.resolve(env.__MELLY_AUTH_SDK__);
  return new Promise((resolve,reject)=>{
    const script=env.document.createElement('script');
    const timer=env.setTimeout(()=>{script.remove();reject(new Error('LOCAL_AUTH_SDK_UNAVAILABLE'));},15000);
    script.type='module';script.src=new URL('../../runtime/auth-sdk.js',import.meta.url).href;
    script.onload=()=>{env.clearTimeout(timer);env.__MELLY_AUTH_SDK__?resolve(env.__MELLY_AUTH_SDK__):reject(new Error('LOCAL_AUTH_SDK_UNAVAILABLE'));};
    script.onerror=()=>{env.clearTimeout(timer);script.remove();reject(new Error('LOCAL_AUTH_SDK_UNAVAILABLE'));};
    env.document.head.append(script);
  });
}
