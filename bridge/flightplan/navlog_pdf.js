/* FlyFranceVFR — Log de navigation (PDF) construit à partir du plan de vol, affiché dans la visionneuse des cartes VAC. */
window.NAVLOG=(()=>{
  const PW=842,PH=595,M=30,FS=8.5,LINE=11,MINROW=20,BOTTOM=60,HEAD=22;
  // [titre, largeur, alignement] — les 3 dernières colonnes (fréquences) sont sur plusieurs lignes si besoin
  const COLS=[['N°',22,'c'],['De',72,'c'],['Vers',72,'c'],['Alt./FL',44,'c'],['Rv',32,'c'],['Rm',32,'c'],['Dérive',36,'c'],['Cm',32,'c'],['Dist. NM',42,'c'],['GS (kt)',34,'c'],['Temps',38,'c'],['Cumul',40,'c'],['Fréq. départ',96,'l'],['SIV (route)',104,'l'],['Fréq. arrivée',0,'l']];
  const FD=COLS.length-3,FSIV=COLS.length-2,FA=COLS.length-1;   // colonnes de fréquences
  COLS[FA][1]=PW-2*M-COLS.reduce((t,c)=>t+c[1],0);
  const XS=[];let acc=M;COLS.forEach(c=>{XS.push(acc);acc+=c[1];});
  const RIGHT=acc,TOTALW=RIGHT-M;
  const p3=n=>String(Math.round(n)%360||360).padStart(3,'0');
  const ang=v=>v===null?'-':p3(v)+'°';
  const altText=a=>!a?'-':(/^FL/.test(a)?a:a+' ft');
  const place=(p,i)=>p.icao||p.name||('Point '+p.lat.toFixed(3)+', '+p.lon.toFixed(3));

  // Fréquences d'un aérodrome (hors SIV), classées comme dans le popup des aérodromes
  function freqTokens(icao){
    const g=icao&&typeof apFreqGroups==='function'?apFreqGroups(icao):null;
    if(!g)return [];
    const one=(list,label)=>list[0]?label+' '+list[0].freq:'';
    return [one(g.atis,'ATIS'),one(g.tower,'TWR'),one(g.afis,'AFIS'),one(g.ground,'SOL'),one(g.airToAir,'A/A')].filter(Boolean);
  }

  // SIV traversés par une branche : zones rencontrées en échantillonnant la route (environ 1 point par mille)
  function sivTokens(a,b,distNm){
    if(typeof getSivAt!=='function')return [];
    const n=Math.max(2,Math.ceil(distNm)),found=[];
    for(let k=0;k<=n;k++){
      const t=k/n,siv=getSivAt(a.lat+(b.lat-a.lat)*t,a.lon+(b.lon-a.lon)*t);
      if(!siv)continue;
      const text=(siv.name||'SIV')+(siv.freq?' '+siv.freq:'');
      if(!found.includes(text))found.push(text);
    }
    return found;
  }

  // Découpe une liste de mots courts en lignes qui tiennent dans la largeur de la colonne
  function wrap(tokens,width){
    const lines=[];let cur='';
    tokens.forEach(t=>{
      const next=cur?cur+'  '+t:t;
      if(cur&&MiniPDF.width(next,FS)>width-8){lines.push(cur);cur=t;}else cur=next;
    });
    if(cur)lines.push(cur);
    return lines.length?lines:['-'];
  }

  // Nom d'un point découpé par mots pour tenir dans sa colonne
  function wrapName(text,width){
    const lines=[];let cur='';
    String(text).split(' ').forEach(w=>{
      const next=cur?cur+' '+w:w;
      if(cur&&MiniPDF.width(next,FS)>width-6){lines.push(cur);cur=w;}else cur=next;
    });
    if(cur)lines.push(cur);
    return lines.length?lines:['-'];
  }

  function rowsOf(nav){
    const rows=nav.legs.map((l,i)=>({cells:[
      String(i+1),wrapName(place(l.from,i),COLS[1][1]),wrapName(place(l.to,i+1),COLS[2][1]),altText(l.to.alt),
      ang(l.tc),ang(l.rm),l.rm!==null&&l.wind?(l.wca>=0?'+':'')+Math.round(l.wca)+'°':'-',ang(l.cm),
      l.dist.toFixed(1),String(Math.round(l.gs)),formatMinutes(l.ete),formatMinutes(l.cum),
      wrap(freqTokens(l.from.icao),COLS[FD][1]),wrap(sivTokens(l.from,l.to,l.dist),COLS[FSIV][1]),wrap(freqTokens(l.to.icao),COLS[FA][1])
    ]}));
    rows.push({total:true,cells:['','TOTAL','','','','','','',nav.dist.toFixed(1),'',formatMinutes(nav.ete),'','','','']});
    rows.forEach(r=>{
      const lines=Math.max(...r.cells.map(c=>Array.isArray(c)?c.length:1));
      r.h=Math.max(MINROW,lines*LINE+8);
    });
    return rows;
  }

  function build(nav){
    const rows=rowsOf(nav),first=nav.wps[0],last=nav.wps[nav.wps.length-1];
    const top1=PH-115,topN=PH-50,pages=[];
    let cur={top:top1,rows:[],used:0};
    rows.forEach(r=>{
      if(cur.top-HEAD-cur.used-r.h<BOTTOM){pages.push(cur);cur={top:topN,rows:[],used:0};}
      cur.rows.push(r);cur.used+=r.h;
    });
    pages.push(cur);

    const doc=MiniPDF.create(PW,PH);
    const pilotName=(typeof pilot!=='undefined'&&pilot.name)||'Pilote';
    const immat=typeof pilotRegistration==='function'?pilotRegistration():'';
    pages.forEach((pg,pi)=>{
      const P=doc.page();
      if(pi===0){
        P.text(M,PH-42,'Log de navigation',{bold:true,size:20});
        P.text(M,PH-62,`Départ : ${place(first,0)}  ->  Arrivée : ${place(last,nav.wps.length-1)}     Édité le ${new Date().toLocaleDateString('fr-FR')}     Pilote : ${pilotName}`,{size:10});
        P.text(M,PH-80,nav.detected?`Avion : ${nav.ac.name||'Avion'}${immat?' ('+immat+')':''}     Vitesse de croisière : ${nav.tas} kt`:`Avion non détecté par MSFS : vitesse générique de ${nav.tas} kt, les temps sont indicatifs.`,{size:9});
        P.text(M,PH-94,`Conditions MSFS : ${nav.condText}`,{size:9});
      }else{
        P.text(M,PH-32,'Log de navigation (suite)',{bold:true,size:11});
      }
      const bodyTop=pg.top-HEAD,bottom=bodyTop-pg.used;
      P.fill(M,bodyTop,TOTALW,HEAD,0.9);
      let y=bodyTop;
      pg.rows.forEach(r=>{y-=r.h;if(r.total)P.fill(M,y,TOTALW,r.h,0.94);});
      COLS.forEach((c,i)=>P.center(XS[i],pg.top-HEAD+7,c[1],c[0],{bold:true,size:FS}));
      P.stroke(0.5,0.5);
      P.line(M,pg.top,RIGHT,pg.top);P.line(M,bodyTop,RIGHT,bodyTop);
      y=bodyTop;pg.rows.forEach(r=>{y-=r.h;P.line(M,y,RIGHT,y);});
      XS.forEach(x=>P.line(x,pg.top,x,bottom));
      P.line(RIGHT,pg.top,RIGHT,bottom);
      P.resetStroke();
      y=bodyTop;
      pg.rows.forEach(r=>{
        const rowTop=y;y-=r.h;
        r.cells.forEach((cell,k)=>{
          const lines=Array.isArray(cell)?cell:[cell];
          if(!lines.length||(lines.length===1&&!lines[0]))return;
          const o={bold:!!r.total,size:FS},start=rowTop-(r.h-LINE*lines.length)/2-9;
          lines.forEach((text,j)=>{
            const s=MiniPDF.fit(text,COLS[k][1],FS),by=start-LINE*j;
            if(COLS[k][2]==='c')P.center(XS[k],by,COLS[k][1],s,o);else P.text(XS[k]+4,by,s,o);
          });
        });
      });
      if(pi===pages.length-1){
        P.text(M,bottom-16,'Rv : route vraie - Rm : route magnétique - Cm : cap magnétique à tenir (dérive du vent incluse) - GS : vitesse sol - Alt./FL : altitude (ft) ou niveau de vol retenu - SIV : zones traversées.',{size:7.5});
        P.text(M,bottom-27,"Variation et vent relevés dans MSFS au moment de l'export. Document de préparation pour simulateur.",{size:7.5});
      }
      P.text(M,22,'FlyFranceVFR - Log de navigation',{size:8});
      P.text(PW-M-60,22,`Page ${pi+1} / ${pages.length}`,{size:8});
    });
    return doc.build();
  }

  // Les zones SIV sont chargées avant la construction pour que la colonne SIV soit complète
  function open(){
    const nav=FPL.navData();
    const ready=typeof ensureSivData==='function'?ensureSivData():Promise.resolve();
    ready.then(()=>MiniPDF.view(build(nav),'Log de navigation','navlog'));
  }

  return {open,build};
})();
