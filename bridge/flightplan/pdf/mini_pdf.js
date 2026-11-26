/* FlyFranceVFR — Mini bibliothèque PDF (sans dépendance) : pages, texte, lignes, et affichage dans la visionneuse des cartes VAC. */
window.MiniPDF=(()=>{
  // Texte en Latin-1/WinAnsi : accents conservés, symboles remplacés
  const enc=s=>String(s)
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\uFE0F]/gu,'')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g,c=>({'€':'\x80','→':'->','≈':'~','—':'-','–':'-','’':"'",'…':'...'}[c]??'?'));
  const txt=s=>'('+enc(s).replace(/[\\()]/g,'\\$&')+')';
  const width=(s,size)=>enc(s).length*size*0.54;
  const fit=(s,w,size)=>{s=enc(s);const max=Math.floor((w-4)/(size*0.55));return s.length>max?s.slice(0,Math.max(1,max-1))+'.':s;};

  function create(W,H){
    const pages=[];
    function page(){
      let c='';
      const api={
        text(x,y,s,o={}){
          c+=(o.rgb?o.rgb+' rg\n':'')+`BT /${o.bold?'F2':'F1'} ${o.size||8} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td ${txt(s)} Tj ET\n`+(o.rgb?'0 g\n':'');
        },
        center(x,y,w,s,o={}){api.text(x+Math.max(2,(w-width(s,o.size||8))/2),y,s,o);},
        fill(x,y,w,h,gray){c+=`${gray} g ${x} ${y} ${w} ${h} re f 0 g\n`;},
        stroke(gray,lw){c+=`${gray} G ${lw} w\n`;},
        line(x1,y1,x2,y2){c+=`${x1.toFixed(1)} ${y1.toFixed(1)} m ${x2.toFixed(1)} ${y2.toFixed(1)} l S\n`;},
        resetStroke(){c+='0 G\n';}
      };
      pages.push(()=>c);
      return api;
    }
    function build(){
      const objs=[];
      const add=s=>objs.push(s);
      add('<< /Type /Catalog /Pages 2 0 R >>');
      add('');
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const kids=[];
      pages.forEach(get=>{
        const c=get(),cid=objs.length+1;
        add(`<< /Length ${c.length} >>\nstream\n${c}endstream`);
        add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`);
        kids.push(objs.length+' 0 R');
      });
      objs[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
      let pdf='%PDF-1.4\n';const offs=[];
      objs.forEach((o,i)=>{offs.push(pdf.length);pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
      const xref=pdf.length;
      pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`+offs.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      const bytes=new Uint8Array(pdf.length);
      for(let i=0;i<pdf.length;i++)bytes[i]=pdf.charCodeAt(i)&255;
      return bytes;
    }
    return {page,build,count:()=>pages.length};
  }

  // --- Affichage dans la visionneuse des cartes VAC (retour, zoom, impression, enregistrement) ---
  let blobUrl=null;
  function release(){
    if(blobUrl){URL.revokeObjectURL(blobUrl);blobUrl=null;}
  }
  // source : octets du PDF, ou adresse d'un fichier PDF (le nom du fichier est alors conservé à l'enregistrement)
  function view(source,title,hash){
    release();
    const src=typeof source==='string'?source:(blobUrl=URL.createObjectURL(new Blob([source],{type:'application/pdf'})));
    const viewer=document.getElementById('vac-viewer');
    document.getElementById('vac-viewer-title').textContent=title;
    document.getElementById('vac-viewer-frame').src=src;
    viewer.classList.add('is-open');
    viewer.setAttribute('aria-hidden','false');
    history.pushState({vacViewer:true},'',location.href.split('#')[0]+'#vac-'+hash);
  }

  return {create,width,fit,view,release};
})();
