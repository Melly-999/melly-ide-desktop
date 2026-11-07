import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {dirname,resolve,join,relative} from 'node:path';
import {readFileSync,readdirSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';

export async function buildAuthSDK(output=fileURLToPath(new URL('../../runtime/auth-sdk.js',import.meta.url))) {
  output=resolve(output);
  const result=await build({entryPoints:[fileURLToPath(new URL('../../js/auth/sdk-entry.js',import.meta.url))],outfile:output,bundle:true,format:'esm',platform:'browser',target:['safari16','chrome110'],minify:true,metafile:true,legalComments:'external',write:false,logLevel:'warning'});
  const packages=new Map();
  for(const input of Object.keys(result.metafile.inputs)){
    if(!input.replaceAll('\\','/').includes('node_modules/'))continue;
    let dir=dirname(resolve(input));
    while(dir!==dirname(dir)){
      const meta=join(dir,'package.json');
      if(existsSync(meta)){const pkg=JSON.parse(readFileSync(meta,'utf8'));if(pkg.name){packages.set(dir,pkg);break;}}
      dir=dirname(dir);
    }
  }
  const notices=[];
  for(const [dir,pkg]of [...packages].sort((a,b)=>a[1].name.localeCompare(b[1].name))){
    notices.push(pkg.name+' '+pkg.version+' — '+(pkg.license||'See package notice'));
    const files=readdirSync(dir).filter(name=>/^(?:licen[cs]e|notice|copying)(?:\..*)?$/i.test(name)).sort();
    for(const name of files)notices.push(readFileSync(join(dir,name),'utf8'));
  }
  // Read this build's output, never append to a previous generated notices file.
  const extracted=result.outputFiles.find(file=>file.path===output+'.LEGAL.txt')?.text||'';
  mkdirSync(dirname(output),{recursive:true});
  for(const file of result.outputFiles)if(file.path!==output+'.LEGAL.txt')writeFileSync(file.path,file.contents);
  writeFileSync(output+'.LEGAL.txt',extracted+'\nThird-party package notices for bundled inputs\n\n'+notices.join('\n\n---\n\n')+'\n');
  const outputEntry=Object.entries(result.metafile.outputs).find(([name])=>resolve(name)===output);
  if(!outputEntry)throw new Error('Bundled SDK output is missing from the esbuild metafile.');
  const bundledInputs=Object.entries(outputEntry[1].inputs)
    .filter(([,detail])=>detail.bytesInOutput>0)
    .map(([input,detail])=>[input.replaceAll('\\','/'),detail.bytesInOutput]);
  const inventory=[...packages].map(([dir,pkg])=>({
    path:relative(process.cwd(),dir).replaceAll('\\','/'),name:pkg.name,version:pkg.version,license:pkg.license??null
  }));
  writeFileSync(output+'.inventory.json',JSON.stringify({packages:inventory,bundledInputs},null,2)+'\n');
  return {packages:packages.size};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await buildAuthSDK();
  console.log('Built pinned auth SDK and notices for '+result.packages+' bundled packages. No environment values are bundled.');
}
