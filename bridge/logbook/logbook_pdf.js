/* FlyFranceVFR — Carnet de vol en PDF (mise en page type carnet de pilote), affiché dans la visionneuse des cartes VAC. */
window.LOGBOOK=(()=>{
  const PW=842,PH=595,M=30,ROW=18,NUMROW=13,FS=8,BOTTOM=40,HH=NUMROW+2*ROW;
  // [groupe, sous-colonne, largeur, alignement]
  const COLS=[
    ['Date','(jj/mm/aa)',48,'c'],
    ['Départ','Lieu',38,'c'],['Départ','Heure',34,'c'],
    ['Arrivée','Lieu',38,'c'],['Arrivée','Heure',34,'c'],
    ['Aéronef','Constructeur, modèle',130,'l'],['Aéronef','Immatriculation',62,'c'],
    ['Temps de vol','Monomoteur',54,'c'],['Temps de vol','Multimoteur',54,'c'],
    ['Carburant (L)','Départ',40,'c'],['Carburant (L)','Arrivée',40,'c'],
    ['Atterrissage','ft/min',58,'c'],
    ['Remarques','',0,'l']
  ];
  COLS[COLS.length-1][2]=PW-2*M-COLS.reduce((t,c)=>t+c[2],0);
  const XS=[];let acc=M;COLS.forEach(c=>{XS.push(acc);acc+=c[2];});
  const TOTALW=acc-M,RIGHT=acc;
  const GROUPS=[];
  COLS.forEach((c,i)=>{const g=GROUPS[GROUPS.length-1];if(g&&g.name===c[0])g.to=i;else GROUPS.push({name:c[0],from:i,to:i});});
  const hmm=m=>formatMinutes(m).replace('h',':');

  function rowsOf(entries){
    return entries.slice().sort((a,b)=>(a.date||0)-(b.date||0)).map(h=>{
      const crashed=h.status==='crash',lr=h.landingRate,start=h.date&&h.dur?h.date-h.dur*60000:null;
      return {crashed,cells:[
        h.date?new Date(h.date).toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit',year:'2-digit'}):'-',
        logbookPlace(h,'from'),start?formatClock(start):'-',
        logbookPlace(h,'to'),h.date?formatClock(h.date):'-',
        h.aircraft||'-',h.immat||'-',
        h.dur&&!h.multi?hmm(h.dur):'',h.dur&&h.multi?hmm(h.dur):'',
        h.fuelStart!=null?String(h.fuelStart):'-',h.fuelEnd!=null?String(h.fuelEnd):'-',
        crashed?'Crash':(lr!=null?String(lr):'-'),
        (crashed?'CRASH - ':'')+(h.name||'')
      ]};
    });
  }

  function summary(entries){
    const lrs=entries.filter(h=>h.status!=='crash'&&h.landingRate!=null).map(h=>h.landingRate);
    const mono=entries.filter(h=>!h.multi).reduce((t,h)=>t+(Number(h.dur)||0),0);
    const multi=entries.filter(h=>h.multi).reduce((t,h)=>t+(Number(h.dur)||0),0);
    return {
      vols:entries.length,mono,multi,minutes:mono+multi,
      nm:Math.round(entries.reduce((t,h)=>t+(Number(h.dist)||0),0)),
      fuel:Math.round(entries.reduce((t,h)=>t+(Number(h.fuelLiters)||0),0)),
      atterr:lrs.length,
      avions:new Set(entries.map(h=>h.aircraft).filter(Boolean)).size,
      meilleur:lrs.length?Math.max(...lrs):null
    };
  }

  function buildPdf(entries){
    const rows=rowsOf(entries),sm=summary(entries);
    const total=new Array(COLS.length).fill('');
    total[5]='TOTAL';total[7]=sm.mono?hmm(sm.mono):'';total[8]=sm.multi?hmm(sm.multi):'';
    total[12]='Carburant consommé : '+sm.fuel+' L';
    rows.push({total:true,cells:total});

    const top1=PH-120,topN=PH-50,groups=[];
    let cur={top:top1,rows:[]};
    rows.forEach(r=>{
      if(cur.top-HH-ROW*(cur.rows.length+1)<BOTTOM){groups.push(cur);cur={top:topN,rows:[]};}
      cur.rows.push(r);
    });
    groups.push(cur);

    const doc=MiniPDF.create(PW,PH);
    const pilotName=(typeof pilot!=='undefined'&&pilot.name)||'Pilote';
    groups.forEach((pg,pi)=>{
      const P=doc.page();
      if(pi===0){
        P.text(M,PH-42,'Carnet de vol',{bold:true,size:20});
        P.text(M,PH-60,`Pilote : ${pilotName}   -   Édité le ${new Date().toLocaleDateString('fr-FR')}   -   FlyFranceVFR`,{size:9});
        P.text(M,PH-82,`Vols : ${sm.vols}     Heures de vol : ${formatMinutes(sm.minutes)}     Distance : ${sm.nm} NM     Atterrissages : ${sm.atterr}`,{size:10});
        P.text(M,PH-98,`Avions différents : ${sm.avions}     Carburant consommé : ${sm.fuel} L     Meilleur atterrissage : ${sm.meilleur!=null?sm.meilleur+' ft/min':'-'}`,{size:10});
      }else{
        P.text(M,PH-32,'Carnet de vol (suite)',{bold:true,size:11});
      }
      const bodyTop=pg.top-HH,bottom=bodyTop-ROW*pg.rows.length;
      // en-tête (fond gris), puis lignes de total
      P.fill(M,bodyTop,TOTALW,HH,0.9);
      pg.rows.forEach((r,i)=>{if(r.total)P.fill(M,bodyTop-ROW*(i+1),TOTALW,ROW,0.94);});
      GROUPS.forEach((g,gi)=>{
        const gx=XS[g.from],gw=XS[g.to]+COLS[g.to][2]-gx;
        P.center(gx,pg.top-NUMROW+4,gw,String(gi+1),{size:FS});
        P.center(gx,pg.top-NUMROW-ROW+6,gw,g.name,{bold:true,size:FS});
      });
      COLS.forEach((c,i)=>{if(c[1])P.center(XS[i],pg.top-HH+6,c[2],c[1],{size:FS});});
      // grille
      P.stroke(0.5,0.5);
      [pg.top,pg.top-NUMROW,pg.top-NUMROW-ROW,bodyTop].forEach(y=>P.line(M,y,RIGHT,y));
      pg.rows.forEach((r,i)=>P.line(M,bodyTop-ROW*(i+1),RIGHT,bodyTop-ROW*(i+1)));
      GROUPS.forEach(g=>P.line(XS[g.from],pg.top,XS[g.from],bottom));
      P.line(RIGHT,pg.top,RIGHT,bottom);
      COLS.forEach((c,i)=>{if(GROUPS.some(g=>g.from<i&&g.to>=i))P.line(XS[i],pg.top-NUMROW-ROW,XS[i],bottom);});
      P.resetStroke();
      // lignes du tableau
      pg.rows.forEach((r,i)=>{
        const yb=bodyTop-ROW*(i+1)+6;
        r.cells.forEach((cell,k)=>{
          if(!cell)return;
          const o={bold:!!r.total,size:FS,rgb:r.crashed?'0.8 0 0':null},s=MiniPDF.fit(cell,COLS[k][2],FS);
          if(COLS[k][3]==='c')P.center(XS[k],yb,COLS[k][2],s,o);else P.text(XS[k]+3,yb,s,o);
        });
      });
      P.text(M,22,'FlyFranceVFR - Carnet de vol',{size:8});
      P.text(PW-M-60,22,`Page ${pi+1} / ${groups.length}`,{size:8});
    });
    return doc.build();
  }

  function exportPdf(){
    const entries=(typeof pilot!=='undefined'&&pilot.history)||[];
    if(!entries.length){try{showNotif('Aucun vol à exporter');}catch(e){}return;}
    MiniPDF.view(buildPdf(entries),'Carnet de vol','carnet');
  }

  return {exportPdf,buildPdf};
})();
