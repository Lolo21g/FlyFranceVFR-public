/* FlyFranceVFR — Checklist de l'avion : PDF du dossier aircraft/checklist, ajouté par l'app ou copié à la main.
   Le PDF d'un avion est celui dont le nom contient son modèle (ex. DR400.pdf) ; il s'ouvre dans la visionneuse des cartes VAC. */
window.CHECKLIST=(()=>{
  const MAX_MB=30,DIR='aircraft/checklist/';
  let current=null;   // PDF associé à l'avion détecté (nom du fichier)
  const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const notif=m=>{try{showNotif(m);}catch(e){}};
  const norm=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  const stem=f=>norm(f.replace(/\.pdf$/i,''));

  async function files(){
    try{return (await (await fetch('/api/checklist-list')).json()).files||[];}
    catch(e){return [];}
  }

  // Le PDF dont le nom contient le modèle ou le titre de l'avion (ou l'inverse) ; si plusieurs, le nom le plus précis
  function match(list){
    const names=ACLIVE.liveNames().map(norm).filter(n=>n.length>=3);
    let best=null;
    list.forEach(f=>{
      const s=stem(f);
      if(s.length>=3&&names.some(n=>n.includes(s)||s.includes(n))&&(!best||s.length>stem(best).length))best=f;
    });
    return best;
  }

  // Le fichier prend le modèle de l'avion (ex. DR400.pdf)
  function pick(){
    const input=document.createElement('input');
    input.type='file';
    input.accept='application/pdf,.pdf';
    input.onchange=async()=>{
      const f=input.files[0];
      if(!f)return;
      if(f.size>MAX_MB*1048576){notif('⚠ Fichier trop volumineux (maximum '+MAX_MB+' Mo)');return;}
      const data=await f.arrayBuffer();
      if(new TextDecoder().decode(data.slice(0,5))!=='%PDF-'){notif("⚠ Ce fichier n'est pas un PDF");return;}
      const base=(ACLIVE.liveNames()[0]||'checklist').replace(/[^A-Za-z0-9 _.()-]/g,'').trim().slice(0,60)||'checklist';
      const name=current||base+'.pdf';
      try{
        const j=await (await fetch('/api/checklist?file='+encodeURIComponent(name),{method:'POST',body:data})).json();
        if(!j.ok){notif('⚠ '+j.message);return;}
      }catch(e){notif("⚠ Enregistrement impossible : le bridge ne répond pas");return;}
      notif('📋 Checklist enregistrée : '+name);
      render();
    };
    input.click();
  }

  function open(){
    if(!current)return;
    MiniPDF.view(DIR+encodeURIComponent(current)+'?t='+Date.now(),'Checklist - '+((AIRCRAFT[pilot.aircraft]||{}).name||'avion'),'checklist');
  }

  function remove(){
    const name=current;
    confirmModal({
      title:'Supprimer la checklist ?',
      message:'Le fichier « '+esc(name)+" » sera supprimé du dossier aircraft/checklist.",
      confirmLabel:'Supprimer',
      onConfirm:async()=>{
        try{await fetch('/api/checklist-delete?file='+encodeURIComponent(name),{method:'POST'});}catch(e){}
        render();
      }
    });
  }

  async function render(){
    const box=document.getElementById('aircraft-checklist');
    if(!box)return;
    const list=await files();
    current=match(list);
    box.innerHTML=current
      ?`<div style="display:flex;gap:6px;align-items:stretch;"><button class="btn p" style="flex:1;min-width:0;" onclick="CHECKLIST.open()"><svg class="ico" aria-hidden="true"><use href="#ic-file"/></svg> Checklist : ${esc(current.length>26?current.slice(0,25)+'…':current)}</button><button class="btn d" title="Supprimer la checklist" style="flex:0 0 38px;width:38px;padding:0;font-size:13px;" onclick="CHECKLIST.remove()">🗑</button></div>`
      :`<button class="btn" style="width:100%;" onclick="CHECKLIST.pick()"><svg class="ico" aria-hidden="true"><use href="#ic-file"/></svg> Ajouter la checklist de l'avion (PDF)</button>`;
  }

  return {pick,open,remove,render};
})();
